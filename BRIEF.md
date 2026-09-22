# BRIEF — Dashboard (usage, stats, limits) for the acp-ui control center

You are implementing ONE workstream in a Vue 3 app. Work only inside this worktree
(`/home/hermes/projects/acp-ui-cc-dash`, branch `cc/dashboard`). When you are done, `REPORT.md`
must exist at the worktree root and your work must be committed on this branch.

## Read first (in this order)

1. `docs/control-center-requirements.md` — the requirements this workstream implements:
   **F5** (dashboard: tokens/cost/limits) plus **F6** where it concerns surfacing agent state;
   the non-functional rules **N1–N10** all apply.
2. `src/App.vue` — the shell has a view rail (Chat, Projects, Board, Dashboard); the Dashboard
   view is already wired to `src/components/DashboardView.vue`. Also read its `:root` token
   block AND its dark-mode block (`@media (prefers-color-scheme: dark)`).
3. `src/stores/activity.ts` — THE data source. Its header comment documents the whole API:
   `recent`, `entriesInRange`, `usageInRange`, `totalUsage(from,to)`,
   `usageByAgent(from,to)`, `usageByProject(from,to)`, `usageByDay(from,to)`,
   `dayRange(days)`, `recordEntry`, `recordUsage`, `liveSessions`.
   `ActivityEntry.kind` is one of: session-open, session-close, connected, disconnected,
   turn-start, turn-end, tool-call, usage, error, lock, sync.
4. `src/stores/session.ts` — read the exported names (sessions, agents, current session,
   `isConnected`, `isLoading`, `savedSessions`, `visibleSessions`); do NOT edit it.
5. `src/lib/host/storage.ts` — the KV store used for persistence on both web (localStorage)
   and desktop (Tauri store).
6. `src/components/SessionList.vue` — house style: dense rows, hairline rules, mono for
   numbers, no emoji, flat surfaces.

## Ownership — files you may change

- `src/components/DashboardView.vue` (replace the placeholder)
- new files under `src/features/dashboard/**`
- new file `src/stores/limits.ts` (your own pinia store for quotas)
- `scripts/e2e_dashboard.py` (your E2E script)
- `REPORT.md` at the worktree root

**Forbidden:** `src/App.vue`, `src/stores/session.ts`, `src/stores/activity.ts`,
`src/stores/ui.ts`, other views/stores, `package.json` dependencies, `vite.config.ts`,
`docs/**`. If you need a change in one of those, do NOT make it — describe it in `REPORT.md`
under `## Integration requests`.

Never run `systemctl`, never touch other worktrees or the main checkout
(`/home/hermes/projects/acp-ui`), and serve your test build only on port 25998.

## What to build (F5)

All numbers come from the ledger — never invent data, and label the range every figure covers.

1. **Range selector**: `Today · 7 days · 30 days · All`. Persisted with the view. Every panel
   on the page follows the selected range.
2. **Summary strip** (dense, one line per metric, no big decorative numbers): tokens used,
   cost (with currency when the agent reported one; if several currencies appear, group them
   instead of summing), turns, sessions touched, tool calls.
3. **By agent**: table — agent, tokens, cost, turns, share of tokens (bar), last activity.
   Sorted by tokens desc. Empty state: "no usage recorded yet" plus one line explaining that
   the numbers come from the agents' `usage_update` notifications.
4. **By project**: same shape, project = last path segment of the session cwd (use
   `projectName()` exported from the activity store), plus the cwd in mono as a tooltip.
5. **By day**: a hand-rolled SVG bar/step chart (no chart libraries) of tokens per day over
   the selected range, plus a table row per day with tokens/cost/turns. X axis labelled with
   dates (short form), Y axis with a token scale; bars use the accent token, grid lines use the
   hairline token. The chart must render with a single data point and with an empty data set
   (empty state, not a broken axis).
6. **Sessions top-N**: the 10 sessions with the highest tokens in range — session title, agent,
   project, tokens, cost, last turn time, and a click that opens the session in the chat view is
   a nice-to-have (the session store's `resumeSession` is available; if you use it, keep it
   inside a try/catch).
