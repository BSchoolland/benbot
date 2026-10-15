import fs from 'node:fs';
import path from 'node:path';
import { q } from './db.mjs';
import { STATE_DIR, OWNER_IDS } from './config.mjs';
import { systemHeader } from './identity.mjs';
import { enqueue } from './queue.mjs';
import * as sessions from './sessions.mjs';
import { PROJECTS_ROOT, sessionFile, readEntries, isFallback, isReply, turnStartBefore, modelMatches, rewind, modelName } from './transcript.mjs';

// When the primary model refuses, the CLI answers on a fallback model (a model_refusal_fallback line in the transcript),
// and the session stays there while the triggering content is in its transcript. Recovery: roll the transcript back to
// before the turn that triggered it (one more turn per failed attempt), then check the model of the next reply.
const POLL_MS = 5000;
const MAX_ATTEMPTS = 3;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const BACKUP_DIR = path.join(STATE_DIR, 'transcript-backups');
const owner = `<@${OWNER_IDS[0]}>`;
const startedAt = Date.now();

const watched = new Map(); // session_uuid -> { file, offset }: how far incident detection has read
const lastError = new Map(); // thread_key -> message, so a persistent error is posted once

const when = (entry) => entry.timestamp ? new Date(entry.timestamp).toLocaleString('en-US', { timeZone: 'America/Chicago' }) + ' CT' : 'an unknown time';
const clock = (entry) => entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }) : 'an unknown time';

// One quiet line per incident, edited as it progresses; only a failure gets a fresh message that pings.
async function status(row, rep, text) {
  const id = await sessions.announce(row.thread_key, `-# ${text}`, rep.status_msg ?? undefined);
  if (!rep.status_msg) q.setRepairStatusMsg.run(id, row.session_uuid);
}

function watch(row, root) {
  const w = watched.get(row.session_uuid);
  if (w && fs.existsSync(w.file)) return w;
  const file = sessionFile(row.session_uuid, root);
  if (!file) return null;
  const { size, mtimeMs } = fs.statSync(file);
  // A transcript untouched since the bot started has no live incident; one written since is read from the top.
  const fresh = { file, offset: mtimeMs < startedAt ? size : 0 };
  watched.set(row.session_uuid, fresh);
  return fresh;
}

async function detect(row, w) {
  if (fs.statSync(w.file).size < w.offset) w.offset = fs.statSync(w.file).size; // rewound outside the bot (/rewind)
  const { entries, end } = readEntries(w.file, w.offset);
  w.offset = end;
  const rep = q.repair.get(row.session_uuid);
  if (rep?.state === 'failed') {
    const recovered = entries.some(({ entry }) => isReply(entry) && modelMatches(entry.message.model, rep.expected_model)) &&
      !entries.some(({ entry }) => isFallback(entry));
    if (recovered) {
      q.deleteRepair.run(row.session_uuid);
      await status(row, rep, `✅ Back on ${modelName(rep.expected_model)}.`);
    }
    return;
  }
  if (rep) return; // an open incident is judged by verify()
  const hit = entries.find(({ entry }) => isFallback(entry));
  if (!hit) return;

  const { originalModel: expected, fallbackModel: fallback } = hit.entry;
  if (!expected || !fallback) throw new Error(`fallback entry at byte ${hit.offset} has no originalModel/fallbackModel`);
  q.insertRepair.run({ session_uuid: row.session_uuid, thread_key: row.thread_key, fallback_at: hit.offset,
    expected_model: expected, fallback_model: fallback, now: Date.now() });
  console.log(`[${row.thread_key}] refusal fallback ${expected} → ${fallback} at byte ${hit.offset}`);
  await status(row, q.repair.get(row.session_uuid), `⚠️ Safety classifier flagged this session: answering on ${modelName(fallback)} ` +
    `instead of ${modelName(expected)}. Rolling back once it's idle.`);
}

