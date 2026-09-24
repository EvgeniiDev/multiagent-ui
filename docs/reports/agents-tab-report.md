# F9.9 — Agents tab: who is holding what, right now

STATUS: DONE

## What the card asked

One Board tab that answers, per executor (CLI/agent): which roles it serves,
how many `maxConcurrent` slots are busy right now, which card titles are
currently held, and the last ledger activity/error per role — with
release/stop controls going through the same state documents the runner
uses, and no pretending the panel can kill processes it does not own.

Truth sources honoured:

- "In work" = live claims only (`claims.json`, `leaseUntil > now`). A card's
  stage/status is an intention and is never shown as work in flight.
- Last activity / last error = the `kind:'card'` rows the dispatcher writes
  to `activity.json` (each carries `role`), not card status.
- "No activity yet" is distinguished from "last activity failed".

## What changed

- `src/features/board/AgentsTab.vue` — rewritten (extends the existing tab,
  not a parallel view):
  - executor sections keyed on `role.cli`; every role the registry knows is
    listed — including slots-free and never-run roles;
  - `busy/max` per role and summed per executor from live, lease-aware
    claims (`claimsStore.now` ticks, expired leases drop on their own — no
    manual refresh);
  - held card titles resolved from `claims.json` cardIds through the board
    store; claim's role resolved via `roleId` with the `runner:role`
    agentName-suffix fallback; live claims with no resolvable role land in
    an honest "unassigned claims" group instead of disappearing;
  - last ledger row per role shown with its timestamp; failure rows
    (non-zero `exit=`, timeout kill, `maxRetries … exhausted`, lease-expiry
    sweep) render in the error colour; deliberate releases/cancels are not
    errors; "no activity yet" is its own state;
  - **Release** per held claim and **Stop all** per executor call
    `claimsStore.releaseClaims` — the same rev-checked PUT the runner's
    `mutate()`/`boardctl` use — then append `kind:'card'` audit rows
    (`role`, `sessionId`) to `activity.json` and show a note that says
    plainly the panel cannot signal the pid (`pids N keep running until the
    runner that owns it exits; run node server/acp-runner.mjs stop-all`);
  - 390px: rows wrap, no horizontal scroll; `.ctl-btn` meets the 44px
    touch-target rule under the existing `max-width: 800px` media block.
- `src/lib/host/storage.ts`:
  - new `mutateRemoteDoc(name, fn)` — rev-safe GET → mutate → PUT →
    retry-on-409 against `/api/state/:name`, the same protocol
    `acp-runner.mjs`/`boardctl` use;
  - **bug fix** in `RemoteKVStore.reload()`: a `dirty` store whose remote
    copy was newer neither pushed nor adopted — it wedged forever (`dirty`
    never cleared, remote updates never adopted). The dirty branch now
    always calls `push()`; the conflict path inside `push()` already
    resolves correctly (adopts a genuinely newer remote, force-puts when
    the local edit is newer). Found by this suite: the fallback write plus
    an external seed left the claims store permanently showing the stale
    map (see "the failure that took two fixes" below).
- `src/stores/claims.ts` — `releaseClaims(cardIds)`: prefers
  `mutateRemoteDoc` (web + state server), falls back to the local
  mirror/plugin-store path (Tauri, offline) — returns the claims actually
  dropped so the tab can audit them.
- `scripts/e2e_agents_tab.py` — new suite (registered in `e2e_all.py`):
  own `acp-state-server` on **25912** (`STATE_DIR=tmp-agents-tab-test`),
  own UI server on **25911**, page `:25900` traffic proxied to the test
  server via a playwright route (the host's real state service on :25900 is
  never touched). Seeds roles (devin: dev+qa, codex: review, pi: idle),
  board cards, `kind:'card'` ledger rows and two live claims.
- `scripts/e2e_board.py` — its Agents-tab check now seeds a minimal
  `roles.json` and counts `[data-testid="role-row"]` (the tab no longer
  lists raw configured agents — it lists roles/executors).
- `docs/agents-tab-390x844.png` — the suite's own 390px screenshot.

## The failure that took two fixes

First full run: release "worked" in the UI but `claims.json` kept the claim,
and a later re-seed never showed (0/2 forever). Two independent causes:

