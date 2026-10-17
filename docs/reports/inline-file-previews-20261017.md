# Inline file previews — published verification, 2026-10-17

Source: `bd72a8011a799bd6c17079516954a2806f38c6dd`, committed on main.
Built from clean isolated checkout `/tmp/acp-inline-previews`, rebased onto
`6f0a3ea` before the final build. Main integration preserved the pre-existing
staged tree exactly after subtracting this feature's patch. Unrelated root
and main-worktree changes were excluded.

## Delivered behavior

Text/Markdown/PDF file links in assistant replies now produce preview cards
under their text segment. ACP text and PDF attachments use the same cards.
Text shows a 2000-character excerpt (read from an 8192-byte prefix); Markdown
retains safe formatting; PDF cards render the first page at thumbnail scale.
Open retains the full viewer/download behavior and reuses loaded bytes.

Only cards near the viewport in the active chat load file bytes; leaving or
hiding them aborts reads and releases objects/workers. The existing reader's
32 MiB limit remains. Markdown file HTML is escaped and document-supplied
links/images cannot run scripts or issue network requests. MIME-only Markdown
and .md/.markdown files use the same classification in card and full viewer.
No backend, dependency or bridge change was needed.

## Evidence

- `npm run build:web -- --outDir /tmp/acp-inline-candidate`: typecheck and build
  passed on final committed source. Existing large-chunk warnings remain.
- `node scripts/test_chat_files_client.mjs`: four tests pass, including
  in-memory Blob/text reuse without refetch, size guards and shared Markdown
  classification including MIME parameters.
- Updated `scripts/test_chat_files_browser.cjs` failed against the old published
  UI because no file card existed, then passed at390/1440 on final candidate
  and published UI. Protocol and KV state are fixtures; file reads use the real
  local HTTP adapter on candidate and the actual deployed backend on production.
- Browser checks cover pre-click formatted Markdown/text/PDF cards, embedded
  JSON and MIME-only Markdown, Open/full view/download byte equality, no extra
  HTTP read on loaded-card Open, first-page-only PDF card, scroll-away delayed
  response cancellation and return, loading/errors/retry controls, replay and
  reload. Both OS color preferences and shared hover/focus/disabled/touch styles
  were inspected. Existing Graphite palette is retained in both preferences.
- PDF tests wait for completion/no renderer error and inspect nontransparent
  dark ink pixels, rather than treating default canvas dimensions as a render.
- Markdown tests include raw HTML onerror, scripts, javascript links and remote
  image URLs; no active elements, script execution or document network fetches.
- Existing `scripts/test_image_preview_browser.cjs` passed1440/390 after final
  build, including attachments, original image downloads, focus, replay,
  clipboard, file picker and drag/drop/composer behavior.
- Published smoke also opened the exact user files `hello.txt`, `report.md`,
  `document.pdf` from `.agent-artifacts/preview-demo/`: text, formatted Markdown
  and rendered PDF were visible before opening a modal. TXT Open/download
  retained the exact original bytes. Screenshots are in the evidence folder.
- Eight-lens formal code review completed with no remaining findings. Fixed
  review findings: a false-positive canvas test and inconsistent MIME Markdown
  classification. Independent cross-model review was unavailable (runner lacks
  jq); local adversarial fallback completed. Simplification reuse/quality passes
  completed; efficiency reviewed inline due the thread limit. A tiny escape
  helper extraction touching an unrelated board component was deliberately
  left out of this feature.

## Publication

Verified web mount `/home/hermes/projects/acp-ui/dist-web` -> `/repo/dist-web`.
Published assets from the isolated build, retaining old hashed files and the
LAN CA download; replaced index last. Actual HTTPS index and entry assets were
byte-compared with the candidate at `https://192.168.1.222:25809`.

- `/assets/index-CIVYex0Q.js` SHA-256 `a022a93c035332f93a46906bf7d1041ca8dd93cb740bb6b043b882890b6aac87`
- `/assets/index-BAzbpoBG.css` SHA-256 `e0713fe1206e5c8cfec391a5a44ba17fd5d7267ff00fc2013f3cba54f0780811`

No container or agent bridge was restarted, rebuilt or reconfigured. Bridge
PIDs remain Hermes1901671, OpenCode1902227, Devin1902451, Pi1664757, Codex1024589.
Evidence: `/home/hermes/projects/acp-ui/.agent-tmp/inline-file-release/`.

## Limits and operational checks

Cards render an excerpt/first page; Open shows the full file. Existing local
path/private-file and maximum-size restrictions remain. Card reads fetch the
whole allowed file because the existing endpoint has no prefix/range API;
loading is limited to visible active cards and full views reuse those bytes.
Not directly exercised: switching between two active session runtimes while
an inline PDF is still loading; scroll-away cancellation and worker cleanup
were exercised and the active-session guard was reviewed.

Existing pages need a reload. User validation: inspect the supplied TXT,
Markdown and PDF cards on Android PWA. Visible file error states and pageerror/
HTTP observations distinguish loading failures. Rollback: restore the saved
previous index in `/tmp/acp-inline-integration/index-before.html`, keeping old
assets; no bridge or backend lifecycle operation is required.
