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
import { finish, openEvent } from './voicelog.mjs';

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
const RTP_GAP_MS = 200; // a wall-clock pause between two of the owner's packets worth recording
const MAX_GAPS = 30;
const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

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
      call: openEvent('call', thread.id).set('channel', channel.name).set('owner', member.displayName),
      utterances: new Map(), // userId -> the open utterance event
      rtp: new Map(), // userId -> { seq, ts, at, idle: packets seen while no utterance was open, gap: the last gap seen outside one }
      lastUtteranceEnd: null,
      surfaced: new Set(), // issue codes already posted to the thread
    };
    sessions.set(session.guildId, session);
    byThread.set(thread.id, session);
    // The drop dir doubles as the "this thread is on a call" flag for discord-send.
    fs.rmSync(session.dropDir, { recursive: true, force: true });
    fs.mkdirSync(session.dropDir, { recursive: true });
    session.watcher = fs.watch(session.dropDir, () => scanDrops(session));
    session.watcher.on('error', (e) => problem(session, 'error', 'drop-watch', e.message));
    log(`voice: joining #${channel.name} for ${member.displayName}, thread ${thread.id}`);

    session.player.on(AudioPlayerStatus.Idle, () => playNext(session));
    session.player.on('error', (e) => problem(session, 'error', 'player', e.message, e.stack));

    try {
      session.connection = await connect(channel, session);
    } catch (e) {
      problem(session, 'error', 'connect', `giving up: ${e.message}`);
      await end(session, 'could not connect');
      return;
    }
    const { connection } = session;
    connection.subscribe(session.player);
    tapRtp(session);
    connection.on('stateChange', (_o, n) => { if (n.status === VoiceConnectionStatus.Ready) tapRtp(session); });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      session.call.count('disconnects');
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
      if (!ownerIds.includes(userId)) return;
      if (session.capturing.has(userId)) return void session.call.count('speakingStartWhileCapturing');
      capture(session, userId).catch((e) => {
        session.utterances.get(userId)?.issue('error', 'capture', e.message, e.stack);
        problem(session, 'error', 'capture', e.message, e.stack);
      });
    });

    session.call.set('connected', Date.now() - session.call.t0);
    await thread.send(`🎙 Voice session started in **#${channel.name}**. Everything ${member.displayName} says lands here as text; my replies are read aloud.`);
    say(session, greeting);
  }

  // Every problem during a call: on the call's wide event, in the journal, and the first of each kind of error
  // posted to the thread (a 🎙 line, so it is not read aloud).
  function problem(session, level, code, message, detail) {
    session.call.issue(level, code, message, detail);
    log(`voice: ${level} ${code}: ${message} (thread ${session.threadId})`);
    if (level !== 'error' || session.surfaced.has(code)) return;
    session.surfaced.add(code);
    client.channels.fetch(session.threadId)
      .then((t) => t.send(`🎙 ⚠️ voice ${code} error: ${message.slice(0, 300)}`))
      .catch((e) => log(`voice: could not post ${code} error to thread ${session.threadId}: ${e.message}`));
  }

  // Watches the owner's raw RTP packets on the voice UDP socket. Sequence numbers tell network loss
  // (seq jumps) apart from the sender going quiet (seq contiguous, RTP timestamp jumps), and packets that
  // arrive while no utterance is subscribed are audio nobody transcribed.
  function tapRtp(session) {
    const udp = session.connection.state.networking?.state?.udp;
    if (!udp) return problem(session, 'warn', 'rtp-tap', 'connection is Ready but has no UDP socket');
    if (udp.benbotTapped) return;
    udp.benbotTapped = true;
    session.call.count('rtpTaps');
    const { receiver } = session.connection;
    udp.on('message', (msg) => {
      if (msg.length <= 12 || (msg[1] & 0x7f) !== 120) return;
      const userId = receiver.ssrcMap.get(msg.readUInt32BE(8))?.userId;
      if (!ownerIds.includes(userId)) return;
      const seq = msg.readUInt16BE(2);
      const ts = msg.readUInt32BE(4);
      const now = Date.now();
      const utterance = session.utterances.get(userId);
      let st = session.rtp.get(userId);
      if (!st) session.rtp.set(userId, (st = { idle: 0, gap: null }));
      if (st.at !== undefined) {
        const seqJump = (seq - st.seq) & 0xffff;
        const lost = seqJump > 1 && seqJump < 3000 ? seqJump - 1 : 0;
        const wallMs = now - st.at;
        const gap = wallMs >= RTP_GAP_MS ? { at: now, wallMs, rtpMs: Math.round(((ts - st.ts) >>> 0) / 48), lost } : null;
        if (utterance) {
          const r = utterance.business.rtp;
          r.packets++;
          r.lost += lost;
          if (gap && r.gaps.length < MAX_GAPS) r.gaps.push({ ...gap, at: gap.at - utterance.t0 });
        } else {
          st.idle++;
          if (gap) st.gap = gap;
        }
        if (seqJump === 0 || seqJump >= 3000) session.call.count('rtpOutOfOrder');
        if (lost) session.call.count('rtpLost', lost);
      } else if (utterance) utterance.business.rtp.packets++;
      else st.idle++;
      session.call.count('rtpPackets');
      Object.assign(st, { seq, ts, at: now });
    });
  }

  // The UDP handshake sometimes never gets an answer (seen right after a bot
  // restart that left a stale voice session behind). Re-sending the join for
  // the same channel reuses the stuck socket, so retry from a fresh connection.
  async function connect(channel, session) {
    let lastError;
    for (let attempt = 1; attempt <= READY_ATTEMPTS; attempt++) {
      session.call.set('connectAttempts', attempt);
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      connection.on('error', (e) => problem(session, 'error', 'connection', e.message, e.stack));
      connection.on('stateChange', (o, n) => {
        const net = n.networking?.state;
        const where = net ? ` (net ${NetworkingStatusCode[net.code]} @ ${net.connectionOptions?.endpoint})` : '';
        log(`voice: conn ${o.status} -> ${n.status}${where}`);
        const states = (session.call.business.connStates ??= []);
        if (states.length < 50) states.push({ at: Date.now() - session.call.t0, from: o.status, to: n.status, ...(net ? { net: NetworkingStatusCode[net.code] } : {}) });
      });
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
        return connection;
      } catch (e) {
        lastError = e;
        const net = connection.state.networking?.state;
        problem(session, 'warn', 'connect-attempt', `attempt ${attempt}/${READY_ATTEMPTS} never became Ready (net ${net ? NetworkingStatusCode[net.code] : 'none'} @ ${net?.connectionOptions?.endpoint})`);
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
    session.player.stop(true);
    if (session.connection && session.connection.state.status !== VoiceConnectionStatus.Destroyed) session.connection.destroy();
    fs.rmSync(session.dropDir, { recursive: true, force: true });
    log(`voice: session ended (${why}), thread ${session.threadId}`);
    session.call.set('ended', why);
    for (const u of session.utterances.values()) { u.set('outcome', 'call-ended'); finish(u); }
    try {
      const thread = await client.channels.fetch(session.threadId);
      await thread.send(`🎙 Voice session ended (${why}). Thread still works as text.`);
    } catch (e) {
      session.call.issue('error', 'end-notice', e.message);
      log(`voice: end notice failed: ${e.message}`);
    }
    try {
      await onEnd(session.threadId, why);
    } catch (e) {
      session.call.issue('error', 'on-end', e.message, e.stack);
      throw e;
    } finally {
      finish(session.call);
    }
  }

  // ---------- listening ----------
  // One utterance = one wide event: how the audio arrived (packets, gaps, loss), why it ended, what STT made
  // of it and what happened to the text. Each also gets one journal line.
  async function capture(session, userId) {
    session.capturing.add(userId);
    const u = openEvent('utterance', session.threadId, session.call.id);
    session.utterances.set(userId, u);
    const st = session.rtp.get(userId);
    u.set('rtp', { packets: 0, lost: 0, gaps: [], idleBefore: st?.idle ?? 0, gapBefore: st?.gap ? { ...st.gap, at: st.gap.at - u.t0 } : null });
    if (st) { st.idle = 0; st.gap = null; }
    if (session.lastUtteranceEnd) u.set('sinceLastMs', u.t0 - session.lastUtteranceEnd);
    session.call.count('utterances');
    try {
      await listen(session, userId, u);
    } catch (e) {
      u.issue('error', 'capture', e.message, e.stack);
      u.set('outcome', 'error');
      throw e;
    } finally {
      session.utterances.delete(userId);
      session.call.count(`outcome.${u.business.outcome}`);
      const b = u.business;
      const gaps = b.rtp.gaps.map((g) => `${g.wallMs}ms${g.lost ? `/lost${g.lost}` : ''}`).join(',');
      log(`voice: utterance ${b.outcome} ${b.audioS ?? '?'}s wall ${b.wallMs ?? '?'}ms pkts ${b.rtp.packets} lost ${b.rtp.lost} gaps [${gaps}] idleBefore ${b.rtp.idleBefore}${b.sinceLastMs !== undefined ? ` since ${b.sinceLastMs}ms` : ''}${b.stt ? ` conf ${b.stt.confidence?.toFixed(2)} stt ${b.stt.ms}ms: ${b.stt.text}` : ''}`);
      finish(u);
    }
  }

  async function listen(session, userId, u) {
    const member = await client.guilds.cache.get(session.guildId)?.members.fetch(userId).catch((e) => {
      u.issue('warn', 'member-fetch', e.message);
      return null;
    });
    const name = member?.displayName || 'owner';
    const opus = session.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_END_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const pcm = [];
    let bytes = 0;
    let frames = 0;
    let silenceFrames = 0;
    let bargedIn = false;
    const overPlayback = session.player.state.status === AudioPlayerStatus.Playing; // only then can this cut us off
    u.set('overPlayback', overPlayback);
    opus.on('data', (p) => { frames++; if (p.equals(SILENCE_FRAME)) silenceFrames++; });

    const ended = await new Promise((resolve) => {
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
          u.issue('error', 'decode', e.message);
          problem(session, 'error', 'decode', e.message);
          resolve('decode-error');
        })
        .on('end', () => resolve('silence'));
      opus.on('error', (e) => {
        u.issue('error', 'receive', e.message);
        problem(session, 'error', 'receive', e.message);
        resolve('receive-error');
      });
    });
    session.capturing.delete(userId);
    if (session.player.state.status === AudioPlayerStatus.Idle) playNext(session); // release replies held while they talked

    const seconds = bytes / (48000 * 2 * 2);
    session.lastUtteranceEnd = Date.now();
    u.set('ended', ended).set('wallMs', Date.now() - u.t0).set('audioS', +seconds.toFixed(2)).set('frames', frames).set('silenceFrames', silenceFrames);
    if (bargedIn) { u.set('bargedIn', true); session.call.count('bargeIns'); }
    const notSpeech = (outcome) => {
      u.set('outcome', outcome);
      if (bargedIn) session.player.unpause();
    };
    if (seconds < MIN_UTTERANCE_S) return notSpeech('too-short');

    let stt;
    try {
      stt = await transcribe(wav(Buffer.concat(pcm), 48000, 2));
    } catch (e) {
      notSpeech('stt-error');
      u.issue('error', 'stt', e.message);
      problem(session, 'error', 'stt', e.message);
      return;
    }
    const { text, confidence } = stt;
    u.set('stt', stt);
    const norm = text.trim().toLowerCase().replace(/[.!?,]+$/, '');
    if (STT_NOISE.has(norm) || !/[a-z]/.test(norm)) return notSpeech('noise');
    if (confidence < STT_MIN_LOGPROB) return notSpeech('low-confidence');
    u.set('outcome', 'posted');
    if (bargedIn) {
      dropPending(session);
      session.player.stop(true);
    }
    try {
      await onTranscript(session.threadId, userId, name, text.trim());
    } catch (e) {
      u.set('outcome', 'post-error');
      u.issue('error', 'post', e.message, e.stack);
      problem(session, 'error', 'post', `transcript not delivered: ${e.message}`, text);
      return;
    }
    chime(session);
  }

  async function transcribe(wavBuffer) {
    const started = Date.now();
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
    return { text: body.text || '', confidence: +(lps.reduce((a, b) => a + b, 0) / lps.length).toFixed(3), minLogprob: +Math.min(...lps).toFixed(3), ms: Date.now() - started };
  }

  // ---------- speaking ----------
  // Bot-originated lines (greetings) go through the same helper the agent
  // uses, so they get the same voice and effects.
  function say(session, text) {
    execFile(SEND_HELPER, [session.threadId, text], (err, _out, stderr) => {
      if (err) problem(session, 'error', 'say', (stderr || err.message).trim());
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
      session.call.count(next.file ? 'clipsPlayed' : 'chimes');
    } catch (e) {
      problem(session, 'error', 'playback', e.message, e.stack);
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
