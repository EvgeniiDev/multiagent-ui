# Mobile document scrolling and composer statuses — 15 October 2026

Later updates: [composer actions and graphite recovery](composer-actions-20261015.md).

The mobile web chat now scrolls the document rather than an inner history pane.
Session navigation is fixed to the top, hides on user scrolling toward newer
messages, and reappears toward older messages. The composer stays at the visual
viewport bottom. Desktop, other views, and Tauri retain their existing scrollers.
Recording status and its duration now share the bottom toolbar between settings
and Send. Phones show a compact duration; microphone errors retain a separate,
wrapping line above the field. Live thinking/tool progress and Stop now sit
directly above the composer, remaining visible while history is scrolled.
Long tool titles truncate within the row and retain their full tooltip; Stop
uses the shared UiButton with a 44px mobile touch target.

This supersedes the earlier CSS-only publication described in
[mobile-fullscreen-20261015.md](mobile-fullscreen-20261015.md).

## Cause and implementation

The previous fixed-height shell constrained `.messages-container` with
`overflow-y:auto`; swiping its history did not scroll the document. A regression
check against that build failed with “mobile chat uses native page scrolling”.
Mobile web chat now enables document overflow, releases the shell height, and
reserves history padding for the fixed header/composer. Composer height is
measured, including attachments and notices. Visual viewport height and offset
keep it reachable when browser chrome or the keyboard changes the visible area.

History windowing, following new output, and restoration use the document
scrollport only for the active mobile web tab. Other tabs preserve their own
positions. Deferred history growth checks that it still owns the same scrollport
before changing the shared document position.

The browser controls its address bar. Native document scrolling removes the
application's nested-scroll obstacle; physical browser toolbar animation was
not observable in headless emulation. No fullscreen prompt or forced scrolling
hack was introduced. See Chromium's
[root scrolling documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/renderer/core/page/scrolling/README.md).

## Release scope

Source branch: `feature/pi-session-image-cleanup`, HEAD `c025d0bb92153d3a7cb92f25aede58f7c6757868`.
The working tree already contained unrelated changes. Release sources came from
`git archive HEAD` plus only this session's owned App.vue and ChatView.vue edits
(including the previous mobile geometry fix). In-progress telemetry, session
runtime, package, branding and other changes were excluded. The isolated source
has its own dependencies and passed `npm run build:web`, including vue-tsc.
Vite reported its existing chunk size advisory.

Verified web mount: `/home/hermes/projects/acp-ui/dist-web` → `/repo/dist-web`.
Unchanged web image: `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.
Assets were copied while preserving older hashed files; index.html was replaced
atomically last. Served index and entry assets were compared byte for byte.
No bridge or other service lifecycle operation was performed.


- `/assets/index-BCSn-KBz.js` — SHA-256 `5a9b4d5eb5ac6e34351c0641a8a596b9c1a6961e8ffd4daa400bf11ed80afdd1`.
- `/assets/index-Dj-uKN5V.css` — SHA-256 `6e0ab1d7f0ec3de8a7b2c312ea8bf448fe3173b5c4b6d7c5d39776cafaaa7ade`.

## Verification

- Fifteen send, dictation insertion and drawer gesture regression tests passed.
- The final release build and published assets passed the mobile browser suite
  at 320/390/430/780px and desktop at 1440px, with mocked ACP/state and no models.
  Checks cover actual window scrolling, absence of a nested history scrollport,
  fixed header/composer, scrolling direction, keyboard viewport height/offset,
  draft and history position restoration, earlier history windows, following
  new output at the bottom, preserving an older reading position during output,
  switching views, light/dark theme, focus/touch geometry, inline recorder phases
  and duration, and readable microphone errors. Live thinking and long tool
  operation status
  were checked while reading older history, including Stop focus/touch sizing
  and status removal when the turn completes; desktop placement was checked too.
  Recorder states were injected
  through the component's real events; physical microphone hardware was unused.
- Real backend checks on the candidate and published assets opened existing
  history without prompting/cancelling a model. They cover eight mobile
  width/theme combinations, native touch document scrolling, short viewport,
  desktop transition and reload. JavaScript, JSON-RPC, HTTP and visible error
  banners were monitored; activity-state conflicts, if any, must recover with a
  subsequent successful PUT before the check passes.
- Targeted manual code review covered only owned changes because the branch
  contains unrelated WIP. The overlapping App.vue edits were not mechanically
  simplified. Scoped diff/whitespace checks passed with CRLF accounted for.

Local evidence is in `.agent-tmp/mobile-browser-voice-release/`, including
`deployment.json`, browser/build logs, before-build failures for document
scrolling and misplaced thinking status, source patch and browser screenshots.
Physical Safari/Chrome toolbar collapse, the on-screen keyboard and microphone
require device confirmation. Existing pages need reload.
