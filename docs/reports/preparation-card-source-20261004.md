# Preparation starts from the card — 2026-10-04

The backlog card already contains the initial idea. Preparation now saves pending
drawer edits, reads the authoritative card inside the command queue, and starts
a focused grilling/brainstorming conversation. It no longer asks for a second
copy of the idea. The snapshot includes title, description, acceptance criteria
and verification; restarting uses the current card. Explicit intent remains
supported for existing API clients.

The lead is instructed to read the idea, challenge unresolved assumptions and
explore alternatives one question at a time, using recorded answers. Existing
intent/document approvals and explicit implementation handoff remain in place.
Recommended available discussion skills are selected automatically; advanced
choices are collapsed. All changed actions use the shared UiButton component.

A joined board save now waits for the in-flight save and any queued edits. This
prevents preparation from starting with an older description when the user
edits immediately before clicking Start brainstorming.

## Verification

- Backend preparation state/lead: 37 tests passed.
- Execution UI/store, including delayed saves with concurrent edits: 76 passed.
- Preparation UI/payload/rendering: 26 passed.
- Host `npm run build:web`: passed; served asset `index-CMAEXlVR.js` verified at
  `https://192.168.1.222:25809/board`.
- Actual Chromium + production backend/provider: created an isolated reading
  queue card, changed its description immediately before start, verified the
  fresh description reached the lead without an intent input/payload, received
  a substantive clarification question, answered through the panel, and
  verified the answer survived reload. No browser errors or implementation run.
- Stopped the isolated QA discussion through the API and confirmed `stopped`.
  The user's Reddit card was not started or changed by this test.

This check covers the changed initial discussion and answer persistence. It did
not repeat the previously exercised full requirements/plan approval flow or
the three development modes; their downstream behavior was unchanged.

Local evidence (ignored runtime artifacts):
`.agent-tmp/autonomous/browser-production/prep-card-source-proof.json`,
`prep-card-qa.png`, and `check_prep_card_source.py` in the same directory.

## Deployment

Integration branch: `ship/agent-modes-20261003`. Runtime source mount:
`/home/hermes/projects/acp-ui-lead-integration`; frontend mount: its `dist-web`.
State and runner were restarted after backend verification; bridges unchanged.

Images verified in running containers:

- state: `sha256:c095adf10615e8379bd718bfbc05695f825338caa606cf03d6c1ba5e3afa41aa`
- runner: `sha256:512bc78ce2fe4a5ef74b424b1f8071a48b3194349a26ced3ef86d50bd0fcef83`
- web: `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`

Existing pages need a reload to load the new frontend.
