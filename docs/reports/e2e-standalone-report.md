# Report: every `scripts/e2e_*.py` suite runs standalone

Branch `cc/w14-e2e-standalone`, tree `/home/hermes/projects/acp-ui-w14-e2e`.
Card: board/dashboard/touch died with `net::ERR_CONNECTION_REFUSED` when run
alone because only the aggregator started the web bundle. Fixed for **every**
suite — harness-only changes plus a handful of stale-fixture repairs; no
assertion semantics changed.

## What changed

### New shared harness — `scripts/_e2e_harness.py`

One place for the three duplicated dialects suites used to start servers:

- `listening_ports()` / `port_free()` — asks `ss -ltn` whether a port is
  LISTENING. A port with only TIME_WAIT sockets is FREE (no bare bind-probe;
  the `SO_REUSEADDR` bind path is only a fallback when `ss` is absent).
- `serve_web(preferred, dist)` — serves `dist-web` on `preferred`, or on the
  first free port above it, prints a `NOTE` on fallback, returns
  `(proc, base_url)`. Fails non-zero if nothing in the span can serve.
- `serve_state(preferred, state_dir)` — same policy for
  `server/acp-state-server.mjs`; returns `(proc, port)`.
- `wait_port`, `stop` — readiness + terminate/kill teardown.

The preferred-port-plus-fallback rule is the real fix for the observed bug:
a foreign stale server from `acp-ui-w-agents` held `:25999` the whole
session, so board's old code would either silently test **another
worktree's build** (observed: `21/21` against the wrong `dist-web`) or
refuse to run. Now it falls back and says so:

```
NOTE  port 25999 busy — serving /home/hermes/projects/acp-ui-w14-e2e/dist-web on 26000 instead
```

(dark_contrast similarly fell back `25994 → 25995`; both foreign servers
untouched.)

### Suite migrations (28 files use the harness)

- **Web-serving suites** — board, dashboard, touch, accent_contrast,
  auto_approve, board_pipeline, card_pipeline, card_run, composer,
  dark_contrast, dash_math, global_actions, icons, live_stream,
  muted_contrast, project_scope, projects_registry, projects_ux, roles,
  scrollbars, voice, white_text: `start_server` blocks (connect-probe,
  bind-probe and no-check dialects) replaced by `serve_web`; `BASE` rebased
  to the returned URL.
- **State-server suites** — agents_tab, state_backend, pm, review,
  dispatch, runner: `serve_state` for their own `acp-state-server.mjs`,
  `serve_web` where they drive the UI; `STATE_URL`/`WEB_URL` rebased to the
  actual ports (`e2e_pm` still builds its `VITE_STATE_URL` bundle against
  the real port).
- **`e2e_all.py`** — dropped its serve role entirely; it is now a thin
  runner that executes the (self-serving) suites and summarises. Same 16
  suites as before; exit non-zero on any failure.

### Shared-state isolation (`:25900` is the live panel's, not ours)

`localStorage.clear()` does not isolate a suite — the app probes
`http://<host>:25900/health` and adopts remote docs. Every browser suite
now handles it one of two ways:

- `page.route(re.compile(r":25900/"), lambda r: r.abort())` — for suites
  whose fixtures are localStorage seeds (board, dashboard, board_pipeline,
  composer, dark_contrast, accent_contrast, muted_contrast, projects_ux,
  icons, white_text, card_pipeline, card_run, auto_approve, dash_math,
  live_stream, scrollbars, touch, voice, project_scope, global_actions,
  projects_registry).
- Own `acp-state-server.mjs` via `serve_state` (agents_tab, state_backend,
  pm, review, dispatch, runner — the last two are node-side and hit
  `STATE_URL` directly, no page traffic).

This fixed real false-failures observed in verification: board_pipeline saw
24 live cards instead of the seeded 8; dark_contrast reported 42 phantom
contrast failures from live board chips; composer couldn't see
`.new-session-btn`; accent_contrast's "New card" element was hidden by a
non-empty live board. All green after isolation.

### Live-dependency suites (say so + SKIP, never take over a live port)

- `e2e_shell_projects.py` — asserts on real agent sessions and the real
  projects tree; docstring declares it, probes
  `http://192.168.1.222:25808/` and prints `SKIP` + exit 0 when unreachable.
- `e2e_global_actions.py` — needs the real Hermes bridge on `:25901`
  (POST `/api/fs/mkdir` side effects); probes `/api/fs/root`, SKIP + exit 0
  when unreachable.
- `e2e_projects_registry.py` — same live bridge for on-disk folder
  assertions; same SKIP contract.

### Stale-fixture repairs (mechanism, not assertions)

- `e2e_icons.py` / `e2e_white_text.py` — `.settings-btn` no longer exists in
  this tree (renamed `scope-icon-btn`); selectors updated to the same
  controls (`title`/`aria-label` unchanged). Checks still assert the same
  things.
- `e2e_icons.py` — its static scan also flagged a real `U+2715` glyph in a
  `src/features/projects/ProjectDetail.vue` comment (committed in
  `385a1ce`); replaced with `×` (U+00D7, outside the `2600–27BF` range).