1. **Harness**: `wait_for` polled the state server through pure `urllib`
   for up to 16s without a single playwright call — the page's routed
   requests (including the release's own GET/PUT and its 5s polls) could
   not be dispatched in that window. The release landed only when the next
   locator call pumped the dispatcher. Fix: `wait_for` now sleeps via
   `page.wait_for_timeout`, keeping the dispatcher alive.
2. **Product**: when the starved GET timed out, `releaseClaims` fell back
   to `store.set` + `store.save()` — but `save()` skips `push()` while
   `down`, leaving `dirty=true`; then `reload()`'s dirty branch
   early-returned forever once the remote doc was newer than `touchedAt`.
   Any store could wedge this way in production (offline edit + a newer
   remote write). Fixed in `RemoteKVStore.reload()` as described above —
   not papered over with a retry.

## Verification

```
$ npm run build:web
…
✓ 281 modules transformed.
dist-web/assets/index-yk-lw2gl.js   539.49 kB │ gzip: 188.20 kB
✓ built in 2.83s        (vue-tsc --noEmit clean; only the pre-existing
                         >500kB chunk warning)
```

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_agents_tab.py
PASS  every executor is listed (devin, codex, pi)  (['devin', 'codex', 'pi'])
PASS  every role is listed incl. never-run (dev, qa, review, idle)
PASS  devin shows exactly 2/2 busy slots  (2/2)
PASS  devin holds both card titles  (['AGT alpha card — held by dev', 'AGT beta card — held by qa'])
PASS  idle role says no activity yet
PASS  review role shows the failed last run  (… exit=7 dur=9s … role=review …)
PASS  review slot stays free while showing the error
PASS  dev's live run is not shown as an error
PASS  expired lease stops counting busy on its own  (slots=1/2 titles=['AGT alpha card — held by dev'])
PASS  release drops the claim in claims.json
PASS  view follows the release (0/2, title gone)  (slots=0/2)
PASS  release audited to activity.json with the role  (… "claim released by panel (Agents tab) card=card-alpha — child pid not signalled", "role": "dev" …)
PASS  release note admits the pid is not signalled
PASS  re-seeded claims show up as 2/2 again  (2/2)
PASS  stop-all releases the executor's claims in the doc  ({})
PASS  view follows stop-all (0/2, no held cards)
PASS  stop-all audited per claim with roles  (["dev","qa"])
PASS  stop note admits the panel cannot kill
PASS  agents@390: devin shows 2/2  (2/2)
PASS  agents@390: no page-level horizontal scroll  (0px)
PASS  agents@390: all 5 tab controls >= 44px  (ok)
PASS  agents@390: all 11 pane controls >= 44px  (ok)
PASS  zero pageerror events

23/23 assertions passed
```

Regression — the whole runner (`storage.ts` touches every store):

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_all.py
…
[PASS] shell + projects      [PASS] dashboard        [PASS] phone targets
[PASS] live stream           [PASS] scrollbars       [PASS] roles
[PASS] card pipeline         [PASS] auto approve     [PASS] runner
[PASS] dispatch              [PASS] agents tab       [PASS] pm
[PASS] dashboard math        [PASS] voice
[FAIL] board   ->  Agents tab lists configured agents (0 rows)   [pre-fix]

$ ~/.hermes/tools-venv/bin/python scripts/e2e_board.py   (after seeding roles)
…
PASS  Agents tab lists role rows  (1 rows)
…
21/21 assertions passed
```

## NOT verified live

- **Real runner interplay**: the suite drives the real `acp-state-server`
  code, but no live `acp-runner.mjs` was holding claims while the panel
  released them. The "released claim is not re-taken" behaviour and the
  owning-runner exit path are covered only by the document contract, not a
  live process.
- **No real child pids**: seeded claims carry `pid: <e2e pid>`; the "not
  signalled" note and the audit rows are asserted, actual SIGTERM routing
  belongs to the runner (intentionally — the panel never signals).
- **`mutateRemoteDoc` 409-retry loop**: exercised implicitly only; no
  injected concurrent writer forced a conflict round.
- **Tauri backend**: `releaseClaims`' plugin-store fallback is for the
  desktop host; e2e runs the web/remote path plus deliberately exercises
  the mirror path only through the wedged-store bug it exposed.
- **Very long ledgers/boards**: the tab renders fine at fixture scale; no
  stress run with hundreds of roles/claims.

## Implementation notes

- Role↔claim matching prefers `claim.roleId`; the `runner:role` agentName
  suffix is the documented fallback the runner itself writes.
- A claim is shown under the *role that took it*, not the card's current
  stage — stage is intention, claim+ledger are fact.
- The `unassigned` executor group exists so a live claim whose role was
  deleted (or was written by hand) still surfaces instead of vanishing.
