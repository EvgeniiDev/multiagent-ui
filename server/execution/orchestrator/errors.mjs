// server/execution/orchestrator/errors.mjs — O1 error helpers.
//
// Every orchestrator rejection fails CLOSED with an HTTP-style status plus a
// stable machine code — the same shape execution-domain's CommandError uses,
// produced here without importing the domain module (no dependency cycle).

import { RuntimeError } from '../common.mjs';

export function orchError(status, code, message, details = {}) {
  return new RuntimeError(code, message, { status, details });
}

// 422 — the caller's document/command is malformed or fails the contract.
export const invalid = (code, message, details = {}) => orchError(422, code, message, details);

// 409 — the document is well-formed but conflicts with durable state
// (graph already exists, illegal transition, idempotency conflict, ...).
export const conflict = (code, message, details = {}) => orchError(409, code, message, details);
