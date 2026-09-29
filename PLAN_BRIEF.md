# PLANNING BRIEF — Stable custom ACP transport in acp-ui (workstream: bridge)

You are a PLANNER. Your ONLY deliverable is a low-level implementation plan written to `PLAN.md`
at this worktree root. **Do NOT write, edit, or generate any product code.** Study the bridge and
its client, verify against the real files, and produce a plan another agent will implement. When
done, `PLAN.md` must exist and be committed on this branch (`cc/bridge`).

## Where you are
- Machine: this host (Linux). Worktree: `/home/hermes/projects/acp-ui-w-bridge`, branch `cc/bridge`,
  cut from skeleton commit `2e077b9`. Git worktree of `~/projects/acp-ui`.
- Stack: the bridge is a zero-framework Node script (`require('ws')`, `node:http`). The frontend
  is Vue 3 + TS. Frontend builds with `npm run build:web`; the bridge runs under docker compose in
  prod, but you do NOT need to run either to plan.
- Idea donor (READ-ONLY, do not modify): `/home/hermes/projects/paseo-src` — React Native / Expo.
  Its transport layer (`packages/protocol`, `packages/client/src/daemon-client.ts`,
  `packages/relay`) is the source of proven reconnect/heartbeat ideas.

## The task you are planning
Harden acp-ui's existing WebSocket bridge so the connection is stable and bidirectional. Scope
decided with the user: **harden the existing bridge, NOT a full protocol rewrite.** Bring in ideas
from Paseo. Three concrete goals from the user:
1. **WebSocket does not silently drop** — add heartbeat/keepalive (ping-pong) + reconnect/resume so
   a dropped or half-open connection is detected and recovered, not left hanging.
2. **Bidirectional channel** — all information the UI needs flows both ways reliably.
3. **Poke an agent mid-run** — ability to steer/interrupt an agent while it is working.

## The current bridge — verified facts (read the file, cite line numbers)
Source of truth: `deploy/acp-ws-bridge.mjs` (905 lines). The copy at `~/.hermes/acp-ws-bridge.mjs`
is an install.sh artifact — **edit only the deploy/ source.** Runs one child ACP process serving
ALL WebSocket clients over stdio, newline-framed NDJSON, one JSON-RPC line per WS frame.

What EXISTS today (verify each):
- **Child-process watchdog** (line ~746): if there are pending client requests, no pending agent
  requests, and no traffic for `IDLE_TIMEOUT_MS`, it declares the agent wedged, fails all pending
  client requests with a JSON-RPC error, and SIGKILLs the child; the next client message respawns.
  This guards the AGENT, not the socket.
- **Per-session routing** (`sessionOwner` map, `broadcast()` line ~772): a frame naming a claimed
  sessionId goes only to the owning socket; responses go to the caller; sessionless frames
  broadcast. **SACRED INVARIANT — a `session/load` replay in one tab must reach only its own tab.**
- **Per-socket request-id namespacing** (`noteOutbound`/`noteInbound`, `pendingClientReqs`): each
  client numbers ids from 1; the bridge rewrites to bridge-unique ids and rewrites responses back.
  **SACRED INVARIANT — do not let one socket's ids collide with another's on the shared child.**
- **failPending()** (line ~730): answers each pending client request with an attributable
  JSON-RPC error on child death.
- Child `error`/`exit` handlers close all client sockets with code 1011.

What DOES NOT exist today (the gaps to plan for — verify by absence):
- **No WebSocket-level ping/pong heartbeat.** There is no `ws.isAlive`/`ws.ping()` liveness sweep,
  so a half-open TCP socket (mobile sleep, router NAT drop) is not detected server-side; a dead
  socket lingers in `clients`. Confirm there is no `ws.on('pong')` / periodic ping.
- **No server-side reconnect/resume.** Reconnection is entirely client-driven — see acp-ui
  `src/App.vue` (`scheduleReconnect`, `handleVisibilityChange`, `handleOnline`, `tryReconnect`) and
  `src/stores/session.ts`. The bridge has no session-resume-after-reconnect concept beyond the
  ACP-level `session/load` the client re-issues.
