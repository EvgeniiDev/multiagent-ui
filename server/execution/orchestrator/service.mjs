// server/execution/orchestrator/service.mjs — O1 command surface.
//
// One serialized entry point (dispatch) per run: every command carries an
// idempotency key (commandId); the ledger stores the SHA-256 fingerprint of
// {type, payload} alongside the recorded result. An identical replay returns
// the SAME result without re-running the handler — no second graph, no
// duplicate events — while the same key under a different payload is a hard
// 409 command_conflict. Failed commands are never recorded, so a corrected
// retry under the same key is not a phantom conflict.
//
// Everything is in-memory by design: this is the pure O1 contract. Durable
// persistence is an adapter concern for the core integration slice — the
// entire observable contract (events, ordering, statuses, idempotency) lives
// here and is exercised by scripts/test_orchestrator_graph.mjs without any
// runtime or compose.

import { SAFE_ID_RE } from '../common.mjs';
import { sha256 } from '../execution-store.mjs';
import { canonicalJson } from '../environment/agent-profile.mjs';
import { invalid, conflict } from './errors.mjs';
import { isObj, assertOnlyKeys, assertNoSecrets } from './subtask.mjs';
import {
  decompose, proposeInputChange, decideInputChange, transitionTask, stopGraph,
} from './graph.mjs';

const COMMAND_KEYS = new Set(['commandId', 'type', 'payload']);
const COMMAND_TYPES = new Set([
  'decompose', 'propose_input_change', 'decide_input_change', 'transition_task', 'stop',
]);

export function createOrchestratorService({ now } = {}) {
  const clock = typeof now === 'function' ? now : () => new Date().toISOString();
  const runs = new Map();

  function ctxFor(runId) {
    let c = runs.get(runId);
    if (!c) {
      c = {
        runId,
        commands: new Map(),  // commandId → {fingerprint, result} — applied only
        events: [],           // run-level append-only log; graph ops write here
        eventsCursor: 0,
        graph: null,
        graphSeq: 0,
        proposalSeq: 0,
      };
      runs.set(runId, c);
    }
    return c;
  }

  function handle(ctx, runId, type, payload, commandId) {
    switch (type) {
      case 'decompose': return decompose(ctx, runId, payload, clock);
      case 'propose_input_change': return proposeInputChange(ctx, ctx.graph, payload, clock);
      case 'decide_input_change': return decideInputChange(ctx, ctx.graph, payload, clock, commandId);
      case 'transition_task': return transitionTask(ctx, ctx.graph, payload, clock, commandId);
      case 'stop': return stopGraph(ctx, ctx.graph, clock, commandId);
      default: throw invalid('command_invalid', `unknown command type ${JSON.stringify(type)}`);
    }
  }

  function dispatch(runId, raw) {
    if (typeof runId !== 'string' || !SAFE_ID_RE.test(runId)) {
      throw invalid('invalid_run_id', `run id must match ${SAFE_ID_RE}`);
    }
    if (!isObj(raw)) throw invalid('malformed', 'command must be an object');
    // The secret scan precedes every other check: a credential-shaped key is
    // rejected as secrets_forbidden no matter where it hides in the command.
    assertNoSecrets(raw, 'command');
    assertOnlyKeys(raw, COMMAND_KEYS, 'command');
    if (typeof raw.commandId !== 'string' || !SAFE_ID_RE.test(raw.commandId)) {
      throw invalid('command_invalid', `commandId must match ${SAFE_ID_RE}`);
    }
    if (!COMMAND_TYPES.has(raw.type)) {
      throw invalid('command_invalid', `unknown command type ${JSON.stringify(raw.type)}`);
    }
    if (raw.payload !== undefined && !isObj(raw.payload)) {
      throw invalid('malformed', 'command payload must be an object');
    }
    const payload = raw.payload ?? {};

    const ctx = ctxFor(runId);
    const fingerprint = sha256(canonicalJson({ type: raw.type, payload }));
    const seen = ctx.commands.get(raw.commandId);
    if (seen) {
      if (seen.fingerprint !== fingerprint) {
        throw conflict('command_conflict',
          `commandId ${raw.commandId} was already applied with a different payload`,
          { commandId: raw.commandId });
      }
      return { ...structuredClone(seen.result), replayed: true };
    }
    const result = handle(ctx, runId, raw.type, payload, raw.commandId);
    ctx.commands.set(raw.commandId, { fingerprint, result });
    return { ...result, replayed: false };
  }

  return {
    dispatch,
    graph: (runId) => runs.get(runId)?.graph ?? null,
    events: (runId, fromSeq = 0) =>
      (runs.get(runId)?.events ?? []).filter((e) => e.seq > fromSeq),
    runIds: () => [...runs.keys()],
  };
}
