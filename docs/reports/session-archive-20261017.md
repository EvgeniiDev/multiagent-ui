# Session archive — 2026-10-17

The X in the sessions list now archives a saved chat instead of merely closing
its tab. Archived chats leave the main history, remain available through the
archive icon, and can be restored. Transcript and attachment records are not
deleted. All saved rows are archivable, including rows without an open runtime.
Transient pending/failed creations without saved session metadata retain Close.

Archive state is stored alongside session metadata as archivedAt: a positive
timestamp marks an archived chat; null records explicit restore; absence keeps
legacy filtering. Agent inventory updates preserve this field. Archive state
is persisted before detaching an open runtime; startup does not reopen archived
tabs. Explicit restore overrides legacy capability/prefix hiding so the restored
row cannot vanish from both lists. Closed sessions whose agents cannot resume
show Cannot reopen rather than silently attempting an unsupported request.

Validation:

- Baseline browser regression failed because Archive session was absent.
- Isolated build based on main 44d64e5117a2974bbcc8a3e968c505650e0c4092;
  uncommitted work was excluded. npm ci and npm run build:web succeeded.
- Updated existing test_mobile_sessions_page_browser.cjs: real Chromium UI and
  deterministic state/ACP boundaries, widths 320/390/780/1440, both themes,
  focus, disabled/pending/failure/retry, edge tap, archive open and closed chats,
  agent refresh without resurrection, reload, archive view and restore,
  unsupported+prefix-hidden restore, and desktop archiving. All passed.
- Focused review executed the actual session store using real Vue and Pinia
  with isolated persistence/runtime boundaries, including save rollback.
  Final ce-code-review verdict: Ready to merge; no remaining findings.
- Simplification reuse, quality and efficiency passes found no actionable changes.
- Model calls and live user session writes were not used for testing.

Release uses the inspected web mount /home/hermes/projects/acp-ui/dist-web,
retains older hashed assets, and publishes index.html last. No service lifecycle
changes are required. Open pages need Settings → Reload app.

Limits: reopening history still depends on the agent's load capability. This
change retains archived metadata and the existing transcript/attachment records;
it cannot add a missing agent resume capability. Browser fixture checks do not
claim a live-provider execution.
