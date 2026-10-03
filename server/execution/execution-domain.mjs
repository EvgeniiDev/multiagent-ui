// server/execution/execution-domain.mjs — execution lifecycle vocabulary.
//
// Canonical home of the run/attempt lifecycle constants that this branch's
// code shares. The F1 worker reaper (fusion/reaper.mjs) gates every reap
// decision on ATTEMPT_TERMINAL: a nonterminal attempt is 'live', supervised
// by the drivers, never a reap candidate.
//
// This file intentionally carries ONLY the lifecycle subset. The full
// U2–U5 domain module (commands, documents, approvals, workspaces,
// validation, fusion panel/handoff, preparation) belongs to the Core slice
// and imports modules that are not part of the F1 environment foundation;
// it must not be reconstructed here. The sets below are verbatim from the
// source domain module — keep them identical when the Core slice lands.

// Run lifecycle. queued|active|stopping|awaiting_acceptance are live;
// everything else is terminal.
export const RUN_NONTERMINAL = new Set(['queued', 'active', 'stopping', 'awaiting_acceptance']);
// 'cancelling' is a LIVE state: workspace+slot stay reserved until a
// positive terminal observation — a cancel request is never itself proof of
// process death.
export const ATTEMPT_NONTERMINAL = new Set(['launching', 'running', 'cancelling']);
export const ATTEMPT_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'blocked']);
