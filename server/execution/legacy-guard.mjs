// server/execution/legacy-guard.mjs — the managed-card dispatch barrier.
//
// Cards managed by the execution core (U2+) are dispatched exclusively
// through the managed lifecycle (internal commands + scheduler). The legacy
// acp-runner must NEVER claim them — even if a stale board row advertises a
// dispatchable stage. This predicate is the single definition both sides use.

export function isManagedCard(card) {
  return card?.execution?.managed === true;
}

// Whole-loop predicate used by the legacy dispatcher: unchanged semantics —
// done/backlog, blocked/cancelled, and managed cards are not dispatchable.
export function legacyCardDispatchable(card) {
  if (!card || typeof card !== 'object') return false;
  if (card.stage === 'done' || card.stage === 'backlog') return false;
  if (card.blocked || card.cancelled) return false;
  if (isManagedCard(card)) return false;
  return true;
}
