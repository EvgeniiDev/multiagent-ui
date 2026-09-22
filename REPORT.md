STATUS: DONE

## Defects fixed

Measured at 390x844 against the built `dist-web` (playwright, chromium headless).
"Before" values are the audit's numbers / pre-change CSS; "after" values are
measured by `scripts/e2e_touch.py`.

### Defect 1 — Board `.pane-note` overflow

- Before: `scrollWidth 488` inside `clientWidth 302`. The rule already had
  `nowrap + overflow:hidden + text-overflow:ellipsis`, but `scrollWidth`
  counts clipped content, so the invariant `scrollWidth <= clientWidth + 1`
  can never hold while truncating. Took the brief's wrap option instead:
  dropped `nowrap`/`ellipsis`, added `min-width: 0` + `text-align: right`,
  and put the full summary on a `title` attribute.
- After: 390px -> `scrollWidth 302 <= clientWidth 302`; 1024px ->
  `488 <= 488` (fits on one line). No page-level horizontal scroll (0px).

### Defect 2 — Board touch targets < 44px

All rules applied under `@media (max-width: 800px)`; hit area grows, icons and
font sizes unchanged. Desktop geometry untouched (verified at 1024, below).

| control                                   | before | after |
|-------------------------------------------|--------|-------|
| `.col-add` (column `+`)                   | 22px   | 44px  |
| `.empty-btn` ("New card" / "Add example") | 30px   | 44px  |
| `.card-menu-btn` ("Move to" trigger)      | 32px   | 44px  |
| `.menu-item` (menu entries)               | 40px   | 44px  |
| `.drawer-close`                           | 26px   | 44px  |
| `.day-row` (Timeline expander button)     | 28px   | 44px  |
| `.ev-select` (Events filters)             | 28px   | 44px  |
| `.filter-clear`                           | ~18px  | 44px  |
| `.link-add` / `.link-del` (drawer)        | 26/28px| 44px  |

Already compliant (unchanged): `.tab-btn` 44px, `.switch-btn` 44px,
`.f-search`/`.f-select`/`.f-clear` 44px, `.btn`/`.seg-btn`/`.f-input` 44px —
their existing `max-width: 767px` media queries were widened to `800px` to
match the "under 800px" rule.

e2e_touch.py measured 18 controls on the phone board (min 44px), 8 in the
"Move to" menu, 21 in the card drawer, 1 in the filter-empty row, 2 in the
empty state — all >= 44px.

### Defect 3 — Projects head controls < 44px

Only the existing `@media (max-width: 800px)` block was edited.

- `.search`: 28px -> 44px, still `width: 100%` (measured 358px = full
  `.head-controls` width).
- `.picker`: 28px -> 44px.
- `.range button` (7d/30d/all): 28px -> 44px each; group still fits the row
  next to the picker and the "N projects" note — `documentElement.scrollWidth
  - innerWidth = 0`.

Desktop (>= 800px) unchanged: `.search`, `.picker`, `.range button`,
`.tab-btn`, `.f-search` measured 28–30px at 1024 (asserted >= 24 and < 44).

## Evidence

- `npm run build:web` — `vue-tsc --noEmit && vite build --mode web` green,
  `✓ built in 2.39s`, 247 modules, output to `dist-web/`.
- `scripts/e2e_board.py` (dist-web served on 25999): **16/16 PASS**, unchanged.
- `scripts/e2e_touch.py` (serves `dist-web` itself on 25996): **17/17 PASS** —
  per-view control sweep, `.pane-note` overflow at 390 + 1024, search full
  width, no horizontal scroll, desktop-density spot checks, zero `pageerror`.
- Screenshots: `docs/polish-board-390x844.png`, `docs/polish-projects-390x844.png`
  (plus the `docs/board-*.png` set refreshed by the required e2e_board run).

## Left as is

- `KanbanTab` phone-layout switch (`matchMedia('(max-width: 767px)')`): a
  layout breakpoint, not a touch-target rule — deliberately not moved to
  800px so the stacked-column layout doesn't change on 768–800px tablets.
- `LocksTab`, `AgentsTab`: no `button`/`input`/`select` elements — nothing to
  size. Their row-wrap media queries stay at 767px (non-interactive rows).
- `.pane-note` inside `ProjectsView`: it's a plain text span ("N projects"),
  not the audited board summary; short content, no overflow observed.
- Desktop (>= 800px) geometry everywhere — the defects were phone-width only,
  and the 1024 spot checks confirm 24–30px density is preserved.
- `BRIEF.md` left untracked (task input, not project content).
