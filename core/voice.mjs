// Voice mode. An owner joins a voice channel -> the bot joins too, opens a
// voice-bound thread, transcribes each utterance into that thread as text (so it
// flows through the normal thread->session path), and plays back whatever audio
// lands in state/voice/<threadId>/. Synthesis, voices and effects all live in
// scripts/voice_tts.py (driven by scripts/discord-send), so none of that needs
// a bot restart. The session never touches audio; it is told the thread is on a call.

import {
  AudioPlayerStatus,
  EndBehaviorType,
  NetworkingStatusCode,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import prism from 'prism-media';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE_DIR } from './config.mjs';



const VOICE_STATE = path.join(STATE_DIR, 'voice');
const SEND_HELPER = path.join(ROOT, 'scripts', 'discord-send');

const SILENCE_END_MS = 1200; // utterance ends after this much silence
const MIN_UTTERANCE_S = 0.6; // shorter than this is a cough or road noise
const BARGE_IN_MS = 1000; // owner talks this long (real audio, not wall clock) while we're speaking -> we stop once STT confirms it
const BARGE_IN_BYTES = (BARGE_IN_MS / 1000) * 48000 * 2 * 2;
const READY_TIMEOUT_MS = 8000;
const READY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;
const STT_MODEL = 'gpt-4o-transcribe';
const CHIME = chimePcm(); // "heard you" ack: two rising notes, replaces a spoken "on it"
// Transcripts the STT model emits for pure noise/silence. No `prompt` is sent:
// gpt-4o-transcribe returns the prompt verbatim for unclear audio.
const STT_NOISE = new Set(['you', 'thank you', 'thanks for watching', 'bye', '.', '']);
// Mean token logprob below this is the model guessing at road noise ("Oké", "Allora",
// "ogólnych"); clear speech scores around -0.05 to -0.3. Every transcript logs its score.
const STT_MIN_LOGPROB = -0.6;

