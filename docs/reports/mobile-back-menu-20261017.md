# Mobile system Back opens the menu — 2026-10-17

Scope: narrow browser/PWA layout (max-width 800px). System/browser Back from
content reveals the sidebar while retaining the selected section/session.
Back from the menu permits ordinary navigation out. Desktop navigation and
Tauri routing retain their existing behavior. No bridge lifecycle operations.

Implementation: one marked menu/page history pair. View changes replace mobile
page URLs; desktop entries do not inherit pair ownership. Session URL writes
notify the pair, including asynchronous session creation. The controller is
constructed before stores register window popstate listeners: capture alone
does not reorder window target listeners. URL preservation applies on both
Back and Forward. Reload reuses the pair, and resizing does not add entries.

Verification:

- Before change, `test_mobile_back_browser.cjs` failed waiting for the sidebar
  after browser Back (the document had navigated away).
- Isolated candidate based on main `8623aaff9ca58f31f089fd1248588a0e920ae172`,
  with only this task's changes; dependencies installed with `npm ci` there.
- `npm run build:web`: typecheck and production build pass.
- `scripts/test_mobile_back_browser.cjs`: real Chromium history + shell, isolated
  mocked state/ACP, at 390 and 1440 px. Covers menu/section consistency, repeated
  width changes, bounded history, reload, Forward, and navigation out.
- Additional real-browser tests use the actual session/view URL helpers for
  delayed session creation, URL writes while the menu is open, and desktop
  navigation between mobile layouts. No model prompts or user-state writes.
- Focused ce-code-review completed via `/root/review_mobile_back`: all observed
  issues fixed and rechecked; final verdict Ready to merge, no findings.
  Simplification review found no actionable reuse/quality/efficiency changes.

Release candidate frontend: `/assets/index-BcvEqZ1l.js`.
Live web mount inspected: `/home/hermes/projects/acp-ui/dist-web`.
Web image: `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.
Publish assets before index.html and retain older assets for open tabs.

Limits: Chromium automation exercises the same history traversal used by
system Back, but cannot establish physical Android/iOS gesture behavior.
On-screen keyboards may consume the first system Back to hide themselves.
Open PWA pages need a reload to receive the new frontend.
