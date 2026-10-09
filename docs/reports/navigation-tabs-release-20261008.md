# Mobile navigation tabs — 8 October 2026

The mobile navigation row showed the menu and, only with two or more open
sessions, chat tabs. Main-view controls remained inside the drawer. The row
now includes Chat / Projects / Board / Dashboard and an open-session strip,
including a single session. Its contents scroll horizontally within the same
52px row. Navigation still appears on scrolling up and collapses down.

Chat panes stay mounted and hidden when switching sections, preserving the
composer draft and expanded history. Shared UiButton touch controls have both
a minimum height and width of 44px; their appearance uses existing theme tokens.

Verification:

- The four-section regression failed before this change.
- `npm run build:web -- --outDir .agent-tmp/navigation-tabs-release/dist-web`
  passed, including vue-tsc (existing chunk-size advisory).
- `scripts/test_mobile_navigation_browser.cjs` passed first against the staged
  assets and again against the served frontend at 320/390/1440px. This suite
  mocks ACP/state and uses native Chromium touch: both scroll directions,
  four section transitions, draft preservation, one remaining session tab,
  horizontal reachability, light/dark themes, 44px controls, keyboard focus,
  menu opening, visual-viewport shrinkage and a bounded 1000-message hidden pane.
- The actual served frontend and real backend restored the existing Codex
  session `01a11818-5bb2-7612-aa79-b65ea1bc2d30`, visited all four sections and
  preserved a local test draft. No model prompts, new sessions or cancellation
  were allowed. No page or JSON-RPC errors. Existing filesystem HTTP500s for
  missing `.acp/cards/<id>` directories were recorded and confirmed as ENOENT;
  they did not prevent navigation or chat restore.

Source: main, base `23cd35ab8f443b9885c3d6f36c33ea6bef47905f`, with dirty
frontend changes. Live checkout: `/home/hermes/projects/acp-ui-lead-integration`,
branch `ship/agent-modes-20261003`. All other frontend source files matched the
already deployed tree before publication. Source hashes, full frontend source
manifest, browser evidence and screenshot are in
`.agent-tmp/navigation-tabs-release/`.

Published to the inspected web bind mount, retaining older hashed assets and
replacing index.html last. Final served asset bytes verified after acceptance:
JS `index-DeBXuhIy.js`, SHA-256
`ed15e874f889aa04eacf26aecaa5a3a13d36b9a3db46024dce24904c199ed5c0`;
CSS `index-BguigbdW.css`, SHA-256
`8bc936d0967c580ba99b18a18ed41eb0297197c2eab0a01ffad1fc0fd471fdd8`.
Web container `9f3b63587b5d5dda98c293230439debcc02287ef78c6e3cc0d903f6c37def488`,
image `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.

No services were restarted or recreated. Every bridge retained its container
ID, start timestamp and image, verified before and after publication. Existing
pages need a reload.