7. **Limits block** (the "subscription tracker" idea from the reference): a small list of
   user-defined quotas, each `{ id, label, scope: 'agent'|'project'|'global', target, period:
   'day'|'week'|'month', currency? }`, edited in an inline form (add/edit/delete). Each row shows
   the period-to-date usage against the target with a progress bar in the accent colour, the
   percentage, and a warning state (danger token) above 90 %. Persist in
   `loadKvStore('limits.json')` with a `version` key. The period-to-date usage is computed from
   the ledger; state clearly in the UI which period is being measured.
8. **Export**: a button that downloads the range data as JSON and as CSV (client-side Blob,
   no server). Filename must include the range and date.
9. **Agent state strip** (F6, small): per configured agent — reachable per its transport config,
   current session, turn in flight (`isLoading`), last event time and text from the ledger.

## Design rules (N2 — non-negotiable)

- Only tokens from `App.vue :root` (and the dark-mode block): no hardcoded colours in your CSS
  except inside `var(--token, #fallback)` fallbacks.
- Flat, hairline borders, **no box-shadows, no gradients**; one accent (terracotta); numbers in
  `var(--font-mono)` and tabular; UI strings English, short.
- No emoji; if you need an icon, inline stroke SVG in `currentColor`.
- Dense tables: 26–30 px rows, hairline separators, right-aligned numeric columns.
- Accessibility: focus-visible styles, `aria-label` on icon-only buttons, `aria-live` for the
  range-change loading state, `<table>` semantics for tabular data.

## Responsive (N1)

- ≥1280 px: two columns of panels; ≥768 px: single column; <768 px: every table becomes a
  stacked list of labelled rows (no horizontal scrolling), the range selector becomes a
  segmented control that fits the width, touch targets ≥44 px.

## Verification (required, N10)

1. `npm run build:web` must pass (vue-tsc + vite; type errors are failures).
2. E2E against the real build, with REAL data: the ledger is empty in a fresh browser, so seed
   it through the app's own path — the activity store is reachable from the page via the pinia
   app? It is not exposed globally, so instead seed `localStorage` before load: the activity
   store persists under the KV key `acp-ui:activity.json` with `{ entries: [...], usage: [...] }`.
   In the E2E script: `page.add_init_script` (or `page.evaluate` before reload) setting
   `localStorage['acp-ui:activity.json']` to a small deterministic fixture (a few turns, tool
   calls, usage samples across two agents and two projects on different days). Then assert:
   - the Dashboard view renders (switch via the rail button),
   - the summary strip shows the expected tokens/turns from the fixture,
   - the by-agent table has a row per agent in the fixture with the right token counts,
   - the day chart renders an SVG with at least one bar per day present in the fixture,
   - adding a quota with a target below current usage shows a warning state,
   - export buttons produce a non-empty download (Playwright `expect_download`),
   - zero `pageerror` events.
   Run it as: `npm run build:web`, then `cd dist-web && python3 -m http.server 25998` in the
   background, then `~/.hermes/tools-venv/bin/python scripts/e2e_dashboard.py` (playwright lives
   in that venv; use `sync_playwright`, chromium headless, `ignore_https_errors=True`).
   Print PASS/FAIL per assertion, exit non-zero on failure.
3. Screenshots at 1440×900, 1024×768, 390×844 into `docs/dashboard-*.png`, referenced in the report.
4. Paste the real command output (build tail + E2E output) into `REPORT.md`.

Do not try to talk to real agent bridges in the test; the fixture is the point.

## Report format (`REPORT.md`)

```
STATUS: DONE | PARTIAL | BLOCKED
## What was built          — panel by panel, with file paths
## Evidence                — build output tail, E2E output, screenshot paths
## Deliberate stubs        — honest list of what is mocked or unfinished
## Integration requests    — anything you needed in a file you may not touch
## How to review           — exact commands + what to click
```

## Working rules

- Small commits on `cc/dashboard`; commit once when the build first passes and again at the end.
  No merge commits, no rebases, no other branches.
- Prefer a smaller thing that fully works. If budget runs out, leave the build green and mark
  `PARTIAL` in the report.
- No new runtime dependencies (no chart, date or CSV libraries — hand-roll them).
- No network calls, no telemetry, no secrets.
