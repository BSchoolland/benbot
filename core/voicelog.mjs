// Wide events for voice calls: one structured record per unit of work (a call, an utterance), built up
// over its life and written whole to state/voice-events.jsonl. Open events are rewritten every 30 s while
// they change, so a crash still leaves them on disk; readers keep the newest snapshot per id
// (scripts/voice-events). `trace` is the call's thread id, so one trace pulls up the whole call.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';

export const EVENTS_FILE = path.join(STATE_DIR, 'voice-events.jsonl');
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ISSUES = 40;
const RANK = { info: 0, warn: 1, error: 2 };

const open = new Set();
setInterval(flushOpen, 30_000).unref();

function append(record) {
  fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
  if (fs.existsSync(EVENTS_FILE) && fs.statSync(EVENTS_FILE).size > MAX_BYTES) fs.renameSync(EVENTS_FILE, EVENTS_FILE + '.1');
  fs.appendFileSync(EVENTS_FILE, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
}

export class WideEvent {
  level = 'info';
  issues = [];
  business = {};
  seq = 0;
  final = false;
  written = '';

  constructor(kind, trace, parent = null) {
    this.id = crypto.randomBytes(8).toString('hex');
    this.kind = kind;
    this.trace = trace;
    this.parent = parent;
    this.t0 = Date.now();
  }

  set(key, value) {
    this.business[key] = value;
    return this;
  }

  // Adds to a numeric counter in business.
  count(key, n = 1) {
    this.business[key] = (this.business[key] ?? 0) + n;
    return this;
  }

  // A problem worth reading: escalates the level; the same code and message again only bumps its count.
  issue(level, code, message, detail) {
    if (RANK[level] > RANK[this.level]) this.level = level;
    const same = this.issues.find((i) => i.code === code && i.message === message);
    if (same) { same.n++; return this; }
    if (this.issues.length >= MAX_ISSUES) return this.count('issuesDropped');
    this.issues.push({ level, code, message: String(message).slice(0, 300), ...(detail ? { detail: String(detail).slice(0, 800) } : {}), at: Date.now(), n: 1 });
    return this;
  }

  headline() {
    const first = this.issues.find((i) => i.level === 'error') ?? this.issues[0];
    return first ? `${first.code}: ${first.message}` : null;
  }

  write() {
    this.seq++;
    const record = {
      id: this.id, kind: this.kind, trace: this.trace, parent: this.parent, level: this.level, headline: this.headline(),
      t0: this.t0, t1: Date.now(), seq: this.seq, final: this.final, pid: process.pid, issues: this.issues, business: this.business,
    };
    this.written = JSON.stringify([this.level, this.issues, this.business]);
    append(record);
  }
}

// A unit of work that outlives one step: rewritten while it changes, until `finish`.
export function openEvent(kind, trace, parent = null) {
  const e = new WideEvent(kind, trace, parent);
  open.add(e);
  e.write();
  return e;
}

export function finish(e) {
  if (e.final) {
    e.issue('error', 'impossible', 'finished twice');
    console.error(`voice event ${e.kind} ${e.trace} finished twice`);
  }
  e.final = true;
  open.delete(e);
  e.write();
}

function flushOpen() {
  for (const e of open) {
    if (e.written !== JSON.stringify([e.level, e.issues, e.business])) e.write();
  }
}

// Everything still open ends with the process (index.mjs owns the actual shutdown).
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const e of [...open]) { e.business.exit ??= signal; finish(e); }
  });
}
process.on('uncaughtExceptionMonitor', (err, origin) => {
  for (const e of [...open]) { e.issue('error', origin, err.message, err.stack); e.business.exit ??= 'crash'; finish(e); }
});
