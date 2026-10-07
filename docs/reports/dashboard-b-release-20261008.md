# Dashboard B release verification — 2026-10-08

Approved direction: timeline first, period inspector, breakdown navigation,
compact phone rows, top 20 with expansion, newest days first. User approved
prototype B and its mobile/project views before implementation.

Implementation commit: `f2daa3b` on `main`, fast-forwarded into the running
`ship/agent-modes-20261003` checkout. Frontend built on the host and copied
into `/home/hermes/projects/acp-ui-lead-integration/dist-web`; index replaced
atomically after copying assets. No service restart, provider/model run, or
backend/bridge change was needed.

## Validation

- `npm run build:web` passed (existing large-bundle warning remains).
- `node --test scripts/test_dashboard_aggregate.mjs scripts/test_usage_accounting.mjs`: 13/13 passed.
- `scripts/test_dashboard_usage_browser.py`: built frontend with controlled
  history; checked five-agent accounting, cumulative deltas, separate currencies,
  selected 600-token day, known-zero cost coverage, full-range JSON export,
  search/empty results, table expansion, all range/day ordering, keyboard tabs,
  keyboard chart focus after reducing range, mobile 320/360/390/430px, quota form
  opening/cancellation, source error/retry, and 52,000 rows/200 projects.
- Separate code review identified export currency/unknown-cost semantics,
  stale chart focus, and selected-period coverage. All fixed; focused re-review
  passed. CSV/JSON leave scalar cost blank/null when unavailable or mixed;
  currency groups remain explicit and reported zero remains zero.

## Actual deployed page

Opened `https://192.168.1.222:25809/dashboard` in Chromium against the actual
HTTPS server and state API, without asset/API mocks or modified browser feature
flags. Tested dark desktop, dark phone, and light desktop. TLS certificate
validation was skipped for the local certificate only.

- desktop: 52,053 native records; UI **10,816,545,633 tokens**, exactly equal to the API snapshot. Selected final bar matched its exact count; clearing selection restored the full total. Projects/sessions/days render 20 rows; agents render 5. No page errors or usage HTTP errors.
- mobile: 52,053 native records; UI **10,816,545,633 tokens**, exactly equal to the API snapshot. Selected final bar matched its exact count; clearing selection restored the full total. Projects/sessions/days render 20 rows; agents render 5. No page errors or usage HTTP errors.
- light: 52,053 native records; UI **10,816,545,633 tokens**, exactly equal to the API snapshot. Selected final bar matched its exact count; clearing selection restored the full total. Projects/sessions/days render 20 rows; agents render 5. No page errors or usage HTTP errors.

Search preserved totals; days were newest first; mobile had no horizontal
page overflow at 320–430px and project rows were under 140px. Daily buckets use
the browser time zone (verified Asia/Karachi), including local day boundaries;
calendar stepping also handles DST boundaries.

Measured browser long tasks: desktop maximum 345ms, phone maximum 789ms,
light desktop maximum 675ms across initial loading and all tested flows.
Cold history collection and network waits are separate from UI blocking;
loading status stays visible during retrieval. Large histories still transfer
as a complete snapshot; opening every session row may render a long table.
Hermes historical day attribution and partial provider cost coverage are
explained under “About these numbers”.

## Artifact identity

Web image: `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.
Actual web bind mount: live checkout `dist-web` → `/repo/dist-web`.
HTTPS index and referenced JS/CSS were fetched and compared byte-for-byte with
this host build:

- `/assets/index-ifm0jPg_.js` — SHA-256 `37bdf518a4a8aee1547f3d492cfbbc385ada64bf7af32e08d4f16c5ee37ee788`
- `/assets/index-D1JRMWeg.css` — SHA-256 `a1aaad853be86c7e334b3702c81bf09f11b42255581d143073bffd6d54e4a4b7`

Screenshots and machine-readable evidence are in
`/home/hermes/.codex/visualizations/2026/10/07/01a11760-001f-7333-a356-8f7dd30b4408/`:
`dashboard-b-live-desktop.png`, `dashboard-b-live-mobile.png`,
`dashboard-b-live-mobile-projects.png`, `dashboard-b-live-light.png`,
`dashboard-b-live-evidence.json`.

Open browser tabs need a reload to receive this build. Concurrent Codex bridge
and Compose edits in the primary checkout were excluded from this change.
