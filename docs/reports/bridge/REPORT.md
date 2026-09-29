STATUS: DONE

## What was built

### Bridge — `deploy/acp-ws-bridge.mjs` (mirrored byte-identical to `server/` + `~/.hermes/`)

- **`$/ping` → `$/pong` inline answer** (`noteOutbound`, deploy/acp-ws-bridge.mjs:666-686):
  intercepted inside the per-line NDJSON loop (never in `ws.on('message')` — the
  §5 naive-change trap). Notification form gets a bare `ws.send` of `$/pong`
  with echo params + `ts` — never through `broadcast()`. Request form is
  answered directly with the caller's own id `{pong:true}` — no bridged id
  consumed, never enters `pendingClientReqs`, never reaches child stdin.
- **Watchdog-traffic fix** (§0 trap): `noteTraffic()` moved from unconditional
  top-of-function to `out.length > 0` (:718) — a payload that was all
  keepalives no longer re-arms `lastTrafficAt`. Verified live: test 2 below.
- **WS-protocol ping sweep** (:798-837): `--ws-ping-interval-ms` /
  `ACP_WS_PING_INTERVAL_MS` (default 30 s). Per connection: `ws.isAlive` lease
  renewed on `pong` and on any data frame (:943-946, :951); the sweep
  terminates sockets that produced nothing for an interval → `ws.terminate()`
  runs the ordinary `close` cleanup (claims + pendingReqs dropped). Detection
  bound ≈ 2×interval. Also added the missing `ws.on('error')` (:947) — an
  unhandled `error` would have thrown through EventEmitter.
- **`child.stdin.write` guard** (:981-985): heartbeat-only payloads no longer
  write to the child nor respawn it (`out || line` would have forwarded the
  ping — fixed).
- **`bufferedAmount` cap** (:846, :854-865): 32 MiB per-socket send-buffer
  backstop so a replay can't pile into an undrained zombie between sweeps
  (the optional §2a second line of defense — included; logged once per socket).

### Client transport — `src/lib/transport/`

- `types.ts:35`: optional `probe?(timeoutMs): Promise<boolean>`.
- `websocket.ts`: `$/pong` intercepted per-line in `noteInboundLine` (:223-238)
  — sets `pongCapable=true`, resolves pending probes, never emitted upward
  (Traffic Monitor + RPC idle timer stay clean). Any inbound line is a
  liveness proof (`awaitingPong`/`missedPongs` reset). Heartbeat tick
  (:284-306): missed-pong accounting; `pongCapable` grace window
  (PONG_GRACE_PINGS=4 → `false` for never-ponging peers, enforcement stops);
  MAX_MISSED_PONGS=2 on proven peers → `abortSocket` (:323) synthesizes the
  close (a real `close` event can sit in CLOSING forever). `probe(timeoutMs)`
  (:342-383): shared in-flight promise, resolves on `$/pong` or any frame;
  timeout aborts a pong-capable socket → `false`, or resolves socket state
  for never-ponged peers (graceful degradation).
