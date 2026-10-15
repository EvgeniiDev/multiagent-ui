# Mobile chat geometry — 15 October 2026

The mobile composer now spans the viewport and sits at its visible bottom,
with the shell retaining the OS home-indicator safe area. Hidden session
navigation collapses completely; scrolling toward older messages reveals it.
Desktop spacing is preserved.

## Reproduction and cause

At https://192.168.1.222:25809, native touch scrolling hid navigation visually
but left a 40px box. The deployed stylesheet specified `min-height:40px`,
which won over the hidden state's `max-height:0`. Its empty mobile chat header
also retained a 40px minimum height. In a build of the pre-fix working sources,
the hidden navigation retained 5px from its padding and border. The mobile
composer began 12px from the screen edge and had unnecessary bottom spacing.

The fix explicitly resets the hidden navigation's minimum height, padding and
border, resets the mobile chat header's minimum height, and removes the mobile
composer's outer margins through its container padding and frame geometry.

## Scope and publication

Source branch: `feature/pi-session-image-cleanup`, HEAD
`c025d0bb92153d3a7cb92f25aede58f7c6757868`. The tree already contained unrelated
changes, including telemetry removal in App.vue. Those changes were preserved;
this fix remains uncommitted to avoid combining them at file level.

`npm run build:web -- --outDir .agent-tmp/mobile-fullscreen-release/dist-web`
passed, including vue-tsc (existing Vite chunk size advisory).

To avoid publishing unrelated working changes or replacing the live JavaScript,
publication appended only the equivalent scoped mobile CSS overrides to the
actual deployed stylesheet. Original JavaScript `/assets/index-D5g5KCSy.js`
and all older assets remain available. The new CSS is
`/assets/mobile-fullscreen-0e69c1d0eebd.css`, SHA-256
`0e69c1d0eebdfd67a53523fd43db505cf620bd904a336247483ac623122ad57b`.
The full measured hash is also in the local deployment manifest; use it if
checking bytes rather than the filename prefix.

The web container bind mount was inspected immediately before publication:
`/home/hermes/projects/acp-ui/dist-web` → `/repo/dist-web`.
Web image: `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.
CSS was copied first and index.html atomically replaced last. HTTPS index and
stylesheet bytes were compared with the prepared files. No service was restarted.

## Verification

- `scripts/test_mobile_navigation_browser.cjs` passed against the final source
  build and the actual published assets with mocked ACP/state. It checks
  320/390/430/780px mobile widths and 1440px desktop, native touch scrolling,
  zero hidden navigation height, transcript top position, full-width bottom
  composer, visual viewport shrinkage, light/dark themes, focus and touch
  targets, session switching and preservation of drafts.
- A separate browser check used published assets and the real backend, with
  model prompts/cancellation prohibited. Existing history restored successfully;
  all eight mobile width/theme combinations, both scroll directions, a short
  viewport, desktop layout and reload passed. No JavaScript or JSON-RPC errors
  or user error banners were observed. Activity-state HTTP 409 conflicts are
  accepted only when a subsequent successful PUT200 confirms recovery.
- Scoped diff review and `git -c core.whitespace=cr-at-eol diff --check` passed
  for the three changed implementation/test files.

Evidence, build logs, before/after scripts, screenshots, source hashes and
publication metadata are in `.agent-tmp/mobile-fullscreen-release/`.
These are browser emulation checks; a physical iOS/Android keyboard was not used.
Existing open pages need a reload to receive the new stylesheet.
