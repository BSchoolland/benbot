import { Client, GatewayIntentBits, Partials, Events, ChannelType } from 'discord.js';
import { TOKEN, DEFAULT_MODEL, OWNER_IDS, OPENAI_API_KEY, VOICE_CHANNEL_ID, VOICE_MODEL, VOICE_EFFORT } from './config.mjs';
import { createVoice } from './voice.mjs';
import { q } from './db.mjs';
import { header, systemHeader } from './identity.mjs';
import { enqueue } from './queue.mjs';
import * as sessions from './sessions.mjs';
import * as conductor from './conductor.mjs';
import * as secrets from './secrets.mjs';

export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel],
});

const dmKey = (channelId) => `dm:${channelId}`;
const discordIdOf = (threadKey) => threadKey.startsWith('dm:') ? threadKey.slice(3)
  : sessions.isChat(threadKey) ? threadKey : conductor.channelId();

async function post(threadKey, text, { editId } = {}) {
  const ch = await client.channels.fetch(discordIdOf(threadKey));
  const body = sessions.isChat(threadKey) ? text : `[${threadKey}] ${text}`;
  return (editId ? await ch.messages.edit(editId, body) : await ch.send(body)).id;
}
sessions.onNotify(post);
conductor.onMirror((text) => post(sessions.CONDUCTOR_KEY, text));

function lineFor(msg) {
  const attachments = [...msg.attachments.values()].map((a) => `[attachment] ${a.url}`);
  const author = (msg.member?.displayName || msg.author.globalName || msg.author.username) + (msg.author.bot ? ' [bot]' : '');
  return `${author} (msg ${msg.id}): ${[msg.content, ...attachments].filter(Boolean).join('\n')}`;
}

function preface(threadKey, where, { voice = false } = {}) {
  const id = discordIdOf(threadKey);
  return `[session start · ${where} · thread id ${id}. Speak only with discord-send ${id} … — nothing else reaches anyone. React with discord-react ${id} <msg id> <emoji>. ` +
    'The conductor is your continuous self across conversations: conductor-read shows what it has been up to; report tells it something worth remembering.' +
    (voice ? ' This thread is bound to a voice call: lines marked (voice, msg …) are transcripts and everything you send with discord-send is read aloud. Follow the Voice section of CLAUDE.md.' : '') + ']';
}

function whereOf(msg, isDM, threadName) {
  return isDM ? `a DM with ${msg.author.globalName || msg.author.username}`
    : `thread "${threadName}" under #${msg.channel.isThread() ? msg.channel.parent?.name : msg.channel.name} in ${msg.guild.name}`;
}

