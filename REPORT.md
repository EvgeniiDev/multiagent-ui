# REPORT — Kanban pipeline board (cc/v3-board)

## STATUS: PARTIAL

All owned code is implemented, built, and verified green end to end. The only
failing required check is `scripts/e2e_touch.py`, which hard-codes the old
board model (`[data-col="inbox"]`) — that file is outside this workstream's
ownership, so an Integration request is filed below instead of editing it.

## What changed

The Board is now a true pipeline: six ordered **stages** (`backlog → spec →
plan → dev → reviewtest → done`) replace the old status columns, and every
card carries an independent **status** valid for its stage:

- `backlog`, `done` — no status (status-less stages).
- `spec`, `plan`, `dev` — `in_progress | review | done`.
- `reviewtest` — `in_progress | agent_tested | accepted`; picking `accepted`
  moves the card to `done` (status cleared).

**Flags** are orthogonal to stages and settable in any of them: `blocked`
(with optional `blockedReason` — free text, may reference a card; structured
links live in the PM fields) and `cancelled`. Flagged cards render a badge on
the card and a `N blocked` counter in the column header. There is no
auto-claiming code in the app today, so the exclusion contract is purely the
flag data.

**PM fields** on every card (data only, no PM logic yet): `touches`,
`dependsOn`, `blocks`, `conflictsWith` — `string[]`, default `[]`.

**Stage moves** (`moveCard`, drag or ⋮ menu): a card entering a stage for the
first time gets the stage's initial status; a card returning to a stage it
already visited resumes the status it left there — `statusByStage` remembers
the last status per stage, which is what «если у карточки не было статуса
этой стадии» requires. Same-stage moves reorder without touching status.

**Project scope** follows the global selector (`stores/ui.ts` →
`activeProjectId`): a scoped project shows only its cards; the board's own
**All** button in the filter row drives the same global selector back to
`all`. Project-less cards appear only under `All` and carry an `unassigned`
chip. New cards created without a live session inherit the scoped project.

**Migration** (`board.json` → `version: 2`, on store init, sanitized through
`sanitizeCard` so malformed records are dropped consistently):

| v0/v1 column | v2 stage | v2 status | flags |
|---|---|---|---|
| `inbox` | `backlog` | — | |
| `ready` | `spec` | `in_progress` | |
| `active` | `dev` | `in_progress` | |
| `review` | `reviewtest` | `in_progress` | |
| `done` | `done` | — | |
| `cancelled` | `done` | — | `cancelled` |
| `blocked` | `backlog` | — | `blocked` (+ `blockedBy` → `blockedReason`) |

**UI**: column headers show label + count + per-status breakdown (e.g.
`in_progress 2`) + `N blocked`; cards show a status chip that opens the
stage's status menu on click; the drawer edits stage, status (constrained to
the stage's vocabulary), both flags and the blocked reason; columns scroll
independently; ≤800 px uses the stage switcher; all new controls use app
tokens — no shadows, gradients, or emoji; touch targets ≥44 px.

Owned files touched: `src/stores/board.ts`, `src/features/board/{columns.ts,
KanbanTab.vue, BoardColumn.vue, BoardCardItem.vue, BoardFilters.vue,
CardDrawer.vue}`, `src/components/BoardView.vue`, `scripts/e2e_board.py`, new
`scripts/e2e_board_pipeline.py`.

## Verification (real output)

```
$ npm run build:web
vite v6.4.1 building for web...
✓ built in 2.63s        (vue-tsc --noEmit clean)
```

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_board_pipeline.py   # port 25984
49/49 assertions passed   (zero pageerror)
```
Covers: v0/v1 migration incl. 2 malformed records dropped and all 8 valid
cards preserved; six stages in order; per-status header breakdowns; status
chip → menu → persist across reload; move → initial status + revisit restores
remembered status; blocked/cancelled set·render·clear; two-project scope +
global selector + board **All**; `unassigned` markers; 390 px switcher,
≥44 px targets, zero page-level hscroll; screenshots.

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_board.py            # port 25999
21/21 assertions passed   (zero pageerror)
```

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_project_scope.py    # regression
23/23 assertions passed
```

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_dark_contrast.py    # dark + light
7/7 assertions passed  (0 contrast failures in both schemes)
```

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_touch.py            # port 25996
TimeoutError: waiting for locator('[data-col="inbox"] .board-card')
→ FAIL — stale foreign-owned test, see Integration request #1.
```

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_accent_contrast.py
9/10  — every live contrast gate passes; the single FAIL is "baseline diff:
.accent_baseline.json missing" (baseline must be recorded pre-change).
$ ~/.hermes/tools-venv/bin/python scripts/e2e_muted_contrast.py
5/6   — all muted gates pass; FAIL is "0 accent exception rows observed":
the script expects the known pre-fix accent failures, which no longer occur.
```

Both are baseline/fixture artifacts of foreign-owned scripts, not board
regressions — noted for completeness.

## Screenshots

- `docs/pipeline-1440x900.png` — desktop board, six stages, chips/flags
- `docs/pipeline-1024x768.png`
- `docs/pipeline-390x844.png` — stage switcher, no page hscroll
- `docs/pipeline-card-zoom.png` — zoomed card with status chip
- `docs/board-*.png` — refreshed legacy shots (incl. drawer, events, timeline)

## Integration requests (files outside this workstream's ownership)

1. **`scripts/e2e_touch.py` — update board selectors to the pipeline model.**
   Its v0-style seed (`status: "inbox"`, `status: "blocked"`) already migrates
   correctly; only four selectors are stale: lines 245, 265, 273, 346 use
   `[data-col="inbox"]` → should be `[data-col="backlog"]`. Everything else it
   asserts (`.board-card`, `.card-menu`, `.card-drawer`, `.filter-clear`,
   `.board-empty`, ≥44 px targets, no hscroll) is model-agnostic and verified
   equivalent in `e2e_board_pipeline.py`.
2. **`scripts/e2e_accent_contrast.py` / `scripts/e2e_muted_contrast.py` —
   regenerate fixtures.** `.accent_baseline.json` needs a `baseline` run on
   the pre-change tree; the muted script's "known accent exceptions" fixture
   list is stale now that accent contrast is clean.
