# C1-a — panel reads/writes shared state (`storage.ts` only)

## STATUS: PASS

- `npm run build:web` — green (vue-tsc + vite).
- Live server API smoke on :25900 — all calls OK.
- `scripts/e2e_state_backend.py` — **18/18 assertions passed**, zero `pageerror`.

## Done

`src/lib/host/storage.ts` is now a pluggable backend; the public API
(`loadKvStore(name)` / `KVStore` `get`/`set`/`save`) is unchanged, and no
store or component was touched:

- **Probe:** `GET http://<location.hostname>:25900/health`, 1.5 s timeout,
  result cached for the session (`healthProbe` singleton).
  `VITE_STATE_URL` can override the base URL at build time.
- **Remote backend** (`RemoteKVStore`) when the probe succeeds:
  - reads/writes `/api/state/<name>`; the localStorage copy is kept as an
    always-on mirror;
  - **migration** — on first contact, if the doc is missing on the server but
    present in localStorage, the local copy is pushed up (nothing lost);
  - **poll** — `reload()` on a fixed 5 s interval adopts the remote doc only
    when `updatedAt` is newer and there are no unsaved edits (`dirty` guard);
    while `dirty`, inbound state never clobbers local edits, and pending
    edits are pushed once the server can take them;
  - **conflicts** — PUT uses `rev`; on 409 the later `updatedAt` wins
    (adopt remote if newer than our newest local edit, else overwrite);
  - **degradation** — any fetch failure flips to localStorage-only mode
    silently; the poll re-syncs on recovery. No exceptions escape `save()`.
- **Tauri** path unchanged (`@tauri-apps/plugin-store`).
- Web stores are cached per doc name, so `preferences.json` etc. get one
  shared in-memory view and one poll timer.

## Verification output

`npm run build:web`:

```
vite v6.4.1 building for web...
✓ 264 modules transformed.
dist-web/assets/index-DHqZcHLw.js   470.67 kB │ gzip: 165.69 kB
✓ built in 2.71s
```

Live server smoke (`curl http://127.0.0.1:25900/...`):

```
GET /health                      -> {"ok":true,"dir":"/home/hermes/.hermes/acp-ui-state","docs":0}
GET /api/state (before)          -> {"docs":[]}
PUT /api/state/smoke.json        -> {"name":"smoke.json","rev":1,"updatedAt":1790163721869}
GET /api/state/smoke.json        -> {"name":"smoke.json","rev":1,"updatedAt":1790163721869,"data":{"ok":true}}
DELETE /api/state/smoke.json     -> {"name":"smoke.json","deleted":true}
GET /api/state (after)           -> {"docs":[]}
```

E2E (`~/.hermes/tools-venv/bin/python scripts/e2e_state_backend.py`) —
dist-web on :25982, test server `STATE_DIR=<worktree>/tmp-state-test
PORT=25908`, page traffic to `:25900` routed to the test server; context A =
laptop, B = phone (clean profiles), C = server returns 500:

```
PASS  A: session list synced through mocked agent  (alpha one,alpha two,beta one,loose work,orphan job)
PASS  A: sessions.json reached the state server
PASS  A: server sessions.json holds the synced inventory  (alpha one,alpha two,beta one,loose work,orphan job)
PASS  A: localStorage projects.json migrated to the server
PASS  A: server projects.json carries the seeded registry  (Alpha,Beta,Common)
PASS  A: preferences.json migrated to the server
PASS  setup: marker session PUT into shared sessions.json
PASS  setup: Gamma project PUT into shared projects.json
PASS  B: sidebar shows the server-only marker session  (alpha one,alpha two,beta one,loose work,orphan job,shared from laptop)
PASS  B: scope selector shows server-only project Gamma  (All,Common,Alpha,Beta,Gamma)
PASS  B: localStorage mirror of sessions.json matches server state  (alpha one,alpha two,beta one,loose work,orphan job,shared from laptop)
PASS  B: localStorage mirror of projects.json matches server state  (Alpha,Beta,Common,Gamma)
PASS  B: server sessions.json still matches the shared inventory
PASS  B: server projects.json still matches the shared registry
PASS  C (server down): sidebar still syncs via the agent  (alpha one,alpha two,beta one,loose work,orphan job)
PASS  C (server down): seeded registry read from localStorage  (All,Common,Alpha,Beta)
PASS  C (server down): writes persist to localStorage  (p-alpha)
PASS  zero pageerror events

18/18 assertions passed
```

## Remaining / out of scope

- Settings "shared state" indicator — separate task (not touched).
- Live cross-device updates apply to a store's KV view on the next `get()`;
  already-mounted Pinia state refreshes on reload/navigation (stores were
  not to be touched).
- `server/acp-state-server.mjs` stays untracked — orchestrator's file;
  `scripts/e2e_state_backend.py` runs it directly for the test leg.
