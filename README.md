# BenBot

Ben's agent in Discord. One long-lived `claude` process per conversation (thread or DM), fed over stream-json stdin.
Messages inject into the live session mid-turn instead of killing it; background work survives between turns;
idle sessions are evicted silently and resume by session id with memory intact.

Architecture (Ben's): **AGENT** (`claude`, via `core/drivers/claude.mjs`) · **CORE** (`core/`, the only code) ·
**PERIPHERAL** (`scripts/`, `skills/`, `CLAUDE.md`, `TEAM/` — scripts and markdown).

## Core, one file each
| file | does |
|---|---|
| `core/gateway.mjs` | discord.js client. Watched channels (table `channels`) open a thread per known-person message; threads under them and DMs from known people are inputs. @mentioning the bot, or a second message while it is still mid-turn, soft-interrupts the current turn before delivery. Boot sweep for messages missed while down. |
| `core/identity.mjs` | Stamps every input with `[from: name · where · role] note` from `identities` / `identity_overrides` / `defaults`. Ben writes the notes. |
| `core/queue.mjs` | The single input queue: per-thread debounce (1.5 s) + coalesce, delivered in order; threads independent. |
| `core/sessions.mjs` | Thread ↔ session table, spawn/resume/inject/interrupt/evict, idle eviction (30 min), per-thread event logs, ⚠️ error surfacing, orphan reaping on boot. |
| `core/drivers/claude.mjs` | The verified runtime from the lab: spawn, `inject`, `interrupt`, `evict`, `resume`, events. |
| `core/db.mjs` / `state/state.db` | sqlite: `threads`, `channels`, `identities`, `identity_overrides`, `defaults`. |

Rules the code relies on (measured in `~/Projects/excalibur-19-lab/FINDINGS.md`): results are correlated by
`user_message_uuids`; an interrupt shows up as `is_error` + `terminal_reason: aborted_tools` and is not an error;
resume emits an empty zero-turn result first; SIGTERM loses background children, resume restores the conversation.

## Per-server workspaces
Sessions are cwd-bound, so each server gets `workspaces/<guildId>/` (DMs: `workspaces/dm/`), created on first use with
symlinks `CLAUDE.md`, `TEAM`, `bin → scripts`, `.claude/skills → skills`. Put server-specific skills or notes in a
workspace by replacing a symlink with a real file.

## Setup
```sh
npm install
printf 'DISCORD_TOKEN=...\n' > .env            # AGENT_MODEL=fable, OWNER_IDS=..., IDLE_EVICT_MS, DEBOUNCE_MS optional
scripts/channels watch <channelId> <guildId> [model]   # which channels open threads
scripts/identity set <discordId> <Name> "<note>"       # who may talk, and what they may ask
cp benbot.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now benbot
```
Bot needs the Message Content and Server Members intents and permission to create/manage threads and add reactions.

## Ops
```sh
journalctl --user -u benbot -f          # bot log
state/logs/<threadKey>.jsonl            # every stream-json event of that session
scripts/identity list · scripts/channels list
```
Reset one conversation: `sqlite3 state/state.db "delete from threads where thread_key='<id>'"`.
Restarting the bot SIGTERMs live agents (a child's stdin can't be re-attached); conversations resume on the next message.

## Not in v0
Cron/scheduled inputs, voice, wakes, memory beyond grep, the codex driver, evergreen's DevOps skills.
