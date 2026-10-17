# Sidebar menu redesign

Implementation committed to `main` as `2a2254b6fe17a09203650eb87113145d84659f8f`,
on top of `166ea86` (including the concurrent system Back feature).
Built from isolated checkout `/tmp/acp-sidebar-redesign` using its own
`npm ci --ignore-scripts` dependencies and unchanged package/lockfile.
Unrelated working-tree and staged edits were preserved and excluded.

## Changes

- Dedicated sidebar header with shared ghost icon buttons and a small brand mark.
- Four labelled mobile navigation tiles replace the anonymous icons and repeated
  current-page caption. Current-page styling and the stacked layout belong to
  `UiButton`, with shared hover/focus/disabled behavior and theme tokens.
- One full-width project field replaces the duplicated Project headings.
- Removed the superseded parent styles; component appearance is self-contained.
  Session inventory, scope persistence, drawer behavior and desktop resizing
  retain their existing owners.

## Verification

The new browser check failed against the previous published menu because only
one of its three header actions used the shared button. It passed against the
candidate and again against published assets at 320/390/430/1440px: visible
navigation labels, compact menu height, 44px mobile actions, bounds, theme/hover,
keyboard focus, project filtering and reload persistence, section changes,
settings, traffic monitor, and no page errors or failed HTTP responses.

- `npm run build:web -- --outDir /tmp/acp-sidebar-candidate`: typecheck/build passed.
- `scripts/test_sidebar_header_browser.cjs`: all four widths passed on candidate
  and published UI.
- `scripts/test_mobile_back_browser.cjs`: passed on candidate and published UI,
  including mobile Back/Forward, section selection, reload, bounded history,
  desktop isolation and delayed session URL recovery.
- `scripts/test_sidebar_resize_browser.cjs`: candidate passed resize bounds,
  persistence, reset, compact rows, collapse and mobile isolation.
- Owned diff/content checks passed; shared control changes and callers were
  inspected. No unrelated behavior was changed to satisfy checks.

Browser suites use isolated state/ACP fixtures; they do not start model work or
write user state. Production assertions concern the actual served UI/assets,
not a provider run or physical-phone test. An initial desktop overflow assertion
was corrected to measure controls: the existing resize grip intentionally extends
4px beyond the sidebar. Mobile whole-drawer overflow remains checked.

## Publication

Verified live bind `/home/hermes/projects/acp-ui/dist-web` -> `/repo/dist-web`.
Copied isolated built assets, retained previous hashes and the host certificate,
and replaced `index.html` last. On `https://192.168.1.222:25809`, the served index
and both entry assets matched candidate bytes:

- `/assets/index-rjlT3pnN.js`: SHA-256
  `6b92a55742bf5a77457efa4ca52212afad1752b320b30ad44ed324689831f0d3`.
- `/assets/index-Doixkv9M.css`: SHA-256
  `6474d16bf8ee1e73cd758de2f6b05a788c311787510b6b51f7c04d23a1fc6500`.

No service or bridge lifecycle changes were performed. Existing pages/PWA need
reload. Evidence is retained in `.agent-tmp/sidebar-header-release/`.
