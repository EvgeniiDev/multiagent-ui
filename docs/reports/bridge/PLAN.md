# PLAN — Stable bidirectional ACP transport (workstream: bridge)

Harden the existing stdio↔WebSocket bridge (`acp-ws-bridge.mjs`) and its Vue client
transport. **No protocol rewrite** — adapt the proven reconnect/heartbeat ideas from
Paseo (`/home/hermes/projects/paseo-src`) onto the current shape: one child ACP
process per bridge serving every WebSocket client over newline-framed NDJSON.

Goals: (1) dead/half-open sockets detected and recovered both directions,
(2) bidirectional channel stays reliable through those failures,
(3) user can steer/interrupt an agent mid-run.

---

## 0. Verified current state (all line numbers read from the worktree files)

### Bridge — `deploy/acp-ws-bridge.mjs` (905 lines)

- `clients: Set` (:598), shared `child` + stdout `buffer` (:599-600).
- `sessionOwner: Map<sessionId, ws>` (:602-605); `nextBridgeId` (:609).
- Watchdog: `IDLE_TIMEOUT_MS` default 180 000 (:622-624), `pendingClientReqs`
  `Map<bridgedId,{method,ws,origId}>` (:626-629), `pendingAgentReqs: Set`
  (:630-631), `lastTrafficAt` (:632), `noteTraffic()` (:635-637).
- `noteOutbound(payload, ws)` (:646-689): **verified** — calls `noteTraffic()`
  unconditionally at :647 for *every* inbound WS payload, rewrites request ids to
  `nextBridgeId` (:660-662), claims `sessionOwner` only for `session/load` /
  `session/prompt` requests (:663-667), passes notifications + agent-bound
  responses through verbatim (:676-687).
- `noteInbound(line)` (:695-725): registers `pendingAgentReqs` on agent→client
  requests (:709-711), resolves `pendingClientReqs` + restores `origId` + sets
  `dest` (:713-716), claims `sessionOwner` when a `session/new` response names
  the fresh id (:719-722).
- `failPending(message)` (:730-744): JSON-RPC error `-32000` to each asking
  socket with its original id.
- Watchdog `setInterval` (:746-765): fires only when `pendingClientReqs.size>0`
  AND `pendingAgentReqs.size===0` AND `idleFor>=IDLE_TIMEOUT_MS`; then
  `failPending` + `SIGKILL` child (next client message respawns, :857).
- `broadcast(line,msg,dest)` (:772-786): claimed `params.sessionId` → owner only;
  else `dest` socket; else all clients (:773-776).
- `spawnChild()` (:788-844): stdout→NDJSON split→`noteInbound`→`broadcast`;
  `error`/`exit` → `failPending` + `ws.close(1011)` on every client (:816-843).
- `wss.on('connection')` (:851-903): `clients.add`, lazy `spawnChild`;
  `ws.on('message')` respawns child, resolves relative `session/new` cwd
  (:870-881), `noteOutbound` → `child.stdin.write` (:884-885);
  `ws.on('close')` drops the socket's `sessionOwner` claims and
  `pendingClientReqs` entries (:891-902).
- **Verified absent**: no `ws.ping()`, no `ws.on('pong')`, no `isAlive`, no
  `ws.terminate()`, and **no `ws.on('error')`** — a ws `error` event with no
  listener would throw through the EventEmitter contract. Also no
  reconnect/resume concept server-side; `session/cancel` needs no bridge change
  (it is a notification → forwarded verbatim through the :676-687 path).

**Verified trap**: the client's existing `$/ping` heartbeat (below) is a
notification that reaches `noteOutbound` → `noteTraffic()` (:647) and is then
written to the child's stdin (:685-688). Every 25 s this re-arms
`lastTrafficAt`, so while any browser client is connected the 180 s agent-wedge
watchdog (:746-749) can never reach its idle threshold — `$/ping` must stop
counting as traffic, or the watchdog is dead code.

### Client

