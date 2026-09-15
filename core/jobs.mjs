import { q } from './db.mjs';
import { systemHeader } from './identity.mjs';
import { enqueue } from './queue.mjs';
import * as sessions from './sessions.mjs';

// A job is a scheduled input to its own long-lived thread (job:<name>), never a fresh process.
// Job sessions have no voice to humans; they report to the conductor with bin/report.

function fieldMatches(field, value, min) {
  return field.split(',').some((part) => {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let lo, hi;
    if (range === '*') { lo = min; hi = Infinity; }
    else if (range.includes('-')) { [lo, hi] = range.split('-').map(Number); }
    else { lo = hi = Number(range); if (stepStr) hi = Infinity; }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

export function cronMatches(expr, date) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`bad cron expression: ${expr}`);
  const dow = date.getDay();
  return fieldMatches(f[0], date.getMinutes(), 0) && fieldMatches(f[1], date.getHours(), 0)
    && fieldMatches(f[2], date.getDate(), 1) && fieldMatches(f[3], date.getMonth() + 1, 1)
    && (fieldMatches(f[4], dow, 0) || (dow === 0 && fieldMatches(f[4], 7, 0)));
}

export function tick(job) {
  const threadKey = `job:${job.name}`;
  sessions.ensureThread({ threadKey, guildId: null, channelId: 'job', model: job.model });
  const item = { text: `${systemHeader(`job ${job.name} · scheduled tick`)}\n${job.prompt}` };
  if (!sessions.isStarted(threadKey)) {
    item.preface = `[session start · you are BenBot's job "${job.name}" · nothing you write reaches a person. ` +
      'Report what matters with bin/report "<text>" (it goes to the conductor, who decides what Ben sees). Nothing changed = no report.]';
  }
  q.jobRan.run(Date.now(), job.name);
  enqueue(threadKey, item);
  console.log(`[${threadKey}] tick`);
}

export function startScheduler() {
  const check = () => {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60_000);
    for (const job of q.jobs.all()) {
      if (job.run_now) { tick(job); continue; }
      if (!job.enabled) continue;
      if (job.last_run_at && Math.floor(job.last_run_at / 60_000) === minute) continue;
      let due;
      try { due = cronMatches(job.cron, now); } catch (e) { console.error(`job ${job.name}:`, e.message); continue; }
      if (due) tick(job);
    }
  };
  setInterval(check, 5_000).unref();
}
