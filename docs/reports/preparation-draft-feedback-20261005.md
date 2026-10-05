# Draft request feedback and artifact import — 2026-10-05

The Reddit requirements button appeared available again after a request.
Its first attempt returned another scope proposal without a document; the
second wrote a real artifact but paused in the skill's terminal routing menu.
Neither outcome supplied a requirements pointer to the panel.

The UI now immediately disables the action and labels submission, accepted
generation or waiting for an answer. A local guard covers the interval before
the next authoritative poll; an active draft covers reload and subsequent
polls. Native questions are treated as waiting, rather than a working spinner.
Missing-document failures offer an explicit retry.

The draft prompt uses the already accepted idea without asking for redundant
scope confirmation. A settled draft without a document becomes a retryable
error. A fresh declared workspace artifact can complete a known terminal
routing menu without selecting shipping or fabricating an answer. Recovery
after restart imports the existing attempt-age artifact and marks only the
validated routing question deferred. Genuine content questions remain open;
import is refused if such a question coexists with the routing menu.

Verification:

- Preparation lead/state: 42 tests passed; preparation UI: 33 passed.
- Host build passed. Final deployed frontend: `index-DVkIC8LH.js`.
- Browser-only delayed POST/poll test: immediate disabled Submitting state,
  then accepted Creating state; repeated click sends exactly one mocked
  command. No production command or provider call from that test.
- Actual production Reddit request recovered through the running backend:
  requirements version `v_de033507-cd43-416e-a6d5-6f10fc6ea79d`, 9,022 bytes,
  canonical card document pointer and preparation pointer agree. Browser shows
  document review, not another Create button. Terminal shipping route closed;
  no answer, approval or implementation command invented. No browser errors.
- Local evidence: `.agent-tmp/autonomous/browser-production/`:
  `check_draft_button.py`, `check_imported_requirements.py`,
  `imported-requirements-proof.json`.

Deployed on `ship/agent-modes-20261003` through existing source/dist-web mounts.
State and runner restarted after backend tests; no active implementation runs
existed. Bridges and images unchanged. Existing pages require reload.