- `src/lib/transport/websocket.ts` (305 lines): sends
  `{"jsonrpc":"2.0","method":"$/ping"}\n` every `DEFAULT_HEARTBEAT_MS=25_000`
  (:31, :196-210) — keepalive only; **no reply is expected or checked** (verified:
  nothing parses inbound methods). `handleMessage` splits NDJSON frames
  (:152-174); `send()` appends `\n` (:233-234); `connect()` has a 15 s open
  timeout (:108-147); `WebSocketCtor` injectable for tests (:65); header comment
  explicitly says no auto-reconnect (:15-19). Nothing here detects a half-open
  socket — `send()` on a dead-but-unclosed TCP succeeds silently.
- `src/lib/acp-bridge.ts` (543 lines): `onClose` rejects all in-flight requests
  and fires `onTransportClose` (:98-115); `disconnect()` unlistens first so
  voluntary closes never reach `onTransportClose` (:126-156) — **this is the
  clean seam distinguishing expected vs unexpected closes**; client-side idle
  watchdog `RPC_IDLE_TIMEOUT_MS=180s` (:59) stands down while a permission
  request is pending (:186-191); `cancel()` sends `session/cancel` notification
  (:415-417); `handleNotification` ignores everything but `session/update`
  (:321-327) — so a `$/pong` notification reaching this layer would be
  dropped harmlessly but would feed `noteTraffic` (:208) and the traffic store.
- `src/lib/sessionRuntime.ts` (1731 lines): `handleUnexpectedClose` (:288-300)
  nulls `acpClient`, flips `isConnected`, marks the replay buffer stale;
  `resume()` creates a fresh client + `initialize` + `session/load` each time
  (:1239-1277) → re-claiming `sessionOwner` on the bridge is automatic;
  `handleSessionUpdate` drops frames whose `sessionId` ≠ this tab's
  (`foreign` guard :671-674, :707) — the client-side safety net for the
  broadcast-fallback window; `cancelOperation` (:1495-1501); `tryReconnect`
  (:1634-1670) **returns false early when `isConnected`** (:1636) — a half-open
  socket therefore looks "connected" and is never probed today; guards
  `supportsLoadSession` (:1652) and `acpClient`-already-exists (:1646).
- `src/stores/session.ts`: `tryReconnect()` loops all open tabs
  (:281-288); `openTab` re-resumes a tab whose transport is down (:183-190);
  `restoreTabs` resumes in parallel (:572-574).
- `src/App.vue`: `scheduleReconnect` (250 ms debounce, :85-95) on
  `visibilitychange`/`pageshow`/`online` (:96-101, :229-235); manual
  "Reconnect" banner via `canManuallyReconnect` (:123-129, :135-137).
- `src/components/ChatView.vue`: `handleSend` early-returns when `isLoading`
  (:581); send button `:disabled` includes `isLoading` (:1058); Stop button
  `v-if="isLoading"` → `handleCancel` → `rt.cancelOperation()` (:908-911, :678).
- `src/lib/transport/stdio.ts`: `StdioTransport` — local pipe, Tauri-only;
  process death already emits `onClose` (:42-60). A liveness probe is a no-op
  here.

### Deployment facts that shape the work

- `compose.yaml` mounts `.:/repo:ro` (:12) and runs
  **`server/acp-ws-bridge.mjs`** on ports 25901–25904 (:24,32,40,48) — NOT the
  `deploy/` copy. `deploy/install.sh` installs `deploy/acp-ws-bridge.mjs` →
  `~/.hermes/acp-ws-bridge.mjs` (install.sh :15-16, :39) for the disabled
  systemd path. All three copies are currently byte-identical (verified:
  `diff` empty), and `scripts/e2e_bridge_timeout.py` asserts
  `server/acp-ws-bridge.mjs === ~/.hermes/acp-ws-bridge.mjs` (:44, :404-406).
  **Every bridge edit must land in `deploy/` and be mirrored byte-for-byte to
  `server/` and `~/.hermes/`** (or that e2e check fails). The compose stack
  picks up `server/` changes on `docker compose restart bridge-*` — the code is
  a bind mount, no image rebuild.
