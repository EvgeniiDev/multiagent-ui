# PWA installation and chat completion notifications

Released on 2026-10-17 from `/home/hermes/projects/acp-ui`, branch
`feature/pi-session-image-cleanup`. Source baseline was
`07a57f5ec356b6a55a54e267826b13ea4d9bd9e8`; the feature commit containing this
report records the implementation. Pre-existing working changes were preserved
and excluded from the feature commit. The web build used the current checkout,
including its existing local customizations.

## Behavior

- Web builds expose a standalone manifest, PNG home-screen icons and a service
  worker. There is no worker fetch handler or offline transcript cache.
- Settings -> App & notifications offers installation instructions, per-device
  notification enrollment, test delivery, disable, and the required reload for
  existing chats. iPhone/iPad instructions require opening the installed app.
- Only enrolled devices route the five same-host bridges through a state-owned
  WebSocket relay. It keeps a pending prompt's upstream alive after the browser
  closes, then sends Web Push with the matching chat link. History replay and
  cancelled turns do not notify. Other remote agents retain their transport.
- Expired push subscriptions preserve working chat credentials. Shared settings
  state serializes mutations across closing/reopening the dialog. Upstream close
  diagnostics remain visible. A disconnected pending prompt is bounded to 24h;
  attached connections have no such deadline.
- Keys/subscriptions live in `STATE_DIR/.push/devices.json`, outside the flat KV
  namespace, with directory 0700 and file 0600. Dependency lockfile pins
  web-push 3.6.7 and ws 8.22.0; its npm audit reported zero vulnerabilities.
- Existing viewport/keyboard and safe-area handling remains useful in standalone
  mode and in browser tabs; it was retained.

## Verification

- `npm run build:web -- --outDir /tmp/acp-ui-pwa-build`: typecheck/build passed.
- `node --test scripts/u2_state_selftest.mjs`: 35/35 passed, real state/request
  implementation with isolated fixtures.
- `node scripts/test_ws_transport.mjs`: 10/10 passed.
- `node scripts/test_pwa_contracts.mjs`: actual client mapping for five plain/TLS
  ports, protocol retention and direct/remote/Tauri bypass; worker push content,
  exact-window focus, new-chat links, draft preservation and origin/path checks.
- `node scripts/test_push_relay.mjs`: real HTTP/WS relay with a stub upstream and
  injected push delivery; closed-client completion, replay/cancel silence,
  parallel sockets and shared-session request IDs, 410 recovery, diagnostics,
  malformed upgrades, persisted keys and private storage namespace/permissions.
- `scripts/test_pwa_browser.cjs` passed at 320/390/1440px against both the
  candidate and published HTTPS assets. Actual worker registration and CDP push
  injection produced a browser notification. Subscription/provider responses
  and ordinary state/ACP are mocked in this suite. It covers permission denial,
  pending/disabled/error states, test/disable, reload restoration, refresh error,
  Settings remount during delayed DELETE, reload instruction persistence, theme,
  focus, 44px touch sizing, overflow and page errors.
- Nine scoped review lenses ran; eight distinct findings were fixed. One fresh
  validator confirmed all eight absent in current code. Additional independent
  inspection confirmed the private-storage boundary. The cross-model pass did
  not run because its whole-tree diff would include excluded pre-existing WIP;
  the local adversarial review covered the bounded feature scope.

The first new relay test failed before implementation because its module did not
exist. The extended browser test reproduced the missing Reload app control after
Settings remount before shared settings state fixed it. A browser harness focus
assertion was corrected to enter keyboard modality before measuring focus style.

## Publication and actual production checks

Verified web mount: `/home/hermes/projects/acp-ui/dist-web` -> `/repo/dist-web`.
Published candidate files without deleting old hashed assets, replacing
`index.html` last. Served index, entry JS/CSS, manifest, worker and PNG bytes
matched the candidate on `https://192.168.1.222:25809`.

- JS `/assets/index-CMg6kU0U.js`, SHA-256
  `0ed2b50d4bae86d45ad4fecf8367baf465d15d7f8f99ac7c0db5a404bc5685d7`.
- CSS `/assets/index-CvUtdJfO.css`, SHA-256
  `b900d738ac15312fb8a9dd7c10c0ef182f1ddc0731c3b7d4d461b6cae8224da2`.
- State image:
  `sha256:66ec5b5f1e7db15f82f0bcde10ab1ae655e9484551e7575ae2cb6d318f22f9bd`.
  Image dependencies were inspected as web-push 3.6.7 / ws 8.22.0.

State alone was rebuilt/recreated using the existing Compose ownership and
`compose.yaml` + `compose.prod-env.yaml`, with `--no-deps`. During verification,
state was stopped briefly to move this release's initial credentials into their
private subdirectory without losing enrollments, then started again. Health and
push config remained available; private nested KV path returns 400 and the old
flat document returns 404. No web restart was needed.

Actual production HTTPS subscription registration and WSS relay `initialize`
succeeded for Hermes Agent, OpenCode, Devin, Pi and Codex. The temporary test
device was removed. No model prompts were sent. All five bridge process IDs
remained unchanged: 1901671, 1902227, 1902451, 1664757, 1024589 respectively;
selected host mode was unchanged. Runner, cron and other workers were untouched.

Evidence: `.agent-tmp/pwa-release/`; review receipt and detailed artifacts were
retained locally under `/tmp/acp-pwa-review/`.

## Limits and operational checks

Physical phone installation, app suspension and external provider-to-phone push
delivery are not claimed verified. The user must install from the trusted HTTPS
origin, open the home-screen app on iOS, grant notification permission, reload,
and send a new prompt; enrollment does not retrofit an already-running direct
connection. Send test notification provides a device-level delivery check.

Notifications currently cover chat prompt completion/errors, not managed board
run lifecycle. Browser/device notification settings and network/provider
availability still govern delivery. State must stay running for relay-owned
prompts; a state restart interrupts those relay sockets.

After release, inspect state health and `Web Push delivery failed` status/code
logs during the first device test. Expected signals are successful enrollment,
successful test send, correct chat opening and preserved ordinary chat reconnect.
If notifications disrupt chat connections, disable them on that device and
reload to restore direct transport; frontend rollback can restore the saved
previous index while retaining assets. No bridge lifecycle operation is part of
that mitigation. Existing pre-work whitespace findings remain outside this diff;
the feature's staged diff check passed.
