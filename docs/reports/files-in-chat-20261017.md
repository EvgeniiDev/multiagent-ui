# Files in chat — published verification, 2026-10-17

Source revision: `45ab2ce00f09b8135596f457eb7ac6dc22065830` on `main`.
Built and published from isolated checkout `/tmp/acp-chat-files`; unrelated WIP
in the original and main worktrees was excluded. Integration verified the
pre-existing staged tree byte-for-byte after subtracting this feature patch.

## Behavior

- Local Markdown file/image links and local ACP resource links open inside chat.
- Images, plain text/Markdown/JSON/CSV/source and paginated PDFs can be viewed;
  other linked formats offer downloads with original bytes and filenames.
- Embedded ACP images, text and binary resources can be viewed/downloaded.
- Reader: regular project files up to 32 MiB; reject private/hidden paths,
  state storage and symlink escapes. Explicit artifact folders are allowed.
- Text preview truncates at 512 KiB with a notice; downloads retain all bytes.
- Loading/error/retry, disabled download, modal focus/Escape and stale-request
  cleanup are covered. See [file delivery conventions](../chat-files.md).

## Verification

- `npm run build:web -- --outDir /tmp/acp-chat-files-candidate`: Vue typecheck
  and production build passed. Existing large-chunk warnings remain.
- `node --test scripts/test_chat_files.mjs scripts/test_chat_files_client.mjs
  scripts/test_usage_endpoint.mjs scripts/test_push_relay.mjs`: passed.
  Tests use `NODE_PATH=/tmp/acp-chat-files/server/push/node_modules` for the
  existing separately packaged push dependencies. HTTP adapter and client
  guard tests cover Unicode, path/symlink/private-state denial, methods,
  missing/oversized/nonregular files and cancelling oversized responses.
- `scripts/test_chat_files_browser.cjs`: passed at 390/1440 on candidate and
  published assets. ACP/state records are fixtures; candidate file reads use
  the real socket adapter, published file reads use the actual state service.
  Image/PDF/text/ZIP, relative/Unicode/resource links, exact download bytes,
  512 KiB truncation/full download, loading/error, close/reopen races,
  shared hover/focus/disabled/touch styles and both OS color preferences pass.
  The existing Graphite theme remains the same under both OS preferences.
- `scripts/test_image_preview_browser.cjs`: candidate and published passed
  1440/390 including original image download bytes/name, attachments, replay,
  clipboard, file picker, drag/drop and composer behavior.
- `scripts/test_mobile_back_browser.cjs`: candidate passed mobile/desktop,
  delayed URL restoration and layout transitions after rebasing onto main.
- Baseline adapter test against pre-feature source returned 404 instead of
  the required 200. New reader returns exact bytes. No paid agents were run.
- Simplification: three independent passes; removed dead disclosure state,
  deferred text encoding and cancelled oversized bodies. Formal nine-lens
  review completed with no remaining findings. A credential exposure found
  during review was fixed and regression-tested before release. Independent
  cross-model corroboration was unavailable because the runner lacked jq;
  local adversarial fallback completed. Review receipt is in release evidence.

## Published runtime

Web mount verified: `/home/hermes/projects/acp-ui/dist-web` -> `/repo/dist-web`.
Older hashed files and the LAN CA download were retained; index replaced last.
Served index and entry assets match the candidate byte-for-byte:

- `/assets/index-ZD5gbYyr.js` SHA-256
  `fd39e98801435ccb6fa3a323f2ea4cb6a368b7a7b210dea383019b2b9f521f5e`
- `/assets/index-D0viUjjV.css` SHA-256
  `a678f8054b65192d2afd26cbe5004ffaec3c14cd673c73125e9a621d3a97ba35`

Only state was restarted to load the two changed, bind-mounted server files.
Its image remains `sha256:66ec5b5f1e7db15f82f0bcde10ab1ae655e9484551e7575ae2cb6d318f22f9bd`.
Container ID: `e1d5ddbe3095e7ac32e02d957c03918f714307bf0e666a32baf5bc0dd26b131a`.
Actual container file SHA-256 matches the isolated source:

- `server/acp-state-server.mjs`:
  `378a274b847380181de23b60e83fead29772da4d422cb98becf31e8577272523`
- `server/chat-files.mjs`:
  `1544e25171e79fb1b88cb71a402da297ef26fcbda72a9b5e3710355b770957f5`

Initial request during state startup saw 502; after readiness, health and all
file requests passed. Public endpoint denies `/etc/passwd` and the private
push store with 403. Published versioned CMap, WASM and actual font resources
return 200 (a manually guessed nonexistent FoxitSans filename returned the
correct 404, then the actual FoxitFixed resource was checked).
No bridge was restarted or reconfigured. All five bridge PIDs stayed unchanged:
Hermes 1901671, OpenCode 1902227, Devin 1902451, Pi 1664757, Codex 1024589.

## User test files and evidence

Eight demo files are retained under
`/home/hermes/projects/acp-ui/.agent-artifacts/preview-demo/`: PNG, SVG, TXT,
Markdown, JSON, CSV, a two-page Cyrillic PDF, and a ZIP containing the set.
HTTPS reads of every exact file were byte-compared with the originals.
Published Android-size browser check also opened the exact user PDF (both
pages and Cyrillic), SVG and TXT, and byte-checked the TXT download.
Browser screenshots and build/review evidence:
`/home/hermes/projects/acp-ui/.agent-tmp/chat-file-release/`.
Existing open pages need a reload to load this frontend.

Known limits: local files must remain in the allowed project folders;
external/container-only or `/tmp` files must be copied there. Unsupported
formats and encrypted/invalid PDFs can be downloaded. PDF rendering currently
uses a canvas without a selectable text layer. Not exhaustively exercised:
PDF CMap/WASM-dependent document decoding and concurrent same-relative-name
previews across two live agent sessions (request ownership is scoped in code).

Post-deploy validation: user tests the supplied files on Android PWA. File
errors should be visible and retryable; frontend entry hashes and state health
are the rollback diagnostics if errors appear. Rollback only the two server
files plus previous frontend index, retaining old assets and agent bridges.
