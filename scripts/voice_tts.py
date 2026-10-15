"""Turn a reply into audio for a voice-bound thread.

The bot owns the call and the player; everything about *how* a reply sounds
lives here. `speak()` synthesises the text with OpenAI or xAI TTS (picked by
voice name), runs it through
an ffmpeg filtergraph or a shell pipe, and drops the finished 48kHz stereo
s16le PCM into `state/voice/<thread_id>/`, which the bot watches and plays in
filename order. Editing this file never needs a bot restart.

Leading tags on a message override the defaults for that one reply:
  [voice:name]   TTS voice; XAI_VOICES go to xAI, the rest to OpenAI
                 (default DISCORD_TTS_VOICE, else ash)
  [style:text]   OpenAI delivery instructions; xAI has no equivalent
                 (default DISCORD_TTS_INSTRUCTIONS)
  [fx:graph]     ffmpeg -af filtergraph    (default DISCORD_TTS_FX)
  [pipe:cmd]     shell command: encoded audio on stdin, 48kHz stereo s16le on stdout,
                 run from the benbot root (default DISCORD_TTS_PIPE; wins over fx)
A tag's value runs to the first `]` followed by whitespace, so fx graphs may
contain pad labels like `[a][b]amix`.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BOT_DIR = Path(__file__).resolve().parent.parent
ENV_PATH = BOT_DIR / ".env"
VOICE_STATE = BOT_DIR / "state" / "voice"
TTS_MODEL = "gpt-4o-mini-tts"
TTS_MAX_CHARS = 4000
# gpt-4o-mini-tts ignores `speed`; pace is steered through `instructions`.
INSTRUCTIONS_DEFAULT = ("Speak at a brisk, natural conversational pace, like a quick-witted "
                        "teammate on a call. No slow, careful enunciation.")
XAI_VOICES = {"eve", "ara", "rex", "sal", "leo"}
TAG_RE = re.compile(r"^\[(voice|style|fx|pipe):(.+?)\](?:\s+|$)", re.I | re.S)


def env():
    out = {}
    for line in ENV_PATH.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = re.sub(r"^(['\"])(.*)\1$", r"\2", v.strip())
    return out


def drop_dir(thread_id):
    return VOICE_STATE / str(thread_id)


def is_voice_thread(thread_id):
    return drop_dir(thread_id).is_dir()


def parse_tags(content):
    """Strip leading [voice:]/[style:]/[fx:]/[pipe:] tags; return (text, opts)."""
    opts, text = {}, content
    while True:
        m = TAG_RE.match(text)
        if not m:
            return text, opts
        key, val = m.group(1).lower(), m.group(2).strip()
        opts["instructions" if key == "style" else key] = val.lower() if key == "voice" else val
        text = text[m.end():]


def speakable(md):
    """Markdown and links read badly aloud."""
    s = re.sub(r"```[\s\S]*?```", " (code omitted) ", md)
    s = re.sub(r"`([^`]*)`", r"\1", s)
    s = re.sub(r"https?://\S+", " (link) ", s)
    s = re.sub(r"<@!?\d+>", "", s)
    s = re.sub(r"<#\d+>", "that channel", s)
    s = re.sub(r"[*_~#>|]", "", s)
    s = re.sub(r"^\s*[-•]\s+", "", s, flags=re.M)
    s = re.sub(r"^\s*\d+\.\s+", "", s, flags=re.M)
    s = re.sub(r"\s*\n\s*", "\n", s)
    return s.strip()


def chunks(text):
    out, cur = [], ""
    for para in text.split("\n"):
        if not para.strip():
            continue
        if cur and len(cur) + 1 + len(para) > TTS_MAX_CHARS:
            out.append(cur)
            cur = para
        else:
            cur = f"{cur}\n{para}" if cur else para
    if cur:
        out.append(cur)
    return out


def synthesize(text, voice, instructions, e):
    """Encoded audio bytes (opus from OpenAI, mp3 from xAI)."""
    if voice in XAI_VOICES:
        url, key = "https://api.x.ai/v1/tts", "XAI_API_KEY"
        body = {"text": text, "voice_id": voice, "language": "en",
                "output_format": {"codec": "mp3", "sample_rate": 48000}}
    else:
        url, key = "https://api.openai.com/v1/audio/speech", "OPENAI_API_KEY"
        body = {"model": TTS_MODEL, "voice": voice, "instructions": instructions,
                "input": text, "response_format": "opus"}
    if not e.get(key):
        raise RuntimeError(f"{key} not set in {ENV_PATH}")
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {e[key]}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"TTS HTTP {e.code}: {e.read().decode()[:200]}") from None


def to_pcm(audio, fx=None, pipe=None):
    """48kHz stereo s16le, what the bot's player takes as raw."""
    if pipe:
        cmd, shell = pipe, True
    else:
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0"]
        if fx:
            cmd += ["-af", fx]
        cmd += ["-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"]
        shell = False
    p = subprocess.run(cmd, shell=shell, cwd=BOT_DIR, input=audio, capture_output=True)
    if p.returncode:
        what = "pipe" if pipe else "ffmpeg"
        raise RuntimeError(f"{what} exit {p.returncode}: {p.stderr.decode().strip()[:300]}")
    return p.stdout


def drop(thread_id, pcm, seq):
    """Write atomically: the bot only picks up `.pcm`, never the `.tmp`."""
    d = drop_dir(thread_id)
    final = d / f"{int(time.time() * 1000):013d}-{seq:02d}.pcm"
    tmp = final.with_suffix(".tmp")
    tmp.write_bytes(pcm)
    os.rename(tmp, final)
    return final


def speak(thread_id, content):
    """Synthesise `content` (tags already applied) into the thread's drop dir.

    Returns the tag-stripped text so the caller can post it. Raises if the
    thread is not voice-bound or synthesis fails.
    """
    text, opts = parse_tags(content)
    e = env()
    voice = opts.get("voice") or e.get("DISCORD_TTS_VOICE") or "ash"
    instructions = opts.get("instructions") or e.get("DISCORD_TTS_INSTRUCTIONS") or INSTRUCTIONS_DEFAULT
    fx = opts.get("fx") or e.get("DISCORD_TTS_FX") or None
    pipe = opts.get("pipe") or e.get("DISCORD_TTS_PIPE") or None
    if not is_voice_thread(thread_id):
        raise RuntimeError(f"thread {thread_id} is not voice-bound (no {drop_dir(thread_id)})")
    for i, chunk in enumerate(chunks(speakable(text))):
        drop(thread_id, to_pcm(synthesize(chunk, voice, instructions, e), fx, pipe), i)
    return text


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("usage: voice_tts.py <thread_id> <text...>   (audio only; use discord-send to also post)")
    speak(sys.argv[1], " ".join(sys.argv[2:]))
