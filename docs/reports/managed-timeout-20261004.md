# Managed execution: timeout and recovery, 2026-10-04

User reported `state server did not finish responding within 8000ms` with
`offline` and `Loading managed state…` simultaneously. A failed initial read
rendered the loading fallback despite its error. The panel now shows a failed
read or an explicit retry, and exposes the actual in-flight request on the
refresh button. It never offers enable while managed state is unknown.

Backend measurements found excessive unrelated work: every queued read parsed
all managed aggregates twice, including an 18 MB Swarm aggregate. Repair now
reuses aggregates within that single queue operation for its projection pass.
There is no persistent cache or relaxed repair barrier: subsequent operations
still read disk, drain pending effects, and fail closed on corruption.

On the production TLS state API, 24 concurrent reads of the existing Reddit
card completed in about 4.99 seconds before and 2.76 seconds after this change.
All post-deploy reads returned 200. These are bounded spot measurements, not a
performance guarantee. Current responses were small (768–4755 bytes), and
header-to-body completion was under 1 ms before the change. The original
natural body timeout was **not reproduced**; the measured queue delay and the
misleading UI are confirmed separate findings.

Validation:

- UI regression failed before the fix because a failed read still said loading;
  all 75 execution UI/API/store tests pass after the final fix.
- Backend regression failed with two reads per aggregate instead of one;
  all 35 U2 state tests pass. It checks recovery after injected failed claims
  purge, both managed board projections, and subsequent disk corruption.
- Host frontend build passed; LAN `/board` serves `index-KwzxdB2J.js`.
- Only Compose state was restarted, using the existing read-only repository
  mount and unchanged image. Runner and bridges were not restarted.
- Browser proof intentionally stalls the body of an actual successful Reddit
  card GET until the client's 8000 ms abort. This is fault injection, not a
  reproduction of a natural production timeout or a fabricated success DTO.
  It checks error/retry, recovery to the actual managed view, mode controls,
  and managed state after reload without enabling or starting work. This
  browser check passed on the final deployed frontend with no page errors.

Private evidence is under `.agent-tmp/autonomous/browser-production/`:
`managed-timeout-proof.json` and `managed-latency-after.json`.
