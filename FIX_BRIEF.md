# FIX BRIEF — bridge workstream (branch cc/bridge), review round

The review (`REVIEW.md`) returned **APPROVE_WITH_NITS** — no blocking issues. Apply the small fixes
below, nothing else. Do NOT re-architect. Read `REVIEW.md`, `PLAN.md`, `REPORT.md` for context.
When done: re-run the suites + build, update `REPORT.md` evidence, commit on `cc/bridge`.

## Fixes to apply (only these)
1. **`src/lib/sessionRuntime.ts:~1760` — `isReconnecting` can stick `true`.** At the `tryReconnect`
   disarm site, pair `disarmAutoReconnect()` with `isReconnecting.value = false` (matching the other
   disarm sites at ~:1613/:1663). This is the highest-value fix — without it the banner can stay
   "Reconnecting…" with nothing armed.
2. **`src/lib/sessionRuntime.ts` — `isLoading` owned in one place.** In `resume()`/`create()`
   `finally`, change the unconditional `isLoading.value = false` to
   `if (inFlightPrompts === 0) isLoading.value = false;` so a resume/create completing while a
   prompt is in flight cannot hide Stop mid-turn.
3. **`src/lib/sessionRuntime.ts` `steer()` — guard the fallback.** Only fall back to `sendPrompt`
   when the socket is truly live for a prompt (gate on `isConnected`, or keep the `inFlightPrompts`
   check but add a short comment) so a programmatic `steer` during a `resume`/`session/load` can't
   fire `session/prompt` mid-load. A comment + guard is enough — it's a runtime-API footgun, not a
   live UI bug.

Skip the rest of the nits (capLogged reset, test-harness note, pongCapable one-way-door) — the
reviewer marked them acceptable-as-is.

## Constraints
- Same ownership as before: `deploy/acp-ws-bridge.mjs` (mirror to `server/` + `~/.hermes/` if you
  touch it — you probably won't this round, all three fixes are client-side), `src/lib/transport/**`,
  `src/lib/acp-bridge.ts`, `src/lib/sessionRuntime.ts`, `src/stores/session.ts`, `ChatView.vue`,
  `scripts/e2e_bridge_*`. Forbidden unchanged (App.vue, package.json, vite.config, workflow files).
- Preserve both sacred invariants. Keep the 3 bridge copies byte-identical if you edit the bridge.

## Verify (paste real output into REPORT.md, append a "## Review-round fixes" section)
1. `npm run build:web` — must stay green (vue-tsc clean).
2. `node scripts/e2e_bridge_heartbeat.mjs` — 21/21.
3. `node scripts/test_ws_transport.mjs` — 10/10.
4. `node scripts/e2e_bridge_routing.mjs` — 10/10; `~/.hermes/tools-venv/bin/python
   scripts/e2e_bridge_timeout.py` — 14/14 (run after any bridge `cp`).
Commit on `cc/bridge`. End the appended REPORT section with `FIX COMPLETE`.
