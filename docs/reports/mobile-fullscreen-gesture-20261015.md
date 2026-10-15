# Mobile fullscreen gesture correction — 15 October 2026

The user reported that the first automatic-fullscreen release hid session tabs
but never entered fullscreen on their phone. Manual fullscreen worked. This
corrects the permission boundary rather than treating tab hiding as evidence of
fullscreen entry.

## Cause and reproduction

A native scrolling gesture does not grant the transient user activation required
by requestFullscreen. The old handler returned when navigator.userActivation
was inactive. Prior Playwright tests accidentally supplied activation through
page evaluation: the installed Playwright coreBundle.js passes userGesture:true
when evaluating JavaScript. A fresh context using addInitScript for observation
showed native touchstart/move/end all inactive and the fullscreen request rejected
with TypeError / Permissions check failed.

The browser regression now waits 5.2 seconds immediately before its entry swipe,
then checks activation with CDP Runtime.evaluate(userGesture:false). No Playwright
evaluation occurs between that check and touch release. It failed on the previous
published build and passes on the corrected candidate. Reference:
[Chromium scroll versus activation decision](https://groups.google.com/a/chromium.org/g/blink-dev/c/TO_x7FRkdmw).

## Behavior

For an eligible single-finger downward-history gesture, the handler cancels the
first touchmove before native scrolling takes ownership. It moves the document
with the finger and requests fullscreen on trusted release, which now grants
activation. After entry, native page scrolling resumes. The first entry gesture
therefore has no native fling inertia; subsequent scrolling does. This is a
custom entry gesture, not a claim that ordinary scroll events grant permission.

Older-history gestures and horizontal movement stay native. Short/cancelled
movements never enter fullscreen. Buttons, form fields and editable content are excluded. Drags starting on
message links also qualify; preventing the drag default preserves ordinary
link taps and suppresses accidental link activation during scrolling. There must be more than 32px of document overflow. Fullscreen
still targets the document, including the bottom composer. Manual exit suppresses
automatic reentry until reload. Unsupported, desktop, Tauri and standalone paths
retain their existing behavior.

A scoped simplification review found one efficiency issue: a non-passive
move listener must not remain on document for every tab. It is now attached only
for an accepted initial touch and removed on direction rejection, end, cancel and
unmount. Reuse/quality review found no changes needed. Final scoped manual review
and whitespace checks passed; unrelated repository WIP was preserved.

## Build and deployment

Initial gesture fix `ee498d271305437eb9d7e858e3d3364faa3a56fb`;
final implementation `849b8f4c85f538e5e9d975442bdb300955cb0287` on
`feature/pi-session-image-cleanup`. An isolated build passed vue-tsc and Vite with
the existing chunk advisories. Compiled sources were compared byte for byte with
committed frontend sources, excluding unrelated WIP. Graphite tokens were
unchanged. The web mount was verified as
`/home/hermes/projects/acp-ui/dist-web` → `/repo/dist-web`. Older hashed assets were
retained and index.html replaced last. No services or bridges were restarted.
The unchanged web image was `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.




- `/assets/index-CbQatH6Z.js` — SHA-256 `5370e2465d7ac289934e7dc52500f2a4c3c8e41069ca5de9e52ae4f45e0fe667`.
- `/assets/index-BWDYsZhw.css` — SHA-256 `ff6acdd5ba939fdabf8dde912fba7376f99b0cdda09fcbdeda344ae3c2d713f7`.

## Verification

The initial corrected candidate browser suite passed widths 320/390/430/780/1440px,
including activation expiry, actual fullscreen entry, composer/draft preservation,
horizontal/short/cancelled/older-history exclusions, exit suppression, manual
entry and rejection/retry, fallback, themes, navigation and busy controls. ACP,
state and transcription were mocked for action tests, with fake microphone input.

A candidate test with the real backend restored existing history in 4,054 ms,
confirmed automatic entry after activation expiry and completed manual entry/exit,
native scroll, mobile dimensions, themes, short viewport, desktop and reload.
No model prompts/cancellations were sent. No page errors, JSON-RPC errors or
error banners occurred; one activity CAS 409 recovered with subsequent PUT 200s.

A first published real-backend run timed out waiting for automatic entry; a
second run with touch-event diagnostics passed. The diagnostic records contain
only event metadata, not message text. The exact target of the first failure was
not captured. Inspection found that the handler excluded anchor elements, so a
drag on a message link was independently reproduced as a failure using a stable
link fixture. The anchor exclusion was removed; button and field exclusions
remain. The fixture verifies actual fullscreen entry without prior activation
and that the link is not opened by the drag.

Evidence is in `.agent-tmp/fullscreen-gesture-release/`. Physical phone behavior
still requires user confirmation. Open tabs require reload to get this code.

The final candidate suite also passed the link-start gesture at all five widths;
a focused published-assets run at 390px passed the full action suite, including
expired-activation fullscreen on a message link, no accidental link navigation,
manual controls and existing busy/composer behavior. Two later real-read probes
correctly refused to proceed because the fixed 5.2-second wait had not yet cleared
activation on the busy page; their assertions are test preconditions, not a
claimed product success. The read-only probe now polls activation using
CDP with userGesture:false before sending its entry gesture.

The final published real-backend read-only check passed. Restoration took 2,615 ms.
The trace records the entry gesture starting on an actual anchor with activation
false; each move was cancelled and the trusted release had activation true,
followed by document fullscreen. Composer visibility, manual entry/exit, exit
suppression, short viewport, desktop transition and reload also passed. Page
errors, RPC errors and error banners were empty; activity CAS 409 recovered with
PUT 200. Screenshots from this probe mask the transcript to avoid saving message
content. Physical phone confirmation is still outstanding.
