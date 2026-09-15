import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_DIR = path.join(ROOT, 'state');
export const LOG_DIR = path.join(STATE_DIR, 'logs');
export const WORKSPACES = path.join(ROOT, 'workspaces');
export const DB_PATH = path.join(STATE_DIR, 'state.db');

function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) throw new Error(`${p} missing — needs DISCORD_TOKEN=...`);
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}
const env = loadEnv();
if (!env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN missing from .env');

export const TOKEN = env.DISCORD_TOKEN;
export const OWNER_IDS = (env.OWNER_IDS || '953441333601763358').split(',').map((s) => s.trim()).filter(Boolean);
export const DEFAULT_MODEL = env.AGENT_MODEL || 'fable';
export const CLAUDE_BIN = env.CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');
export const CCR_BIN = env.CCR_BIN || path.join(os.homedir(), 'Projects', 'claude-router', 'bin', 'ccr');
export const DEBOUNCE_MS = Number(env.DEBOUNCE_MS || 1500);
export const IDLE_EVICT_MS = Number(env.IDLE_EVICT_MS || 50 * 60 * 1000);

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(WORKSPACES, { recursive: true });
