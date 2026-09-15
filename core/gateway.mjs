import { Client, GatewayIntentBits, Partials, Events, ChannelType } from 'discord.js';
import { TOKEN, DEFAULT_MODEL } from './config.mjs';
import { q } from './db.mjs';
import { header } from './identity.mjs';
import { enqueue } from './queue.mjs';
import * as sessions from './sessions.mjs';

export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

const dmKey = (channelId) => `dm:${channelId}`;
const discordIdOf = (threadKey) => threadKey.startsWith('dm:') ? threadKey.slice(3) : threadKey;

sessions.onNotify(async (threadKey, text) => {
  const ch = await client.channels.fetch(discordIdOf(threadKey));
  await ch.send(text);
});

function lineFor(msg) {
  const attachments = [...msg.attachments.values()].map((a) => `[attachment] ${a.url}`);
  const author = msg.member?.displayName || msg.author.globalName || msg.author.username;
  return `${author} (msg ${msg.id}): ${[msg.content, ...attachments].filter(Boolean).join('\n')}`;
}

function preface(threadKey, msg, isDM) {
  const id = discordIdOf(threadKey);
  const where = isDM ? `a DM with ${msg.author.globalName || msg.author.username}`
    : `thread "${msg.channel.name}" under #${msg.channel.parent?.name} in ${msg.guild.name}`;
  return `[session start · ${where} · thread id ${id}. Speak only with bin/discord-send ${id} … — nothing else reaches anyone. React with bin/discord-react ${id} <msg id> <emoji>.]`;
}

async function onMessage(msg) {
  if (msg.author.bot) return;
  const isDM = msg.channel.type === ChannelType.DM;
  let threadKey, guildId, channelId, model;

  if (isDM) {
    if (!q.identity.get(msg.author.id)) return; // unknown people can't open DM sessions (cost + safety); add them to identities
    threadKey = dmKey(msg.channelId); guildId = null; channelId = msg.channelId; model = DEFAULT_MODEL;
  } else if (q.channel.get(msg.channelId)) {
    // watched channel: known identities open a thread on their message
    if (!q.identity.get(msg.author.id)) return;
    const watched = q.channel.get(msg.channelId);
    let thread = msg.hasThread ? msg.thread : null;
    if (!thread) {
      const name = (msg.content || '').replace(/<[@#][!&]?\d+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'chat';
      thread = await msg.startThread({ name });
    }
    threadKey = thread.id; guildId = msg.guildId; channelId = msg.channelId; model = watched.model || DEFAULT_MODEL;
  } else if (msg.channel.isThread?.() && q.channel.get(msg.channel.parentId)) {
    // inside a thread under a watched channel: anyone in the server may talk; identity header says what they may ask
    const watched = q.channel.get(msg.channel.parentId);
    threadKey = msg.channelId; guildId = msg.guildId; channelId = msg.channel.parentId; model = watched.model || DEFAULT_MODEL;
  } else return;

  sessions.ensureThread({ threadKey, guildId, channelId, model });
  const h = header({ discordId: msg.author.id, displayName: msg.author.globalName || msg.author.username, guildId,
    guildName: msg.guild?.name, channelName: isDM ? null : (msg.channel.parent?.name || msg.channel.name), isDM });
  const item = { text: `${h.line}\n${lineFor(msg)}`, msgId: msg.id, mention: msg.mentions.has(client.user) };
  if (!sessions.isStarted(threadKey)) item.preface = preface(threadKey, msg, isDM);
  enqueue(threadKey, item);
}

// Deliver messages that arrived while the bot was down.
async function bootSweep() {
  for (const row of q.threads.all()) {
    const ch = await client.channels.fetch(discordIdOf(row.thread_key)).catch(() => null);
    if (!ch) { sessions.pruneThread(row.thread_key); continue; }
    if (ch.archived) continue;
    const recent = await ch.messages.fetch({ limit: 10 }).catch(() => null);
    if (!recent) continue;
    const missed = [...recent.values()].filter((m) => !m.author.bot && BigInt(m.id) > BigInt(row.last_delivered_id || '0'))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    for (const m of missed) await onMessage(m).catch((e) => console.error('sweep onMessage:', e.message));
    if (missed.length) console.log(`boot sweep: ${missed.length} missed in ${row.thread_key}`);
  }
}

export async function startGateway() {
  client.on(Events.MessageCreate, (m) => onMessage(m).catch((e) => console.error('onMessage:', e)));
  client.once(Events.ClientReady, async () => {
    console.log(`BenBot online as ${client.user.tag}; watching ${q.channels.all().length} channel(s), ${client.guilds.cache.size} server(s)`);
    await bootSweep().catch((e) => console.error('bootSweep:', e));
  });
  await client.login(TOKEN);
}
