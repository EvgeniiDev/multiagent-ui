# DEV BRIEF — harden the ACP transport (workstream: cc/bridge)

You are the IMPLEMENTER for the bridge workstream. A detailed plan already exists at `PLAN.md` in
this directory (written and accepted). **Read `PLAN.md` first and implement it.** It has verified
line numbers for every current mechanism, the heartbeat/reconnect/steer designs, the sacred-invariant
preservation map, and the test plan. Follow it. Where it leaves an open question with a
recommendation (Q1 reconnect-forever-with-cap, R5 cancel-then-prompt default), take the recommendation.

## Where you are
- Worktree: `/home/hermes/projects/acp-ui-w-bridge`, branch `cc/bridge`, based on skeleton commit
  `2e077b9`. Git worktree of `~/projects/acp-ui`. `node_modules` is symlinked from the main checkout
  — do NOT run `npm install`.
- Stack: the bridge is a zero-framework Node script (`require('ws')`, `node:http`). Client is
  Vue 3 + TS. Build on the host: `npm run build:web`. Node here is v26.7.0.

## Ownership — files you may edit
- `deploy/acp-ws-bridge.mjs` — **the source of truth per AGENTS.md.** PLAN §7-R1: after editing,
  mirror it byte-for-byte to `server/acp-ws-bridge.mjs` AND `~/.hermes/acp-ws-bridge.mjs`
  (`cp deploy/acp-ws-bridge.mjs server/acp-ws-bridge.mjs && cp deploy/acp-ws-bridge.mjs
  ~/.hermes/acp-ws-bridge.mjs`). `scripts/e2e_bridge_timeout.py` asserts server==~/.hermes; a
  drift fails it. **compose actually runs `server/`** — so the mirror is not optional.
- `src/lib/transport/websocket.ts`, `src/lib/transport/types.ts`, `src/lib/transport/stdio.ts`
- `src/lib/acp-bridge.ts`, `src/lib/sessionRuntime.ts`, `src/stores/session.ts`
- `src/components/ChatView.vue` — composer-gate change only (keep the diff minimal, PLAN §4)
- new `scripts/e2e_bridge_heartbeat.mjs` + `scripts/e2e_bridge_heartbeat_agent.mjs`
**Forbidden — do NOT touch:** `package.json` (no test script may be added — tests run as
`node scripts/...` directly), `vite.config.ts`, `src/App.vue` (PLAN §Q2 makes zero edits here on
purpose — verify-on-foreground folds into `tryReconnect` which App.vue already calls), and the
workflow workstream's files (`server/acp-state-server.mjs`, `src/stores/ui.ts`,
`src/components/WorkflowView.vue`, `src/lib/porch/**`, `src/stores/workflow.ts`,
`src/features/workflow/**`). Need a forbidden file? → `REPORT.md` `## Integration requests`.

## The two sacred invariants (PLAN §5 — do not break either)
1. **Per-session routing** — a `session/load` replay in one tab reaches only its own tab
   (`sessionOwner` map + `broadcast()`). `$/pong` must be sent with a bare `ws.send` to the asking
   socket, never through `broadcast()`.
2. **Per-socket request-id namespacing** — each client numbers ids from 1; the bridge rewrites to
   bridge-unique ids on the shared child. `$/ping`/`$/pong` are handled before the id-rewrite and
   never enter `pendingClientReqs`. Intercept `$/ping` INSIDE `noteOutbound`'s per-line loop, never
   in `ws.on('message')` (a WS frame can carry several NDJSON lines — PLAN §5 naive-change trap).

Do not forget the §0 trap fix: `$/ping` currently re-arms `lastTrafficAt`, making the agent-wedge
watchdog dead code. The fix (PLAN §2b) stops `$/ping` counting as traffic.

## Verification (required — do it, paste real output into REPORT.md)
1. `npm run build:web` must pass (vue-tsc errors are failures). Paste the tail.
2. New standalone e2e: `node scripts/e2e_bridge_heartbeat.mjs` — must assert all 6 behaviors in
   PLAN §6 (pong same-socket-only; watchdog unmasked; sweep keeps healthy sockets; half-open socket
   swept + claim dropped; reconnect re-claim; steer cancel-then-prompt). Paste full output.
3. Regression — the existing bridge suites must still pass after your edits + the 3-copy mirror:
   `node scripts/e2e_bridge_routing.mjs` and
   `~/.hermes/tools-venv/bin/python scripts/e2e_bridge_timeout.py`. Paste both tails. (The python
   one's first check forces the three bridge copies into sync — run it AFTER the cp mirror.)
4. Do NOT `docker compose restart` unless explicitly asked — the compose-only rule in AGENTS.md.
   Your e2e spins the bridge standalone on scratch ports (PLAN §6), which is the right way to test.

## Report (`REPORT.md` at worktree root)
```
STATUS: DONE | PARTIAL | BLOCKED
## What was built        — heartbeat, reconnect, steer — with file paths + line refs
## Evidence              — build tail, e2e_bridge_heartbeat output, both regression tails (real)
## Deliberate stubs      — anything left (e.g. pongCapable degradation for native ACP agents)
## Integration requests  — anything needing a forbidden file
## How to review         — exact commands + what to observe
```

## Working rules
- Small commits on `cc/bridge`; commit once when the build first goes green, again at the end.
- Preserve the two sacred invariants through EVERY new path (heartbeat teardown, reconnect, steer).
- Smaller-fully-working over big-half: low on budget → leave build green, mark `PARTIAL`, never
  leave vue-tsc broken or the three bridge copies out of sync.
- No new runtime deps, no secrets. `pongCapable` graceful degradation (PLAN §2c) is required so
  native ACP-over-WS agents that never pong are not torn down.
- End REPORT.md with a line: `DEV COMPLETE`.
