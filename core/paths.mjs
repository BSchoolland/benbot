// Where things live. The repo is code; everything personal or machine-specific is under local/ (gitignored).
// No side effects, so scripts can import it without loading the bot's .env.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_DIR = path.join(ROOT, 'local');
export const CONFIG_DIR = path.join(LOCAL_DIR, 'config');

/** local/config/<name>, parsed as JSON. Throws if it's missing: a fresh machine has to write its own. */
export function readConfig(name) {
  const p = path.join(CONFIG_DIR, name);
  if (!fs.existsSync(p)) throw new Error(`${p} missing: this machine's config lives in local/config/ (see README)`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