// Routing: DMs from known people; known people's messages in watched channels open a thread;
// anyone in a tracked thread or a thread under a watched channel; anyone, anywhere, by @mention
// (a channel @mention opens a thread on that message, a thread @mention adopts the thread).
async function onMessage(msg) {
  if (msg.author.id === client.user.id) return; // other bots are senders like anyone else; only our own posts are ignored
  const isDM = msg.channel.type === ChannelType.DM;
  const mentioned = !isDM && msg.mentions.users.has(client.user.id);
  let threadKey, guildId, channelId, model, threadName;

  if (isDM) {
    if (!q.identity.get(msg.author.id)) return; // unknown people can't open DM sessions (cost + safety); add them to identities
    threadKey = dmKey(msg.channelId); guildId = null; channelId = msg.channelId; model = DEFAULT_MODEL;
  } else if (q.channel.get(msg.channelId)?.mode === 'sms') {
    // Ben's forwarded texts ("From <sender>: <body>"). A reply to a text a session sent (scripts/text) wakes that
    // session; everything else just sits here for sms.
    const m = (msg.content || '').match(/^From\s+(.+?):\s*([\s\S]*)$/);
    const digits = m ? m[1].replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '') : '';
    const pending = digits ? q.textPending.get(digits) : null;
    if (pending && q.thread.get(pending.thread_key)) {
      enqueue(pending.thread_key, { text: `${systemHeader('sms reply')}\nReply from ${m[1].trim()}: ${m[2].trim().slice(0, 1500)}` });
    }
    return;
  } else if (q.channel.get(msg.channelId)?.mode === 'conductor') {
    // the conductor's own channel: known people talk to it directly, no thread
    if (!q.identity.get(msg.author.id) || !conductor.ensure()) return;
    threadKey = sessions.CONDUCTOR_KEY; guildId = msg.guildId; channelId = msg.channelId; model = conductor.ensure().model;
  } else if (msg.channel.isThread()) {
    const parent = q.channel.get(msg.channel.parentId);
    if (parent?.mode !== 'threads' && !mentioned && !q.thread.get(msg.channelId)) return;
    threadKey = msg.channelId; guildId = msg.guildId; channelId = msg.channel.parentId; model = parent?.model || DEFAULT_MODEL;
    threadName = msg.channel.name;
  } else {
    const channel = q.channel.get(msg.channelId);
    if (!mentioned && !(channel?.mode === 'threads' && q.identity.get(msg.author.id))) return;
    let thread = msg.hasThread ? msg.thread : null;
    if (!thread) {
      const name = (msg.content || '').replace(/<[@#][!&]?\d+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'chat';
      thread = await msg.startThread({ name });
    }
    threadKey = thread.id; guildId = msg.guildId; channelId = msg.channelId; model = channel?.model || DEFAULT_MODEL;
    threadName = thread.name;
  }

  sessions.ensureThread({ threadKey, guildId, channelId, model });
  const h = header({ discordId: msg.author.id, displayName: msg.author.globalName || msg.author.username, isBot: msg.author.bot, guildId,
    guildName: msg.guild?.name, channelName: isDM ? null : (msg.channel.parent?.name || msg.channel.name), isDM });
  const item = { text: `${h.line}\n${lineFor(msg)}`, msgId: msg.id, mention: mentioned };
  if (!sessions.isStarted(threadKey)) {
    item.preface = threadKey === sessions.CONDUCTOR_KEY ? conductor.preface() : preface(threadKey, whereOf(msg, isDM, threadName), { voice: !!voice.sessionFor(threadKey) });
    if (sessions.isChat(threadKey)) {
      conductor.notice('gateway', `${h.line.split(']')[0]}] opened a conversation: ${isDM ? 'DM' : `thread "${threadName}" in ${msg.guild.name}`} (id ${discordIdOf(threadKey)}). ` +
        `First message: ${(msg.content || '').slice(0, 300)}`);
    }
  }
  enqueue(threadKey, item);
}

// Voice: an owner joining a voice channel opens a thread under the guild's watched channel; each utterance is
// posted there as text and delivered like a typed message, stamped with the speaker's identity.
const voiceMeta = new Map(); // threadId -> { guildId, guildName, channelName, threadName }
const voice = createVoice({
  client, apiKey: OPENAI_API_KEY, ownerIds: OWNER_IDS, onlyChannelId: VOICE_CHANNEL_ID, log: (line) => console.log(line),
  openThread: async (member, guild) => {
    const watched = q.channels.all().find((c) => c.guild_id === guild.id && c.mode === 'threads');
    if (!watched) throw new Error(`voice: no watched channel in ${guild.name} to open the thread under`);
    const main = await client.channels.fetch(watched.channel_id);
    const anchor = await main.send(`🎙 Voice session with ${member.displayName}`);
    const thread = await anchor.startThread({
      name: `🎙 ${member.displayName} · ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })}`,
      type: ChannelType.PublicThread,
    });
    sessions.ensureThread({ threadKey: thread.id, guildId: guild.id, channelId: watched.channel_id, model: VOICE_MODEL || watched.model || DEFAULT_MODEL });
    if (VOICE_MODEL || VOICE_EFFORT) q.setModel.run(VOICE_MODEL || watched.model || DEFAULT_MODEL, VOICE_EFFORT || null, thread.id);
    voiceMeta.set(thread.id, { guildId: guild.id, guildName: guild.name, channelName: main.name, threadName: thread.name });
    return thread;
  },
  onTranscript: async (threadId, userId, displayName, text) => {
    const thread = await client.channels.fetch(threadId);
    const posted = await thread.send(`🎙 **${displayName}:** ${text}`);
    const m = voiceMeta.get(threadId);
    const h = header({ discordId: userId, displayName, isBot: false, guildId: m.guildId, guildName: m.guildName, channelName: m.channelName, isDM: false });
    const item = { text: `${h.line}\n${displayName} (voice, msg ${posted.id}): ${text}`, msgId: posted.id };
    if (!sessions.isStarted(threadId)) {
      item.preface = preface(threadId, `voice-call thread "${m.threadName}" under #${m.channelName} in ${m.guildName}`, { voice: true });
      conductor.notice('gateway', `[from: ${displayName}] opened a voice call: thread "${m.threadName}" in ${m.guildName} (id ${threadId}). First words: ${text.slice(0, 300)}`);
    }
    enqueue(threadId, item);
  },
  onEnd: async (threadId, why) => {
    voiceMeta.delete(threadId);
    if (sessions.isStarted(threadId)) enqueue(threadId, { text: `${systemHeader('voice')}\nVoice session ended (${why}). Nothing is spoken any more; the thread continues as text.` });
  },
});

// Deliver messages that arrived while the bot was down.
async function bootSweep() {
  for (const row of q.threads.all()) {
    if (sessions.isJob(row.thread_key)) continue;
    const ch = await client.channels.fetch(discordIdOf(row.thread_key)).catch(() => null);
    if (!ch) { sessions.pruneThread(row.thread_key); continue; }
    if (ch.archived) continue;
    const recent = await ch.messages.fetch({ limit: 10 }).catch(() => null);
    if (!recent) continue;
    const missed = [...recent.values()].filter((m) => m.author.id !== client.user.id && BigInt(m.id) > BigInt(row.last_delivered_id || '0'))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    for (const m of missed) await onMessage(m).catch((e) => console.error('sweep onMessage:', e.message));
    if (missed.length) console.log(`boot sweep: ${missed.length} missed in ${row.thread_key}`);
  }
}

export async function startGateway() {
  client.on(Events.MessageCreate, (m) => onMessage(m).catch((e) => console.error('onMessage:', e)));
  client.on(Events.InteractionCreate, (i) => secrets.handleInteraction(i).catch((e) => console.error('interaction:', e)));
  if (OPENAI_API_KEY) client.on(Events.VoiceStateUpdate, (o, n) => voice.onVoiceStateUpdate(o, n).catch((e) => console.error('voice:', e)));
  client.once(Events.ClientReady, async () => {
    console.log(`BenBot online as ${client.user.tag}; watching ${q.channels.all().length} channel(s), ${client.guilds.cache.size} server(s)${OPENAI_API_KEY ? '' : '; voice off (no OPENAI_API_KEY)'}`);
    await bootSweep().catch((e) => console.error('bootSweep:', e));
    if (OPENAI_API_KEY) await voice.sweep().catch((e) => console.error('voice sweep:', e.message));
  });
  await client.login(TOKEN);
}