- `server/https-front.mjs` WS proxies are raw TCP pipes post-upgrade
  (`upstream.pipe(clientSocket); clientSocket.pipe(upstream)` :133-134), so
  WebSocket protocol ping/pong frames traverse the TLS front transparently —
  no change needed there. A client that vanishes without FIN leaves both halves
  of the pipe open → the bridge-side sweep is the correct detection point.

### Paseo reference (ideas being adapted — all verified)

- **App-level ping/pong, not WS-protocol frames** (RN/browser clients can't
  send protocol pings): WS-level `{type:"ping"}`→`{type:"pong"}`
  (`packages/protocol/src/messages.ts`:7403-7409); richer session-level
  `ping`/`pong` carry `requestId`+timestamps (:2842-2846, :3717-3725). Server
  answers `pong` immediately on receipt
  (`packages/server/src/server/websocket-server.ts`:2319-2326).
- **Server-side lease for stale sockets**: `ApplicationSocketLease`
  (`packages/server/src/server/websocket/physical-socket.ts`:12-44) — 45 s
  deadline, renewed on *every* inbound message (websocket-server.ts:2283),
  expired sockets closed by a 10 s sweep (:855-866). Plus a 64 MiB
  `bufferedAmount` send cap as OOM backstop (physical-socket.ts:4, :89-95).
- **Client liveness**: heartbeat every `LIVENESS_HEARTBEAT_INTERVAL_MS=10_000`,
  pong deadline `15_000`, **2 consecutive failures** → `disposeTransport` +
  `scheduleReconnect` (daemon-client.ts:1044-1046, :2211-2237, :6529-6542);
  single in-flight probe deduped via `pingProbe` (:2165-2209); *any* inbound
  message resets the failure counter (:6227).
- **Verify-on-foreground**: `ensureConnected({verify:true})` → `verifyConnection`
  pings with a **3 s deadline independent of the heartbeat** (the OS may have
  suspended the heartbeat timer while asleep); failure → dispose + reconnect
  (:1568-1588).
- **Reconnect**: exponential backoff `min(baseDelay·2^attempt, maxDelay)` with
  base 1 500 ms, cap 30 000 ms, reset on successful hello (:1038-1039,
  :6485-6498, :6570); all waiters/pending sends rejected on disconnect so
  nothing hangs (:6443-6445); auth failure disables reconnect (:6449).
- **Stale-socket-vs-replacement e2e** worth mirroring:
  `websocket-server.liveness.e2e.test.ts` pauses a socket (`original.pause()`),
  reconnects the same clientId, and asserts the zombie is closed (1006) while
  the replacement stays usable (:95-112). No zod/validation machinery is being
  copied — only these behaviors.

---

## 1. File inventory (implementer edits)

| File | Change | Owned? |
|---|---|---|
| `deploy/acp-ws-bridge.mjs` | Heartbeat sweep, `$/ping`→`$/pong` answer, `ws.on('error')`, watchdog-traffic fix | **yes** — then `cp` byte-identical to `server/acp-ws-bridge.mjs` **and** `~/.hermes/acp-ws-bridge.mjs` (see §7-R1) |
| `src/lib/transport/websocket.ts` | Intercept `$/pong`, track missed pongs, `probe()`, abort-dead-socket path | yes |
| `src/lib/transport/types.ts` | Add optional `probe?(timeoutMs): Promise<boolean>` to `AcpTransport` | yes |
| `src/lib/transport/stdio.ts` | Trivial `probe` returning `true` (or rely on optional-method absence — see §3) | yes |
| `src/lib/acp-bridge.ts` | `probe(timeoutMs)` passthrough to `transport.probe` | yes |
| `src/lib/sessionRuntime.ts` | Auto-reconnect w/ backoff on unexpected close; verify-on-foreground inside `tryReconnect`; `steer()` (cancel+prompt) | yes (session layer; not forbidden) |
| `src/stores/session.ts` | `tryReconnect` unchanged or thin pass-through; expose `steer` delegate like `sendPrompt` (:802-803) | yes |
| `src/components/ChatView.vue` | Enable composer while `isLoading` for steer; keep Stop | not in the forbidden list — needed for goal 3 UX; keep the diff minimal (§4) |
| `src/App.vue` | **prefer zero edits** — see §3 | shared, flag only |
| `scripts/e2e_bridge_heartbeat.mjs` + `scripts/e2e_bridge_heartbeat_agent.mjs` | New standalone test (same harness pattern as `e2e_bridge_routing.mjs`) | yes — `scripts/` is unclaimed |
| `package.json` | **FORBIDDEN** — no test script may be added; tests run as `node scripts/e2e_bridge_heartbeat.mjs` directly | no |
| `server/acp-state-server.mjs`, `src/stores/ui.ts`, `src/components/WorkflowView.vue`, `src/lib/porch/**` | untouched | workflow stream |

