import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Claude Code session transcripts: ~/.claude/projects/<cwd slug>/<session uuid>.jsonl, one entry per line.
// Never log or post entry contents from here: a flagged transcript is exactly what we must not echo.

export const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

export function sessionFile(uuid, root = PROJECTS_ROOT) {
  for (const dir of fs.readdirSync(root)) {
    const p = path.join(root, dir, `${uuid}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Complete lines from byte `from` on: [{ offset, entry }], plus `end`, the byte after the last complete line.
// A trailing partial line is left for the next read.
export function readEntries(file, from = 0) {
  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    const size = fs.fstatSync(fd).size;
    buf = Buffer.alloc(Math.max(0, size - from));
    fs.readSync(fd, buf, 0, buf.length, from);
  } finally { fs.closeSync(fd); }
  const entries = [];
  let start = 0;
  for (let nl = buf.indexOf(10); nl !== -1; start = nl + 1, nl = buf.indexOf(10, start)) {
    const line = buf.subarray(start, nl).toString('utf8');
    if (!line.trim()) continue;
    try { entries.push({ offset: from + start, entry: JSON.parse(line) }); }
    catch { throw new Error(`${file}: invalid JSON on the line at byte ${from + start}`); }
  }
  return { entries, end: from + start };
}

const mainChain = (e) => !e.isSidechain;

export const isFallback = (e) => mainChain(e) && e.type === 'system' && e.subtype === 'model_refusal_fallback';

// A real model reply: not a refused leg, not the CLI's own <synthetic> error message.
export const isReply = (e) => mainChain(e) && e.type === 'assistant' && !!e.message?.model &&
  e.message.model !== '<synthetic>' && e.message.stop_reason !== 'refusal';

// The input that starts a turn, as opposed to a tool result fed back mid-turn.
export const isPrompt = (e) => mainChain(e) && e.type === 'user' && !e.isMeta && !e.isCompactSummary &&
  (typeof e.message?.content === 'string' || (Array.isArray(e.message?.content) && !e.message.content.some((b) => b.type === 'tool_result')));

// The last turn start strictly before byte `offset`.
export function turnStartBefore(entries, offset) {
  return entries.findLast(({ offset: o, entry }) => o < offset && isPrompt(entry)) ?? null;
}

// claude-opus-4-8 → Opus 4.8; anything else is returned as is.
export const modelName = (id) => id.replace(/^claude-([a-z]+)-(\d+)-(\d+).*$/, (_, f, a, b) => `${f[0].toUpperCase()}${f.slice(1)} ${a}.${b}`);

const bare = (m) => m.replace(/\[1m\]$/, '');

// `wanted` is an exact model id seen before the incident, or the thread's configured model (alias or id).
export function modelMatches(actual, wanted) {
  const a = bare(actual), w = bare(wanted);
  return w.startsWith('claude-') || w.startsWith('gpt-') ? a.startsWith(w) : a.startsWith(`claude-${w}-`);
}

// Copies the transcript to backupDir, then cuts it at byte `offset` (a line start), dropping that line and everything after.
// The caller guarantees no process is writing the file.
export function rewind(file, offset, backupDir, label) {
  const { entries } = readEntries(file);
  if (!entries.some((x) => x.offset === offset)) throw new Error(`rewind: byte ${offset} is not a line start in ${file}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `${path.basename(file, '.jsonl')}.${new Date().toISOString().replace(/[:.]/g, '-')}.${label}.jsonl`);
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  fs.truncateSync(file, offset);
  const after = readEntries(file);
  if (after.end !== offset || after.entries.length !== entries.findIndex((x) => x.offset === offset)) {
    throw new Error(`rewind: ${file} is not the expected ${offset}-byte prefix after truncation (backup at ${backup})`);
  }
  return backup;
}
