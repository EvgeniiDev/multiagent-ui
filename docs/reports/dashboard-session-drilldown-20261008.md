# Historical session drilldown verification — 2026-10-08

Fix commit: `88611b1`. Deployed to the existing web container via the live
checkout `acp-ui-lead-integration`, frontend assets copied with index replaced
last. No backend or bridge restart.

Root cause: Agent Activity used configured agents and the browser's current
session instead of native histories. Model rows had no drilldown. Historical
usage remained present in `/api/usage` but could not be traced in the UI.

Model clicks now show sessions for the exact model/provider and selected date
interval. Filtering happens before grouping, preserving a model's contribution
in mixed-model sessions. Session inspection exposes full ID, folder, agent,
selected-period usage and model contributions; saved chat opening is a separate
action. Native histories drive Agent Activity counts and its session drilldown.
The inspector and exports retain their documented full period scope; the
session panel labels its filtered subtotal and share denominator explicitly.

Validation:

- `npm run build:web`: passed.
- `node --test scripts/test_dashboard_aggregate.mjs scripts/test_usage_accounting.mjs`:
  13 passed.
- `scripts/test_dashboard_usage_browser.py` using built assets: passed ordinary,
  error, 52k-row and mixed-currency cases, including mixed-model same-session
  attribution and unsaved native inspection without browser activity entries.
- Actual `https://192.168.1.222:25809/dashboard`, no network mocks: verified
  Oct 1 in Asia/Karachi, desktop dark/light and phone dark. Exact model
  `gpt-6.1-sol` total **700,415,155**, five Codex sessions. Each row matched
  the actual API grouped by session ID; no page errors. Agent Activity also
  showed five Codex sessions and linked to its separately labeled total.
- Mobile widths 320, 360, 390, 430: no document horizontal overflow.
- Actual served index, JS and CSS matched the host build byte for byte.
  JS `index-CbtlseKJ.js` SHA256
  `725b33a0db8bbc7918e88e64dd4b21287965ad41ca4c0c66741358f8d98025c6`;
  CSS `index-CeiRMZYJ.css` SHA256
  `4bb39095529402cb3bf9981a02eda9543708fc3a2cacf2a44e0910fffa34d90c`.

Confirmed model contributions (tokens):

| Session | Tokens |
| --- | ---: |
| 01a0f3e6-cd15-7383-860c-f7a36171decf | 371,382,421 |
| 01a0f398-8c34-7911-a2b6-9b030c373a96 | 311,724,532 |
| 01a0f38d-daae-7441-97f2-308a59bdcb0e | 14,459,257 |
| 01a0f32b-9b2b-78b3-9d7b-1b786e53d09c | 2,563,928 |
| 01a0f3c8-40af-7940-8aca-c9bd722b46f7 | 285,017 |

Visual evidence and per-session API comparisons are in
`/home/hermes/.codex/visualizations/2026/10/07/01a11760-001f-7333-a356-8f7dd30b4408/dashboard-model-sessions-*`.
No model prompts were launched during verification. Unrelated compose and
adapter changes were excluded from the commit. Already open pages need reload.
