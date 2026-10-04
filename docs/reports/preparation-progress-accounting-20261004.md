# False no-progress blocker — 2026-10-04

The Reddit preparation session made several successful question/answer turns.
Each resumed attempt later repeated its answered question; the final empty
result overwrote the attempt's earlier `progress=true`. The driver counted
these useful attempts as consecutive failures. A new user message was then
blocked before reaching the provider because the historical streak remained.

Progress is now cumulative across an attempt, including native dialog questions.
Accepted human answers and continuation commands increment a durable retry
epoch; completed attempts from older epochs do not consume the new automatic
retry window. Automatic corrective turns cannot increment this epoch, so
repeated model failures remain bounded. Missing fields in legacy sessions
default to zero, and new human input recovers those sessions too.

The panel renders a plain recovery message instead of raw blocker JSON. Full
details remain in collapsed Diagnostics. API types now reflect structured
blockers, boolean progress and retry epochs.

Verification:

- Backend regressions reproduced the overwritten progress and blocked human
  continuation before the fix. Preparation lead/state: 41 tests passed.
- Preparation UI: 30 tests passed; host frontend build passed.
- Actual Chrome + production provider on the existing Reddit session: resent
  only the user's already recorded question “мы все осбудили?” through the
  panel. The provider produced a new question about search parameters and
  RSS fallback. The blocker cleared, the new attempt reports progress=true,
  all five prior answers remain intact, and reload preserves the discussion.
  No user answer, approval or implementation command was invented.
- Browser errors: none. Local proof:
  `.agent-tmp/autonomous/browser-production/progress-recovery-proof.json`.
- Final frontend asset: `index-CrMTIHs0.js`. Deployed through the existing
  source/dist-web mounts on `ship/agent-modes-20261003`; state and runner
  restarted after backend checks. Bridges and images unchanged. No active
  implementation runs existed before the restart.

Existing browser tabs require reload.
