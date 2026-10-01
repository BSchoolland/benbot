import fs from 'node:fs';
import { q } from './db.mjs';
import { systemHeader } from './identity.mjs';
import { enqueue } from './queue.mjs';

// One-shot watchers registered by scripts/discord-wake. Firing is an ordinary input to the thread's
// session, so a sleeping session resumes and a live one sees the line mid-conversation.
const POLL_MS = 3000;

function pidAlive(pid, startTicks) {
  try {
    process.kill(pid, 0);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]) === startTicks;
  } catch { return false; }
}

function reason(w) {
  if (w.file && fs.existsSync(w.file)) return `${w.file} appeared`;
  if (w.pid && !pidAlive(w.pid, w.pid_start)) return `pid ${w.pid} exited`;
  return null;
}

export function startWakes() {
  setInterval(() => {
    for (const w of q.wakes.all()) {
      const why = reason(w);
      if (!why) continue;
      q.deleteWake.run(w.id);
      if (!q.thread.get(w.thread_key)) { console.error(`wake ${w.id}: thread ${w.thread_key} unknown, dropped (${why})`); continue; }
      enqueue(w.thread_key, { text: `${systemHeader('wake')}\n[wake] ${why}${w.text ? ' — ' + w.text : ''}` });
      console.log(`[${w.thread_key}] wake ${w.id}: ${why}`);
    }
  }, POLL_MS).unref();
}
