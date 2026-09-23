# W6-B — Autonomous run: auto-approve without permission dialogs + audit

**STATUS: DONE** — build green, e2e 15/15, zero pageerrors.

## What was built

- **`src/stores/session.ts`** — per-run `autonomous` flag (default off;
  `createSession`/`resumeSession` take `options.autonomous`; reset on every
  connect/disconnect, never a global toggle). Permission requests from the
  bridge route through `handlePermissionRequest`: autonomous sessions answer
  immediately with the agent's `allow_once` option (no dialog, so App.vue
  mounts no `.permission-dialog`) and audit; manual sessions publish the
  request for the dialog and arm a real `setTimeout`. `resolvePermission` /
  `cancelPermission` clear the timer and the dialog state. `disconnect` and
  transport-close clear both. Exports: `PERMISSION_TIMEOUT_MS` (default
  120000), `setPermissionTimeoutMs()`, `setAutonomous()` /
  `setPermissionTimeout()` actions, `autonomous` + `permissionTimeoutMs`
  state.
- **`src/stores/activity.ts`** — new `ActivityKind` `'permission'`. Every
  auto-approval writes one entry: agent, session, `title` = the agent's
  tool-call title, `detail` = chosen option + `auto-approve: autonomous run`.
  No allow option offered → an `auto-deny` entry, never silence. Timeouts →
  a `permission request timed out after Ns (no answer)` entry. Read by
  Events/Timeline tabs with no changes needed there.
- **`src/components/PermissionDialog.vue`** — always-visible time-limit
  line (`Ответ нужен в течение N с — иначе запрос закроется сам.`), N from
  the store ceiling (120 с by default). Tokens only, one muted style.
- **`src/components/ChatView.vue`** — `auto` badge next to the agent name
  in the chat header when the session is autonomous (token-styled mono
  chip); exposes `window.__session` + `window.__activity` for the e2e (same
  shape as `window.__projects`).
- **`scripts/e2e_auto_approve.py`** (new) — self-serves `dist-web` on port
  **25989**, mocked WS agent via `page.route_web_socket` (handshake +
  `session/request_permission`, synchronous replies, no sleeps in the
  handler; the timeout case shortens the real constant through
  `__session.setPermissionTimeout(1500)`).

Untouched per scope: `src/stores/board.ts`, `src/features/board/**`,
`src/stores/roles.ts`, `src/App.vue`.

## Verification output (real)

### `npm run build:web`

```
vite v6.4.1 building for web...
transforming...
✓ 271 modules transformed.
rendering chunks...
computing gzip size...
dist-web/index.html                   0.96 kB │ gzip:   0.50 kB
dist-web/assets/index-B0PxCoK2.css  119.94 kB │ gzip:  16.31 kB
dist-web/assets/index-mMtcOqJ_.js     0.17 kB │ gzip:   0.16 kB
dist-web/assets/app-C--UO2wg.js       0.25 kB │ gzip:   0.21 kB
dist-web/assets/core-DsojzR6k.js      0.77 kB │ gzip:   0.41 kB
dist-web/assets/event-DRK-L59a.js     1.07 kB │ gzip:   0.58 kB
dist-web/assets/index-D8BamZOI.js     1.39 kB │ gzip:   0.69 kB
dist-web/assets/index-5FpjeHmg.js     1.53 kB │ gzip:   0.52 kB
dist-web/assets/stdio-C82-FncS.js     1.63 kB │ gzip:   0.62 kB
dist-web/assets/index-URLPmOnq.js   498.42 kB │ gzip: 174.22 kB
✓ built in 2.73s
```

### `~/.hermes/tools-venv/bin/python scripts/e2e_auto_approve.py`

```
PASS  auto: agent receives an answer  ({'jsonrpc': '2.0', 'id': 9001, 'result': {'outcome': {'outcome': 'selected', 'optionId': 'allow-auto'}}})
PASS  auto: answer selects the allow-once option  ({'outcome': 'selected', 'optionId': 'allow-auto'})
PASS  auto: no .permission-dialog in the DOM
PASS  auto: chat header shows the auto badge  (auto)
PASS  auto: ledger has a permission entry  ([{"kind": "permission", "title": "Run approved tool (auto)", "detail": "auto-approve: autonomous run (option \"Allow once\" / allow-auto)"}])
PASS  auto: entry says what/why (title + auto-approve)  ([{"kind": "permission", "title": "Run approved tool (auto)", "detail": "auto-approve: autonomous run (option \"Allow once\" / allow-auto)"}])
PASS  manual: dialog appears
PASS  manual: dialog says the answer is time-limited  (Ответ нужен в течение 120 с — иначе запрос закроется сам.)
PASS  manual: human answer reaches the agent  ({'outcome': 'selected', 'optionId': 'allow-manual'})
PASS  manual: dialog closes after the answer
PASS  timeout: dialog appears first
PASS  timeout: dialog closes by itself
PASS  timeout: agent receives a cancelled outcome  ({'outcome': 'cancelled'})
PASS  timeout: ledger records the timeout  ([{"kind": "permission", "title": "Run approved tool (timeout)", "detail": "permission request timed out after 2s (no answer)"}])
PASS  zero pageerror events

15/15 assertions passed
```

## Not verified / known limits

- Tauri build (`npm run build`) not exercised — changes are host-agnostic
  (store + two components, no host APIs touched).
- The auto-deny branch (agent offers no allow option) is implemented and
  audited but not covered by the e2e — the mock always offers `allow_once`.
- Production callers don't set `autonomous: true` yet (role/card dispatch
  is another branch's workstream); the flag is wired at
  `createSession`/`resumeSession` and flipped via `setAutonomous()` for now.
- Timeout re-arming across reconnects: a transport close clears the timer;
  re-attaching to a half-answered agent request is the agent's decision.

## Integration requests

None — no changes needed in `board.ts`, `features/board/**`, `roles.ts`,
or `App.vue` for this workstream.
