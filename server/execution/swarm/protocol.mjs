// server/execution/swarm/protocol.mjs — S1: messages, decisions, file ownership.
//
// STANDALONE: zero repo imports (node:crypto only) so the backend worker can
// vendor or import this file directly. State is plain JSON — the parent owns
// persistence and calls dispatch()/toJSON()/loadJSON().
//
// Model:
//   * participants register with callsign + role; no model boss exists.
//   * a turn lease is { participantId, attemptId, turnId, generation }.
//     start_turn mints generation = previous+1; every authed command must
//     carry the EXACT active lease. Past-turn / foreign / stale-generation
//     auth is rejected — including reviewer-fix commands issued after a new
//     turn started. Silence is never consent: decisions need an explicit ack
//     from EVERY affected participant on the EXACT current revision hash.
//   * decision affected-set is DERIVED BY THE SERVER from scope:
//       global        -> all registered participants
//       file / files  -> owner + declared consumers of each path
//     Text or scope change creates a new revision (new revHash); old acks
//     stay in history only. Expanding the circle (new consumer) cancels prior
//     readiness back to pending until fresh acks arrive.
//   * one file = one owner. Transfers need explicit consent of owner AND
//     recipient and are rejected while either side holds an active turn.
//     Exception: user-command force transfer after the lost owner's turn is
//     confirmed terminal (no active turn + terminal flag from parent).

import { createHash, randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = 1;

export class SwarmError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'SwarmError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const bad = (status, code, message, extra) => new SwarmError(status, code, message, extra);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CALLSIGN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Same traversal discipline as the edit broker: protocol paths never escape
// the shared tree either (defense in depth; the broker re-checks on disk).
export function assertSafePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) {
    throw bad(422, 'bad_path', `invalid path ${JSON.stringify(p)}`);
  }
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) {
    throw bad(422, 'absolute_path', `absolute paths rejected: ${JSON.stringify(p)}`);
  }
  const parts = p.split('/').filter((s) => s.length > 0);
  if (parts.length === 0) throw bad(422, 'bad_path', `empty path ${JSON.stringify(p)}`);
  for (const seg of parts) {
    if (seg === '.' || seg === '..') throw bad(422, 'path_traversal', `traversal rejected: ${JSON.stringify(p)}`);
    if (seg === '.git') throw bad(422, 'git_path', `.git paths rejected: ${JSON.stringify(p)}`);
    if (seg.includes('\0')) throw bad(422, 'bad_path', `NUL in path ${JSON.stringify(p)}`);
  }
  return parts.join('/');
}

function assertId(v, what) {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw bad(422, 'bad_id', `invalid ${what} ${JSON.stringify(v)}`);
  return v;
}

export function createInitialState({ runId, now = Date.now } = {}) {
  assertId(runId, 'runId');
  const stamp = typeof now === 'function' ? now() : now;
  return {
    version: PROTOCOL_VERSION,
    runId,
    createdAt: stamp,
    seq: 0,
    participants: {},
    order: [],
    files: {},
    messages: [],
    proposals: {},
    decisions: {},
    deadlineDirectives: [],
  };
}

function nextSeq(state) {
  state.seq += 1;
  return state.seq;
}

// ---- server derivation ------------------------------------------------------

function affectedForScope(state, scope) {
  if (!isObj(scope) || typeof scope.kind !== 'string') {
    throw bad(422, 'bad_scope', `decision scope must be an object with kind, got ${JSON.stringify(scope)}`);
  }
  if (scope.kind === 'global') {
    return [...state.order];
  }
  const paths = scope.kind === 'file' ? [scope.path]
    : scope.kind === 'files' ? scope.path ?? scope.paths
    : null;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw bad(422, 'bad_scope', `scope kind ${JSON.stringify(scope.kind)} needs a path/paths list`);
  }
  const out = [];
  for (const raw of paths) {
    const p = assertSafePath(raw);
    const f = state.files[p];
    if (!f || !f.owner) throw bad(422, 'unowned_scope', `decision scope path has no owner: ${JSON.stringify(p)}`);
    for (const pid of [f.owner, ...(f.consumers ?? [])]) {
      if (!out.includes(pid)) out.push(pid);
    }
  }
  if (out.length === 0) throw bad(422, 'empty_affected', 'decision affects nobody');
  return out;
}

