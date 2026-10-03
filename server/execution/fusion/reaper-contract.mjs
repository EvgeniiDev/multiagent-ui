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
// Attempt lifecycle per the core plan ("Данные и хранение"): launching →
// running → terminal, where a terminal outcome is the bound porch run's
// verdict — the same vocabulary porch-runtime.mjs TERMINAL_STATUSES and
// this module's RUN_DONE use. Membership decides the ATTEMPT TERMINAL gate:
// a status outside this set — 'launching', 'running', absent, or any
// unknown value — is 'live': supervised by the drivers, never a reap
// candidate, no record written. Non-membership can only defer reaping,
// never authorize it, so the set may only grow once the attempt authority
// (the state service) is proven to persist a new terminal value.
export const ATTEMPT_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
