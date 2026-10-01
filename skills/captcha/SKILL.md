---
name: captcha
description: use when you run into a captcha
---

# Captcha

Pointers for getting past captchas from a BenBot session, learned on real bookings. The browser is
Ben's CDP Chrome (`browse-as-ben`); everything below assumes Playwright over `connectOverCDP` because the
budget driver's `click`/`eval` cannot reach inside the captcha iframes. A worked script with `captcha-open`
and `captcha-click` subcommands lives at `~/.budget/driver/booker-flow.mjs`.

## Play the human first

Most checkbox captchas pass with no puzzle when the click looks like a person in a logged-in profile.
- `scrollIntoViewIfNeeded()`, pause ~500 ms, `hover()`, pause ~400 ms, then `click()`. A fast click straight
  from script is what triggered the image puzzle on Booker; the paced one passed clean.
- Type into the surrounding form with `keyboard.type(text, { delay: 60 })` and Tab between fields. The
  risk score is built from the whole page session, not just the checkbox.
- Stale widget: if a challenge popup closed on its own and the challenge iframe now reports a 0×0 box,
  re-clicking does nothing. Reload the page or rebuild the flow (new cart, new form) and try again.
- Check the result on the anchor, not the popup: `aria-checked="true"` on `#recaptcha-anchor` inside the
  `recaptcha/.../anchor` iframe means you are through.

## reCAPTCHA v2 / Enterprise image puzzle

Frames: `iframe[src*="recaptcha"][src*="anchor"]` holds the checkbox; `iframe[src*="bframe"]` holds the puzzle.
Use `page.frameLocator(...)` for both.
1. **See it.** Get the bframe's `boundingBox()` and `page.screenshot({ clip: box })`. Clip to the iframe
   only; the page around it may contain things you must not see (a checkout form shows the full card
   number). Read the PNG with the Read tool. Delete it after.
2. **Read the task.** Instruction text: `.rc-imageselect-desc-wrapper` ("Select all images with
   *crosswalks*"). Grid: `table.rc-imageselect-table-33` (3×3, nine separate photos) or `-44` (4×4, one
   photo cut into tiles). Tiles: `td.rc-imageselect-tile`, row-major from 0.
3. **Pick tiles.** 3×3: any tile where the object clearly appears, even partially. 4×4: every tile the
   object touches, including thin slivers (poles, bus edges); missing a sliver is the usual "please try
   again". If nothing matches, click Skip/Verify with none selected; that is a valid answer.
4. **Click with jitter** (400–900 ms apart), then `#recaptcha-verify-button`.
5. **Dynamic puzzles** ("click verify once there are none left"): each clicked tile is replaced by a new
   image. Re-screenshot after the replacements load (~2 s) and keep clicking until nothing matches, then verify.
6. **After verify**: re-check the anchor. Errors live in `.rc-imageselect-error-select-more`,
   `.rc-imageselect-incorrect-response`, `.rc-imageselect-error-dynamic-more`; a new grid means another
   round, which is normal (two or three rounds is common). Also watch for the puzzle expiring (~2 minutes
   idle) and for the host page's own timer (Booker's cart runs 10 minutes).

## Audio alternative

The bframe has a headphones button (`#recaptcha-audio-button`). It serves a short mp3
(`.rc-audiochallenge-tdownload-link`), a few spoken digits or words. Download it, transcribe with the
OpenAI STT the bot already uses for voice (`OPENAI_API_KEY` in the bot's `.env`), type the answer into
`#audio-response`, verify. Fewer rounds than images when the spoken clip is clear; Google sometimes locks
audio ("try again later") after several attempts from one profile.

## hCaptcha and Turnstile

- Cloudflare Turnstile usually clears itself; give it ~5 s and read the page again before touching it.
  If it shows a checkbox, same paced hover+click as above, inside `iframe[src*="challenges.cloudflare.com"]`.
- hCaptcha: checkbox in `iframe[src*="hcaptcha.com"][src*="checkbox"]`, puzzle in the `frame=challenge`
  iframe. Task text in `.prompt-text`, images in `.task-image` (usually 3×3), submit via `.button-submit`.
  Same tile rules; it likes to ask two rounds.

## Plain text captchas

Screenshot the image element, read it, type the characters into the field. Ambiguous glyphs (0/O, 1/l/I)
are the usual miss; a wrong answer just reloads the image.

## Keep the flow alive

A captcha sits inside something with a clock: cart timers, login attempts, one-time codes. Before starting
the puzzle, note the timer, and prepare the rest of the form so the submit is one click after the anchor
turns green. If the timer wins, rebuild the cart before retrying the captcha; on Booker a rebuilt cart
keeps the old line item, so check the confirmation for duplicates.
