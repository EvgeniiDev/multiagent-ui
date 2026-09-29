# REVIEW BRIEF — bridge workstream (branch cc/bridge)

You are a READ-ONLY code reviewer with clean context. Review the diff of this branch against its
base and write findings to `REVIEW.md` at this worktree root. **Do NOT change any product code** —
review only. Commit `REVIEW.md` on `cc/bridge` when done.

## What to review
The diff `git diff 2e077b9..HEAD` on this branch (`/home/hermes/projects/acp-ui-w-bridge`). It
hardens a stdio↔WebSocket ACP bridge (`deploy/acp-ws-bridge.mjs`, a zero-framework Node script,
mirrored to `server/` and `~/.hermes/`) and its Vue client transport: heartbeat/keepalive,
reconnect with backoff, and mid-run steer. Accepted design in `PLAN.md`; dev self-report in
`REPORT.md`. Read both, then the actual changed files.

## Focus (in priority order)
1. **The two SACRED invariants must survive every new path** (PLAN §5):
   - **Per-session routing**: a `session/load` replay reaches only its own tab (`sessionOwner` +
     `broadcast()`). Verify `$/pong` is sent with a bare `ws.send` to the asking socket, NEVER via
     `broadcast()`. Verify heartbeat `ws.terminate()` runs the same cleanup as `ws.on('close')`
     (drops sessionOwner claims + pendingClientReqs).
   - **Per-socket request-id namespacing**: `$/ping`/`$/pong` handled BEFORE the id-rewrite, never
     entering `pendingClientReqs`, never colliding ids on the shared child. Verify `$/ping` is
     intercepted inside `noteOutbound`'s per-line loop, NOT in `ws.on('message')` (multi-line frame
     trap, PLAN §5).
2. **The §0 watchdog fix** — confirm `$/ping` no longer re-arms `lastTrafficAt` (it was making the
   agent-wedge watchdog dead code). `noteTraffic()` should fire only when a real frame was forwarded.
3. **Correctness of new logic** — heartbeat sweep (isAlive lease, terminate on miss), `pongCapable`
   graceful degradation (native ACP agents that never pong must NOT be torn down), reconnect backoff
   + verify-on-foreground probe, steer = cancel-then-prompt without blocking on cancel.
4. **Client transport** (`src/lib/transport/websocket.ts`) — missed-pong accounting, `$/pong`
   swallowed below the listener layer (not leaked to Traffic Monitor / RPC idle timer), abortSocket
   synthesizing close (a real close can hang in CLOSING).
5. **Test quality** — open `scripts/e2e_bridge_heartbeat.mjs` + `scripts/test_ws_transport.mjs`:
   real behavior assertions, or tautologies / source-grep cheats? Flag any test that can't fail.
   Confirm the regressions (`e2e_bridge_routing.mjs`, `e2e_bridge_timeout.py`) still assert real
   routing/timeout behavior.
6. **3-copy mirror** — `deploy/`, `server/`, `~/.hermes/acp-ws-bridge.mjs` must be byte-identical
   (`diff -q`). compose runs `server/`; the python e2e asserts server==~/.hermes.
7. **Scope/ownership** — only allowed files touched? Flag edits to forbidden files (App.vue,
   package.json, vite.config, or workflow-stream files: acp-state-server.mjs, ui.ts,
   WorkflowView.vue, lib/porch/**).

## Output — `REVIEW.md`
```
VERDICT: APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES
## Blocking issues     — file:line, what's wrong, why (empty if none)
## Nits                — minor, non-blocking
## What I verified     — checks you actually ran/read
## Notes for the implementer — concrete, actionable
```
Cite `file:line`. Pay special attention to any way the two sacred invariants could break under
reconnect/heartbeat/steer. End with `REVIEW COMPLETE`.

## Rules
- Read-only. Do NOT edit product code. You MAY run the test scripts + `npm run build:web` to verify.
- Do not `docker compose restart` or start the stack. Commit only `REVIEW.md`.
