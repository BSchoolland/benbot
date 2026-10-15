---
name: browse-as-ben
description: Drive a real Chrome that is logged in as Ben (Discord, Google, GitHub, banks, developer portals, anything with no API). Use whenever a task needs a website as Ben, when Ben says "use the browser", "do it in the browser", "log in as me", or when a settings page / OAuth portal / dashboard has to be changed. Never tell Ben to do a browser step himself before trying this.
---

# Browse as Ben

There is a persistent Chrome profile that is a copy of Ben's real one, logged into his accounts,
reachable over CDP (`services/` in your cwd links to the shared budget/google code). It is the only browser available from BenBot sessions.
The `claude-in-chrome` and `built-in-browser` skills need the desktop app or the extension and
are NOT available here; don't look for those tools, use this.

## Start

```
bash services/budget/ensure-chrome.sh          # idempotent: starts Chrome on :9222 if needed
node services/budget/driver.mjs tabs           # list open tabs
```

Every driver call attaches, acts, prints, detaches. Tabs persist between calls. The full command
list is in the header of `services/budget/driver.mjs`:
`goto <urlsub|new> <url>`, `text`, `links`, `tables`, `aria`, `click <urlsub> <text>`,
`fill <urlsub> <css> <value>`, `eval <urlsub> <js>`, `shot <urlsub> [file]`. `<urlsub>` is any
substring of the tab's URL.

## How to work a page

1. `goto new <url>`, then `aria <urlsub> 6000` to see the structure (headings, buttons, textboxes)
   and `shot <urlsub> /tmp/x.png` + Read the PNG when layout matters.
2. Buttons/links: `click <urlsub> "<visible text>"`.
3. **Inputs in React apps (Discord, Google, most SaaS): use `fill`, never set `.value` in eval.**
   `fill` sends real keystrokes so the framework sees the change (the unsaved-changes bar / Save
   button appears). Setting `.value` + dispatching `input` looks right but the form ignores it.
   If the input has no usable selector, tag it first:
   `eval <urlsub> "(() => { const h=[...document.querySelectorAll('h2')].find(h=>h.textContent.trim()==='Redirects'); const i=h.parentElement.querySelector('input[type=text]'); i.id='target'; return 'ok'; })()"`
   then `fill <urlsub> "#target" "<value>"`, then blur it via eval if a save bar should appear.
4. Save, then **verify from outside** when you can (an API read, a fresh `goto` + `text`), not
   just the page saying so.
5. Human pacing: a couple of seconds between steps. Sites that fingerprint (banks) get slower.

## The tab-substring trap
`<urlsub>` picks the FIRST open tab whose URL contains it, and this profile has dozens of old
tabs. `discord.com` matched a stale `discord.com/oauth2/authorized` tab, not the one just opened.
Use a substring unique to your tab (a query param, an id: `client_id=1506…`, `sketch-battle/`),
and check `tabs` when a read looks wrong. After a redirect the URL changes, so re-pick.

## Canvas / game pages
Text-based `click` can't see canvas UI. Drive with keyboard events via `eval`
(`document.dispatchEvent(new KeyboardEvent('keydown', {code:'Enter'}))`, and matching keyup) or
navigate straight to the URL the button would open.

## Payment pages
Never screenshot a page once card fields are filled. A 3DS popup or modal overlay does not hide them:
the CVC and card digits showed through behind one on 2026-09-30 and again on 2026-10-06. Read state from
the DOM instead (field `value.length`, button text, error elements, iframe `src`). For a challenge iframe,
find its input with Playwright `page.frames()` rather than looking. If a screenshot is truly unavoidable,
first blank the card inputs via eval (`value = ''`) or clip strictly to the iframe that holds no card data.
Any accidental exposure gets told to Ben.

## When it's stuck
- Logged out: sign back in yourself with `~/.budget/credentials.env` (fill the form, human pacing).
  Only a 2FA challenge is a reason to ask Ben, and then ask for the code in the thread.
- Chrome dead: `ensure-chrome.sh` restarts it; logs in `~/.budget/logs/chrome.log`.
- Profile missing: BUDGET.md in `services/budget/` has the setup.

## Worked example (Discord developer portal, 2026-09-26)
Add an OAuth2 redirect: `goto new https://discord.com/developers/applications/<app id>/oauth2`
→ `click … "Add Redirect"` → tag the new input under the "Redirects" heading → `fill … "#target"
"<url>"` → blur → `click … "Save Changes"` → verify with
`curl -H "Authorization: Bot $DISCORD_TOKEN" https://discord.com/api/v10/applications/@me`
(`redirect_uris`). Setting `.value` via eval showed the text but never enabled Save; `fill` did.
Then the whole OAuth flow as Ben: `goto new <authorize url>` → the consent page has TWO things
containing "Authorize", so `click … "Authorize"` hit the wrong one; `eval` clicking the last
`<button>` whose text is exactly "Authorize" worked → the tab redirected to the site with the
token → `eval <site> "localStorage.getItem('sketchbattle.account')"` showed the signed-in player.