function scopeBinding(state, scope) {
  if (scope.kind === 'global') return { kind: 'global', participants: [...state.order].sort() };
  const paths = scope.kind === 'file' ? [scope.path] : scope.path ?? scope.paths;
  return { kind: scope.kind, paths: paths.map(assertSafePath).sort().map(path => {
    const file = state.files[path];
    return { path, owner: file.owner, version: file.version, consumers: [...(file.consumers ?? [])].sort() };
  }) };
}
function revHashFor(text, affected, binding) {
  return sha256Hex(canonicalJson({ text, affected: [...affected].sort(), scopeBinding: binding }));
}

// Ownership/consumer/registration changes create an immutable new revision.
// Old acknowledgments stay in history and never count for the new binding.
function refreshDecisionBindings(state, now, emit, events) {
  for (const decision of Object.values(state.decisions)) {
    const affected = affectedForScope(state, decision.scope);
    const binding = scopeBinding(state, decision.scope);
    const latest = decision.revisions.at(-1);
    const revHash = revHashFor(latest.text, affected, binding);
    if (revHash === latest.revHash) continue;
    const rev = latest.rev + 1;
    decision.affected = [...affected];
    decision.revisions.push({ rev, text: latest.text, textHash: latest.textHash, revHash,
      affected: [...affected], scopeBinding: binding, by: 'broker', at: now });
    decision.acks[rev] = {};
    decision.status = 'pending';
    decision.agreedRev = null;
    events.push(emit('decision_readiness_cancelled', { decisionId: decision.id, rev, revHash, affected }));
  }
}

// ---- lease fencing ----------------------------------------------------------

function activeLeaseOf(state, participantId) {
  const p = state.participants[participantId];
  if (!p) throw bad(404, 'unknown_participant', `unknown participant ${JSON.stringify(participantId)}`);
  return { participant: p, lease: p.activeTurn };
}

// Every authed command funnels through here: exact match on attempt, turn
// AND generation. A new turn mints a new generation, so any command, message
// or ack from a past turn — including a reviewer fix — is rejected.
function requireLease(state, auth) {
  if (!isObj(auth)) throw bad(401, 'missing_auth', 'auth lease is required');
  const { participant: p, lease } = activeLeaseOf(state, auth.participantId);
  if (!lease) {
    throw bad(409, 'no_active_turn', `participant ${auth.participantId} holds no active turn`, {
      participantId: auth.participantId,
    });
  }
  const mismatch =
    auth.attemptId !== lease.attemptId ||
    auth.turnId !== lease.turnId ||
    auth.generation !== lease.generation;
  if (mismatch) {
    throw bad(409, 'stale_lease', 'auth lease does not match the active turn/generation', {
      participantId: auth.participantId,
      expected: { attemptId: lease.attemptId, turnId: lease.turnId, generation: lease.generation },
      got: { attemptId: auth.attemptId, turnId: auth.turnId, generation: auth.generation },
    });
  }
  return { participant: p, lease };
}

function requireRole(auth, roles) {
  if (!roles.includes(auth.role)) {
    throw bad(403, 'forbidden_role', `role ${JSON.stringify(auth.role)} may not issue this command`, { roles });
  }
}

// Transfer commands happen BETWEEN turns (neither side may hold an active
// turn at completion), so they authenticate by registered identity, not by
// active lease. Unknown participants are still rejected.
function requireIdentity(state, auth) {
  if (!isObj(auth)) throw bad(401, 'missing_auth', 'auth identity is required');
  const p = state.participants[auth.participantId];
  if (!p) throw bad(404, 'unknown_participant', `unknown participant ${JSON.stringify(auth.participantId)}`);
  return { participant: p };
}

// ---- command application ----------------------------------------------------

