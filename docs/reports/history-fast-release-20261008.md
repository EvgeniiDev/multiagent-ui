# History tail and mobile viewport fixes — 8 October 2026

The local history cache was being evicted by large tool payloads, only worked
in the same browser, and restored after an awaited ACP session inventory.
Hidden chat panes also treated their zero height as an underfilled viewport,
recursively expanding the whole message window.

The frontend now keeps a bounded local tail and a shared per-session copy in
the existing state server. Oversized tool details are omitted from the cache;
ACP restores them in the background. Replay prefixes stay outside the DOM and
are never saved as the newest tail. Session-list fetching does not block
restoration. Hidden panes cannot grow their history window.

## Verification

- `node --test scripts/test_history_cache_budget.mjs scripts/test_history_shared_cache.mjs scripts/test_session_replay_activity.mjs scripts/test_new_session_gate.mjs`: 16 passed.
- Oversized-cache regression failed before the fix. Replay tests cover shared
  snapshots arriving during replay and after closure/completion, identity,
  offline fallback, stale-write protection, and historical activity suppression.
- Real chat: `01a11818-5bb2-7612-aa79-b65ea1bc2d30`, at the user's HTTPS address.
  Final deployed assets: fresh context showed the tail in **1044 ms**; reload
  in **2081 ms**. Full restores completed in 4359/3673 ms. These are browser
  measurements on this host, not phone hardware latency guarantees.
- With a genuine ACP load response delayed by four seconds, shared text was
  already visible at 1472 ms; restore finished at 7208 ms. Different sessions
  and the same session in two simultaneous contexts restored successfully,
  with matching session IDs and no page/JSON-RPC errors.
- Initially only 30 rows of the 46-message full transcript render. A mocked
  1000-message hidden pane stays at 30 rows in the browser regression below.
- Managed card `49739980-2c79-468e-9fac-a8fd8cd96f67` read its real state during
  a pending restore, then again after reload (2195/2248 ms from navigation).
  Full restores completed in 8096/6767 ms, including the deliberate delay.
  The enable action did not appear for this managed card.

An entirely uncached session still needs its first full ACP replay. Shared
cache GET404 for missing documents and CAS PUT409 conflicts were observed;
cache/session retries succeeded. Existing activity CAS conflicts were also
recorded. The managed card's separate filesystem panel returns HTTP500 because
its `.acp/cards/<id>` directory is absent (confirmed ENOENT); managed-state
reading succeeded. No model prompts, execution commands or process restarts
were used for these checks.

Browser evidence: `.agent-tmp/history-fast-release/{baseline,preview,deployed,final-check,board-final-check}.json`.

## Mobile navigation and clipping

After the owner’s correction, scrolling up reveals the menu and tabs;
scrolling down collapses them. The corrected direction regression failed on
the inverted deployment and passed on the replacement. Automatic replay/scroll corrections do not toggle
navigation. The shell follows the visual viewport height on mobile, with a
100dvh fallback, preserving composer visibility as browser bars or the keyboard
change the visible area. Pinch zoom does not resize the shell.

`PLAYWRIGHT_MODULE=/tmp/acp-layout-check/node_modules/playwright node scripts/test_mobile_navigation_browser.cjs`
passed against the actual served frontend at 320/390/1440 px. This test uses
mocked ACP/state, native Chromium touch, both themes, menu opening, a simulated
visual-viewport reduction with preserved draft, and the 1000-message hidden
pane. The clipping regression failed on the previous frontend. No physical
phone or native Chrome toolbar was available in this automated check.

## Final publication

Built in the agent container with `npm run build:web -- --outDir .agent-tmp/mobile-viewport-release/dist-web`, including vue-tsc.
Source: `main`, base `f0cd83acfa1c3a30b8bdf29e089584a13f8942f0`, with dirty
source hashes recorded in `.agent-tmp/mobile-viewport-release/deployment.json`.
Live checkout: `/home/hermes/projects/acp-ui-lead-integration`, branch
`ship/agent-modes-20261003`. Verified the existing web mount
`dist-web` → `/repo/dist-web`; preserved old hashed assets and replaced
`index.html` last through the Docker socket. Verified final HTTPS asset bytes
again after browser acceptance.

- JS: `index-oji2l2rN.js`, SHA-256 `cc524507f62ab99efd5e8164f76ad3a7571c6fd1b626cd82de08cac5822c5227`.
- CSS: `index-Dw67CBQc.css`, SHA-256 `62f76c720e321559601bc03a8e226614267fa1ed2f62bd4512ebb8bc9782f5a0`.
- Web container: `9f3b63587b5d5dda98c293230439debcc02287ef78c6e3cc0d903f6c37def488`, image `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.

Unchanged state/bridge container identities and all mounts are recorded in the
same deployment JSON. Existing pages need a reload.

## Post-Fix Quality

Scope: targeted manual review of cache/replay, navigation direction and
viewport listeners; unrelated branch work preserved. Simplification skipped
for the small viewport/direction fix. Review checked cached/replayed identity,
CAS fallback, closed-session guards, listener cleanup and pinch handling.
Re-verification: build, scoped unit tests, deployed layout regression, real
chat restoration, parallel contexts and real managed-card reads. Residual:
the existing missing card artifact directory described above; no tracker
record created. No commit or push requested for this follow-up.

Direction-only follow-up publication: `.agent-tmp/mobile-direction-release/deployment.json`; built with `npm run build:web -- --outDir .agent-tmp/mobile-direction-release/dist-web`. Deployed assets passed the same native-touch regression at 320/390/1440 px, including the composer viewport and hidden-history checks. Web container/image/mount unchanged.
