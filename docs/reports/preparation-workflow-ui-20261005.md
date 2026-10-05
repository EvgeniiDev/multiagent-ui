# Preparation sidebar workflow — 2026-10-05

Branch: `ship/agent-modes-20261003`, production checkout:
`/home/hermes/projects/acp-ui-lead-integration`.

## Result

The sidebar shows four stages: Discussion → Requirements → Plan → Handoff.
The current stage and its next action appear before the conversation history.
Canonical requirements and plan content are readable and explicitly approved
inside the preparation panel. Plan verification commands are shown before
approval. Earlier questions, decisions, settings and development controls remain
available in collapsed sections. Implementation still requires an explicit
handoff and a separate launch.

A document approval sends the exact reviewed version/hash and then confirms
its matching artifact gate with an exact subject pin. The server rejects a
changed subject with `409 gate_subject_changed`. A core approval alone does
not advance the UI while a required artifact gate remains pending.

## Verification

- Preparation UI: 34 tests passed.
- Canonical document reader: 6 tests passed, including errors, wrong version,
  plan checks and unsafe Markdown HTML/links.
- Preparation lead/state: 43 tests passed, including stale subject rejection.
- Execution UI: 76 tests passed.
- Host web build and diff whitespace check passed.
- Production browser read the Reddit card's real requirements version
  `v_de033507-cd43-416e-a6d5-6f10fc6ea79d` and rendered the full document.
  History and development controls were collapsed. Keyboard focus, hover,
  light/dark theme and a 390px viewport were checked; no horizontal overflow,
  JavaScript errors or failing execution-card responses were observed.
- Browser transitions Requirements → Plan → Handoff used intercepted server
  responses. All approval/generation POSTs were intercepted. This proves the
  frontend transitions, not a new production provider run. The user's real
  requirements/plan approvals and development execution were untouched.

Evidence: `.agent-tmp/autonomous/browser-production/prep-wizard-proof.json`,
`prep-wizard-light.png`, `prep-wizard-dark.png`, `prep-wizard-mobile.png`.
Two harness failures were corrected: readiness was initially missing from the
mock card summary, and programmatic focus needed keyboard modality to check
`:focus-visible`. Neither represented a product failure.

## Deployment

The existing web container serves the checkout's bind-mounted `dist-web`.
The user's HTTPS URL serves `index-CcRSZIyp.js` and `index-B3nPC1B6.css`.
The state service uses the same checkout mounted at `/repo`; it was restarted
through Compose after the usual service/port preflight. Its image is
`sha256:c095adf10615e8379bd718bfbc05695f825338caa606cf03d6c1ba5e3afa41aa`.
The frontend and state changes were verified after deployment. Runner and
bridge services were not changed. Existing browser tabs need a refresh.