---

## 2. Heartbeat design

### 2a. Server → client: WS-protocol ping sweep (bridge)

In `deploy/acp-ws-bridge.mjs`, in `wss.on('connection')` (:851) and a new
module-level interval next to the watchdog (:746):

```
const WS_PING_INTERVAL_MS = Number(
  argValue('--ws-ping-interval-ms', process.env.ACP_WS_PING_INTERVAL_MS || 30_000)
);
```

- On connection: `ws.isAlive = true`; `ws.on('pong', () => { ws.isAlive = true; })`;
  **also mark `ws.isAlive = true` inside `ws.on('message')`** — any inbound frame
  proves the peer is alive (Paseo renews the lease identically,
  websocket-server.ts:2283). Add `ws.on('error', (e) => log('ws error:', e.message))`
  — currently absent; `error` precedes `close` and must not throw.
- Sweep every `WS_PING_INTERVAL_MS` (`.unref?.()` like the watchdog :765):
  `for (const ws of clients)`: if `ws.readyState !== 1` skip; if
  `ws.isAlive === false` → `ws.terminate()`; else `ws.isAlive=false; ws.ping()`
  (wrap `ping` in try/catch). Terminating fires `ws` 'close' → the existing
  handler (:891-902) drops the socket's `sessionOwner` claims and
  `pendingClientReqs` — i.e., cleanup is identical to a clean close, which is
  what the invariant requires.
- Detection bound ≈ 2×interval (≤60 s at the default). Works through
  `https-front`'s raw TCP pipe because protocol pings are just frames.
- Optional second line of defense (Paseo physical-socket.ts:4): in `broadcast()`
  skip sockets whose `ws.bufferedAmount` exceeds a large cap (e.g. 32 MiB) —
  cheap guard against replaying history into an undrained zombie between
  sweeps. Mark optional in review; not required for correctness once the sweep
  exists.

### 2b. Client → bridge: `$/ping` → `$/pong` (app-level)

- **Bridge answers `$/ping` itself, never forwards it.** In `noteOutbound`'s
  per-line loop (:649-687), when a parsed frame is `{method:'$/ping'}`:
  - notification (no `id`) → `ws.send('{"jsonrpc":"2.0","method":"$/pong","params":{"ts":<Date.now()>}}')`
    **directly to that socket** (never through `broadcast()` — a `$/pong` must
    not leak to other tabs), echo `msg.params` into `pong.params` merged with
    `ts` so a nonce round-trips for `probe()`;
  - request (has `id`) → reply `{"jsonrpc":"2.0","id":<client's id>,"result":{"pong":true}}`
    directly — **do not** register it in `pendingClientReqs` and do not rewrite
    the id: it never reaches the child, so the client's own id space applies;
  - in both cases: the line is dropped from `out` (never written to child stdin)
    and **must not call `noteTraffic()`**.