function applyCommand(state, cmd, ctx) {
  const now = ctx.now();
  const emit = (type, payload) => ({ type, seq: nextSeq(state), at: now, ...payload });
  const events = [];
  const type = cmd?.type;

  switch (type) {
    case 'register_participant': {
      const pid = assertId(cmd.participantId, 'participantId');
      if (typeof cmd.callsign !== 'string' || !CALLSIGN_RE.test(cmd.callsign)) {
        throw bad(422, 'bad_callsign', `invalid callsign ${JSON.stringify(cmd.callsign)}`);
      }
      if (state.participants[pid]) throw bad(409, 'already_registered', `participant ${pid} already registered`);
      state.participants[pid] = {
        participantId: pid, callsign: cmd.callsign, role: cmd.role ?? 'peer',
        generation: 0, activeTurn: null, addedAt: now,
      };
      state.order.push(pid);
      refreshDecisionBindings(state, now, emit, events);
      events.push(emit('participant_registered', { participantId: pid, callsign: cmd.callsign }));
      return { events };
    }

    case 'start_turn': {
      const pid = assertId(cmd.participantId, 'participantId');
      const attemptId = assertId(cmd.attemptId, 'attemptId');
      const turnId = assertId(cmd.turnId, 'turnId');
      const { participant: p } = activeLeaseOf(state, pid);
      if (p.activeTurn) {
        throw bad(409, 'turn_active', `participant ${pid} already holds turn ${p.activeTurn.turnId}`, {
          activeTurnId: p.activeTurn.turnId,
        });
      }
      const generation = p.generation + 1;
      p.generation = generation;
      p.activeTurn = { participantId: pid, attemptId, turnId, generation, phase: cmd.phase ?? 'coordinate', startedAt: now };
      events.push(emit('turn_started', { participantId: pid, attemptId, turnId, generation }));
      return { events, lease: { ...p.activeTurn, runId: state.runId, role: p.role } };
    }

    case 'end_turn': {
      const { participant: p, lease } = requireLease(state, cmd.auth);
      p.activeTurn = null;
      events.push(emit('turn_ended', {
        participantId: p.participantId, turnId: lease.turnId, generation: lease.generation,
        outcome: cmd.outcome ?? 'done',
      }));
      return { events };
    }

    case 'send_message': {
      const { participant: p, lease } = requireLease(state, cmd.auth);
      const to = cmd.to === 'all' ? 'all' : assertId(cmd.to, 'to');
      if (to !== 'all' && !state.participants[to]) throw bad(404, 'unknown_recipient', `unknown recipient ${to}`);
      if (typeof cmd.body !== 'string' || cmd.body.length === 0 || cmd.body.length > 65536) {
        throw bad(422, 'bad_body', 'message body must be a non-empty string <= 64KiB');
      }
      const msg = {
        seq: state.messages.length + 1, id: cmd.id ?? randomUUID(),
        from: p.participantId, to, kind: 'message', body: cmd.body,
        turnRef: { turnId: lease.turnId, generation: lease.generation }, at: now,
      };
      state.messages.push(msg);
      events.push(emit('message_sent', { message: msg }));
      return { events, message: msg };
    }

    case 'claim_file': {
      const { participant: p } = requireLease(state, cmd.auth);
      const path = assertSafePath(cmd.path);
      const existing = state.files[path];
      if (existing?.owner) {
        throw bad(409, 'already_owned', `file already owned by ${existing.owner}`, {
          path, owner: existing.owner, version: existing.version,
        });
      }
      if (existing?.reservedBy && existing.reservedBy !== p.participantId) {
        throw bad(409, 'reserved', `path reserved by ${existing.reservedBy}`, { path });
      }
      state.files[path] = {
        path, owner: p.participantId, version: (existing?.version ?? 0) + 1,
        reservedBy: null, consumers: existing?.consumers ?? [], pendingTransfer: null, claimedAt: now,
      };
      events.push(emit('file_claimed', { path, owner: p.participantId }));
      return { events };
    }

    case 'reserve_path': {
      // Ownership reservation for a path that does not exist yet (KTD4:
      // the new path is reserved BEFORE create). No other participant may
      // claim or create it afterwards.
      const { participant: p } = requireLease(state, cmd.auth);
      const path = assertSafePath(cmd.path);
      const existing = state.files[path];
      if (existing?.owner) throw bad(409, 'already_owned', `path owned by ${existing.owner}`, { path });
      if (existing?.reservedBy && existing.reservedBy !== p.participantId) {
        throw bad(409, 'reserved', `path reserved by ${existing.reservedBy}`, { path });
      }
      state.files[path] = {
        path, owner: null, version: 0, reservedBy: p.participantId,
        consumers: [], pendingTransfer: null, reservedAt: now,
      };
      events.push(emit('path_reserved', { path, by: p.participantId }));
      return { events };
    }

    case 'declare_consumer': {
      const { participant: p } = requireLease(state, cmd.auth);
      const path = assertSafePath(cmd.path);
      const f = state.files[path];
      if (!f?.owner) throw bad(422, 'unowned_path', `cannot consume unowned path ${JSON.stringify(path)}`);
      const who = cmd.participantId ?? p.participantId;
      if (!state.participants[who]) throw bad(404, 'unknown_participant', `unknown participant ${who}`);
      if (who !== f.owner && !(f.consumers ?? []).includes(who)) {
        f.consumers.push(who);
        refreshDecisionBindings(state, now, emit, events);
        events.push(emit('consumer_declared', { path, participantId: who }));
      }
      return { events };
    }

    case 'request_transfer': {
      const { participant: p } = requireIdentity(state, cmd.auth);
      const path = assertSafePath(cmd.path);
      const to = assertId(cmd.to, 'to');
      const f = state.files[path];
      if (!f?.owner) throw bad(422, 'unowned_path', `no owner to transfer ${JSON.stringify(path)}`);
      if (f.owner !== p.participantId) {
        throw bad(403, 'not_owner', `only owner ${f.owner} may request transfer of ${JSON.stringify(path)}`);
      }
      if (!state.participants[to]) throw bad(404, 'unknown_participant', `unknown recipient ${to}`);
      if (to === f.owner) throw bad(422, 'self_transfer', 'recipient already owns the file');
      if (f.pendingTransfer) throw bad(409, 'transfer_pending', 'a transfer is already pending for this file', { path });
      const other = state.participants[to];
      if (p.activeTurn || other.activeTurn) {
        throw bad(409, 'transfer_during_active_turn', 'ownership transfer is rejected while either side holds an active turn', {
          path, ownerActive: Boolean(p.activeTurn), recipientActive: Boolean(other.activeTurn),
        });
      }
      f.pendingTransfer = { to, ownerConsents: true, recipientConsents: false, requestedAt: now };
      events.push(emit('transfer_requested', { path, from: f.owner, to }));
      return { events };
    }

    case 'consent_transfer': {
      const { participant: p } = requireIdentity(state, cmd.auth);
      const path = assertSafePath(cmd.path);
      const f = state.files[path];
      if (!f?.pendingTransfer) throw bad(409, 'no_transfer_pending', `no pending transfer for ${JSON.stringify(path)}`);
      const t = f.pendingTransfer;
      if (p.participantId !== t.to && p.participantId !== f.owner) {
        throw bad(403, 'not_party', 'only the transfer parties may consent');
      }
      if (cmd.accept === false) {
        f.pendingTransfer = null;
        events.push(emit('transfer_rejected', { path, by: p.participantId }));
        return { events };
      }
      if (p.participantId === t.to) t.recipientConsents = true;
      else t.ownerConsents = true;
      if (t.ownerConsents && t.recipientConsents) {
        // Both consents are turn-free identity commands, so completion is
        // only reachable when neither side holds an active turn — the
        // request-time check plus this completion-time check enforce the
        // no-active-transfer rule on both edges.
        const owner = state.participants[f.owner];
        const recip = state.participants[t.to];
        if (owner.activeTurn || recip.activeTurn) {
          throw bad(409, 'transfer_during_active_turn',
            'transfer cannot complete while either party holds an active turn', { path });
        }
        const from = f.owner;
        f.owner = t.to;
        f.version += 1;
        f.pendingTransfer = null;
        refreshDecisionBindings(state, now, emit, events);
        events.push(emit('transfer_completed', { path, from, to: t.to, version: f.version }));
      } else {
        events.push(emit('transfer_consented', { path, by: p.participantId }));
      }
      return { events };
    }

    case 'transfer_force': {
      // R8 exception, user channel only: after the lost owner's attempt is
      // confirmed terminal (parent passes terminal:true and the owner holds
      // NO active turn), move ownership without the owner's consent.
      requireRole(cmd.auth, ['user']);
      const path = assertSafePath(cmd.path);
      const to = assertId(cmd.to, 'to');
      const f = state.files[path];
      if (!f?.owner) throw bad(422, 'unowned_path', `no owner to transfer ${JSON.stringify(path)}`);
      if (!state.participants[to]) throw bad(404, 'unknown_participant', `unknown recipient ${to}`);
      const owner = state.participants[f.owner];
      if (owner.activeTurn) {
        throw bad(409, 'owner_active', 'force transfer requires the lost owner to hold no active turn');
      }
      if (cmd.ownerTerminal !== true) {
        throw bad(422, 'terminal_unconfirmed', 'force transfer requires explicit ownerTerminal:true confirmation');
      }
      const from = f.owner;
      f.owner = to;
      f.version += 1;
      f.pendingTransfer = null;
      refreshDecisionBindings(state, now, emit, events);
      events.push(emit('transfer_forced', { path, from, to, version: f.version }));
      return { events };
    }

    case 'open_proposal': {
      const { participant: p } = requireLease(state, cmd.auth);
      if (typeof cmd.text !== 'string' || cmd.text.length === 0) {
        throw bad(422, 'bad_text', 'proposal text must be non-empty');
      }
      const id = cmd.id ?? randomUUID();
      if (state.proposals[id]) throw bad(409, 'duplicate_id', `proposal ${id} already exists`);
      state.proposals[id] = { id, from: p.participantId, scope: cmd.scope ?? null, text: cmd.text, status: 'open', at: now };
      events.push(emit('proposal_opened', { proposalId: id, from: p.participantId }));
      return { events, proposalId: id };
    }

    case 'open_decision': {
      const { participant: p, lease } = requireLease(state, cmd.auth);
      if (typeof cmd.text !== 'string' || cmd.text.length === 0 || cmd.text.length > 65536) {
        throw bad(422, 'bad_text', 'decision text must be a non-empty string <= 64KiB');
      }
      if (cmd.proposalId !== undefined && cmd.proposalId !== null) {
        const prop = state.proposals[cmd.proposalId];
        if (!prop) throw bad(404, 'unknown_proposal', `unknown proposal ${cmd.proposalId}`);
      }
      const affected = affectedForScope(state, cmd.scope);
      const scopePaths = cmd.scope.kind === 'global' ? null
        : (Array.isArray(cmd.scope.paths) ? cmd.scope.paths : [cmd.scope.path]).map(assertSafePath);
      const id = cmd.id ?? randomUUID();
      if (state.decisions[id]) throw bad(409, 'duplicate_id', `decision ${id} already exists`);
      const textHash = sha256Hex(cmd.text);
      const binding = scopeBinding(state, cmd.scope);
      const revHash = revHashFor(cmd.text, affected, binding);
      state.decisions[id] = {
        id, proposalId: cmd.proposalId ?? null, scope: cmd.scope, scopePaths, affected,
        revisions: [{ rev: 1, text: cmd.text, textHash, revHash, affected: [...affected], scopeBinding: binding, by: p.participantId, at: now }],
        acks: { 1: {} }, ackHistory: [],
        status: 'pending', agreedRev: null, openedBy: p.participantId,
        turnRef: { turnId: lease.turnId, generation: lease.generation },
      };
      if (cmd.proposalId && state.proposals[cmd.proposalId]) state.proposals[cmd.proposalId].status = 'decided';
      events.push(emit('decision_opened', { decisionId: id, rev: 1, revHash, affected }));
      return { events, decisionId: id, rev: 1, revHash, affected };
    }

    case 'amend_decision': {
      const { participant: p } = requireLease(state, cmd.auth);
      const d = state.decisions[assertId(cmd.decisionId, 'decisionId')];
      if (!d) throw bad(404, 'unknown_decision', `unknown decision ${cmd.decisionId}`);
      if (d.status === 'agreed' && cmd.reopen !== true) {
        throw bad(409, 'decision_agreed', 'agreed decisions are immutable; pass reopen:true to start a new revision', {
          decisionId: d.id,
        });
      }
      const text = cmd.text ?? d.revisions[d.revisions.length - 1].text;
      const scope = cmd.scope ?? d.scope;
      const affected = affectedForScope(state, scope);
      const scopePaths = scope.kind === 'global' ? null
        : (Array.isArray(scope.paths) ? scope.paths : [scope.path]).map(assertSafePath);
      const rev = d.revisions.length + 1;
      const binding = scopeBinding(state, scope);
      const revHash = revHashFor(text, affected, binding);
      d.scope = scope;
      d.scopePaths = scopePaths;
      d.affected = affected;
      d.revisions.push({ rev, text, textHash: sha256Hex(text), revHash, affected: [...affected], scopeBinding: binding, by: p.participantId, at: now });
      d.acks[rev] = {};
      d.status = 'pending';
      d.agreedRev = null;
      events.push(emit('decision_amended', { decisionId: d.id, rev, revHash, affected }));
      return { events, rev, revHash };
    }

    case 'ack_decision': {
      // Explicit ack of an EXACT revision. Silence never counts; a late ack
      // of a superseded revision is recorded in history and rejected.
      const { participant: p, lease } = requireLease(state, cmd.auth);
      const d = state.decisions[assertId(cmd.decisionId, 'decisionId')];
      if (!d) throw bad(404, 'unknown_decision', `unknown decision ${cmd.decisionId}`);
      if (!d.affected.includes(p.participantId)) {
        throw bad(403, 'not_affected', `participant ${p.participantId} is not affected by decision ${d.id}`);
      }
      const latest = d.revisions[d.revisions.length - 1];
      const record = {
        by: p.participantId, rev: cmd.rev, revHash: cmd.revHash,
        turnRef: { turnId: lease.turnId, generation: lease.generation }, at: now,
      };
      if (cmd.rev !== latest.rev || cmd.revHash !== latest.revHash) {
        record.outcome = 'stale';
        record.latestRev = latest.rev;
        d.ackHistory.push(record);
        throw bad(409, 'stale_revision', 'ack targets a superseded revision; confirm the current revision instead', {
          decisionId: d.id, gotRev: cmd.rev, latestRev: latest.rev, latestRevHash: latest.revHash,
        });
      }
      d.acks[latest.rev][p.participantId] = { at: now, turnRef: record.turnRef };
      record.outcome = 'counted';
      d.ackHistory.push(record);
      events.push(emit('decision_ack', { decisionId: d.id, rev: latest.rev, by: p.participantId }));
      const missing = d.affected.filter((pid) => !d.acks[latest.rev][pid]);
      if (missing.length === 0) {
        d.status = 'agreed';
        d.agreedRev = latest.rev;
        events.push(emit('decision_agreed', { decisionId: d.id, rev: latest.rev, revHash: latest.revHash }));
      }
      return { events, agreed: d.status === 'agreed', missing };
    }

    case 'user_directive': {
      // R7: deadlock goes to the user with options+consequences. The user's
      // verdict is recorded as a decision; it does NOT bypass the document
      // gate — when the scope touches requirements/plan/design documents,
      // explicit acks are still required.
      requireRole(cmd.auth, ['user']);
      if (typeof cmd.text !== 'string' || cmd.text.length === 0) {
        throw bad(422, 'bad_text', 'directive text must be non-empty');
      }
      const affected = affectedForScope(state, cmd.scope);
      const id = cmd.id ?? randomUUID();
      if (state.decisions[id]) throw bad(409, 'duplicate_id', `decision ${id} already exists`);
      const binding = scopeBinding(state, cmd.scope);
      const revHash = revHashFor(cmd.text, affected, binding);
      const needsGate = cmd.scope?.touchesDocuments === true;
      state.decisions[id] = {
        id, proposalId: null, scope: cmd.scope, scopePaths: null, affected,
        revisions: [{ rev: 1, text: cmd.text, textHash: sha256Hex(cmd.text), revHash, affected: [...affected], scopeBinding: binding, by: 'user', at: now }],
        acks: { 1: {} }, ackHistory: [],
        status: needsGate ? 'pending' : 'agreed', agreedRev: needsGate ? null : 1,
        byUser: true, options: cmd.options ?? [], consequences: cmd.consequences ?? '',
      };
      events.push(emit(needsGate ? 'decision_opened' : 'decision_agreed',
        { decisionId: id, rev: 1, revHash, affected, byUser: true }));
      return { events, decisionId: id, revHash, gated: needsGate };
    }

    default:
      throw bad(422, 'unknown_command', `unknown command type ${JSON.stringify(type)}`);
  }
}

