# Shared button primitives, 2026-10-04

The managed panel inherited only a subset of CardDrawer's scoped styles.
Its document tabs, add actions, refresh control and fields could consequently
fall back to browser styling. The prior deep `.btn` patch covered neither
other button classes nor the independent preparation panel.

UiButton now owns its appearance and native button behavior. ExecutionPanel
and PreparationPanel use it for every button; CardDrawer uses it for ordinary
footer actions and Apply. Legacy CardDrawer button/deep-button styling was
removed. Page components retain layout classes and all existing handlers,
disabled conditions, aria state and test identifiers. Refresh and dismiss
icons have accessible names. Form fields use shared opt-in ui-input styling.
Theme tokens moved unchanged from App.vue into src/styles/tokens.css.

The design-system guide is linked from AGENTS.md and requires reuse of these
primitives for future changes. Existing specialized navigation/segmented
controls remain and migrate when changed; this is not an app-wide redesign.

Verification:

- Shared-button regression fails on the prior ExecutionPanel and passes on
  the migrated component. All 76 execution UI tests and 25 preparation UI
  tests pass, including SSR and command/store behavior.
- Host web build passes. LAN `/board` serves `index-BGUWOeSl.js` and
  `index-Gf4bTv-o.css` from the existing dist-web bind mount; no service
  restart or backend change was required.
- Real Chromium on the LAN URL opened the existing Reddit card. All
  execution/preparation buttons use the shared primitive. Measured desktop
  button height28px, font12px, border1px, radius6px; tabheight24px.
- Light/dark themes, hover, 2px keyboard focus, disabled opacity0.5 and
  selected tab styling passed. Fusion/Orchestrator/Swarm and document editors
  open and close through real buttons without saving or starting work.
- Mobile390px: button and icon minimum44px, actual form open/close works,
  no horizontal page overflow. Sidebar was closed before mobile interaction.
- Browser pageerrors: none. Screenshots were inspected, not merely captured.

Private browser evidence: `.agent-tmp/autonomous/browser-production/`
`design-buttons-proof.json`, `design-buttons-dark.png`,
`design-buttons-light.png`, `design-buttons-mobile.png`.
