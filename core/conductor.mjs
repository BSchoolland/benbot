import { q, setting } from './db.mjs';
import { reportHeader, systemHeader } from './identity.mjs';
import { enqueue } from './queue.mjs';
import * as sessions from './sessions.mjs';

// The conductor is one privileged session: the only thing that speaks to humans unprompted.
// Everything non-human (job reports, eviction summaries, new-thread notices) is an input to it.

export const channelId = () => setting('conductor_channel');

let mirror = async () => {}; // (text) => shows the report in the conductor channel; set by gateway
export function onMirror(fn) { mirror = fn; }

export function ensure() {
  const ch = channelId();
  if (!ch) return null;
  return sessions.ensureThread({ threadKey: sessions.CONDUCTOR_KEY, guildId: setting('conductor_guild'), channelId: ch, model: setting('conductor_model') || 'opus' });
}

export function preface() {
  return `[session start · you are the conductor · your channel is ${channelId()}. Speak only with bin/discord-send <channel or thread id> …; ` +
    `bin/discord-send ${channelId()} … is your own channel, for debugging talk with Ben.]`;
}

export function deliver(header, text) {
  if (!ensure()) { console.error('conductor: no channel configured; dropping:', text.slice(0, 120)); return; }
  const item = { text: `${header}\n${text}` };
  if (!sessions.isStarted(sessions.CONDUCTOR_KEY)) item.preface = preface();
  enqueue(sessions.CONDUCTOR_KEY, item);
}

export function notice(source, text) { deliver(systemHeader(source), text); }

export function drainInbox() {
  for (const row of q.inboxPending.all()) {
    deliver(reportHeader(row.source), row.text);
    q.inboxDelivered.run(Date.now(), row.id);
    mirror(`📥 **${row.source}**\n${row.text}`).catch((e) => console.error('conductor mirror:', e.message));
  }
}
