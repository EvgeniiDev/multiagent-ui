STATUS: DONE
## What was built

F5 dashboard + F6 agent-state strip, all numbers from the activity ledger (`src/stores/activity.ts`), every figure labelled with its range. No new runtime dependencies.

- `src/components/DashboardView.vue` (replaced placeholder) — shell: header + `Today · 7 days · 30 days · All` segmented range control (persisted in `preferences.json` as `dashboardRange`, `aria-live` announces range changes), then panels:
  - Summary strip (dense one-line-per-metric): tokens, cost (grouped by currency via `groupCost`, never summed across currencies), turns, sessions touched, tool calls.
  - Agent state strip (F6): per configured agent — transport kind, reachable = non-stdio transport (honest client-side proxy, labelled), current session title, "turn in flight" pill from `sessionStore.isLoading`, last ledger event time + text. Getting real ws reachability would need a bridge ping the session store does not expose.
  - By agent: table sorted by tokens desc — tokens, cost, turns, share-of-tokens bar (accent), last activity (`fmtAgo`); empty state "no usage recorded yet" + usage_update explainer.
  - By project: same shape; project = `projectName()` (last cwd segment), cwd in mono as `title` tooltip.
  - By day: hand-rolled SVG bar chart (no libs) — date X labels, compact token Y scale, hairline grid; gaps zero-filled so single-point and empty sets render as an empty state, never a broken axis; plus per-day tokens/cost/turns table.
  - Sessions top-10 by tokens in range (title/agent/project/tokens/cost/last turn); title click resumes via `sessionStore.resumeSession` inside try/catch, then opens chat view (no-op when the session is unknown to the session store).
  - Limits: quotas `{id,label,scope,target,period,currency?}` with inline add/edit/delete form; each row shows period-to-date ledger usage vs target, accent progress bar with % and `role="progressbar"`, danger-token warning state above 90 %; persisted in `loadKvStore('limits.json')` with `{version:1,…}`; period ("today / this week / this month") stated on every row. `currency?` is accepted in the type but the quota tracks tokens only — cost quotas are not implemented (see stubs).
  - Export: JSON + CSV via client-side Blob; filename `dashboard-<range>-<date>.json|csv`.
- `src/features/dashboard/range.ts` — range defs, `rangeBounds`, `rangeLabel`, bucket filler.
- `src/features/dashboard/format.ts` — `fmtInt/fmtCompact/fmtCost/groupCost/fmtAgo/fmtStamp/shortDate`.
- `src/features/dashboard/exportData.ts` — JSON/CSV builders + Blob download.
- `src/stores/limits.ts` — pinia quota store over `limits.json` (versioned), `periodStart` (Monday-first weeks).
- `scripts/e2e_dashboard.py` — seeds `localStorage['acp-ui:activity.json']` with a deterministic fixture (2 agents, 2 projects, 2 days), asserts summary/by-agent/chart/quota-warning/exports/range-switching/zero pageerrors. 16/16 PASS.
- Design: only `App.vue :root` tokens (with fallbacks), flat hairline borders, no shadows/gradients, mono tabular numbers, English strings, no emoji; dense 26–30px rows; focus-visible, aria-labels, table semantics; responsive: 2-col ≥1280px, 1-col ≥768px, stacked labelled rows + full-width 44px+ segmented control <768px.

## Evidence

Build (`npm run build:web`):
```
rendering chunks...
computing gzip size...
dist-web/index.html                   0.96 kB │ gzip:   0.49 kB
dist-web/assets/index-CKli8Udb.css   63.62 kB │ gzip:  10.04 kB
dist-web/assets/index-mMtcOqJ_.js     0.17 kB │ gzip:   0.16 kB
dist-web/assets/app-C--UO2wg.js       0.25 kB │ gzip:   0.21 kB
dist-web/assets/core-DsojzR6k.js      0.77 kB │ gzip:   0.41 kB
dist-web/assets/event-DRK-L59a.js     1.07 kB │ gzip:   0.58 kB
dist-web/assets/index-D8BamZOI.js     1.39 kB │ gzip:   0.69 kB
dist-web/assets/index-5FpjeHmg.js     1.53 kB │ gzip:   0.62 kB
dist-web/assets/stdio-BJ_0j-dr.js     1.63 kB │ gzip:   0.62 kB
dist-web/assets/index-CJTweURj.js   396.91 kB │ gzip: 145.23 kB
✓ built in 2.19s
```

E2E (`~/.hermes/tools-venv/bin/python scripts/e2e_dashboard.py` vs `dist-web` on port 25998):
```
[PASS] rail dashboard button exists
[PASS] summary tokens = 2,500
[PASS] summary turns = 3
[PASS] by-agent has 2 rows
[PASS] alpha tokens = 2000
[PASS] beta tokens = 500
[PASS] day chart renders
[PASS] chart covers fixture days
[PASS] quota below usage shows warning
[PASS] export json non-empty download
[PASS] export csv non-empty download
[PASS] range today updates label
[PASS] range 7d updates label
[PASS] range 30d updates label
[PASS] range all updates label
[PASS] zero pageerrors
16/16 assertions passed
```

Screenshots (pane-body captures; full-page shots were misleading because the shell's own ≤800px rail layout squeezes `.main-area` — a pre-existing shell issue, see Integration requests):
- `docs/dashboard-1440x900.png` (two-column panels, chart with bars)
- `docs/dashboard-1024x768.png` (single column)
- `docs/dashboard-390x844.png` (stacked labelled rows, full-width segmented control)

## Deliberate stubs

- "Reachable" dot = transport is non-stdio (proxy for reachability); no live ping — the session store exposes no bridge-probe API.
- Quota `currency?` field exists in the type but quotas track tokens only; cost quotas not built.
- Export covers summary + by-agent + by-day (CSV is per-day rows only); by-project and top-sessions are not exported.
- `recordUsage` dedup quirk in the activity store (an always-false `!(x) !== !(y)` condition) left untouched — ledger writes are not this workstream's file.
- Test server only: `dist-web` served via `python3 -m http.server 25998` during verification; no server code added.

## Integration requests

- `src/App.vue` (forbidden to touch): at ≤800px the shell keeps `.app-container` as `flex-direction: row` with a 46px+ rail while `.main-area` shrinks to ~180px — Dashboard content is squeezed even though the rail switches to `flex-direction: row`. Suggested: in the ≤800px block, set `.app-container.narrow-layout { flex-direction: column; }` so the horizontal rail sits above full-width content (matches the "rail becomes a horizontal bar" comment already in the CSS).
- `src/stores/session.ts` (forbidden): no change needed. Dashboard only reads `sessions, currentSession, isLoading, savedSessions` and calls `resumeSession` in try/catch.
- `src/stores/activity.ts` (forbidden): no change needed; consider fixing the `recordUsage` dedup condition (`!(sample.cost ?? 0) !== !(last.cost ?? 0)` is always false) in the owning workstream.

## How to review

```
cd /home/hermes/projects/acp-ui-cc-dash
npm run build:web
cd dist-web && python3 -m http.server 25998 &  # background
~/.hermes/tools-venv/bin/python scripts/e2e_dashboard.py
```
Then open http://127.0.0.1:25998/: with a fresh profile the Dashboard shows honest empty states; to see data, open DevTools before load and set `localStorage['acp-ui:activity.json']` to `{entries:[…], usage:[…]}` per the fixture in `scripts/e2e_dashboard.py`, reload, click the Dashboard rail icon (4th). Try: range buttons, Add quota with target 100 (warning row), Edit/Del, Download JSON/CSV.