- `stdio.ts:84`: trivial `probe()` returning `!closed` (pipes can't half-open).
- `acp-bridge.ts:131`: `probe(timeoutMs)` passthrough, absent → `true`.

### Runtime — `src/lib/sessionRuntime.ts`

- **Auto-reconnect** (:314-368): `handleUnexpectedClose` arms
  `armAutoReconnect` when a resumable session exists, not aborted, not
  offline (Paseo backoff `min(1500·2^n, 30000)`, retry forever — Q1
  recommendation). Attempt counter resets on successful `resume`/`create`
  (:1197, :1418); disarmed in `cancelConnection`/`close`/top-of-`resume`
  (:1299, :1613, :1660). `isReconnecting` held while armed/flying.
- **Verify-on-foreground** (`tryReconnect` :1741-1757): if `isConnected &&
  acpClient`, `await acpClient.probe(3000)` first — failed probe aborts the
  socket → `handleUnexpectedClose` → falls into the existing resume path.
  App.vue untouched (Q2).
- **`steer(text, attachments)`** (:1576-1599): fire-and-forget
  `session/cancel` then the existing `sendPrompt` body (R5 default:
  cancel-then-prompt). `inFlightPrompts` counter (:187, :1523, :1572) keeps
  `isLoading` honest across the cancelled-turn/replacement overlap so Stop
  survives the handoff.
- `resume()` now resets `connectionAborted` (:1298) — without it a tab
  resumed after `cancelConnection` would never arm auto-reconnect.

### Store + composer

- `src/stores/session.ts:804`: `steer` delegate next to `sendPrompt`.
- `src/components/ChatView.vue`: `handleSend` routes to `rt.steer` while
  `isLoading` (:598); send button + textarea no longer gated on `isLoading`
  (:983, :1061); attach/mic/mode/model keep their `isLoading` gates. Stop
  button unchanged (pure `cancelOperation`).

## Evidence

`npm run build:web` (tail):

```
npm notice run vue-tsc --noEmit && vite build --mode web
vite v6.4.1 building for web...
✓ 293 modules transformed.
dist-web/assets/index-INUudVDJ.js   600.08 kB │ gzip: 206.33 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
✓ built in 5.34s          (exit 0; vue-tsc clean; pre-existing size warning)
```

`node scripts/e2e_bridge_heartbeat.mjs` — full output (bridge chatter interleaved):

```
[bridge:42809] http+ws listening on :42809 -> node scripts/e2e_bridge_heartbeat_agent.mjs
PASS  1: $/ping -> $/pong on the asking socket  ({"nonce":"n1","ts":1790714977713})
PASS  1: $/pong never leaks to other sockets  (0 pongs on B)
PASS  1: $/ping with an id answered directly (no id rewrite)
PASS  1: agent stdin never sees a $/-frame  (methods=["initialize","initialize","debug/seen"])
PASS  3: healthy socket still resolves after >=2 sweeps
PASS  3: sweep terminated nobody
PASS  4: D claims sess-x
[bridge:42809] ws sweep: terminating unresponsive client
[bridge:42809] client closed (3 active)
PASS  4: paused socket terminated by the sweep
PASS  4: sweep logged the termination
PASS  4: dropped claim -> sess-x frame falls back to broadcast
PASS  5: E claims sess-a
PASS  5: re-load on a fresh socket resolves
PASS  5: replay routed to the NEW socket  (4 frames)
PASS  5: zero sess-a frames leaked to bystanders  (0 leaked)
PASS  6: cancelled prompt resolves stopReason=cancelled  ({"stopReason":"cancelled"})
PASS  6: second prompt resolves stopReason=end_turn
PASS  6: sess-b frames stayed on the asking socket  (0 leaked)
[bridge:33225] http+ws listening on :33225 -> node scripts/e2e_bridge_heartbeat_agent.mjs
[bridge:33225] watchdog: no traffic for 4s — agent appears wedged (idle limit 3s); failing 1 pending request(s)
PASS  2: hung prompt fails "no traffic for Ns" DESPITE flowing $/pings  (elapsed=3711ms msg=no traffic for 4s — agent appears wedged (idle limit 3s))
PASS  2: failure near the idle limit (3000ms)  (elapsed=3711ms)
PASS  2: $/pongs were flowing the whole window  (7 pongs)
PASS  2: bridge log shows the watchdog fire

21/21 assertions passed
```

`node scripts/test_ws_transport.mjs` — 10/10 (client-side liveness,
`websocket.ts` driven on a fake socket):

```
PASS  probe() resolves true on $/pong
PASS  $/pong swallowed below the listener layer (sent=4 received=0)
PASS  probe() resolves on any inbound frame
PASS  2 missed intervals on a pong-capable peer -> half-open close (no inbound frames for 2 heartbeat intervals — socket is half-open)
PASS  transport is closed after the conviction
PASS  probe() timeout on pong-capable peer resolves false
PASS  probe() timeout aborts the socket (liveness probe timed out after 200ms)
PASS  probe() on never-ponged peer answers by socket state
PASS  non-ponging peer is never aborted (graceful degradation) (closes=0 sent=11)
PASS  probe() on marked-non-capable peer resolves true fast

10/10 assertions passed
```

`node scripts/e2e_bridge_routing.mjs` — full output:

```
PASS  A: initialize resolves
PASS  B: initialize resolves during A replay
PASS  B: session/new resolves during A replay  (sess-new-1)
PASS  B: session/prompt resolves during A replay  (0ms)
PASS  A: session/load resolves
PASS  B: zero foreign session/update frames (sess-a)  (0 leaked)
PASS  B: own prompt chunks routed to B  (3 frames)
PASS  A: full replay received on its own socket  (60/60)
PASS  A: zero foreign session/update frames (B session)  (0 leaked)
PASS  unclaimed session still broadcasts to both clients  (A=2 B=1)

10/10 assertions passed
```

`~/.hermes/tools-venv/bin/python scripts/e2e_bridge_timeout.py` — tail
(the first PASS forces all three bridge copies into sync, run after `cp`):

```
PASS  repo bridge copy matches the deployed file  (server/acp-ws-bridge.mjs vs ~/.hermes/acp-ws-bridge.mjs)
PASS  lively: request succeeds past the old 60 s budget  (elapsed=66.0s response={"stopReason": "end_turn"})
PASS  lively: actually ran longer than 60 s  (elapsed=66.0s)
PASS  lively: progress traffic flowed meanwhile  (session/update notifications seen: 11)
PASS  lively: socket stayed open (no wedged-kill)  (closed=None)
PASS  lively: no watchdog fire in bridge log
PASS  silent: request failed with 'no traffic for Ns' wording  (elapsed=18.7s msg='no traffic for 19s — agent appears wedged (idle limit 15s)')
PASS  silent: failure arrived near the idle limit, not at 60 s  (elapsed=18.7s)
PASS  silent: wedged child kill closed the socket  (closed=(1011, 'child exited code=null'))
PASS  silent: bridge log distinguishes the idle kill
PASS  exit: request failed with 'exited' wording  (msg='agent CLI exited (code=3 signal=null)')
PASS  exit: socket close reason says the child exited  (closed=(1011, 'child exited code=3'))
PASS  exit: bridge log shows 'child exited'
PASS  exit: failure is NOT the idle wording

14/14 assertions passed
```

## Deliberate stubs

- **`pongCapable` degradation** (PLAN §2c): a peer that never `$/pong`s
  (native ACP-over-WS agent, old bridge) keeps `$/ping` as keepalive-only;
  client-side liveness is never enforced against it and `probe()` answers by
  socket state. Our bridge always pongs, so deployed agents get full
  detection.
- **Q1 taken**: reconnect retries forever at the 30 s cap; a manual Reconnect
  banner still exists for immediate retry.
- Steer semantics depend on the agent honoring `session/cancel` (§R4); the
  new prompt is never blocked on it.
- Auto-reconnect failures record an activity `error` entry + telemetry per
  attempt (capped by backoff at 30 s) — accepted noise for honesty.

## Integration requests

None — no forbidden file needed edits. `src/App.vue` deliberately untouched
(verify-on-foreground folds into `tryReconnect`, which it already calls).

## How to review

- `node scripts/e2e_bridge_heartbeat.mjs` — all 21 assertions; watch
  `[bridge]` lines: `ws sweep: terminating unresponsive client` + `client
  closed` for the paused socket; `watchdog: no traffic for 4s` on bridge B
  while `$/pong`s were flowing.
- `node scripts/test_ws_transport.mjs` — 10 assertions on a fake socket.
- `node scripts/e2e_bridge_routing.mjs` and `~/.hermes/tools-venv/bin/python
  scripts/e2e_bridge_timeout.py` — regressions.
- `npm run build:web` — vue-tsc + vite.
- Live check (only if asked — compose-only rule): `docker compose restart
  bridge-hermes bridge-opencode bridge-devin bridge-pi`, then watch a tab
  reconnect itself after `docker compose stop bridge-pi`/`start` instead of
  sitting on the error banner.

DEV COMPLETE

## Review-round fixes

Review verdict APPROVE_WITH_NITS — the three fixes the reviewer flagged as
worth taking, applied in `src/lib/sessionRuntime.ts` (no bridge edits; all
three copies stay byte-identical):

- **`isReconnecting` can no longer stick `true`** (:1771): the `tryReconnect`
  disarm site now pairs `disarmAutoReconnect()` with
  `isReconnecting.value = false`, matching the `cancelConnection`/`close`
  sites (:1623-24, :1672-73) and the auto-reconnect loop's own exits
  (:360/:366/:369). A failed probe followed by the `isConnecting`/`isLoading`
  early-return no longer leaves the "Reconnecting…" banner up with nothing
  armed.
- **`isLoading` owned in one place** (:1276, :1484): `create()`/`resume()`
  `finally` blocks now do `if (inFlightPrompts === 0) isLoading.value = false;`
  — the same rule `sendPrompt` uses (:1576) — so a resume/create completing
  while a prompt is in flight cannot hide Stop mid-turn.
- **`steer()` fallback guarded** (:1593-1599): throws `Not connected` when
  `isConnected` is false, before either prompt path. `isConnected` only flips
  after `session/new`/`session/load` resolves, so a programmatic steer during
  a resume can't fire `session/prompt` mid-load. (Runtime-API guard — the
  composer is already disabled while `!isConnected`.)

