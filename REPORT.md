STATUS: DONE
## Replaced                — file:glyph -> what it became
- src/App.vue: 📡 (traffic toggle) -> radio-waves stroke SVG 15px, title/aria-label kept
- src/App.vue: ⚙ (settings) -> gear stroke SVG 15px, title/aria-label kept
- src/App.vue: 📁 (cwd folder button) -> folder stroke SVG 15px, title/aria-label kept
- src/App.vue: ☰ (mobile hamburger) -> 3-line stroke SVG 20px, aria-label kept
- src/App.vue: ◀/▶ (sidebar collapse/expand chevrons, U+25C0/U+25B6) -> chevron SVGs 13px
- src/App.vue: ⚠ (error banner) -> warning-triangle stroke SVG 14px
- src/components/AgentSelector.vue: ⚙ in sentence -> plain words "Open Settings to add one."
- src/components/AuthMethodDialog.vue: ✕ (close) -> X stroke SVG 14px + aria-label
- src/components/DirectoryPicker.vue: 📂 (browse) -> folder SVG 15px + aria-label
- src/components/DirectoryPicker.vue: 📁 (dir-icon) -> folder SVG 16px
- src/components/DirectoryPicker.vue: ✓ (dir-pick) -> check SVG 14px
- src/components/DirectoryPicker.vue: × (tree-close) -> X SVG 16px + aria-label
- src/components/DirectoryPicker.vue: ↑ (go up) -> arrow-up SVG 14px + aria-label
- src/components/EnvVarEditor.vue: ✕ (remove) -> X SVG 12px + aria-label
- src/components/ModePicker.vue: ✓ (check-mark) -> check SVG 14px
- src/components/ModelPicker.vue: ✓ (check-mark) -> check SVG 14px
- src/components/SettingsView.vue: ✕ (close) -> X SVG 14px + aria-label
- src/components/StartupProgress.vue: 🚀📥📦🔨⚙️🔗⏳ getStepIcon switch -> stepIcons
  Record<phase, path> rendered by one inline stroke SVG 16px (phase-icon slot,
  step list + labels unchanged)
- src/components/TrafficMonitor.vue: 📡 (title) -> radio-waves SVG 15px inline in title
- src/components/TrafficMonitor.vue: ▶/⏸ (pause/resume) -> play/pause SVGs 13px
- src/components/TrafficMonitor.vue: 🗑 (clear) -> trash SVG 14px + aria-label
- src/components/TrafficMonitor.vue: 🔍 (search) -> magnifier SVG 12px
- src/components/TrafficMonitor.vue: 📋 (copy) -> copy SVG 13px + aria-label
- src/components/TrafficMonitor.vue: ⏸ Paused -> pause SVG + "Paused"
- src/components/TrafficMonitor.vue: × (panel close) -> X SVG 14px + aria-label
All SVGs: stroke="currentColor" fill="none" stroke-width="1.5" viewBox="0 0 24 24"
aria-hidden="true"; no class names, paddings, grids, or sizes changed.

## Evidence                — build tail, e2e_icons.py output, zero-emoji scan output
build:web (vue-tsc + vite):
  dist-web/assets/index-Bp68Rp6S.js   446.43 kB | gzip: 158.76 kB
  ✓ built in 2.40s
scripts/e2e_icons.py (dist-web served on port 25997, playwright chromium headless):
  PASS  build:web green
  PASS  load: zero emoji in DOM
  PASS  settings opens, zero emoji
  PASS  add-agent form shows EnvVarEditor
  PASS  env row add/remove works, remove is SVG
  PASS  settings closes
  PASS  traffic opens (SVG icons) and closes
  PASS  directory picker opens, zero emoji
  PASS  directory picker closes
  PASS  error banner shows with SVG icon, zero emoji
  PASS  error banner dismisses
  PASS  zero emoji with Settings + Traffic open
  PASS  hamburger opens/closes drawer, zero emoji
  PASS  zero pageerror events
  PASS  src/** free of emoji-range glyphs
  15/15 passed
Zero-emoji scan: every element's own text nodes + all attributes walked on load,
with Settings+Traffic open, and on the 500px narrow layout — 0 hits everywhere;
static grep over src/** for U+1F300–1FAFF, U+2600–27BF, U+FE0F, U+2B00–2BFF: none.
Screenshots: docs/icons-before.png / docs/icons-after.png (app header).

## Left alone              — glyphs you judged out of scope, with the reason
- Arrows/geometric shapes outside the audit range (→ ← ▲ ▼ ▾ ▸ × ⌂ › · in
  ChatView, Mode/ModelPicker dropdown arrows, StartupProgress details toggle,
  DirectoryPicker crumbs, AuthMethodDialog arrow, TrafficMonitor direction
  arrows, CSS content '▍', attach '▤', code comments): not in the
  U+1F300–1FAFF / U+2600–27BF / U+FE0F / U+2B00–2BFF audit range, not emoji
  icons; brief counts only that range and demands zero there.
- Ceiling-adjacent extras I converted anyway (◀ ▶ ⏸ × ↑ — U+25xx/U+23F8/U+2715
  are partly inside the audit range): sidebar chevrons, pause/play, panel
  closes, go-up — all SVG now, so both the letter and spirit of N2 hold.

## Integration requests    — anything needing a file you should not touch
- None. No changes to scripts/e2e_shell_projects.py, scripts/e2e_board.py,
  scripts/e2e_dashboard.py; no class renames, no template restructuring beyond
  the glyph->SVG swap; no new runtime dependencies; no network calls.
