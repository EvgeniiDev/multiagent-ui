# W6-A — Card as pipeline: artifacts, STATUS tokens, transitions

**STATUS: DONE** — `npm run build:web` green (`vue-tsc` strict), e2e 41/41,
zero `pageerror`.

## What was built

- **`src/stores/artifacts.ts`** (new) — per-card session cache
  (`byCard[cardId]`) of the artifact dir `<projectPath>/.acp/cards/<cardId>/`
  read through the host bridge. Today's bridge `GET /api/fs/list` returns
  directories only, so discovery probes the fixed pipeline names
  (`00_brief.md` … `06_handoff.md`) plus the numbered families
  `05_review_rN.md` / `run-N.log` (first 404 ends the sequence) via
  `GET /api/fs/read` → `{path, bytes, content}`. If a newer `list` carries
  `files[]`, it is taken as the listing instead and its size/mtime enrich
  the records — otherwise `mtime` stays `null` (the bridge exposes none).
  Bridge errors surface verbatim: `state.error` keeps the `{error}` text
  next to any stale data, a missing dir is an honest empty state, and a
  per-file failure (403/413/415/malformed) lands on the artifact row as
  `error`. `refresh()` dedupes in-flight calls; `ensureLoaded()` loads once
  and retries after an `error` phase.
  Pure helpers exported (and e2e-tested in-browser via `window.__pipeline`):
  `parseStatusToken` (last non-empty line `STATUS: <token>` + trailing
  detail), `reviewRoundOf`, `pickStatusArtifact` (stage's own output first —
  max `05_review_rN` in reviewtest — else furthest-along token doc;
  `run-*.log` never speaks), and `proposeTransition(stage, reviewRound,
  token, detail)` implementing the table: `spec+APPROVE→plan`,
  `plan+APPROVE→dev`, `dev+DONE→reviewtest`, `reviewtest+DONE→agent_tested`
  (an in-stage status, not a stage), `CHANGES_REQUIRED→` one step back
  (`plan→spec`, `dev→plan`, `reviewtest→dev`), `BLOCKED→` the `blocked`
  flag with the token line's reason; anything else → `none`.

- **`src/features/board/CardDrawer.vue`** — "Artifacts" block: STATUS badge
  (`STATUS: <token>` or `STATUS: —`, title names the source file), Refresh
  button (re-reads the bridge dir; the open viewer re-points at the fresh
  record), file list (name · size · mtime when provided · token chip),
  click opens read-only `pre` mono content — no markdown render. Proposal
  row shows the suggested transition and **Apply** runs it through the
  board's own mutations (`moveCard` / `setCardStatus` / `setCardFlag` +
  `blockedReason` patch) — the boardctl-equivalent path, no direct
  document writes. Empty dir → readable line; unresolvable project →
  no-project note; bridge error → verbatim banner.

