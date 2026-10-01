---
name: printer
description: Control Ben's Anycubic Kobra 2 Max through the Anycubic cloud (status, temps, upload, start, pause, cancel). Use when Ben asks about the 3D printer or wants something printed.
---

# Printer (Anycubic Kobra 2 Max via Anycubic Cloud)

The printer has no LAN API (stock KobraOS, Spe A board). Everything goes through Anycubic's
cloud using a GPL-3 community client checked out at `~/anycubic-cloud-api/` (not vendored into
this MIT repo on purpose). Python 3.12 venv lives there.

```
~/anycubic-cloud-api/anycubic-cli.py printers            # id, name, online, firmware
~/anycubic-cloud-api/anycubic-cli.py status              # temps, job progress, layer, ETA
~/anycubic-cloud-api/anycubic-cli.py print file.gcode    # upload + start (no cloud save)
~/anycubic-cloud-api/anycubic-cli.py pause|resume|cancel
~/anycubic-cloud-api/anycubic-cli.py files               # cloud storage listing
```

Printer id 33016. Slice with OrcaSlicer first (see the Kobra 2 Max setup in
`/tmp/orca` history or re-extract the AppImage in `~/Applications`); the cloud wants gcode
sliced for this machine.

## Auth

`~/.anycubic.env` (mode 600): `ANYCUBIC_EMAIL`, `ANYCUBIC_PASSWORD`, `ANYCUBIC_TOKEN`
(web XX-Token, `ANYCUBIC_AUTH_MODE=1`, polling only). If the CLI says the token is invalid,
run `~/anycubic-cloud-api/refresh-token.sh`: it drives the logged-in budget Chrome
(`services/budget/driver.mjs`) to log in and re-read the token. Anycubic sometimes throws a
slider captcha at login; the script exits 2 and you ask Ben to slide it on the desktop screen.

For live MQTT push updates the client needs a Slicer Next access token (`ANYCUBIC_AUTH_MODE=3`);
not set up yet.

## Gotchas

- `online=False` means the printer isn't on WiFi or hasn't phoned home; nothing works until it is.
- Don't accept cloud firmware updates without Ben deciding; they're one-way on this platform.
- Never post the token or password in Discord. Report usage deltas as usual.
