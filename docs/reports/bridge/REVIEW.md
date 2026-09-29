VERDICT: APPROVE_WITH_NITS

## Blocking issues

None. Both sacred invariants survive every new path, the §0 watchdog fix is real
and regression-tested, and all declared behavior is exercised by tests that
genuinely run the changed code.

## Nits

- `src/lib/sessionRuntime.ts:1755-1765` — `isReconnecting` can stick `true`.
  A failed probe → `abortSocket` → `handleUnexpectedClose` → `armAutoReconnect`
  sets `isReconnecting.value = true` (:343); `tryReconnect` then calls
  `disarmAutoReconnect()` (:1760), which clears the timer but not the flag. If
  the next check at :1764 early-returns (`isConnecting`/`isLoading` still
  settling in that microtask window), the banner stays "Reconnecting…" with
  nothing armed. Every other disarm site pairs the two
  (:1613-14, :1662-63, :360/:366). One-line fix: also clear
  `isReconnecting.value = false` beside the :1760 disarm.
- `src/lib/sessionRuntime.ts:1481` + `:1274` — `isLoading` is now maintained by
  two conventions: `sendPrompt` derives it from `inFlightPrompts` (:1572-1573),
  but `resume()`/`create()` still unconditionally set `isLoading.value = false`
  in `finally`. A resume/create completing while a prompt is in flight
  (`inFlightPrompts === 1`) drops `isLoading` early — Stop hides mid-turn.
  Currently near-unreachable (both reconnect paths bail on `isLoading`, and the
  composer stays disabled while `!isConnected`), but consider
  `if (inFlightPrompts === 0) isLoading.value = false;` there too so the
  invariant lives in one place.
- `src/lib/sessionRuntime.ts:1590-1591` — `steer` delegates to `sendPrompt`
  whenever `inFlightPrompts === 0`, even when `isLoading` is true for a
  non-prompt reason (a `resume`/`session/load` in flight on a live socket).
  The UI can't reach this today (composer is disabled while `!isConnected`,
  and `isConnected` stays false until load finishes), so it's a runtime-API
  footgun rather than a live bug — worth a comment or a guard.
- `src/lib/transport/websocket.ts:286-291` — `pongCapable` is a one-way door
  per connection: a socket that half-opens before the first-ever `$/pong`
  burns the 4-ping grace and disables client-side liveness permanently for
  that connection. Correct degradation per PLAN §2c/§R3, and the server sweep
  still bounds it — just noting that client-side detection requires having
  seen at least one `$/pong` in the connection's lifetime.
- `deploy/acp-ws-bridge.mjs:858-862` — `ws.capLogged` is never reset; one
  "bufferedAmount over cap" log per socket per bridge lifetime. Fine, but if
  a socket recovers and later re-fills you get no second signal.
- `scripts/test_ws_transport.mjs:29-36` — runs a byte-copy of `websocket.ts`
  with `./types` rewritten to `./types.ts` for Node type-stripping. Real
  behavior is asserted (not source-grep), but if `websocket.ts` gains another
  relative import this harness breaks loudly rather than adapting. Acceptable;
  the bridge e2e still covers the wire contract.
- `scripts/test_ws_transport.mjs:137` — `t.pongCapable = true` pokes a
  TS-private field to simulate a proven peer. White-box but legitimate; noted
  in the test's own comment.

## What I verified

- Read `PLAN.md` (full, incl. §5 invariant map + §7 risks), `REPORT.md`, and
  the complete `git diff 2e077b9..HEAD` (16 files).
- Bridge, `deploy/acp-ws-bridge.mjs`:
  - `$/ping` is intercepted inside `noteOutbound`'s per-line loop at :666 —
    before the id-rewrite at :687 — `continue`s without touching
    `pendingClientReqs`, `sessionOwner`, `meterOutbound`, or `nextBridgeId`.
    Request form answered with the caller's own id (:672); notification form
    gets a bare `ws.send` of `$/pong` (:674) — never `broadcast()`, so no
    cross-tab leak.
  - `noteTraffic()` moved to `out.length > 0` (:718) — a keepalive-only
    payload no longer re-arms `lastTrafficAt`. Watchdog unmasked.
  - WS-protocol sweep (:815-837): `isAlive` lease renewed on `pong` (:944)
    and any data frame (:951); `ws.terminate()` on a miss fires the ordinary
    `ws.on('close')` cleanup (:991-1002) which drops `sessionOwner` claims
    and `pendingClientReqs` — identical cleanup path. Verified live: the e2e
    paused-socket test logged `ws sweep: terminating` + `client closed` and
    the claim dropped to broadcast fallback.
  - `ws.on('error')` added (:947); `child.stdin.write` guarded by `if (out)`
    so heartbeat-only payloads neither write to nor respawn the child
    (:981-985); `bufferedAmount` 32 MiB backstop in `broadcast` (:858).