export function createVoice({ client, apiKey, ownerIds, onlyChannelId, openThread, onTranscript, onEnd, log }) {
  const sessions = new Map(); // guildId -> session
  const byThread = new Map(); // threadId -> session

  function sessionFor(threadId) {
    return byThread.get(threadId) || null;
  }

  async function onVoiceStateUpdate(oldState, newState) {
    const userId = newState.id;
    if (!ownerIds.includes(userId)) return;
    if (oldState.channelId === newState.channelId) return; // mute/deafen toggles
    const guild = newState.guild;
    const live = sessions.get(guild.id);

    if (newState.channelId && (!onlyChannelId || newState.channelId === onlyChannelId)) {
      if (live && live.voiceChannelId === newState.channelId) return;
      if (live) await end(live, 'moved channels');
      await start(newState.channel, newState.member);
      return;
    }
    if (live && oldState.channelId === live.voiceChannelId && !ownersIn(live)) {
      await end(live, `${newState.member.displayName} left`);
    }
  }

  // Bot restarts must not need the owner to leave and rejoin the call.
  async function sweep() {
    for (const guild of client.guilds.cache.values()) {
      if (sessions.has(guild.id)) continue;
      for (const ch of guild.channels.cache.values()) {
        if (!ch.isVoiceBased?.()) continue;
        if (onlyChannelId && ch.id !== onlyChannelId) continue;
        const owner = ch.members.find((m) => ownerIds.includes(m.id));
        if (!owner) continue;
        log(`voice: sweep found ${owner.displayName} already in #${ch.name}`);
        await start(ch, owner, "I'm back on the call after a restart.");
        break;
      }
    }
  }

  function ownersIn(session) {
    const ch = client.channels.cache.get(session.voiceChannelId);
    return ch?.members?.some((m) => ownerIds.includes(m.id)) ?? false;
  }

  async function start(channel, member, greeting = "Hey, I'm listening.") {
    const thread = await openThread(member, channel.guild);
    const session = {
      guildId: channel.guild.id,
      voiceChannelId: channel.id,
      threadId: thread.id,
      connection: null,
      player: createAudioPlayer(),
      queue: [], // { file, load } in play order; file is null for the chime
      queued: new Set(), // drop-dir files already picked up
      dropDir: path.join(VOICE_STATE, thread.id),
      watcher: null,
      capturing: new Set(),
    };
    sessions.set(session.guildId, session);
    byThread.set(thread.id, session);
    // The drop dir doubles as the "this thread is on a call" flag for discord-send.
    fs.rmSync(session.dropDir, { recursive: true, force: true });
    fs.mkdirSync(session.dropDir, { recursive: true });
    session.watcher = fs.watch(session.dropDir, () => scanDrops(session));
    log(`voice: joining #${channel.name} for ${member.displayName}, thread ${thread.id}`);

    session.player.on(AudioPlayerStatus.Idle, () => playNext(session));
    session.player.on('error', (e) => log(`voice: player error: ${e.message}`));

    try {
      session.connection = await connect(channel);
    } catch (e) {
      log(`voice: giving up: ${e.message}`);
      await end(session, 'could not connect');
      return;
    }
    const { connection } = session;
    connection.subscribe(session.player);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Discord kicked us or the channel moved; a real disconnect never
        // re-enters Signalling/Connecting.
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        await end(session, 'disconnected');
      }
    });

    connection.receiver.speaking.on('start', (userId) => {
      if (!ownerIds.includes(userId) || session.capturing.has(userId)) return;
      capture(session, userId).catch((e) => log(`voice: capture error: ${e.message}`));
    });

    await thread.send(`🎙 Voice session started in **#${channel.name}**. Everything ${member.displayName} says lands here as text; my replies are read aloud.`);
    say(thread.id, greeting);
  }

  // The UDP handshake sometimes never gets an answer (seen right after a bot
  // restart that left a stale voice session behind). Re-sending the join for
  // the same channel reuses the stuck socket, so retry from a fresh connection.
  async function connect(channel) {
    let lastError;
    for (let attempt = 1; attempt <= READY_ATTEMPTS; attempt++) {
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      connection.on('error', (e) => log(`voice: connection error: ${e.message}`));
      connection.on('stateChange', (o, n) => {
        const net = n.networking?.state;
        const where = net ? ` (net ${NetworkingStatusCode[net.code]} @ ${net.connectionOptions?.endpoint})` : '';
        log(`voice: conn ${o.status} -> ${n.status}${where}`);
      });
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
        return connection;
      } catch (e) {
        lastError = e;
        const net = connection.state.networking?.state;
        log(`voice: attempt ${attempt}/${READY_ATTEMPTS} never became Ready (net ${net ? NetworkingStatusCode[net.code] : 'none'} @ ${net?.connectionOptions?.endpoint})`);
        connection.destroy();
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    throw lastError;
  }

  async function end(session, why) {
    if (!sessions.has(session.guildId)) return;
    sessions.delete(session.guildId);
    byThread.delete(session.threadId);
    session.watcher?.close();
    session.queue.length = 0;
    try {
      session.player.stop(true);
    } catch {}
    session.connection?.destroy();
    fs.rmSync(session.dropDir, { recursive: true, force: true });
    log(`voice: session ended (${why}), thread ${session.threadId}`);
    const thread = await client.channels.fetch(session.threadId).catch(() => null);
    if (thread) await thread.send(`🎙 Voice session ended (${why}). Thread still works as text.`).catch((e) => log(`voice: end notice failed: ${e.message}`));
    await onEnd(session.threadId, why);
  }

  // ---------- listening ----------
  async function capture(session, userId) {
    session.capturing.add(userId);
    const member = await client.guilds.cache.get(session.guildId)?.members.fetch(userId).catch(() => null);
    const name = member?.displayName || 'owner';
    const opus = session.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_END_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const pcm = [];
    let bytes = 0;
    let bargedIn = false;
    const overPlayback = session.player.state.status === AudioPlayerStatus.Playing; // only then can this cut us off

    await new Promise((resolve) => {
      opus
        .pipe(decoder)
        .on('data', (c) => {
          pcm.push(c);
          bytes += c.length;
          // Sustained audio while we're speaking pauses playback; STT then decides
          // whether to cut the reply (speech) or resume it (road noise).
          if (overPlayback && !bargedIn && bytes >= BARGE_IN_BYTES && session.player.state.status === AudioPlayerStatus.Playing) {
            bargedIn = true;
            session.player.pause(true);
          }
        })
        .on('error', (e) => {
          log(`voice: decode error: ${e.message}`);
          resolve();
        })
        .on('end', resolve);
      opus.on('error', (e) => {
        log(`voice: receive error: ${e.message}`);
        resolve();
      });
    });
    session.capturing.delete(userId);
    if (session.player.state.status === AudioPlayerStatus.Idle) playNext(session); // release replies held while they talked

    const seconds = bytes / (48000 * 2 * 2);
    const notSpeech = () => {
      if (bargedIn) session.player.unpause();
    };
    if (seconds < MIN_UTTERANCE_S) return notSpeech();

    let text, confidence;
    try {
      ({ text, confidence } = await transcribe(wav(Buffer.concat(pcm), 48000, 2)));
    } catch (e) {
      notSpeech();
      throw e;
    }
    const norm = text.trim().toLowerCase().replace(/[.!?,]+$/, '');
    if (STT_NOISE.has(norm) || !/[a-z]/.test(norm)) return notSpeech();
    if (confidence < STT_MIN_LOGPROB) {
      log(`voice: dropped low-confidence transcript (${confidence.toFixed(2)}, ${seconds.toFixed(1)}s): ${text}`);
      return notSpeech();
    }
    log(`voice: ${name} (${seconds.toFixed(1)}s, ${confidence.toFixed(2)}): ${text}`);
    if (bargedIn) {
      dropPending(session);
      session.player.stop(true);
    }
    await onTranscript(session.threadId, userId, name, text.trim());
    chime(session);
  }

  async function transcribe(wavBuffer) {
    const form = new FormData();
    form.append('model', STT_MODEL);
    form.append('language', 'en');
    form.append('response_format', 'json');
    form.append('include[]', 'logprobs');
    form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'utterance.wav');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!r.ok) throw new Error(`STT HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const body = await r.json();
    const lps = (body.logprobs || []).map((t) => t.logprob);
    if (!lps.length) throw new Error('STT response has no logprobs');
    return { text: body.text || '', confidence: lps.reduce((a, b) => a + b, 0) / lps.length };
  }

  // ---------- speaking ----------
  // Bot-originated lines (greetings) go through the same helper the agent
  // uses, so they get the same voice and effects.
  function say(threadId, text) {
    execFile(SEND_HELPER, [threadId, text], (err, _out, stderr) => {
      if (err) log(`voice: say failed: ${(stderr || err.message).trim()}`);
    });
  }

  // scripts/voice_tts.py renames finished 48kHz stereo s16le files into the
  // drop dir; play them in filename order. Files are unlinked as soon as they
  // are opened, so a barge-in only has to unlink what hasn't started yet.
  function scanDrops(session) {
    let names;
    try {
      names = fs.readdirSync(session.dropDir).filter((n) => n.endsWith('.pcm')).sort();
    } catch (e) {
      if (e.code === 'ENOENT') return; // session ended mid-scan
      throw e;
    }
    for (const name of names) {
      if (session.queued.has(name)) continue;
      session.queued.add(name);
      const file = path.join(session.dropDir, name);
      session.queue.push({
        file,
        load: async () => {
          const input = fs.createReadStream(file);
          await new Promise((resolve, reject) => input.once('open', resolve).once('error', reject));
          fs.unlinkSync(file);
          return { input, inputType: StreamType.Raw };
        },
      });
    }
    if (session.player.state.status === AudioPlayerStatus.Idle) playNext(session);
  }

  function dropPending(session) {
    for (const { file } of session.queue.splice(0)) {
      if (file) fs.rmSync(file, { force: true });
    }
  }

  function chime(session) {
    session.queue.unshift({ file: null, load: async () => ({ input: Readable.from([CHIME]), inputType: StreamType.Raw }) });
    if (session.player.state.status === AudioPlayerStatus.Idle) playNext(session);
  }

  // Never start talking over the owner: replies wait in the queue until their current utterance ends.
  async function playNext(session) {
    if (session.capturing.size) return;
    const next = session.queue.shift();
    if (!next) return;
    try {
      const { input, inputType } = await next.load();
      session.player.play(createAudioResource(input, { inputType }));
    } catch (e) {
      log(`voice: playback error: ${e.message}`);
      playNext(session);
    }
  }

  return { onVoiceStateUpdate, sweep, sessionFor, end };
}

// 48kHz stereo s16le, what the player takes as StreamType.Raw.
function chimePcm() {
  const rate = 48000;
  const notes = [[659.25, 0.12], [987.77, 0.22]]; // E5 then B5, seconds
  const total = notes.reduce((n, [, d]) => n + Math.round(d * rate), 0);
  const buf = Buffer.alloc(total * 4);
  let i = 0;
  for (const [hz, dur] of notes) {
    const len = Math.round(dur * rate);
    for (let n = 0; n < len; n++, i++) {
      const t = n / rate;
      const env = Math.min(1, n / 200) * Math.exp(-6 * t / dur);
      const v = Math.round(0.35 * 32767 * env * Math.sin(2 * Math.PI * hz * t));
      buf.writeInt16LE(v, i * 4);
      buf.writeInt16LE(v, i * 4 + 2);
    }
  }
  return buf;
}

function wav(pcm, rate, channels) {
  const header = Buffer.alloc(44);
  const byteRate = rate * channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
