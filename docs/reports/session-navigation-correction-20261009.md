# Mobile session navigation correction — 2026-10-09

The prior navigation-tabs release misinterpreted tabs as application sections.
Removed Chat / Projects / Board / Dashboard from the scroll-revealed row.
The row now contains the menu button and open session tabs, including one session.
The menu opens the sidebar; scrolling up reveals the row, scrolling down hides it.
Existing horizontally scrollable session tabs, viewport sizing and drafts remain.

## Verification

- Browser regression failed against the previous deployed frontend: four unwanted
  section buttons appeared where zero were expected.
- `npm run build:web -- --outDir .agent-tmp/session-navigation-release/dist-web`
  passed, including TypeScript checking.
- `scripts/test_mobile_navigation_browser.cjs` passed against staged assets and
  the published site at widths 320, 390 and 1440. Mock ACP/state checks cover
  native touch scroll, session switching/selected state, separate drafts,
  a single remaining tab, horizontal access, menu drawer, light/dark theme,
  44px menu target, focus outline and visible viewport composer bounds.
- Real backend browser restored Codex, Devin and Pi sessions without a model prompt.
  Session tabs appeared beside the menu, the menu opened the sidebar without
  changing the session, and the composer fit inside the viewport. No JavaScript
  or JSON-RPC errors. One HTTP409 on activity.json was observed during concurrent
  activity updates; this check did not establish its subsequent retry outcome.
- Actual served index/JS/CSS bytes matched the built artifacts. Older hashed
  assets were retained and index.html was replaced last.
- All container IDs, images and start timestamps remained unchanged, including
  all five bridges. No service lifecycle operations were performed.
- Diff whitespace checked with `core.whitespace=cr-at-eol` for the repository's
  existing CRLF source. Physical phone testing was not performed.

## Deployment

Source: main checkout `/home/hermes/projects/acp-ui`, base commit `62f4addd064fe4932f774829860eaef4bb6a619a`
plus recorded uncommitted changes. Live checkout:
`/home/hermes/projects/acp-ui-lead-integration`, branch `ship/agent-modes-20261003`.
Web mount: live checkout `dist-web` → container `/repo/dist-web`.
Web container `9f3b63587b5d5dda98c293230439debcc02287ef78c6e3cc0d903f6c37def488`; image `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.

Served artifacts:

- `/assets/index-BrtbzCUd.js` SHA256 `0e9ba6b26b37ccaeac35b88bba16744b74a39f22b16afdbe2907adb21dc89027`
- `/assets/index-CTXWf6_e.css` SHA256 `811108b10f56df6c43ab46b3db73113f6891ee1cd2b378a9e3a74fcce479eac6`

Evidence: `.agent-tmp/session-navigation-release/` contains deployment metadata,
source hashes, browser results/screenshot, previous index and lifecycle snapshots.
Open tabs require a reload to receive the updated frontend.