Skipped per the brief: `capLogged` reset, test-harness import note,
`pongCapable` one-way door — reviewer marked acceptable-as-is.

### Evidence

`npm run build:web` (tail — vue-tsc clean, exit 0):

```
✓ 293 modules transformed.
dist-web/assets/index-CuMr89Jo.js   600.15 kB │ gzip: 206.34 kB
✓ built in 3.84s
```

`node scripts/e2e_bridge_heartbeat.mjs` — 21/21 (watchdog fired at ~3.7 s
while `$/pong`s flowed; sweep terminated the paused socket):

```
PASS  4: paused socket terminated by the sweep
PASS  4: sweep logged the termination
PASS  4: dropped claim -> sess-x frame falls back to broadcast
PASS  5: re-load on a fresh socket resolves
PASS  5: replay routed to the NEW socket  (4 frames)
PASS  5: zero sess-a frames leaked to bystanders  (0 leaked)
PASS  6: cancelled prompt resolves stopReason=cancelled  ({"stopReason":"cancelled"})
PASS  6: second prompt resolves stopReason=end_turn
PASS  2: hung prompt fails "no traffic for Ns" DESPITE flowing $/pings  (elapsed=3707ms)
PASS  2: $/pongs were flowing the whole window  (7 pongs)

21/21 assertions passed
```

