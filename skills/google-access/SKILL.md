You have real, headless access to Ben's Google account — Calendar, Gmail (read/write), Sheets, and Drive
— via an OAuth credential he owns. This is *not* the claude.ai Gmail/Calendar connectors: those need
an interactive login and are dead in the bot-spawned sessions you usually run in. This one works.

## The credential

`~/.budget/google-oauth.env` — client id/secret + refresh token for the "Schoolland Receipts"
OAuth client (GCP project 759968794110), authorized as bschoolland@gmail.com.

Scopes: `drive`, `cloud-platform`, `calendar`, `gmail.modify`, `gmail.settings.basic`.
Check what's live rather than trusting this list: `python3 services/google/auth.py`

## Using it

`services/google/auth.py` gives you `token()` and `call(method, url, body=None)`:

```python
import sys, urllib.parse; sys.path.insert(0, "services/google")
from auth import call

# what's on the calendar today
call("GET", "https://www.googleapis.com/calendar/v3/calendars/primary/events"
            "?timeMin=2026-08-31T00:00:00Z&timeMax=2026-09-01T00:00:00Z&singleEvents=true")

# create an event with a Meet link (conferenceDataVersion=1 is required for the Meet)
call("POST", "https://www.googleapis.com/calendar/v3/calendars/primary/events"
             "?conferenceDataVersion=1&sendUpdates=all",
     {"summary": "Ben / X", "start": {"dateTime": "2026-08-31T17:45:00-05:00"},
      "end": {"dateTime": "2026-08-31T18:30:00-05:00"},
      "attendees": [{"email": "x@example.com"}],
      "conferenceData": {"createRequest": {"requestId": "pick-something-unique"}}})

# find someone's address
call("GET", "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=" + urllib.parse.quote('"James Bates"'))
```

Sheets has a helper already: `python3 services/budget/gsheets.py read|append|update|meta`.

Ben's calendar is on **Central time**, and this machine is on Pacific. Always write times with an
explicit offset or `Z` and say the timezone out loud when you report back.

## What this doesn't cover

Gmail can read, label, archive, mark read, send, and manage filters. It **cannot permanently
delete** — `gmail.modify` stops short of that, so trashing is as far as it goes. To do anything on a
site with no API, drive the logged-in Chrome instead: `bash
services/budget/ensure-chrome.sh`, then `node services/budget/driver.mjs` (see its header).


To widen scopes, run `python3 services/google/reconsent.py <outdir> <scope>...` — it starts a
loopback listener, writes the consent URL to `<outdir>/url.txt` for you to drive Chrome to, and
refuses to write the credential unless every requested scope came back. Two things will bite you:

- The API has to be enabled on the GCP project first. The `cloud-platform` scope lets you do that
  over the Service Usage API — no console trip needed.
- Google's granular-permission screen has a checkbox per scope, and clicking **Continue** without
  ticking them returns a token with the *old* scopes and **no error**. Always diff the `scope`
  field of the token response against what you asked for.

Back up `google-oauth.env` before replacing a refresh token — the budget cron depends on it.
