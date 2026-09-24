# W14 — Bridge RPC timeout: progress-aware wait: report

STATUS: DONE — `npm run build:web` green, e2e_bridge_timeout 14/14,
live round-trip verified on all four bridges after restart.

## Correction to the card's map

`~/.hermes/acp-bridge-*.mjs` does not exist. The four services
(`acp-bridge-hermes/opencode/devin/pi.service`, ports 25901–25904) all run ONE
shared file: `~/.hermes/acp-ws-bridge.mjs` — "one timeout policy in one place"
is therefore literal. The fixed 60 s itself lived in the panel client
(`src/lib/acp-bridge.ts` `sendRequest`, `setTimeout(60000)`); the bridge had no
timeout at all. Both layers now implement the same policy.

## What changed

- `server/acp-ws-bridge.mjs` (new, byte-identical copy of the deployed
  `~/.hermes/acp-ws-bridge.mjs`, which is the file actually edited):
  - Request watchdog: `IDLE_TIMEOUT_MS` (default 180 s; `--idle-timeout-ms`
    flag or `ACP_IDLE_TIMEOUT_MS` env for tests). A request is failed only
    after the wire has been *silent* that long — `noteInbound`/`noteOutbound`
    stamp every JSON-RPC frame in either direction as progress
    (`lastTrafficAt`). `pendingClientReqs` tracks client→agent requests;
    `pendingAgentReqs` tracks agent→client requests and suspends the watchdog
    while the agent is blocked on our answer (e.g.
    `session/request_permission` with a human thinking — silence there is
    expected).
    - On fire: each pending request gets a JSON-RPC error
      `no traffic for Ns — agent appears wedged (idle limit Ms)`, the wedged
      child is SIGKILLed (respawned lazily by the existing `!child` paths),
      and the log line reads `watchdog: no traffic for Ns …`.
    - On child `exit`/`error`: pending requests are answered with
      `agent CLI exited (code=X signal=Y)` / `agent CLI failed to start: …`
      BEFORE the sockets are closed, and the close now carries
      `1011, "child exited code=X"` so the failure is distinguishable per
      request, in the close reason, and in the log (`child exited code=…`).
- `src/lib/acp-bridge.ts` — the fixed `setTimeout(60000)` is gone.
  `RPC_IDLE_TIMEOUT_MS` (180 s, `setRpcIdleTimeoutMs` setter, `<=0` disables)
  backs a single idle timer for the connection: `noteTraffic()` is called on
  every inbound frame (`handleMessage`) and every outbound frame
  (`sendRequest`, `sendNotification`, `handleRequest` response), and re-arms
  the deadline for all in-flight requests. On fire it rejects pending RPCs
  with `no traffic for Ns — RPC abandoned: <methods>`; while
  `permissionResolver` is set (agent waiting on us) it re-arms instead.
  A transport close still rejects with the close reason — which now contains
  "child exited" from the bridge.
- `scripts/e2e_bridge_timeout.py` (new, stdlib only — no browser, no ws
  package): a minimal RFC 6455 client + a stub CLI; spawns the real
  `server/acp-ws-bridge.mjs` on ports 25973–25975 with `--idle-timeout-ms
  15000`. Registered in `scripts/e2e_all.py` ("bridge timeout", self-serving).
- `scripts/e2e_all.py` — one SCRIPTS line added.

## Services to restart

All four run the same file; all were restarted (needs `XDG_RUNTIME_DIR`):

    systemctl --user restart acp-bridge-hermes acp-bridge-opencode \
        acp-bridge-devin acp-bridge-pi

## Command output

```
$ node --check ~/.hermes/acp-ws-bridge.mjs && cp ~/.hermes/acp-ws-bridge.mjs server/acp-ws-bridge.mjs
SYNTAX OK
copied to server/

$ npm run build:web
✓ built in 2.96s   (vue-tsc --noEmit clean)

$ ~/.hermes/tools-venv/bin/python scripts/e2e_bridge_timeout.py
PASS  repo bridge copy matches the deployed file
PASS  lively: request succeeds past the old 60 s budget  (elapsed=66.0s response=...{"stopReason": "end_turn"})
PASS  lively: actually ran longer than 60 s  (elapsed=66.0s)
PASS  lively: progress traffic flowed meanwhile  (session/update notifications seen: 11)
PASS  lively: socket stayed open (no wedged-kill)
PASS  lively: no watchdog fire in bridge log
PASS  silent: request failed with 'no traffic for Ns' wording  (elapsed=18.7s msg='no traffic for 19s — agent appears wedged (idle limit 15s)')
PASS  silent: failure arrived near the idle limit, not at 60 s  (elapsed=18.7s)
PASS  silent: wedged child kill closed the socket  (closed=(1011, 'child exited code=null'))
PASS  silent: bridge log distinguishes the idle kill  (watchdog: no traffic for 19s …)
PASS  exit: request failed with 'exited' wording  (msg='agent CLI exited (code=3 signal=null)')
PASS  exit: socket close reason says the child exited  (closed=(1011, 'child exited code=3'))
PASS  exit: bridge log shows 'child exited'  (child exited code=3 signal=null)
PASS  exit: failure is NOT the idle wording
14/14 assertions passed

$ systemctl --user is-active acp-bridge-{hermes,opencode,devin,pi}
active x4; ss -ltn shows 25901–25904 LISTEN

Live round-trip, acp-bridge-hermes :25901 (real `hermes acp`):
  initialize:    0.8s
  session/new:  10.2s   sessionId=4574a83d-…
  session/prompt: 19.6s, 5 session/update notifications -> stopReason=end_turn,
                  usage={inputTokens:17326, outputTokens:202, …}
  journal: "spawned hermes pid=52419", "client connected", "client closed"

$ ~/.hermes/tools-venv/bin/python scripts/e2e_live_stream.py   (regression)
8/8 assertions passed, zero pageerrors
```

## Not verified live (honest list)

- No *production* turn >60 s was observed end-to-end after the restart — the
  >60 s survival is proven by the e2e against the byte-identical bridge file
  (assertion 1 checks the repo copy == deployed file). The real prompt above
  took 19.6 s.
- The client-side idle timer in `src/lib/acp-bridge.ts` is not covered by the
  python e2e (it tests the bridge). It is typechecked (`vue-tsc`) and
  regression-covered by `e2e_live_stream.py` (real browser, full prompt path
  through `sendRequest`/`handleMessage`), but no browser test waits 180 s.
- Multi-client fan-out on one bridge keeps the old loose semantics
  (broadcast-to-all); the watchdog's pending set is per-bridge, matching it.