- **No explicit mid-run steer/interrupt path** surfaced by the bridge beyond forwarding whatever
  the client sends to the child stdin. Check whether the ACP child supports `session/cancel` or an
  interrupt method (grep the bridge + `server/acp-runner.mjs`), and whether the UI exposes it.

## Reference material to read and cite
- Paseo transport: `paseo-src/packages/client/src/daemon-client.ts` (reconnect, heartbeat,
  request lifecycle), `paseo-src/packages/protocol/src/messages.ts` (message shapes), and
  `paseo-src/docs/` — especially anything on protocol compatibility, reconnect, terminal/stream
  performance. **Do NOT copy Paseo's zod-aot validation or full protocol machinery** — the user
  explicitly scoped this as hardening, not a rewrite. Extract the reconnect/heartbeat/backpressure
  IDEAS and adapt them to the small Node bridge.
- acp-ui client side: `src/lib/acp-bridge.ts`, `src/lib/transport/*`, `src/stores/session.ts`,
  `src/App.vue` reconnect plumbing, `src/lib/sessionRuntime.ts`. The plan must cover BOTH ends —
  a server heartbeat needs a client that answers pings and a client reconnect that resumes cleanly.
- `AGENTS.md` in the repo root: the port map and the "one port one owner" + "single source of
  truth: deploy/acp-ws-bridge.mjs" rules. Honor them.

## What PLAN.md must contain
1. **File inventory** — every file the implementer edits, one-line purpose. Expect at least
   `deploy/acp-ws-bridge.mjs` (bridge), and on the client `src/stores/session.ts` +
   `src/lib/transport/*` / `src/lib/acp-bridge.ts`. Note which are owned by THIS workstream vs the
   workflow workstream (no overlap — the workflow stream owns WorkflowView/lib/porch/stores/workflow).
2. **Heartbeat design** — ping interval, pong timeout, the `isAlive` sweep, what happens to a
   socket that misses N pongs (terminate + clean up its `sessionOwner` claims and `pendingClientReqs`
   exactly like the existing `ws.on('close')` does). Client side: respond to pings (browsers
   auto-answer WS ping frames — verify and state whether an app-level heartbeat is also needed).
3. **Reconnect/resume design** — how the client detects a dead socket faster and reconnects, and
   how a reconnected socket re-establishes its sessions without cross-tab leakage (the sacred
   routing invariant must survive reconnect). Reconcile with the existing App.vue client reconnect
   so you IMPROVE it, not duplicate it.
4. **Mid-run steer/interrupt** — the exact ACP method(s) to send (verify what the child supports),
   how the bridge forwards it to the right session's child, and the minimal UI affordance. If the
   ACP agent has no cancel method, say so and propose the fallback.
5. **How both sacred invariants are preserved** through every new code path (heartbeat teardown,
   reconnect, steer). Call out any place a naive change would break per-session routing or id
   namespacing.
6. **Test plan** — how to test a dropped/half-open socket, a reconnect, and a mid-run steer without
   the full docker stack (the bridge can run standalone on a test port against a fake stdio child;
   check if the repo already has bridge tests — grep for existing test files near the bridge).
   Name the runner (package.json). If none, propose one.
7. **Risks & open questions + Integration requests** — anything needing a file outside this
   workstream's ownership, or a decision the implementer must make.

## Ownership (plan-awareness; you only write PLAN.md)
Implementer owns: `deploy/acp-ws-bridge.mjs` and the client transport/session files
(`src/lib/transport/**`, `src/lib/acp-bridge.ts`, `src/stores/session.ts`, `src/App.vue` reconnect
logic IF needed — flag App.vue as shared, coordinate via integration request since the workflow
stream also can't touch it). Forbidden: `server/acp-state-server.mjs`, `src/stores/ui.ts`,
`src/components/WorkflowView.vue` and `src/lib/porch/**` (workflow workstream), `package.json`,
build config. Preserve the two sacred invariants above at all costs.

## Rules
- Read the real bridge + client + real Paseo files; quote line numbers. Mark each claim "verified"
  or "assumption".
- Do NOT modify any file except `PLAN.md`. Do NOT start servers or run the stack. Commit `PLAN.md`
  on `cc/bridge` when done.
- End PLAN.md with a line: `PLAN COMPLETE`.
