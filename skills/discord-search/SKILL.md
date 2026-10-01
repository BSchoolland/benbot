---
name: discord-search
description: Search the full history of every Discord channel and thread BenBot can see, fetched live from the Discord API into a local archive. Use when someone asks what was said or decided earlier, when a thread references a past conversation, or before answering "did we already talk about X".
---

The archive is the real history (every channel and thread the bot can read, back to the server's first
message), synced into `state/discord_archive.db` and searched full-text. `discord-read` only shows the last
few messages of one channel; use this for anything older or across channels.

```
discord-search "netcode rollback"                 # full-text, results printed oldest-first
discord-search --author ben --days 14             # filters work with or without a query
discord-search --around 27                        # the conversation surrounding row id 27
discord-search "sketch battle" --channel benbot --full   # untruncated content
```

Each result starts with its row id; feed that to `--around` to read the surrounding discussion. The tool syncs
new messages when the archive is stale (>10 min); `--sync` forces a refresh, `--no-sync` skips it for speed.
The first run backfills the whole server and takes a few minutes.