`node scripts/test_ws_transport.mjs` — 10/10:

```
PASS  probe() resolves true on $/pong
PASS  $/pong swallowed below the listener layer (sent=4 received=0)
PASS  probe() resolves on any inbound frame
PASS  2 missed intervals on a pong-capable peer -> half-open close
PASS  transport is closed after the conviction
PASS  probe() timeout on pong-capable peer resolves false
PASS  probe() timeout aborts the socket (liveness probe timed out after 200ms)
PASS  probe() on never-ponged peer answers by socket state
PASS  non-ponging peer is never aborted (graceful degradation) (closes=0 sent=11)
PASS  probe() on marked-non-capable peer resolves true fast

10/10 assertions passed
```

`node scripts/e2e_bridge_routing.mjs` — 10/10 regression (per-session
routing, zero cross-tab leaks):

```
PASS  A: session/load resolves
PASS  A: full replay received on its own socket  (60/60)
PASS  B: zero foreign session/update frames (sess-a)  (0 leaked)
PASS  A: zero foreign session/update frames (B session)  (0 leaked)

10/10 assertions passed
```

`~/.hermes/tools-venv/bin/python scripts/e2e_bridge_timeout.py` — 14/14
(lively 66 s run, silent-kill and exit wording intact, all three bridge
copies confirmed byte-identical):

```
PASS  repo bridge copy matches the deployed file  (server/acp-ws-bridge.mjs vs ~/.hermes/acp-ws-bridge.mjs)
PASS  lively: request succeeds past the old 60 s budget  (elapsed=66.0s)
PASS  silent: request failed with 'no traffic for Ns' wording  (elapsed=18.7s)
PASS  exit: request failed with 'exited' wording  (msg='agent CLI exited (code=3 signal=null)')

14/14 assertions passed
```

FIX COMPLETE