async function repair(row, w, rep) {
  const key = row.thread_key;
  if (sessions.isBusy(key)) return;
  await sessions.evict(key);
  if (sessions.isLive(key)) return; // a message restarted it meanwhile; retry once that turn ends
  // From here to the enqueue, nothing awaits: no message can resume the CLI while the file is cut.
  const attempts = rep.attempts + 1;
  const turn = turnStartBefore(readEntries(w.file).entries, rep.cut_at ?? rep.fallback_at);
  if (!turn) return fail(row, rep, rep.attempts, 'there is no earlier turn left to roll back');
  const backup = rewind(w.file, turn.offset, BACKUP_DIR, `attempt${attempts}`);
  w.offset = turn.offset;
  q.updateRepair.run({ session_uuid: row.session_uuid, state: 'verifying', attempts, cut_at: turn.offset,
    backup: rep.backup ?? backup, now: Date.now() });
  console.log(`[${key}] transcript rolled back to byte ${turn.offset} (attempt ${attempts}), backup ${backup}`);
  enqueue(key, { text: `${systemHeader('transcript repair')}\nThe API safety classifier flagged this conversation and moved it to a ` +
    `fallback model, so your transcript was rolled back to before the message from ${when(turn.entry)}. That message and ` +
    'everything after it are gone from your memory; the thread has been told. Post nothing and use no tools: reply with only "ok".' });
  await status(row, rep, `🩹 Safety classifier flagged this session: rolled back to before the ${clock(turn.entry)} message ` +
    `(attempt ${attempts}/${MAX_ATTEMPTS}), checking the next reply.`);
}

async function verify(row, w, rep) {
  const since = readEntries(w.file, rep.cut_at).entries.map((x) => x.entry);
  const flagged = since.some(isFallback);
  const replies = since.filter(isReply);
  if (!flagged && !replies.length) {
    if (Date.now() - rep.updated_at > VERIFY_TIMEOUT_MS) await fail(row, rep, rep.attempts, `no reply ${VERIFY_TIMEOUT_MS / 60000} minutes after the rollback`);
    return;
  }
  if (sessions.isBusy(row.thread_key)) return; // judge whole turns
  const wrong = replies.find((e) => !modelMatches(e.message.model, rep.expected_model));
  if (!flagged && !wrong) {
    q.deleteRepair.run(row.session_uuid);
    console.log(`[${row.thread_key}] recovered on ${replies.at(-1).message.model} after ${rep.attempts} rollback(s)`);
    await status(row, rep, `✅ Recovered from a safety-classifier flag: rolled back ${rep.attempts} message${rep.attempts > 1 ? 's' : ''}, ` +
      `back on ${modelName(replies.at(-1).message.model)}.`);
    return;
  }
  const seen = modelName(wrong?.message.model ?? rep.fallback_model);
  if (rep.attempts >= MAX_ATTEMPTS) return fail(row, rep, rep.attempts, `still answering on ${seen}`);
  q.updateRepair.run({ session_uuid: row.session_uuid, state: 'repairing', attempts: rep.attempts, cut_at: rep.cut_at, backup: rep.backup, now: Date.now() });
  await status(row, rep, `↩️ Safety classifier flagged this session: still on ${seen} after rollback ${rep.attempts}, rolling back one more message.`);
}

async function fail(row, rep, attempts, why) {
  q.updateRepair.run({ session_uuid: row.session_uuid, state: 'failed', attempts, cut_at: rep.cut_at, backup: rep.backup, now: Date.now() });
  console.error(`[${row.thread_key}] transcript recovery failed after ${attempts} rollback(s): ${why}`);
  await status(row, rep, `🚨 Safety classifier flagged this session; recovery failed.`);
  await sessions.announce(row.thread_key, `## ⚠️ Stuck on ${modelName(rep.fallback_model)}\n${owner} couldn't get this session back to ` +
    `${modelName(rep.expected_model)} after ${attempts} rollback${attempts === 1 ? '' : 's'}: ${why}. It keeps answering on the fallback ` +
    'until its transcript is cleaned by hand or the thread is replaced.' + (rep.backup ? `\n-# pre-repair transcript: \`${rep.backup}\`` : ''));
}

export async function tick({ only, root = PROJECTS_ROOT } = {}) {
  for (const row of q.threads.all()) {
    if (only && row.thread_key !== only) continue;
    try {
      const w = watch(row, root);
      if (!w) continue;
      await detect(row, w);
      const rep = q.repair.get(row.session_uuid);
      if (rep?.state === 'repairing') await repair(row, w, rep);
      else if (rep?.state === 'verifying') await verify(row, w, rep);
      lastError.delete(row.thread_key);
    } catch (e) {
      console.error(`[${row.thread_key}] transcript recovery:`, e.message);
      if (lastError.get(row.thread_key) === e.message) continue;
      lastError.set(row.thread_key, e.message);
      sessions.announce(row.thread_key, `🚨 ${owner} transcript recovery broke: ${e.message.slice(0, 400)}`).catch((x) => console.error('notify:', x.message));
    }
  }
}

export function startRecovery() {
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    tick().catch((e) => console.error('recovery tick:', e.message)).finally(() => { running = false; });
  }, POLL_MS).unref();
}
