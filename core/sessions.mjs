import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnThread } from './drivers/claude.mjs';
import { db, q } from './db.mjs';
import { LOG_DIR, WORKSPACES, ROOT, CLAUDE_BIN, CCR_BIN, IDLE_EVICT_MS } from './config.mjs';

// thread_key -> live Thread (driver). Everything durable is in the threads table.
const live = new Map();
const turn = new Map(); // thread_key -> { busy, deliveries } : deliveries = batches injected during the current turn
let notify = async () => {}; // (threadKey, text) => posts to Discord; set by gateway

export function onNotify(fn) { notify = fn; }

export function workspaceFor(guildId) {
  const dir = path.join(WORKSPACES, guildId || 'dm');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    for (const [link, target] of [['CLAUDE.md', '../../CLAUDE.md'], ['TEAM', '../../TEAM'], ['bin', '../../scripts'],
      ['.claude/skills', '../../../skills']]) {
      const p = path.join(dir, link);
      if (!fs.existsSync(p)) fs.symlinkSync(target, p);
    }
  }
  return dir;
}

export function ensureThread({ threadKey, guildId, channelId, model }) {
  let row = q.thread.get(threadKey);
  if (!row) {
    q.insertThread.run({ thread_key: threadKey, session_uuid: randomUUID(), guild_id: guildId, channel_id: channelId, model, now: Date.now() });
    row = q.thread.get(threadKey);
  }
  return row;
}

function sessionFileExists(uuid) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  try { return fs.readdirSync(root).some((d) => fs.existsSync(path.join(root, d, uuid + '.jsonl'))); }
  catch { return false; }
}

function pidAlive(pid, uuid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(uuid); } catch { return false; }
}

function logStream(threadKey) {
  return fs.createWriteStream(path.join(LOG_DIR, `${threadKey}.jsonl`), { flags: 'a' });
}

function start(row) {
  const resume = sessionFileExists(row.session_uuid);
  const bin = /^gpt-|astra/.test(row.model) ? CCR_BIN : CLAUDE_BIN;
  const thread = spawnThread(row.session_uuid, { model: row.model, cwd: workspaceFor(row.guild_id), bin, resume });
  const log = logStream(row.thread_key);
  const key = row.thread_key;
  thread.on('spawn', ({ pid, command }) => {
    q.setPid.run(pid, key);
    log.write(JSON.stringify({ at: new Date().toISOString(), spawn: { pid, resume, command } }) + '\n');
    console.log(`[${key}] spawned pid=${pid} resume=${resume} model=${row.model}`);
  });
  thread.on('event', (e) => {
    log.write(JSON.stringify({ at: new Date().toISOString(), event: e }) + '\n');
    if (e.type === 'assistant' || e.type === 'result') q.touch.run(Date.now(), key);
    if (e.type === 'result') turn.set(key, { busy: false, deliveries: 0 });
  });
  thread.on('stderr', (chunk) => log.write(JSON.stringify({ at: new Date().toISOString(), stderr: chunk.toString() }) + '\n'));
  thread.on('error', (err) => { if (!err.event) console.error(`[${key}] driver error:`, err.message); });
  thread.on('result', (e) => {
    if (!e.is_error || e.terminal_reason === 'aborted_tools') return; // aborted_tools = our own interrupt
    const why = (e.result || e.errors?.join('; ') || e.subtype || 'unknown').split('\n').slice(0, 3).join(' ');
    notify(key, `⚠️ agent error (${e.terminal_reason || e.subtype}): ${why.slice(0, 400)}`).catch((x) => console.error('notify:', x.message));
  });
  thread.on('exit', ({ code, signal, expected }) => {
    live.delete(key);
    turn.delete(key);
    q.setPid.run(null, key);
    log.write(JSON.stringify({ at: new Date().toISOString(), exit: { code, signal, expected } }) + '\n');
    log.end();
    console.log(`[${key}] exited code=${code} signal=${signal} expected=${expected}`);
    if (!expected) notify(key, `⚠️ agent process exited unexpectedly (code ${code ?? signal}). Your next message resumes the conversation.`)
      .catch((x) => console.error('notify:', x.message));
  });
  live.set(key, thread);
  return thread;
}

// Interrupt rules: an @mention of the bot, or a second batch arriving while the
// agent is still busy with the current turn, cancels that turn before delivery.
export async function deliver(threadKey, text, { mention = false } = {}) {
  const row = q.thread.get(threadKey);
  if (!row) throw new Error(`deliver: unknown thread ${threadKey}`);
  let thread = live.get(threadKey);
  if (!thread) thread = start(row);
  const t = turn.get(threadKey) ?? { busy: false, deliveries: 0 };
  if (t.busy && (mention || t.deliveries >= 1)) {
    console.log(`[${threadKey}] interrupting current turn (${mention ? '@mention' : 'second message mid-turn'})`);
    await thread.interrupt().catch((e) => console.error(`[${threadKey}] interrupt failed:`, e.message));
    turn.set(threadKey, { busy: false, deliveries: 0 });
  }
  const cur = turn.get(threadKey) ?? { busy: false, deliveries: 0 };
  turn.set(threadKey, { busy: true, deliveries: cur.deliveries + 1 });
  q.touch.run(Date.now(), threadKey);
  if (!row.started) q.setStarted.run(threadKey);
  return thread.inject(text);
}

export function isLive(threadKey) { return live.has(threadKey); }
export function isStarted(threadKey) { return !!q.thread.get(threadKey)?.started; }

export async function interrupt(threadKey) {
  const thread = live.get(threadKey);
  if (!thread) return false;
  await thread.interrupt();
  return true;
}

export async function evict(threadKey) {
  const thread = live.get(threadKey);
  if (!thread) return;
  await thread.evict();
}

export async function evictIdle() {
  const now = Date.now();
  for (const row of q.threads.all()) {
    if (!live.has(row.thread_key)) continue;
    if (now - row.last_activity < IDLE_EVICT_MS) continue;
    console.log(`[${row.thread_key}] idle ${Math.round((now - row.last_activity) / 60000)}m — evicting`);
    await evict(row.thread_key).catch((e) => console.error(`evict ${row.thread_key}:`, e.message));
  }
}

// A restarted bot cannot re-attach to a child's stdin, so a live orphan can
// never receive input again. Stop it; the next message resumes by uuid.
export function reapOrphans() {
  for (const row of q.threads.all()) {
    if (pidAlive(row.pid, row.session_uuid)) {
      console.log(`[${row.thread_key}] orphan pid=${row.pid} from a previous bot — SIGTERM`);
      try { process.kill(row.pid, 'SIGTERM'); } catch {}
    }
    if (row.pid) q.setPid.run(null, row.thread_key);
  }
}

export async function evictAll() {
  await Promise.all([...live.keys()].map((k) => evict(k).catch((e) => console.error(`evict ${k}:`, e.message))));
}

export function pruneThread(threadKey) { q.deleteThread.run(threadKey); }
export { db };
