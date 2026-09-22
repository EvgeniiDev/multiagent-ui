STATUS: DONE

## Tokens changed

Only the two light-`:root` text tokens in `src/App.vue` (lines 568–569).
`--bg-primary`, `--text-muted` (owned by sibling `cc/muted`), the whole dark
block, and every component rule are untouched.

| token | old -> new | measured |
|---|---|---|
| `--text-on-accent` | `#fbf8f3` -> `#ffffff` | on `--bg-primary #c2532f`: **4.59:1** (was 4.34:1 — the paper tint in the old value is what made it miss) |
| `--text-accent` | `#c2532f` -> `#b04a28` | on paper `rgb(251, 248, 243)`: **5.14:1**; on the accent tint `rgb(245, 232, 223)`: **4.54:1** (token probe) / **4.53:1** (live element) |

`#b04a28` is the brief's verified candidate and it cleared both backgrounds
on the first live measurement, so no lighter alternative was needed; it stays
in the same terracotta hue family. Dark `--text-on-accent: #211d1a` is
unchanged.

## Per-element

Before values are the brief's measurements (hardcoded baseline); after values
measured live at 1440x900, `color_scheme="light"`, composited backgrounds
(ancestor walk, alpha-aware, bottom-up):

| element | before -> after | colours after |
|---|---|---|
| [Board] `.board-empty .empty-btn.primary` "New card" | 4.34:1 -> **4.59:1** | `rgb(255, 255, 255)` on `rgb(194, 83, 47)` |
| [Dashboard] `.seg-btn.active` "7 days" | 3.82:1 -> **4.53:1** | `rgb(176, 74, 40)` on `rgb(245, 232, 223)` |
| [Board] `.tab-btn.active` "Tasks" | 4.34:1 -> **5.14:1** | `rgb(176, 74, 40)` on `rgb(251, 248, 243)` |
| [Projects] `.range button.active` "7d" | 3.82:1 -> **4.53:1** | `rgb(176, 74, 40)` on `rgb(245, 232, 223)` |

## Baseline diff

Baseline captured pre-edit by `e2e_accent_contrast.py baseline` into
`scripts/.accent_baseline.json` (local artifact, not committed).

- **Failing before (non-muted):** 5 pairs — the four brief cases plus
  `[Chat] .new-session-btn "New Session"` `rgb(251,248,243)` on
  `rgb(194,83,47)` = 4.34:1, which shares the same
  `--text-on-accent`/`--bg-primary` pair and is fixed by the same token change.
- **Failing after (non-muted):** 0.
- **New failures:** none. The only difference vs baseline is the 5 fixes —
  improvements only.
- **Excluded (muted):** 116 failing pairs whose computed color equals the
  still-unfixed `--text-muted` (`rgb(163,154,142)`); identified by color,
  listed by class name — all expected here, fixed in `cc/muted`
  (`--text-muted: #786d62`). Classes: `.label`, `.list-label`, `.list-count`,
  `.list-refresh`, `.list-scope`, `.row-stamp`, `.row-delete` (Chat);
  `.button`, `.pane-note`, `.project-path`, `.project-stat`,
  `.project-stat mono`, `.project-stamp` (Projects); `.pane-note`,
  `.col-count`, `.col-empty` (Board); `.pane-note`, `.panel-title`, `.muted`,
  `.mono muted`, `.state-last muted`, `.th`, `.num`, `.muted mono file-hint`
  (Dashboard).
- All four rail views switch with zero `pageerror`.

## Evidence

`npm run build:web` tail (run inside the script before serving):

```
dist-web/assets/event-DRK-L59a.js     1.07 kB │ gzip:   0.58 kB
dist-web/assets/index-D8BamZOI.js     1.39 kB │ gzip:   0.69 kB
dist-web/assets/index-5FpjeHmg.js     1.53 kB │ gzip:   0.52 kB
dist-web/assets/stdio-DydwEQBM.js     1.63 kB │ gzip:   0.62 kB
dist-web/assets/index-CaZXVyQb.js   446.45 kB │ gzip: 158.78 kB
✓ built in 2.55s
```

`~/.hermes/tools-venv/bin/python scripts/e2e_accent_contrast.py`
(builds, self-serves `dist-web` on :25990, light scheme, 1440x900):

```
RATIO  --text-on-accent on --bg-primary: 4.59:1  (rgb(255, 255, 255) on rgb(194, 83, 47))
RATIO  --text-accent on --bg-main (paper): 5.14:1  (rgb(176, 74, 40) on rgb(251, 248, 243))
RATIO  --text-accent on accent tint rgb(245,232,223): 4.54:1  (rgb(176, 74, 40) on rgb(245, 232, 223))
RATIO  [Board] .board-empty .empty-btn.primary "New card": 4.34:1 -> 4.59:1  (rgb(251, 248, 243) -> rgb(255, 255, 255) on rgb(194, 83, 47); before bg rgb(194, 83, 47))
PASS  .board-empty .empty-btn.primary "New card" >= 4.5:1  (4.34 -> 4.59)
RATIO  [Dashboard] .seg-btn.active "7 days": 3.82:1 -> 4.53:1  (rgb(194, 83, 47) -> rgb(176, 74, 40) on rgb(245, 232, 223); before bg rgb(245, 232, 223))
PASS  .seg-btn.active "7 days" >= 4.5:1  (3.82 -> 4.53)
RATIO  [Board] .tab-btn.active "Tasks": 4.34:1 -> 5.14:1  (rgb(194, 83, 47) -> rgb(176, 74, 40) on rgb(251, 248, 243); before bg rgb(251, 248, 243))
PASS  .tab-btn.active "Tasks" >= 4.5:1  (4.34 -> 5.14)
RATIO  [Projects] .range button.active "7d": 3.82:1 -> 4.53:1  (rgb(194, 83, 47) -> rgb(176, 74, 40) on rgb(245, 232, 223); before bg rgb(245, 232, 223))
PASS  .range button.active "7d" >= 4.5:1  (3.82 -> 4.53)
PASS  rail: Chat switches clean (.chat-view, .welcome-screen)
PASS  rail: Projects switches clean (.view-pane .head-controls)
PASS  rail: Board switches clean (.view-pane .tab-bar)
PASS  rail: Dashboard switches clean ([data-testid="dashboard"])
PASS  zero pageerror events
PASS  no NEW contrast failures vs baseline
DIFF  improvements vs baseline (5 fixed):
    FIXED [Board] .empty-btn  (was rgb(251, 248, 243) on rgb(194, 83, 47))
    FIXED [Board] .tab-btn  (was rgb(194, 83, 47) on rgb(251, 248, 243))
    FIXED [Chat] .new-session-btn  (was rgb(251, 248, 243) on rgb(194, 83, 47))
    FIXED [Dashboard] .seg-btn  (was rgb(194, 83, 47) on rgb(245, 232, 223))
    FIXED [Projects] .active  (was rgb(194, 83, 47) on rgb(245, 232, 223))
DIFF  still failing (pre-existing, unchanged): 0
MUTED  excluded failures (expected, fixed in cc/muted): 116

10/10 assertions passed
```

`~/.hermes/tools-venv/bin/python scripts/e2e_touch.py` (unchanged,
self-serves :25996): **17/17 assertions passed**, exit 0.
