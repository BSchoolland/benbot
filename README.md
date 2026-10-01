# BenBot

Ben's agent in Discord. One long-lived `claude` process per conversation (thread or DM), fed over stream-json stdin.
Messages inject into the live session mid-turn instead of killing it; background work survives between turns;
idle sessions are evicted silently and resume by session id with memory intact.

Architecture (Ben's): **AGENT** (`claude`, via `core/drivers/claude.mjs`) · **CORE** (`core/`, the only code) ·
**PERIPHERAL** (`scripts/`, `skills/`, `CLAUDE.md`, `TEAM/` — scripts and markdown).

## Core, one file each
| file | does |
|---|---|
| `core/gateway.mjs` | discord.js client. Watched channels (table `channels`) open a thread per known-person message; an @mention of the bot in any channel of any server opens a thread on that message (in a thread, adopts it). Tracked threads, threads under watched channels, and DMs from known people are inputs. @mentioning the bot, or a second message while it is still mid-turn, soft-interrupts the current turn before delivery. Boot sweep for messages missed while down. |
| `core/identity.mjs` | Stamps every input with `[from: name · where · role] note` from `identities` / `identity_overrides` / `defaults`. Ben writes the notes. |
| `core/queue.mjs` | The single input queue: per-thread debounce (1.5 s) + coalesce, delivered in order; threads independent. |
| `core/sessions.mjs` | Thread ↔ session table, spawn/resume/inject/interrupt/evict, idle eviction (50 min; chat sessions post a summary to the conductor first), per-thread event logs, ⚠️ error surfacing, orphan reaping on boot. |
| `core/drivers/claude.mjs` | The verified runtime from the lab: spawn, `inject`, `interrupt`, `evict`, `resume`, events. |
| `core/conductor.mjs` | The one privileged session (`conductor`, its own channel, `CONDUCTOR.md` as its CLAUDE.md). Receives job reports (`inbox` table, written by `scripts/report`), idle-eviction summaries and new-conversation notices; the only thing that posts to humans unprompted. |
| `core/voice.mjs` | An owner joining a voice channel opens a voice-bound thread under the guild's watched channel; utterances are transcribed (OpenAI STT) and delivered like typed messages; `scripts/discord-send` speaks replies (TTS in `scripts/voice_tts.py`) into `state/voice/<thread>/`, which the bot plays. Off without `OPENAI_API_KEY`. |
| `core/wakes.mjs` | One-shot watchers from `scripts/discord-wake` (`wakes` table): when a file appears or a pid exits, a `[wake]` line is delivered into the thread's session, live or asleep. |
| `core/jobs.mjs` / `core/jobfiles.mjs` | Scheduler over `jobs/*.md` (re-read every check, so edits apply live; `job_state` remembers last run): a due job is a tick delivered into its own long-lived session `job:<name>`, never a fresh process. Job sessions report to the conductor. |
| `core/db.mjs` / `state/state.db` | sqlite: `threads`, `channels`, `identities`, `identity_overrides`, `defaults`, `settings`, `job_state`, `inbox`. |

Rules the code relies on (measured in `~/Projects/excalibur-19-lab/FINDINGS.md`): results are correlated by
`user_message_uuids`; an interrupt shows up as `is_error` + `terminal_reason: aborted_tools` and is not an error;
resume emits an empty zero-turn result first; SIGTERM loses background children, resume restores the conversation.

## Per-server workspaces
Sessions are cwd-bound, so each server gets `workspaces/<guildId>/` (DMs: `workspaces/dm/`, jobs: `workspaces/jobs/` or the
job's `cwd`, the conductor: `workspaces/conductor/` with `CONDUCTOR.md` as its CLAUDE.md), created on first use with
symlinks `CLAUDE.md`, `TEAM`, `bin → scripts`, `.claude/skills → skills`. Every session gets `BENBOT_THREAD` in its environment. Put server-specific skills or notes in a
workspace by replacing a symlink with a real file.

## Setup
```sh
npm install
printf 'DISCORD_TOKEN=...\n' > .env            # AGENT_MODEL=fable, OWNER_IDS=..., IDLE_EVICT_MS, DEBOUNCE_MS optional
scripts/channels watch <channelId> <guildId> [model]   # which channels open threads
scripts/identity set <discordId> <Name> "<note>"       # who may talk, and what they may ask
scripts/channels conductor <channelId> <guildId> [model] # the conductor's channel (job reports show here; talk to it for debugging)
jobs/<name>.md                                         # scheduled work, gitignored: frontmatter cron/model/cwd/enabled, prompt as body; scripts/jobs list · run · new
cp benbot.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now benbot
```
Bot needs the Message Content and Server Members intents and permission to create/manage threads and add reactions.

## Ops
```sh
journalctl --user -u benbot -f          # bot log
state/logs/<threadKey>.jsonl            # every stream-json event of that session
scripts/identity list · scripts/channels list · scripts/jobs list · scripts/conductor-read
scripts/discord-model <thread> <model> [effort]   # next turn runs under new flags, same session (threads.model/effort)
scripts/discord-wake · discord-rename · discord-search · usage-limits · codex-limits   # the agent's other hands; see CLAUDE.md
```
Reset one conversation: `sqlite3 state/state.db "delete from threads where thread_key='<id>'"`.
Restarting the bot SIGTERMs live agents (a child's stdin can't be re-attached); conversations resume on the next message.

## Skills and shared code
`skills/` is linked into every workspace as `.claude/skills`. `services/` links to code shared with the older Ducktape
bot (`~/Projects/evergreen/services/{budget,google}`: the logged-in Chrome driver and Google OAuth helper the
`browse-as-ben`, `google-access` and `printer` skills use); workspaces get a `services` symlink too.

## Not in v0
Memory beyond grep, the codex driver, evergreen's DevOps skills.