// ---- store: parent binding --------------------------------------------------

export function issueLeaseToken(state, participantId) {
  const { participant: p, lease } = activeLeaseOf(state, participantId);
  if (!lease) throw bad(409, 'no_active_turn', `participant ${participantId} holds no active turn`);
  return { runId: state.runId, participantId, role: p.role, ...lease };
}

export function createSwarmProtocol({ runId, now = Date.now, initialState = null, onEvent = null } = {}) {
  let state = initialState ?? createInitialState({ runId, now });
  if (state.version !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol state version ${state.version}`);
  }
  return {
    getState() { return state; },
    toJSON() { return JSON.stringify(state); },
    loadJSON(text) {
      const parsed = JSON.parse(text);
      if (parsed.version !== PROTOCOL_VERSION || parsed.runId !== state.runId) {
        throw new Error('protocol snapshot runId/version mismatch');
      }
      state = parsed;
    },
    leaseFor(participantId) { return issueLeaseToken(state, participantId); },
    dispatch(cmd) {
      const ctx = { now: typeof now === 'function' ? now : () => now };
      const out = applyCommand(state, cmd, ctx);
      if (onEvent) for (const e of out.events) onEvent(e);
      return out;
    },
  };
}

export const COMMAND_TYPES = [
  'register_participant', 'start_turn', 'end_turn', 'send_message',
  'claim_file', 'reserve_path', 'declare_consumer',
  'request_transfer', 'consent_transfer', 'transfer_force',
  'open_proposal', 'open_decision', 'amend_decision', 'ack_decision',
  'user_directive',
];