- **Watchdog-traffic fix (same edit)**: move `noteTraffic()` out of the
  unconditional top-of-function call (:647) to once-per-payload *only when at
  least one line was actually forwarded* (`out.length > 0`). This restores the
  pre-heartbeat semantics ("agent silence = wedge") that the 25 s client ping
  currently defeats. Inbound side (`noteInbound` :696) is unchanged — any
  agent→client frame is still progress. `$/pong` from the bridge is written
  straight to the socket and never touches `noteInbound`.
- Old clients keep working: an acp-ui build without this change sends `$/ping`,
  receives a `$/pong` notification it ignores (acp-bridge.ts:321-327 drops all
  non-`session/update` notifications). Old *bridge* + new client: `$/ping` is
  forwarded to the agent and ignored as today — see `pongCapable` below.

### 2c. Client liveness detection — `src/lib/transport/websocket.ts`

Browser WebSockets cannot send protocol pings, so detection rides the existing
25 s `$/ping` cadence:

- In `handleMessage` (:152-174): cheap-gate each line on
  `line.includes('$/pong')` → `JSON.parse` only on hit → confirm
  `method==='$/pong'` → set `lastPongAt=Date.now()`, `pongCapable=true`, resolve
  any pending `probe()`, and **do not emit to `messageListeners`** (keeps the
  Traffic Monitor clean — the file already promises heartbeats stay below the
  bridge layer, :188-190 — and, critically, keeps `$/pong` from feeding
  `AcpClientBridge`'s idle timer at acp-bridge.ts:208).
- `pongCapable: boolean | null` — `null` until the first `$/pong` arrives, or
  until `N` pings (≈4) have gone unanswered → set `false` and **stop enforcing
  liveness entirely**: a peer that never pongs is a native ACP-over-WS agent or
  an old bridge, where `$/ping` is keepalive-only exactly as today. This is the
  graceful-degradation rule; without it the new code would tear down healthy
  connections to agents that speak ACP natively.
- Missed-pong accounting: `awaitingPong` flag set on each heartbeat send; cleared
  by `$/pong`. On each tick, if `awaitingPong` still set → `missedPongs++`.
  Paseo: 2 consecutive failures → teardown (:1046, :6531). With a 25 s interval
  that's ~50–75 s to detection; combined with the server's ≤60 s sweep, both
  directions bound a half-open at ~1 minute.
- On threshold: `abortSocket(reason)` — set `closed`, `stopHeartbeat()`,
  best-effort `ws.close()`, and synthesize the close via the existing
  `handleClose` (:176-184; it already guards double-fire via `closed`). A
  `ws.close()` on a dead socket can sit in CLOSING forever — synthesizing the
  listener notification is what actually frees the runtime (the transport's own
  `close()` already does exactly this via `queueMicrotask`, :261-265).
- New `probe(timeoutMs): Promise<boolean>`: send `$/ping` (params `{nonce}`),
  resolve `true` on `$/pong` **or any inbound frame** within `timeoutMs` (any
  frame proves liveness — Paseo :6227), resolve `false` on timeout when
  `pongCapable===true`; when `pongCapable===false`, resolve
  `ws.readyState===OPEN` (best possible answer against a non-ponging peer).
  Add `probe?` as an optional method on `AcpTransport` (types.ts) — a stdio pipe
  cannot half-open, so `StdioTransport` needs no real implementation (either
  omit it or return `Promise.resolve(true)`). `AcpClientBridge` gains a
  `probe(timeoutMs)` passthrough: `this.transport.probe?.(timeoutMs) ?? true`.

---

## 3. Reconnect / resume design

What exists: `visibilitychange`/`pageshow`/`online` → `scheduleReconnect` →
`sessionStore.tryReconnect()` → per-tab `rt.tryReconnect()` → `resume()` =
fresh `WebSocketTransport` + `initialize` + `session/load` (which re-claims
`sessionOwner` on the bridge automatically). Two gaps: (a) nothing fires it on
an unexpected close in the background, (b) `tryReconnect` early-returns on
`isConnected`, so a half-open socket is never noticed (:1636).

Changes in `src/lib/sessionRuntime.ts`:

- **Auto-reconnect loop.** At the end of `handleUnexpectedClose` (:288-300),
  after state teardown: if `(session ?? descriptor)` exists and
  `supportsLoadSession` and `!connectionAborted`, arm `autoReconnectTimer` with
  exponential backoff `min(1500·2^attempt, 30000)` (Paseo constants,
  daemon-client.ts:1038-1039), attempt counter reset on a successful `resume`,
  `isReconnecting.value=true` while armed/flying (the flag + banner already
  exist). Skip arming when `navigator.onLine===false` — the existing `online`
  listener in App.vue re-triggers `tryReconnect`. This only fires on
  *unexpected* closes because `disconnect()` unlistens `onClose` before closing
  (acp-bridge.ts:133-140) — verified seam, no new flag needed.
  Open question (§7-Q1): retry forever at the 30 s cap (Paseo does) vs. give up
  after N attempts and leave the manual banner. Recommend forever-with-cap.
- **Verify-on-foreground (Paseo `verifyConnection`, :1568-1588).** Reorder
  `tryReconnect`'s head: if `isConnected && acpClient`, first
  `await acpClient.probe(3000)` (3 s deadline — independent of the 25 s
  heartbeat the OS may have frozen). `probe` false → the transport aborts
  itself → `onTransportClose` → `handleUnexpectedClose` clears `acpClient` →
  fall through into the existing resume path. `probe` true → return false as
  today. `store.tryReconnect` stays a per-tab loop; **App.vue needs no edits**.
- **Reclaim semantics are automatic**: `resume()` → `session/load` request on
  the new socket → `noteOutbound` sets `sessionOwner.set(sid, newWs)` (:663-667)
  — the sacred routing invariant survives reconnect with no extra code. The
  claim is keyed on the socket object, so the dead socket's earlier claim is
  simply overwritten (and would have been dropped at `close` anyway).
- During the connect→load gap, frames for the session are unclaimed →
  `broadcast()` sends them to all sockets → other tabs drop them via the
  `foreign` sessionId guard (:671-674, :707). Verified safe — flag it, don't
  "fix" it.
- Pending client requests at socket death: bridge deletes the socket's
  `pendingClientReqs` entries at close (:898-900); a late child response then
  broadcasts with the *bridged* id — every live client ignores it (id never
  existed in their resolver maps). Acceptable; do not add forwarding.

---

## 4. Mid-run steer / interrupt

- **Interrupt already works end-to-end** (verified): Stop button
  (ChatView.vue:911) → `cancelOperation` (sessionRuntime.ts:1495) →
  `acpClient.cancel` → `session/cancel` **notification** (acp-bridge.ts:415-417)
  → bridge forwards verbatim to the child (notifications skip the id-rewrite,
  noteOutbound :676-687). `server/acp-runner.mjs` has no ACP `session/cancel`
  handler — it is the porch dispatcher, not an ACP agent; its `cancel`
  subcommand kills card children and is unrelated.
- **Gap is only the UI gate**: `handleSend` returns early on `isLoading`
  (ChatView.vue:581) and the send button is disabled (:1058).
- **Design**: add `steer(text, attachments)` on the runtime —
  `await acpClient.cancel({sessionId})` (fire-and-forget notification; ordering
  with the next write is guaranteed on the single socket/TCP stream), then run
  the existing `sendPrompt` body for the new turn. The in-flight prompt resolves
  with `stopReason:'cancelled'` (agent-dependent — §7-R4) and `sendPrompt`'s
  `finally` clears `isLoading`; the turn-end ledger entry records
  `cancelled` honestly (:1458-1465). In ChatView, when `isLoading` allow the
  submit path (Enter/send) to call `rt.steer` instead of `sendPrompt`, and stop
  gating the send button on `isLoading` (:1058) — leave attach/mic disabled
  (:1038,:1046) as they are. Keep Stop as pure cancel.
- **No bridge change required.** A second `session/prompt` for the same
  sessionId is just another id-rewritten request; `sessionOwner.set` re-points
  at the same socket (no-op). Do NOT add cancel-specific logic to the bridge.

---

## 5. Sacred-invariant preservation map

- **Per-session routing**: heartbeat teardown runs `ws.terminate()` → 'close' →
  the exact cleanup of :891-902 (drop `sessionOwner` claims, drop
  `pendingClientReqs`). `$/pong` is written with a bare `ws.send` to the asking
  socket — never through `broadcast()`. A `$/ping` that is dropped from `out`
  cannot claim a session or consume a bridged id. Reconnect re-claims via
  `session/load`/`session/prompt` on the fresh socket; the unclaimed window is
  covered client-side by the `foreign` guard.
- **Id namespacing**: `$/ping`/`$/pong` are handled before the id-rewrite and
  never enter `pendingClientReqs`. If `$/ping` arrives *with* an id the bridge
  answers it directly with that same id — still safe, because nothing is
  forwarded to the shared child where two sockets' `id:2` would collide.
  **Naive-change trap**: intercepting `$/ping` in `ws.on('message')` *before*
  `noteOutbound` breaks multi-line payloads (a WS frame can carry several NDJSON
  lines — `noteOutbound` splits on `\n`, :649) — do it inside the per-line loop.
- **Watchdog**: after the fix, `lastTrafficAt` reflects only frames actually
  exchanged with the agent; `pendingAgentReqs` stand-down unchanged.
- **`pendingAgentReqs` on socket death**: an agent→client request whose owning
  socket dies stays in the set and correctly keeps the watchdog stood down —
  pre-existing behavior, unchanged by this work.

---

## 6. Test plan

Runner reality: `package.json` has only vite/tauri scripts (verified :6-14) and
is **forbidden** to edit. Existing bridge tests are standalone scripts:
`scripts/e2e_bridge_routing.mjs` + `e2e_bridge_routing_agent.mjs` (spawn real
bridge + mock NDJSON agent + two `ws` clients; resolves global `ws` via
`loadWs()` and passes `NODE_PATH` to the bridge child, :46-67, :149-150) and
`scripts/e2e_bridge_timeout.py` (pure-stdlib RFC 6455 client, ports 25973-75,
asserts `server/`==`~/.hermes` at :404-406). `scripts/e2e_all.py` orchestrates
the python suites. Follow that convention — **no new npm deps, no runner**.

New file `scripts/e2e_bridge_heartbeat.mjs` (companion mock
`e2e_bridge_heartbeat_agent.mjs` — extend the routing mock with a slow-prompt
mode that drips chunks until `session/cancel` arrives, then answers
`stopReason:'cancelled'`). Spawn the bridge with `--idle-timeout-ms` and a new
`--ws-ping-interval-ms` set small (e.g. 5 000 / 500) and assert:

1. `$/ping` notification → `$/pong` returns on the *same* socket only (assert B
   sees none of A's pongs); the mock agent's stdin never receives `$/ping`
   (have the mock record methods seen; a `$/`-prefix assert).
2. **Watchdog unmasked**: with `$/ping`s flowing every ~1 s from the client, a
   `session/prompt` the mock never answers still fails with "no traffic for Ns"
   near the idle limit — the regression test for the §0 trap.
3. WS-protocol sweep: a normal `ws` client auto-pongs and stays open across ≥2
   sweep intervals (send a request after 2×interval, assert it resolves).
4. Half-open socket: connect a `ws` client, claim `sess-x` via `session/load`,
   then freeze it (`ws._socket.pause()` — used by the codebase's own tests for
   zombie sockets, cf. Paseo liveness e2e `original.pause()`). After ≤2 sweeps:
   bridge log shows `client closed`, and a second client's traffic for `sess-x`
   falls back to broadcast (proves the dead claim was dropped).
5. Reconnect re-claim: client A `session/load sess-a` → close → new socket →
   `session/load sess-a` again → replay routes to the new socket; B receives
   zero `sess-a` frames (the routing test's assertion, applied post-reconnect).
6. Steer: `session/prompt` on a slow mock, then `session/cancel` then a second
   `session/prompt` → first resolves `cancelled`, second resolves `end_turn`,
   both responses land on the requesting socket with the caller's original ids.

Regression: re-run `node scripts/e2e_bridge_routing.mjs` and
`~/.hermes/tools-venv/bin/python scripts/e2e_bridge_timeout.py` — the latter's
first check forces the three bridge copies into sync.

Client side without a browser: `websocket.ts` has `WebSocketCtor` injection
(:65) and imports only `./types` — erasable TS. Node 26 (`v26.7.0` here)
type-strips `.ts` imports natively, so a standalone `node
scripts/test_ws_transport.mjs` can `import('../src/lib/transport/websocket.ts')`
and drive it with a fake socket: assert `$/pong` is swallowed (not emitted),
missed pongs produce a synthesized close, `probe()` resolves on pong/timeout.
Caveat: this only works while the file stays free of Vue/runtime imports — if
that breaks, the e2e above still covers the bridge contract and `npm run
build:web` (vue-tsc) covers types.

Ship gate: `npm run build:web` green (host, per AGENTS.md); the standalone
scripts pass; `docker compose restart bridge-hermes bridge-opencode
bridge-devin bridge-pi` picks up the `server/` copy (bind mount) — restart only
if asked, per the compose-only rule.

---

## 7. Risks, open questions, integration requests

- **R1 — three bridge copies.** `deploy/` (AGENTS.md's source of truth),
  `server/` (what compose actually runs and tests exercise),
  `~/.hermes/` (install.sh artifact, asserted equal by e2e). Edit `deploy/`,
  then `cp deploy/acp-ws-bridge.mjs server/acp-ws-bridge.mjs` and to
  `~/.hermes/acp-ws-bridge.mjs`. A future cleanup should make two of these
  symlinks/copies of one file — out of scope.
- **R2 — `ws` lib semantics.** `terminate()` fires `close` on the ws object
  (standard `ws` behavior; asserted by the codebase's own reliance on 'close'
  cleanup). If it ever didn't, the sweep must run the close cleanup inline —
  verify in the e2e (assertion 4 covers it).
- **R3 — non-ponging peers.** Native ACP-over-WS agents never answer `$/pong`.
  `pongCapable` gating (§2c) is the compat story; **assumption** verified by
  code-reading only — the deployed agents are all behind this bridge, so the
  risk is theoretical for the LAN deployment but real for the generic
  `websocket` transport kind.
- **R4 — cancel/steer semantics are agent-dependent** (assumption). ACP
  defines `session/cancel` → `stopReason:'cancelled'`; each CLI (hermes,
  opencode, devin, pi-acp) may abort at different points or ignore it.
  Fallback: Stop button + the agent-wedge watchdog; the client must not block
  `steer` on the cancel being honored.
- **R5 — queueing alternative.** If an agent accepts a second `session/prompt`
  while one runs, "queue" is a gentler steer; undecidable from here — flag for
  implementer to probe per-agent; the cancel-then-prompt path is the safe
  default.
- **Q1 — reconnect policy**: forever at the 30 s cap (recommended, Paseo-style)
  vs. bounded attempts then manual banner. Decide in review.
- **Q2 — `src/App.vue` shared file**: the plan deliberately makes zero edits
  (verify-on-foreground folds into `tryReconnect`, which App.vue already calls).
  If a distinct "verifying connection" UI state is wanted later, that's an
  integration request to whoever owns App.vue — `isReconnecting` suffices now.
- **Q3 — `session/list` transient clients** (`syncAgentSessions`,
  session.ts:387-442) open a second socket on the same bridge; their `$/ping`
  traffic now bypasses the child — no behavior change beyond that.
- **Integration request — none blocking.** ChatView.vue is outside the listed
  ownership but not forbidden; keep its diff to the composer gate only. If the
  workflow stream lands conflicting ChatView changes, coordinate at merge.

PLAN COMPLETE
