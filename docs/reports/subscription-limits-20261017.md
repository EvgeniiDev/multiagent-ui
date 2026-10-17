# Subscription limit display — 2026-10-17

Implemented in `9c872193f3280cfb25c8b5bc1b405f1e3f33b486` on `main`.

Dashboard now shows account subscription windows, percentage remaining, reset
times, update time, and per-provider availability. The server coalesces concurrent
reads and caches responses for one minute. Codex windows use the reported duration,
including weekly-only accounts and multiple buckets. OpenCode Go supports 5-hour,
weekly, and monthly windows. Claude currently has an explicit not-connected state;
its usage reader has not been implemented.

Codex uses the documented `account/rateLimits/read` app-server method with no
thread or inference request. The helper copies auth into a private temporary home,
waits for its own process to close, and removes the directory. This preserves the
real read-only Codex mount and avoids scanning session history. OpenCode reads
`GET https://opencode.ai/zen/go/v1/usage` using the configured Go key. Neither
credentials nor raw upstream error bodies are returned to the browser.

## Verification

- `NODE_PATH=/home/hermes/projects/acp-ui/server/push/node_modules node --test scripts/test_subscription_limits.mjs scripts/test_usage_endpoint.mjs`: 8 passed.
- `npm run build:web` in `/tmp/acp-subscription-release`: shared UI policy,
  TypeScript and Vite passed. Existing large-chunk warnings remain.
- Browser fixtures at 1440, 390 and 320 px passed: delayed loading, disabled state,
  hourly/weekly/monthly values, zero/exhausted quotas, expired reset, failure,
  retry, stale-data notice, reload, keyboard focus, hover, touch size, progress
  colors, no component overflow and no JavaScript page errors.
- Real browser at `https://192.168.1.222:25809/chat`, navigating to Dashboard,
  passed at 1440 and 390 px, including reload. No subscription API failures or
  JavaScript page errors. Provider success/failure scenarios above are fixtures;
  the live checks used actual account responses.
- Live Codex returned one weekly window (55% used at verification); no short
  window was returned. OpenCode returned HTTP 403: active Go subscription required.
  A successful OpenCode subscription response is verified with fixtures only.
  Claude has no live integration yet. The application uses its current graphite
  theme; a separate light theme is not provided by this change.

## Deployment evidence

The frontend was built from clean `main` source plus precisely this commit's UI
changes, with all relevant source bytes compared to the committed revision.
Unrelated staged edits in the main worktree were excluded using a separate Git
index for the task commit; the original index retained those edits.

The verified web bind mount is `/home/hermes/projects/acp-ui/dist-web` →
`/repo/dist-web`. Assets were copied without deleting old hashed files and
`index.html` was replaced last. HTTPS-served index and asset bytes matched the
candidate build:

- `/assets/index-XxKwGisn.js`: SHA256 `e6486438ec9de93879a8881222e7ca616bd736820d49e76480f573cda667fa64`.
- `/assets/index-CpH45qlV.css`: SHA256 `2ebd3a5036264a1a5c93853d2d7d92d52b1adf7a6124e9bbafe174cf0d74368a`.

Only the two changed backend files were published to the existing source mount;
`docker compose -f compose.yaml -f compose.prod-env.yaml restart state` reloaded
them. No bridge or web lifecycle operation was performed. State image remained
`sha256:66ec5b5f1e7db15f82f0bcde10ab1ae655e9484551e7575ae2cb6d318f22f9bd`;
runtime CLI reported `codex-cli 0.160.1`. Source hashes inside the live container:

- `server/usage/subscription-limits.mjs`: `22b39be02e93ad2953e5e2a6d6c147d036039a587ebc536045ab33be3e4be455`.
- `server/acp-state-server.mjs`: `016788ee4d513df930993e8140a83aff003440de9339ad8cb9d44193593db6c9`.

The TLS state endpoint `https://192.168.1.222:25910/api/subscription-limits`
returned the expected provider states and `Cache-Control: no-store`. Browser
screenshots were inspected at `/tmp/subscription-live-390.png` and fixture
screenshots at `/tmp/subscription-fixture-390.png`. Open pages need a reload
to receive the new bundle.

Watch the new endpoint for unavailable Codex responses after credential expiry;
the UI shows availability explicitly and offers retry. Account polling never
starts a model turn. No paid provider inference was used for verification.
