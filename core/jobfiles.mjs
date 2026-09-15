import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

// Job definitions live in git: jobs/<name>.md with a small frontmatter and the prompt as the body.
export const JOBS_DIR = path.join(ROOT, 'jobs');

export function loadJob(name) {
  const file = path.join(JOBS_DIR, `${name}.md`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing frontmatter`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*?)\s*$/);
    if (kv) meta[kv[1]] = kv[2];
  }
  for (const k of ['cron', 'model']) if (!meta[k]) throw new Error(`${file}: frontmatter needs ${k}`);
  return { name, cron: meta.cron, model: meta.model, cwd: meta.cwd || null, enabled: meta.enabled !== 'false', prompt: m[2].trim(), file };
}

export function loadJobs() {
  if (!fs.existsSync(JOBS_DIR)) return [];
  return fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith('.md')).sort().map((f) => loadJob(f.slice(0, -3)));
}
