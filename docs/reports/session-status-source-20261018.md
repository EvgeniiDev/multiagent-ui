# Session status source, 18 October 2026

The UI activity log missed completed prompt responses. Two Codex sessions had
native `task_complete` records at 08:06:04 and 08:12:05 UTC, but the UI retained
only their starts. Inferring Working from those unmatched starts was wrong.

The bridge now owns request lifecycle independently of the originating socket.
`GET /api/sessions/status` returns the current snapshots. Results use bridged
request IDs and per-session generations; replay and Hermes steering command ACKs
do not complete turns. Closed-socket results update status without broadcasting
an old request ID to another socket. Bridge results persist through CAS in a
separate document; a restarted bridge treats prior Working claims as unknown.

The state endpoint aggregates the five known bridge status APIs. Native Codex
logs recover historical terminal outcomes only. A missing end event never proves
that an agent is still working. Native reads are bounded, cached and read-only.
No prompt is started by the status reader.

Verification:

- 69 unit/contract checks passed, including the real two-socket bridge test,
  cancellation/generation guards, steering ACKs, persistence retry, native-file
  recovery and interrupted-native-start with bridge unknown state.
- Existing bridge routing: 10/10 assertions; heartbeat/watchdog: 22/22;
  shutdown test passed. All use isolated mock adapters, without model calls.
- Browser at 390/1440 px: real isolated HTTP/CAS state, real lifecycle tracker
  over HTTP, native log fixtures, stale inventory writes, reload, start/end and
  canonical false-Working correction passed.
- On the user URL, both reported real sessions displayed Completed before and
  after reload, with zero page errors. No test prompts were sent to them.
- Frontend build includes UI policy/type checks. Served asset hashes are recorded
  in `/tmp/acp-native-status-publish.json`; actual state mount and image are
  recorded in `/tmp/acp-native-status-state-release.json`.

## Activation boundary

The frontend and state reader can use existing Codex terminal logs immediately.
The five currently running bridge processes still need the new source loaded.
They have not been restarted during this session: its process ancestry includes
the live Codex bridge, so restarting it would terminate the deployment agent.
Do not claim deployed bridge verification until activation is performed outside
that bridge and its status API is checked.

The controller provides a targeted restart and refuses to restart an ancestor
bridge. From a separate host terminal or a session on another bridge, after
accounting for active work:

```sh
node scripts/acp-bridges.mjs status
ss -tlnp
node scripts/acp-bridges.mjs restart --bridge codex --accept-interruption
```

Use the same controller command for each other bridge when it is safe to
interrupt that bridge. The selected host/Docker mode is preserved. No lifecycle
command should bypass the controller or restart the entire stack.