- `e2e_projects_ux.py` — the Projects view now lists the **registry**
  (`projects.json`), not session cwds; the seed gained a 26-entry
  `acp-ui:projects.json` registry matching the seeded sessions' cwds.
- `scripts/.accent_baseline.json` — generated via
  `python scripts/e2e_accent_contrast.py baseline` and committed, so the
  suite's default `verify` mode runs standalone.

## Verify — exact commands

Build (tail):

```
$ npm run build:web
dist-web/assets/index-T9jNBt1M.js   549.16 kB │ gzip: 191.41 kB
✓ built in 2.90s
```

Each suite (run twice back to back, exit code captured from python, not a
tail pipe):

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_<suite>.py   # ×2 per suite
```

| suite | run 1 | run 2 | last line |
|---|---|---|---|
| e2e_accent_contrast | 0 | 0 | 10/10 assertions passed |
| e2e_agents_tab | 0 | 0 | 23/23 assertions passed |
| e2e_auto_approve | 0 | 0 | 15/15 assertions passed |
| e2e_board | 0 | 0 | 21/21 assertions passed |
| e2e_board_pipeline | 0 | 0 | 49/49 assertions passed |
| e2e_card_pipeline | 0 | 0 | 41/41 assertions passed |
| e2e_card_run | 0 | 0 | 18/18 assertions passed |
| e2e_composer | 0 | 0 | 30/30 assertions passed |
| e2e_dark_contrast | 0 | 0 | 7/7 assertions passed |
| e2e_dash_math | 0 | 0 | 6/6 assertions passed |
| e2e_dashboard | 0 | 0 | 16/16 assertions passed |
| e2e_dispatch | 0 | 0 | 46/46 checks passed |
| e2e_global_actions | 0 | 0 | 52/52 assertions passed |
| e2e_icons | 0 | 0 | 15/15 passed |
| e2e_live_stream | 0 | 0 | 8/8 assertions passed |
| e2e_muted_contrast | **1** | **1** | 5/6 assertions passed |
| e2e_pm | 0 | 0 | 68/68 assertions passed |
| e2e_project_scope | 0 | 0 | 23/23 assertions passed |
| e2e_projects_registry | 0 | 0 | 47/47 assertions passed |
| e2e_projects_ux | 0 | 0 | 19/19 assertions passed |
| e2e_review | 0 | 0 | 50/50 assertions passed |
| e2e_roles | 0 | 0 | 35/35 assertions passed |
| e2e_runner | 0 | 0 | 26/26 checks passed |
| e2e_scrollbars | 0 | 0 | 12/12 assertions passed |
| e2e_shell_projects | 0 | 0 | PROJECTS E2E OK |
| e2e_state_backend | 0 | 0 | 18/18 assertions passed |
| e2e_touch | 0 | 0 | 17/17 assertions passed |
| e2e_voice | 0 | 0 | 30/30 assertions passed |
| e2e_white_text | **1** | **1** | 17/21 assertions passed |

Aggregator:

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_all.py
===== summary
all E2E scripts passed            # exit 0, all 16 member suites PASS
```

## Suites that legitimately need live services

- `e2e_shell_projects` — live panel `http://192.168.1.222:25808/`; panel
  was UP during verification so it ran live (`PROJECTS E2E OK`, exit 0).
  SKIP path reviewed but not exercised — nothing was taken down to test it.
- `e2e_global_actions`, `e2e_projects_registry` — live Hermes bridge
  `http://127.0.0.1:25901`; bridge was UP (`GET /api/fs/root` →
  `{"root":"/home/hermes",...}`) so both ran live. SKIP path reviewed, not
  exercised.
- Live `:25900` state server was up throughout; no suite binds it — all
  browser traffic to it is aborted or proxied to suite-owned servers.

## Known failures — real content, not harness (assertions unchanged)

- **e2e_muted_contrast 5/6** — `FAIL light mode: accent exceptions
  observed (the known three classes) (0 accent rows)`. The suite expects
  the three known light-mode accent near-misses to still fail; in this
  tree's CSS light mode has **zero** contrast failures — the proposal
  appears applied. Dark-mode exceptions are still observed on the same
  fixture, so the elements render; the sentinel is stale relative to this
  branch. Not touched — changing it means changing what the suite asserts.
- **e2e_white_text 17/21** — 4 real measured contrast failures in the
  built bundle: dark `.disconnect-btn` :hover 2.94:1, dark `.send-btn`
  3.32:1, dark `.agent-item .delete-btn` :hover 2.94:1, light `.send-btn`
  2.18:1 (all need ≥4.5). The white-text fix doesn't cover those states in
  this tree's CSS — a design gap for the contrast workstream, outside this
  card's scope. (The suite previously couldn't even reach measurement —
  its trigger selector was stale; now fixed, and these are honest values.)

## Not verified live

- The `SKIP` branches of the three live-dependency suites (all services
  were up; the probe is a 3–5 s `urlopen` with `sys.exit(0)`).
- `e2e_shell_projects` on a host that is **not** `192.168.1.222` — it is
  this machine's panel address, verified answering here.
- Re-run immunity beyond two runs: TIME_WAIT handling is covered by the
  `ss -ltn` check in `port_free` rather than by exhaustion testing.