- Client transport, `src/lib/transport/websocket.ts`:
  - `noteInboundLine` (:223-238): any inbound line clears `awaitingPong` /
    `missedPongs` and resolves pending probes; `$/pong` is cheap-gated on
    `line.includes`, confirmed by `JSON.parse`, and swallowed — never emitted
    to `messageListeners`, so Traffic Monitor and `AcpClientBridge`'s idle
    timer stay clean.
  - Heartbeat tick (:284-306): missed-pong accounting, `PONG_GRACE_PINGS=4`
    degradation for never-ponging peers, `MAX_MISSED_PONGS=2` conviction on
    proven peers → `abortSocket` (:323) synthesizes close (real close can
    hang in CLOSING); `handleClose`'s `closed` guard makes a late real close
    a no-op.
  - `probe()` (:342-383): shared in-flight promise; resolves on any frame;
    timeout aborts a pong-capable socket, resolves by socket state
    otherwise; `probeResolve` cleared in every exit path (timeout, send-fail,
    resolve, `.finally`).
- Runtime, `src/lib/sessionRuntime.ts`:
  - Auto-reconnect arm/backoff (:307-374): `min(1500·2^n, 30000)`, forever,
    skipped offline / aborted / non-resumable; attempts reset on successful
    `resume`/`create` (:1197, :1418); bail-outs prevent double-resume.
  - `resume` resets `connectionAborted` + disarms (:1298-1299).
  - `tryReconnect` verify-on-foreground (:1745-1762): `probe(3000)` before
    the `isConnected` early-return; failed probe aborts →
    `handleUnexpectedClose` → falls into resume.
  - `steer` (:1586-1599): `await acpClient.cancel` (notification send —
    wire-ordered before the prompt on the single socket, never blocks on the
    agent honoring it) then the existing `sendPrompt`; `inFlightPrompts`
    counter keeps `isLoading` honest across the cancel/replacement overlap.
- `ChatView.vue`: composer textarea + send button ungated from `isLoading`
  (:983, :1061); attach/mic/mode/model keep their gates (:1002, :1031,
  :1041, :1049); `handleKeyDown` Enter routes through `handleSend` (:664)
  so keyboard steer works. `src/stores/session.ts:804` delegates `steer`.
- 3-copy mirror: `diff -q deploy/acp-ws-bridge.mjs server/acp-ws-bridge.mjs`
  and `diff -q deploy/ ~/.hermes/` → byte-identical; the python e2e's first
  assertion independently confirms `server/` == `~/.hermes/`.
- Scope: `git diff --stat` on the forbidden list (App.vue, package.json,
  vite.config, acp-state-server.mjs, ui.ts, WorkflowView.vue, lib/porch/**) —
  zero lines. All touched product files are in PLAN §1's owned set.
- Ran everything:
  - `node scripts/e2e_bridge_heartbeat.mjs` — 21/21 (observed the sweep
    terminate the paused socket and the watchdog fire at ~3.7 s while
    `$/pong`s were flowing — the §0 regression test).
  - `node scripts/test_ws_transport.mjs` — 10/10.
  - `node scripts/e2e_bridge_routing.mjs` — 10/10 regression (unchanged file,
    still asserts real per-session routing incl. zero cross-tab leaks).
  - `~/.hermes/tools-venv/bin/python scripts/e2e_bridge_timeout.py` — 14/14
    regression (unchanged file; 66 s live-traffic run, idle-kill and
    child-exit wording checks intact).
  - `npm run build:web` — vue-tsc + vite clean, exit 0.
- Test quality: no tautologies or source-grep cheats found. The heartbeat e2e
  asserts wire-level behavior end to end (pong locality, `debug/seen` proving
  `$/`-frames never reach agent stdin, sweep termination via bridge log,
  post-reconnect replay locality, cancel→`stopReason:'cancelled'`,
  watchdog-fires-despite-keepalives with a real elapsed-time window).

## Notes for the implementer

- The single highest-value nit is the `isReconnecting` flag at
  `sessionRuntime.ts:1760`: pair `disarmAutoReconnect()` with
  `isReconnecting.value = false` there, matching :1613/:1663.
- If you want belt-and-suspenders on the steer path, gate `steer`'s
  `sendPrompt` fallback on `isConnected` (or `inFlightPrompts` only) so a
  programmatic call during `resume` can't fire `session/prompt` mid-load.
- `probe()` on a `pongCapable === null` socket resolves by `readyState` on
  timeout — a reasonable middle ground between PLAN's two specified outcomes,
  but it means a probe can report "alive" on a socket that has never once
  answered. Combined with the `pongCapable=false` one-way door, first-minute
  half-opens rely entirely on the server sweep. Fine for the LAN deployment;
  document it if `WebSocketTransport` ever faces a WAN.
- `deploy/` remains the source of truth per AGENTS.md; `server/` and
  `~/.hermes/` are confirmed in sync now — keep the `cp` step in the edit
  ritual (PLAN §7-R1).
- DEV_BRIEF.md / PLAN_BRIEF.md / PLAN.md / REPORT.md ride along on the
  branch as workflow docs — consistent with the brief-driven convention, no
  product-code pollution.

REVIEW COMPLETE
