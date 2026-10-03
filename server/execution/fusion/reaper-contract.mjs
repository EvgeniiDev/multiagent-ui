// server/execution/fusion/reaper-contract.mjs — the slice of the execution
// domain the F1 D14 worker reaper consumes, declared locally.
//
// server/execution/execution-domain.mjs is an uncommitted shared
// Core/Fusion baseline module (disclosed in 7c5c95e): importing it made the
// reaper unloadable from any clean checkout. The reaper needs exactly one
// domain symbol — the terminal-attempt predicate — so the finite contract
// lives here until the domain module lands; the same decoupling pattern
// orchestrator/errors.mjs already uses for the domain's CommandError shape.
// When execution-domain.mjs is committed, this file is the single seam to
// re-point.
//
// Attempt lifecycle per execution-domain.mjs: terminal outcomes include
// completed, failed, cancelled, interrupted, and blocked. This attempt-level
// set is intentionally broader than porch-runtime.mjs/RUN_DONE: a reaper may
// only act after the state service proves the attempt terminal AND the porch
// registry/process-identity proof chain passes. Unknown, absent, launching,
// or running statuses remain live and can never authorize a reap.
export const ATTEMPT_TERMINAL = new Set([
  'completed', 'failed', 'cancelled', 'interrupted', 'blocked',
]);
