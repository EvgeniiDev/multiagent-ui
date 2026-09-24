# F10 — the `pm` role: a reviewer of the card graph, not an executor

**STATUS: DONE** — build green, unit tests 34/34, `e2e_pm` 68/68, zero
pageerrors.

The pm is the board's project-manager reviewer: it reads the card graph,
reports the four problem classes (contradiction, module overlap, duplicate,
cycle), applies only changes that cannot alter a card's meaning, and hands
everything else to the human as proposals. The behaviour lives in the role
prompt; the arithmetic lives in a deterministic tool; the panel shows the
verdict on stores it already had — no parallel state was added.

## What was built

- **`.acp/roles/pm.md`** — the role prompt (Russian, matching `dev.md`'s
  style): reviewer protocol — `boardctl show` for the trigger card's
  `project` scope → `pmgraph scan` → LLM judges the semantic classes over
  the card texts → writes `.acp/pm/plan.json` → `pmgraph apply`. Explicit
  never-list: no feature code, no stage moves (not even its own trigger
  card), no rewriting substance, no touching a `blockedReason` that does
  not start with `pm:`, no board writes outside `pmgraph apply`, and a
  failed run ends `STATUS: BLOCKED` — never repaired by side edits.

- **`scripts/pmgraph`** (new, no deps, stdlib only) — the deterministic
  half, two commands, scope mandatory on both (`--project LABEL` or
  `--all`):
  - `scan` — read-only: card digests for the LLM's judgement plus the
    *mechanical* findings: `module_overlap` (normalized `touches`
    intersection, pairwise), `cycle` (Tarjan SCC over the wait-graph —
    `dependsOn` ∪ mirrored `blocks`), `dangling_edge`,
    `dep_on_cancelled`, `unmirrored_edge`, `stale_pm_block`, and
    `impliedBlocked` (who waits on an unfinished dep).
  - `apply --plan FILE` — validates the plan, computes the whole diff in
    memory, then writes once: the board in a single rev-guarded PUT (409
    → re-read/re-validate/re-compute), then the audit ledger, then
    `<projectPath>/.acp/pm/proposals.md`. Plan grammar: `actions` only
    `link`/`unlink` on `dependsOn`/`blocks`/`conflictsWith`; `findings`
    and `proposals` declare the rest. Rejections: non-safe op, non-graph
    field, self-link, unknown/out-of-scope refs, and — checked on the old
    graph — any link that would *close* a wait-loop (a pre-existing cycle
    is a finding to report, never an edge to assert).
  - Safe set applied by the tool itself: explicit links/unlinks (an
    unlink clears *both* representations — `dependsOn`↔`blocks`,
    `conflictsWith` on both cards), mirror repair between in-scope cards,
    and derived blocked flags — a card waiting on an unfinished dep gets
    `pm: blocked by <id8>`; pm-owned marks are updated/cleared when the
    graph no longer justifies them; a foreign reason (human's,
    dispatcher's) is never overwritten. `blocked` is never accepted from
    the plan — it is tool arithmetic.
  - Audit: one `kind:"pm"` ledger entry per applied change (card title,
    `applied: <change> — saw: <evidence>`), one `proposed:` row per
    proposal, one `run <session>: findings N (classes); applied M;
    proposed K; scope L` summary — all carrying `role:"pm"` and the run's
    session id.
  - Atomicity is structural, not try/catch: all reads + analysis +
    validation + diff computation precede the single write point;
    `--dry-run` never reaches it. Seven failure legs in the e2e prove the
    board file stays byte-identical and the ledger untouched.

- **`scripts/test_pmgraph.py`** (new) — 34 unit tests: SCC/cycle shapes,
  touch normalization, mirror repair both directions, unlink clearing
  both representations, blocked derivation (unfinished dep → flag, done
  dep → no flag, foreign reason preserved, stale pm mark cleared),
  plan-grammar rejections, cycle-guard, scope enforcement, idempotency of
  the pure core.

- **UI — built on the existing stores only:**
  - `src/features/board/LinksTab.vue` (new) — the pm verdict tab:
    last-run banner, **Proposed — for a human** (ledger `proposed:` rows
    plus the project's `.acp/pm/proposals.md` read through the fs bridge
    when a project is in scope — the applied/proposed split is visible),
    **Applied by pm** (ledger `applied:` rows), the live **Card graph**
    (edge rows derived from board state, `dependsOn`/`conflictsWith`,
    chips open the card drawer), and the **Blocked cards** list.
  - `src/components/BoardView.vue` — `Links` tab registered between Tasks
    and Agents; its count badge shows the number of in-scope problem
    cards (blocked or in a declared conflict).
  - `src/features/board/CardDrawer.vue` — a **Relations** block:
    `depends on` / `blocks` / `conflicts with` chips resolving id8→title
    that navigate to the linked card, and the `pm: blocked` provenance
    mark with the reason text.
  - `src/features/board/BoardCardItem.vue` — the blocked badge names the
    blocker (`blocked by <id8>`) when the reason carries the `pm:`
    provenance; relation chips' tooltips now resolve id8→title.
  - `src/stores/activity.ts` — `ActivityKind` gains `'pm'`; Events and
    Timeline pick it up with no further changes (kind filter is dynamic).

- **`scripts/e2e_pm.py`** (new, registered in `scripts/e2e_all.py`) —
  self-contained: own state server on **25909** (`tmp-pm-test/state`), a
  scratch project `tmp-pm-test/proj`, its own web bundle built with
  `VITE_STATE_URL` served on **25995**. Seeds 13 cards with a known
  problem set (overlap pair via `touches`, text-only contradiction pair,
  duplicate pair, a two-card `dependsOn` loop, a correctly-linked
  consistent card + its done dep, a human-blocked card, an out-of-scope
  card), then runs the real `pmgraph` against the real state-server wire
  protocol and drives the real panel.

Untouched per scope: `server/acp-runner.mjs`, `src/stores/board.ts`
sanitization, card model fields — nothing new invented.

## Verification output (real)

### `python3 scripts/test_pmgraph.py`

```
Ran 34 tests in 0.002s

OK
```

### `npm run build:web`

```
vue-tsc --noEmit && vite build --mode web
✓ built in 2.86s   (no type errors)
```

### `~/.hermes/tools-venv/bin/python scripts/e2e_pm.py` — 68/68

Key lines (full transcript reproduced in the suite output):

```
PASS  scan: module_overlap names the touches pair
      (cards: ["pm-ov-aaaa","pm-ov-bbbb"], "touches intersect on src/api/audit.ts")
PASS  scan: cycle names the waiting pair
      (cards: ["pm-cy-aaaa","pm-cy-bbbb"], "dependency loop over 2 card(s):
       pm-cy-aa waits pm-cy-bb; pm-cy-bb waits pm-cy-aa")
PASS  scan: impliedBlocked marks DEP (unfinished dep)
PASS  scan: consistent CLEAN is not implied-blocked
PASS  apply: run ok, board written
PASS  apply: every applied field is in the safe set
      (fields=['blocked', 'blocks', 'conflictsWith'])
PASS  apply: DEP flagged blocked by pm naming OV_A  (pm: blocked by pm-ov-aa)
PASS  apply: human blockedReason NOT overwritten  (waiting for design review)
PASS  apply: consistent CLEAN untouched
PASS  apply: out-of-scope card untouched
PASS  apply: duplicate pair still exists (merge NOT applied)
PASS  apply: proposals.md written under the project
      (tmp-pm-test/proj/.acp/pm/proposals.md)
PASS  audit: one pm entry per applied change  (11 rows vs 11 applied)
PASS  audit: run summary lists all four finding classes
      (run pmrun-e2e: findings 4 (contradiction 1, cycle 1, duplicate 1,
       module_overlap 1); applied 11; proposed 3; scope pm-proj)
PASS  apply: rerun writes nothing (idempotent)  (rev 2 -> 2, applied=0)
PASS  failure[malformed|unsafe-op|non-graph-field|cycle-closing|
      out-of-scope|unknown-card|finding-out-of-scope]:
      exit non-zero + board byte-identical + ledger untouched   (7 legs)
PASS  empty plan: exit 0 but board byte-identical
PASS  ui: Links badge counts problem cards  (8)
PASS  ui: last run line shows the pm session
PASS  ui: proposals section shows the merge proposal
PASS  ui: card badge names the blocker  (blocked by pm-ov-aa)
PASS  ui: drawer relations show depends-on + pm mark
PASS  ui: relation chip navigates to the blocker card
PASS  ui: Events ledger shows pm rows
PASS  ui: zero pageerror events

68/68 assertions passed
```

## The four classes — honestly delimited

- **module_overlap** and **cycle** are found *mechanically* by `pmgraph
  scan` and the e2e asserts each names the exact seeded pair.
- **contradiction** and **duplicate** are semantic: the tool cannot detect
  them — the pm agent judges them from card texts and declares them in the
  plan's `findings`. The e2e plays the agent's part: it declares the two
  classes with the right pairs, `apply` validates the refs, and the run
  summary records all four classes. What is *verified live* is that the
  tool records/audits them correctly and applies only the safe set — not
  that a real LLM calls them correctly.

## What could not be verified live

- **A real LLM run of the pm role end-to-end** (dispatcher → CLI →
  `pm.md` → plan → apply) was not exercised: the dispatcher is out of
  scope and no live agent was available. The seam that *is* verified is
  the contract the prompt depends on — scan output shape, plan grammar,
  apply semantics, audit, proposals file — all against the real state
  server.
- **The proposals-file UI section** reads `<projectPath>/.acp/pm/
  proposals.md` through the fs bridge; on this host a real bridge
  (:25901, root `/home/hermes`) answered and the file rendered. On a host
  without the bridge the tab shows the honest error line plus the ledger
  `proposed:` rows (always present) — the e2e asserts either branch.
- The LLM-side judgement quality (will a real agent separate duplicate
  from overlap correctly, write good `evidence` strings) is prompt
  engineering, not verifiable here.
