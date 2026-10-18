# Session context and subscription popover — 2026-10-18

Implementation: `bd66b43ec951c7abfceffea7db76f35d20c16ffd` on `main`.

The existing context count now opens a compact, nonmodal usage card. Desktop
hover opens it temporarily; clicking pins it, and a second click closes it.
Touch, Enter, Escape, the close action, outside clicks, leaving the session and
keyboard focus are supported. Its placement uses the entire composer boundary
so it does not cover the text field. Without context data, supported agents
show `Limits` in the same location. Other agents retain access to context
details and an explicit subscription-unavailable note.

The card shows context separately from account subscription limits, filtered to
Codex, OpenCode or Claude for the current agent. It reuses `SubscriptionLimits`
in compact mode; the Dashboard keeps its existing presentation. Quotas load only
when the card opens and stop polling when it closes. This change adds no backend
requests beyond the existing read-only quota endpoint and never prompts a model.

## Verification

- Before implementation, the new browser check failed against the deployed
  baseline: there was no usable context/limits trigger before the first context
  update. The baseline context count was a noninteractive span.
- `npm run build:web`: shared UI policy, TypeScript and Vite passed. Existing
  bundle-size warnings remain. `git diff --check` passed.
- `node --test scripts/test_ui_library_policy.mjs`: 6 passed.
- `BUILD=/tmp/acp-session-limits/dist-web PLAYWRIGHT_MODULE=/tmp/acp-picker-qa/node_modules/playwright node scripts/test_session_usage_browser.cjs`:
  passed at 320, 390 and 1440 px. Covers no initial polling, delayed quota,
  provider isolation, real context frames, hover traversal, click pin/toggle,
  touch sizing, keyboard focus/Enter/Escape, outside dismissal, loading/error/
  retry, one meter while working, leaving the session, and zero prompts/new
  sessions. ACP/state/quota are browser fixtures in this run.
- Existing `test_mobile_context_browser.cjs` passed with candidate assets,
  including narrow screens, installed-PWA mode, long drafts, keyboard viewport,
  settings interaction and both color-scheme preferences. The current theme
  remains graphite.
- Existing `test_subscription_limits_browser.cjs` passed at 1440, 390 and
  320 px with candidate assets: Dashboard display and states preserved.

The first candidate exposed two issues that were corrected before deployment:
anchoring to the trigger covered part of the composer, and disabling a focused
Refresh button caused a null-relatedTarget focus event that closed its card.
The final candidate passed these paths.

## Production evidence

The clean isolated checkout `/tmp/acp-session-limits` was built at the committed
revision above. Only its explicit patch was integrated into `main`; unrelated
staged and unstaged changes in the main worktree were preserved.

The inspected live web mount remained
`/home/hermes/projects/acp-ui/dist-web` → `/repo/dist-web`. Assets were copied
without removing older hashes; `index.html` was replaced last. Its SHA256 is
`8e94aa4bb5e5ccb5af335e9eddc956c68a9893bec4d2acb5d4969ce0727cd13f`.
HTTPS-served index and primary assets were compared byte-for-byte with the build:

- `/assets/index-D-6ciUAf.js`: SHA256 `e2aa0350da26bcb36222293bfc7c1aaea99fe66e71c19e3d45339712c0af2b42`.
- `/assets/index-D35MWGl5.css`: SHA256 `8427eabcab1b0e7b207a867eed1191787912560f1bead07a4b000986e976b14d`.

`LIVE_LIMITS=1 PLAYWRIGHT_MODULE=/tmp/acp-picker-qa/node_modules/playwright node scripts/test_session_usage_browser.cjs`
passed against the deployed site at all three widths. This run used the real
quota endpoint and browser fixtures for ACP/state; it is not a live model turn.

A separate real-browser check used an existing, small saved Codex session at
`https://192.168.1.222:25809/chat`. Both fresh load and reload waited for a
successful actual `session/load` response and a settled connected runtime
before opening the card. The real Codex weekly quota was visible (95% left at
verification); the two checks took 22,430 ms and 7,118 ms including restoration
and opening the quota card. No `session/prompt` or `session/new` occurred, no
JavaScript page errors occurred, and quota HTTP responses were successful.
The inspected screenshot `/tmp/session-usage-live-card-1440.png` contains only
the usage card. Fixture screenshots are `/tmp/session-usage-fixture-320.png`
and corresponding 390/1440 variants.

One extra mobile verification attempt opened the card before restoration was
fully settled and did not observe the quota card in time. It is not counted as
reload evidence. The final real-session check explicitly waited for restoration
and passed both navigations. A transient upstream Codex unavailable state was
also observed during checks; a later real response returned normally. Fixture
checks cover unavailable/error/retry behavior without inventing zero usage.

No services were restarted or rebuilt. Bridges and agent CLI children were not
stopped. The web image remained
`sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.
Open pages need a reload to receive the new frontend bundle.
