# W5-A — Roles (CLI + args + prompt file, bound to stages)

**STATUS: DONE** — build green, e2e 35/35, zero pageerrors.

## What was built

- **`src/stores/roles.ts`** (new) — `roles.json` KV document, `version: 1`,
  keys `version` + `roles` + `stageRoles`. Role = data only:
  `{id, label, cli, args[], promptFile, maxConcurrent, pollIntervalSec,
  timeoutMin}`. CRUD: `addRole`, `updateRole`, `removeRole(id, {force})`,
  `setStageRole(stage, roleId | null)`. Validation (thrown Errors, surfaced
  verbatim in the UI): unique non-empty `id` without whitespace; `cli` from
  `KNOWN_CLIS` (`hermes | opencode | devin | pi | codex`);
  `maxConcurrent >= 1`; `pollIntervalSec >= 5`; `timeoutMin >= 1`.
  `removeRole` on a stage-assigned role throws
  `Role '<id>' is assigned to stage(s): <list>` unless `force: true` —
  no silent orphaning. Persistence via `loadKvStore` + debounced
  `scheduleSave` + pagehide flush, same shape as `board.ts`; permissive
  `sanitizeRole` on load (an unknown hand-edited `cli` survives — it just
  has no runner). `cliHasRunner` maps a cli to a configured agent by
  word-matching agent names (`Hermes Agent` → `hermes`, `Pi` → `pi`).

- **`src/lib/fsApi.ts`** (new) — `readTextFile(baseUrl, path)` →
  `GET <bridge>/api/fs/read?path=` → `{path, bytes, content}`;
  `writeTextFile(baseUrl, path, content)` → `POST <bridge>/api/fs/write`
  `{path, content}`. Bridge errors surface verbatim (403 outside root,
  415 binary, 413 >512KB, 404 missing).

- **`src/features/roles/RolesSection.vue`** (new), registered in
  `SettingsView.vue` next to Projects — role list, add/edit form
  (id, label, cli select, args, prompt-file path, the three limits),
  per-row "Prompt file" editor (bridge read/write, honest error display,
  resolved path shown from the bridge response), and a "Stage → role"
  block (six selects, empty = any runner). Force delete is only offered
  after the guarded delete rejects. Tokens only, stroke icons, no shadows.
  Exposes `window.__roles` like `__projects`.

- **`src/features/board/BoardColumn.vue`** — role selector in the column
  header (`data-testid="col-role-select"`, empty = "any runner"), danger
  styling when the assigned role has no runner.

- **`src/features/board/BoardCardItem.vue`** — `card-role-badge` chip with
  the stage role's label, plus `card-no-runner` chip reading exactly
  `no runner for role` when no configured agent matches the role's CLI.
  `src/stores/board.ts` is untouched — the badge derives from
  `rolesStore.roleForStage(card.stage)` at render time.

- **`src/components/BoardView.vue`** — `rolesStore.initRolesStore()` on
  mount (idempotent; `RolesSection` also self-inits).

- **`scripts/e2e_roles.py`** (new) — serves `dist-web` itself on
  `127.0.0.1:25983`, routes `:25900` state calls to 500 (localStorage
  fallback — nothing lands in `~/.hermes`), seeds a v2 board via
  `add_init_script`. Prompt files are written through the real bridge
  (127.0.0.1:25901) into `./tmp-roles-test/` inside the worktree.

Loose-coupling check: `grep -ri "prompt" src/stores/roles.ts
src/features/roles/ src/lib/fsApi.ts` matches only the word "prompt" in
field names/UI labels — no prompt text anywhere in panel code.

## Verification output (real)

### `npm run build:web`

```
vite v6.4.1 building for web...
transforming...
✓ 271 modules transformed.
rendering chunks...
computing gzip size...
dist-web/index.html                   0.96 kB │ gzip:   0.50 kB
dist-web/assets/index-Ce3iqR39.css  118.77 kB │ gzip:  16.11 kB
dist-web/assets/index-mMtcOqJ_.js     0.17 kB │ gzip:   0.16 kB
dist-web/assets/app-C--UO2wg.js       0.25 kB │ gzip:   0.21 kB
dist-web/assets/core-DsojzR6k.js      0.77 kB │ gzip:   0.41 kB
dist-web/assets/event-DRK-L59a.js     1.07 kB │ gzip:   0.58 kB
dist-web/assets/index-D8BamZOI.js     1.39 kB │ gzip:   0.69 kB
dist-web/assets/index-5FpjeHmg.js     1.53 kB │ gzip:   0.52 kB
dist-web/assets/stdio-Cv8SwEzt.js     1.63 kB │ gzip:   0.63 kB
dist-web/assets/index-CX3CIWF6.js   496.52 kB │ gzip: 173.40 kB
✓ built in 2.79s
```

### `~/.hermes/tools-venv/bin/python scripts/e2e_roles.py`

```
PASS  settings roles section renders
PASS  role row appears
PASS  role persisted in roles.json
PASS  roles.json version is 1
PASS  role fields round-trip
PASS  role survives reload
PASS  duplicate id rejected with visible error  (Role id 'dev' already exists)
PASS  duplicate id not added
PASS  maxConcurrent < 1 rejected
PASS  pollIntervalSec < 5 rejected
PASS  timeoutMin < 1 rejected
PASS  invalid role not added
PASS  second role created
PASS  codex role flagged no-runner in the list
PASS  stage assignments in the selects
PASS  delete of assigned role rejected  (Role 'dev' is assigned to stage(s): dev — unassign it first or use force)
PASS  assigned role still listed
PASS  force delete offered after rejection
PASS  missing prompt file shows the bridge error  (not found: /home/hermes/projects/acp-ui-w5-roles/tmp-roles-test/dev.md)
PASS  prompt path shown is the role's promptFile
PASS  prompt write lands on disk via the bridge
PASS  save status shown
PASS  reopened editor loads the saved content
PASS  dev column selector shows the assigned role  (dev)
PASS  spec column selector shows ghost
PASS  unassigned column selector is empty
PASS  dev card carries the role badge  (Developer)
PASS  dev role has a runner (no warning badge)
PASS  spec card carries the ghost role badge
PASS  codex role shows 'no runner for role' on the card
PASS  unassigned stage shows no role badge
PASS  column header can assign a role
PASS  force delete removes the role
PASS  force delete clears the stage assignment  ({"spec": "ghost"})
PASS  zero pageerror events

35/35 assertions passed
```

## Not verified / known limits

- Tauri build (`npm run build`) not exercised — changes are host-agnostic;
  `loadKvStore` picks plugin-store on Tauri the same way board.ts does.
- The bridge error codes 415/413 were not exercised in e2e (404 and the
  write path are; the helpers surface any `{error}` body verbatim).
- `cliHasRunner` is a name-word match against configured agents — a custom
  agent named e.g. `my-devin-box` counts as a `devin` runner.
- Roles are stored but nothing launches them yet (dispatcher is a later
  workstream); `maxConcurrent`/`pollIntervalSec`/`timeoutMin` are data.