- **`src/features/board/BoardCardItem.vue`** — `card-status-token` meta chip
  showing the artifact STATUS on the kanban card (lazy `ensureLoaded` on
  mount when the card's project resolves; session-cached).

- **`scripts/e2e_card_pipeline.py`** (new) — serves `dist-web` itself on
  `127.0.0.1:25988`; `page.route` stubs `:25900` → 500 (localStorage KV —
  nothing lands in `~/.hermes`) and `/api/fs/` → a bridge stub mirroring
  the real one (dirs-only `list`, 404 `read`, scoped `write` that persists
  under the fixture root). Fixtures are written to `./tmp-pipeline-test/`
  inside the worktree and the seeded registry project points there.

Untouched per the boundaries: `src/stores/session.ts`,
`src/components/PermissionDialog.vue`, `src/stores/board.ts`,
`src/App.vue`, `src/lib/fsApi.ts`, `src/features/settings/fsApi.ts`
(imported only).

## Verification output (real)

### `npm run build:web`

```
vite v6.4.1 building for web...
transforming...
✓ 272 modules transformed.
rendering chunks...
computing gzip size...
dist-web/index.html                   0.96 kB │ gzip:   0.50 kB
dist-web/assets/index-COhF8bJO.css  123.29 kB │ gzip:  16.72 kB
dist-web/assets/index-mMtcOqJ_.js     0.17 kB │ gzip:   0.16 kB
dist-web/assets/app-C--UO2wg.js       0.25 kB │ gzip:   0.21 kB
dist-web/assets/core-DsojzR6k.js      0.77 kB │ gzip:   0.41 kB
dist-web/assets/event-DRK-L59a.js     1.07 kB │ gzip:   0.58 kB
dist-web/assets/index-D8BamZOI.js     1.39 kB │ gzip:   0.69 kB
dist-web/assets/index-5FpjeHmg.js     1.53 kB │ gzip:   0.52 kB
dist-web/assets/stdio-B2pFB07W.js     1.63 kB │ gzip:   0.62 kB
dist-web/assets/index-BmsqoWMF.js   506.54 kB │ gzip: 176.86 kB
✓ built in 2.69s
```

### `~/.hermes/tools-venv/bin/python scripts/e2e_card_pipeline.py`

```
PASS  kanban card carries the STATUS chip
PASS  kanban chip shows the 05_review_r1 token  (DONE)
PASS  artifact list shows the pipeline files  (00_brief.md,01_spec.md,02_plan.md,03_plan_review.md,04_impl_log.md,05_review_r1.md,run-1.log)
PASS  drawer badge shows STATUS: DONE  (STATUS: DONE)
PASS  drawer badge names 05_review_r1.md as the source  (STATUS token from 05_review_r1.md)
PASS  per-file token chips render  (APPROVE,APPROVE,APPROVE,DONE)
PASS  artifact opens read-only content
PASS  viewer is a pre (no markdown render)
PASS  unit: spec+APPROVE -> move plan  ({"kind": "move", "to": "plan", "label": "approve spec → Plan"})
PASS  unit: plan+APPROVE -> move dev  ({"kind": "move", "to": "dev", "label": "approve plan → Dev"})
PASS  unit: dev+DONE -> move reviewtest  ({"kind": "move", "to": "reviewtest", "label": "dev done → Review/Test"})
PASS  unit: reviewtest+DONE -> status agent_tested  ({"kind": "status", "status": "agent_tested", "label": "review done (round 1) → agent_tested"})
PASS  unit: plan+CHANGES_REQUIRED -> back to spec  ({"kind": "move", "to": "spec", "label": "changes required → back to Spec"})
PASS  unit: dev+CHANGES_REQUIRED -> back to plan  ({"kind": "move", "to": "plan", "label": "changes required → back to Plan"})
PASS  unit: reviewtest+CHANGES_REQUIRED -> back to dev  ({"kind": "move", "to": "dev", "label": "changes required (round 2) → back to Dev"})
PASS  unit: BLOCKED -> flag with reason from the token line  ({"kind": "flag", "flag": "blocked", "reason": "reviewer cli missing on host", "label": "flag blocked — reviewer cli missing on host"})
PASS  unit: spec+DONE -> none  ({"kind": "none", "label": "DONE has no step from spec"})
PASS  unit: backlog+APPROVE -> none  ({"kind": "none", "label": "APPROVE has no step from backlog"})
PASS  unit: no token -> none  ({"kind": "none", "label": "no STATUS token yet"})
PASS  unit: parseStatusToken splits token + reason  ({"token": "BLOCKED", "detail": "waiting on creds"})
PASS  unit: non-token last line -> null  (None)
PASS  reviewtest card proposes the token transition  (review done (round 1) → agent_tested / Apply)
PASS  Apply sets the card status to agent_tested  (agent_tested)
PASS  Refresh picks up the rewritten token
PASS  CHANGES_REQUIRED proposes a step back to Dev  (changes required (round 1) → back to Dev / Apply)
PASS  Apply moves the card back to dev
PASS  Apply moves spec card to plan
PASS  blocked card badge shows BLOCKED
PASS  BLOCKED proposes the flag with its reason  (flag blocked — reviewer cli missing on host / Apply)
PASS  Apply sets the blocked flag on the card
PASS  blocked reason lands in the card field  (reviewer cli missing on host)
PASS  dev card proposes the back-step to Plan  (changes required → back to Plan / Apply)
PASS  Apply moves dev card back to plan
PASS  empty dir gives a readable empty state
PASS  empty state: no bogus badge token
PASS  missing dir also gives the empty state
PASS  missing dir raises no error banner
PASS  unassigned project shows the no-project note
PASS  bridge stub answers write  ({"status": 200, "body": {"path": ".../tmp-pipeline-test/.acp/cards/c-spec/run-9.log", "created": true, "bytes": 16}})
PASS  written file lands inside the worktree
PASS  zero pageerror events

41/41 assertions passed
```

## Integration requests

- **Bridge `list`/`read` shape** (host side, `~/.hermes/acp-ws-bridge.mjs`):
  to stop probing and to fill `mtime`, `/api/fs/list` needs a `files[]`
  array (`{name, path, bytes, mtime}`) and/or `/api/fs/read` an `mtime`
  field. `artifacts.ts` already consumes `files[]` when present, so the
  panel needs no code change once the bridge grows it.
- **`board.ts` reload**: Refresh re-reads artifacts and re-syncs the
  drawer; the board document itself has no re-read path. Under the shared
  state backend (`:25900`) the 5 s `RemoteKVStore` poll adopts remote
  changes anyway; under pure localStorage a `reload()` on the board store
  would let Refresh pick up `boardctl` edits without a page reload.

## Not verified / known limits

- Tauri build (`npm run build`) not exercised — the store is host-agnostic
  (same bridge seam as the role prompt editor).
- Bridge error codes 413/415 surfaced per-row but only stub-verified; the
  real `~/.hermes` bridge was read for semantics, not driven live.
- `spec + CHANGES_REQUIRED` and tokens on `backlog`/`done` cards propose
  `none` (the brief's table has no back-step from spec).
- `tmp-pipeline-test/` is recreated by the e2e script on each run and left
  untracked — it is test data inside the worktree, per the brief.
