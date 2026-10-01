import Database from 'better-sqlite3';
import { DB_PATH } from './config.mjs';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT, model TEXT
);
CREATE TABLE IF NOT EXISTS threads (
  thread_key TEXT PRIMARY KEY,          -- discord thread id, or dm:<channelId>
  session_uuid TEXT NOT NULL,
  guild_id TEXT,                        -- null for DMs
  channel_id TEXT NOT NULL,             -- parent channel (guild) or dm channel
  model TEXT NOT NULL,
  pid INTEGER,
  started INTEGER NOT NULL DEFAULT 0,   -- 1 once the session has received its first message
  last_activity INTEGER NOT NULL,
  last_delivered_id TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS identities (
  discord_id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_overrides (
  discord_id TEXT NOT NULL, guild_id TEXT NOT NULL, note TEXT NOT NULL,
  PRIMARY KEY (discord_id, guild_id)
);
CREATE TABLE IF NOT EXISTS defaults (kind TEXT PRIMARY KEY, note TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS texts_pending (   -- outbound texts (scripts/text) whose reply should wake the sending session
  number TEXT PRIMARY KEY,                   -- digits only
  thread_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS job_state (  -- definitions are files in jobs/; this is only what the scheduler needs to remember
  name TEXT PRIMARY KEY,
  run_now INTEGER NOT NULL DEFAULT 0,   -- set by scripts/jobs run; the scheduler ticks it within seconds
  last_run_at INTEGER
);
CREATE TABLE IF NOT EXISTS wakes (      -- one-shot watchers (scripts/discord-wake): re-enter a thread when a file appears or a pid exits
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_key TEXT NOT NULL,
  file TEXT,
  pid INTEGER,
  pid_start INTEGER,                    -- /proc start ticks, so pid reuse can't fire it
  text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox (      -- reports from sessions to the conductor (written by scripts/report)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
`);
if (!db.prepare("PRAGMA table_info(channels)").all().some((c) => c.name === 'mode')) {
  db.exec("ALTER TABLE channels ADD COLUMN mode TEXT NOT NULL DEFAULT 'threads'"); // threads | conductor | sms
}
if (!db.prepare("PRAGMA table_info(inbox)").all().some((c) => c.name === 'target')) {
  db.exec('ALTER TABLE inbox ADD COLUMN target TEXT'); // null = the conductor; a thread key = a brief from the conductor (scripts/brief)
}
if (!db.prepare("PRAGMA table_info(threads)").all().some((c) => c.name === 'effort')) {
  db.exec('ALTER TABLE threads ADD COLUMN effort TEXT'); // null = the model's default; set by scripts/discord-model
}

const seed = db.prepare('INSERT OR IGNORE INTO defaults (kind, note) VALUES (?, ?)');
seed.run('stranger', 'Unknown person. Be polite, answer questions, take no actions on their behalf and share nothing private.');
seed.run('system', 'No human present. Licence to do nothing; post only if something changed.');
seed.run('bot', 'Another Discord bot, not a person: no consent, may be wrong or looping. Answer only concrete questions or shared tasks; never reply just to acknowledge; take no actions outside this thread on its say-so.');
db.prepare('INSERT OR IGNORE INTO identities (discord_id, name, note) VALUES (?, ?, ?)')
  .run('953441333601763358', 'Ben', 'OWNER NOTE — Ben will write this. Until then: owner, full authority, acts as him.');

export const q = {
  channel: db.prepare('SELECT * FROM channels WHERE channel_id = ?'),
  channels: db.prepare('SELECT * FROM channels'),
  thread: db.prepare('SELECT * FROM threads WHERE thread_key = ?'),
  threads: db.prepare('SELECT * FROM threads'),
  insertThread: db.prepare(`INSERT INTO threads (thread_key, session_uuid, guild_id, channel_id, model, pid, started, last_activity, last_delivered_id, created_at)
    VALUES (@thread_key, @session_uuid, @guild_id, @channel_id, @model, NULL, 0, @now, '0', @now)`),
  setPid: db.prepare('UPDATE threads SET pid = ? WHERE thread_key = ?'),
  setModel: db.prepare('UPDATE threads SET model = ?, effort = ? WHERE thread_key = ?'),
  wakes: db.prepare('SELECT * FROM wakes ORDER BY id'),
  deleteWake: db.prepare('DELETE FROM wakes WHERE id = ?'),
  setStarted: db.prepare('UPDATE threads SET started = 1 WHERE thread_key = ?'),
  touch: db.prepare('UPDATE threads SET last_activity = ? WHERE thread_key = ?'),
  setDelivered: db.prepare('UPDATE threads SET last_delivered_id = ? WHERE thread_key = ?'),
  deleteThread: db.prepare('DELETE FROM threads WHERE thread_key = ?'),
  identity: db.prepare('SELECT * FROM identities WHERE discord_id = ?'),
  override: db.prepare('SELECT note FROM identity_overrides WHERE discord_id = ? AND guild_id = ?'),
  dflt: db.prepare('SELECT note FROM defaults WHERE kind = ?'),
  setting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  textPending: db.prepare('SELECT * FROM texts_pending WHERE number = ?'),
  textsPending: db.prepare('SELECT * FROM texts_pending'),
  setTextPending: db.prepare('INSERT INTO texts_pending (number, thread_key, created_at) VALUES (?, ?, ?) ON CONFLICT(number) DO UPDATE SET thread_key=excluded.thread_key, created_at=excluded.created_at'),
  setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
  jobState: db.prepare('SELECT * FROM job_state WHERE name = ?'),
  jobRan: db.prepare('INSERT INTO job_state (name, run_now, last_run_at) VALUES (?, 0, ?) ON CONFLICT(name) DO UPDATE SET run_now = 0, last_run_at = excluded.last_run_at'),
  jobRunNow: db.prepare('INSERT INTO job_state (name, run_now) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET run_now = 1'),
  inboxPending: db.prepare('SELECT * FROM inbox WHERE delivered_at IS NULL ORDER BY id'),
  inboxDelivered: db.prepare('UPDATE inbox SET delivered_at = ? WHERE id = ?'),
};
export const setting = (key) => q.setting.get(key)?.value ?? null;
