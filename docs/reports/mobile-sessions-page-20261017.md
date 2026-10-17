# Mobile sessions page — 2026-10-17

Source release: `a4984bf` on `main`, based on `cd7cdf6` (including the separately shipped Back handling and shared sidebar redesign). Built and published from the isolated checkout `/tmp/acp-mobile-release`; unrelated working trees and their indexes were preserved.

## Result

- Mobile menu fills the viewport; mobile session tabs are removed. Desktop tabs remain.
- Session rows carry working/connecting, permission, error, unread and disconnected states, plus close-without-deleting-history actions. Pending/failed creations and open sessions without load support remain reachable.
- Live user/assistant messages update the ordering timestamp. Opening, replay, tool events and metadata notifications do not bump it. Agent inventory supplies historical timestamps; absent timestamps sort last. A stale inventory cannot overwrite a newer locally observed message.
- Browser Back/Forward/reload retain the existing shared history controller. Drafts and reading positions survive list navigation. Settings and traffic remain accessible.

## Checks

- `npm run build:web`: passed, including `vue-tsc --noEmit`. Existing large-chunk build warnings remain. No standalone lint script is configured.
- `node --test scripts/test_session_replay_activity.mjs`: 12/12 passed. The ordering regression failed before implementation because opening changed the timestamp.
- `scripts/test_mobile_sessions_page_browser.cjs`: passed at 320, 390, 780 and 1440 px, both on candidate assets and the deployed URL. ACP/state mocked; no model calls. Covers message ordering, stale refresh, statuses, pending/failed creation, non-loadable open sessions, drafts/scroll, close/history, creation dialog, reload, themes, focus, disabled state and touch targets.
- `scripts/test_mobile_back_browser.cjs`: passed at 390/1440 px, plus delayed session-URL and orientation/history cases.
- `scripts/test_sidebar_header_browser.cjs`: passed at 320/390/430/1440 px, including project filtering, settings and traffic. Density assertion now accounts explicitly for the shared 44px session-toolbar touch actions.
- `scripts/test_sidebar_resize_browser.cjs`: passed; the viewport assertions now wait for resize processing. Mobile width assertion expects the full page.
- Navigation-only extraction of `scripts/test_mobile_navigation_browser.cjs`: passed at 320/390/430/780/1440 px (native scrolling, fullscreen, history/follow, saved positions and desktop). The microphone capture section was excluded. The complete original smoke stopped while waiting for Escape to finish dictation; dictation is not claimed verified by this release.
- `ce-simplify-code` and `ce-code-review`: complete. Review receipt: `/tmp/compound-engineering-1001/ce-code-review/mobile-sessions-20261017/review.json`; no unresolved findings. A cross-model launcher could not run without jq; the required local adversarial fallback completed.
- `git diff --check`: passed.

## Deployment evidence

Verified actual web bind mount: `/home/hermes/projects/acp-ui/dist-web` → `/repo/dist-web`. Published assets into that mount, retained older hashed assets, and atomically replaced `index.html` last. No services or bridges were restarted.

Web image remained `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.

The user URL `https://192.168.1.222:25809/chat` served these exact candidate asset bytes:

- `/assets/index-DYvpx1TZ.js` — SHA-256 `f9a3c0aebd8217b1c7f5d2d08ad59b02ad23bbc2ca7371bb1fb460bab223d0d3`
- `/assets/index-CVqCOSB4.css` — SHA-256 `a6922cccb11c2231da2bee878fb10aef49833f6e9d443f6c7566728735b6068b`

Real-backend browser read at 390 px: 464 ordinary session rows, sidebar width 390 px, no mobile tab strip, covered content inert, zero page errors and unsuccessful HTTP responses. Opening/returning and reloading the sessions page passed. No prompts were sent. Full real CLI replay/provider operation was outside this UI check.

Evidence: `/tmp/acp-mobile-production.png`, `/tmp/acp-mobile-production-read.log`, `/tmp/acp-mobile-deployed-browser.log`, `/tmp/acp-mobile-header.log`, `/tmp/acp-mobile-back.log`, `/tmp/acp-mobile-navigation-only.log`.

Existing open browser tabs need a reload. Rollback, if needed, is the previous index saved at `/tmp/acp-mobile-before-publish-index.html`; its hashed assets were retained.
