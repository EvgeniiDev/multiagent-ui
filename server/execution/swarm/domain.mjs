// S3 durable domain handlers. The shared execution command queue persists the
// aggregate and invokes these with FUSION_DEPS-style helpers; no runtime effects
// happen here. Participant commands never supply identity, roles or gate proofs.
import { randomUUID } from 'node:crypto';
import { RuntimeError, SAFE_ID_RE } from '../common.mjs';
import { sha256 } from '../execution-store.mjs';
import { validateAgentProfile, profileDigest, canonicalJson } from '../environment/agent-profile.mjs';
import { createSwarmProtocol, assertSafePath, refreshSwarmDecisionBindings } from './protocol.mjs';
import { parseSwarmResult } from './prompt.mjs';

export const SWARM_ROLE = 'participant';
export const SWARM_COMMANDS = ['swarm_input','swarm_extend','swarm_decide'];
export const SWARM_INTERNAL_COMMANDS = ['swarm_claim','swarm_participant_begin','swarm_protocol','swarm_apply_intent','swarm_apply_result','swarm_turn_result','swarm_freeze','swarm_phase','swarm_materialized','swarm_cursor','swarm_observed','swarm_worker_settled'];
export const SWARM_ATTEMPT_ROLES = new Set([SWARM_ROLE]);
export const LIVE = new Set(['launching', 'running', 'cancelling']);
export const WRITE_PHASES = new Set(['implement', 'catch_up']);
const PARTICIPANT_COMMANDS = new Set(['send_message', 'claim_file', 'reserve_path', 'declare_consumer', 'open_proposal', 'open_decision', 'amend_decision', 'ack_decision','request_transfer','consent_transfer']);
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (code, message, status = 409) => { const e = new RuntimeError(code, message); e.status = status; throw e; };
const safeId = (id, what) => { if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) fail('swarm_invalid', `${what} must be a safe identifier`, 422); return id; };
const integer = (x, fallback, min, max, what) => { const n = x ?? fallback; if (!Number.isInteger(n) || n < min || n > max) fail('swarm_invalid', `${what} must be ${min}..${max}`, 422); return n; };
export function validateSwarmSpec(raw) {
  if (!obj(raw) || !Array.isArray(raw.participants) || raw.participants.length < 2 || raw.participants.length > 3) fail('swarm_invalid', 'Swarm requires 2..3 participants with full profiles', 422);
  const ids = new Set(), callsigns = new Set();
  const participants = raw.participants.map(p => {
    const participantId = safeId(p?.participantId, 'participantId'), callsign = safeId(p?.callsign, 'callsign');
    if (ids.has(participantId) || callsigns.has(callsign)) fail('swarm_invalid', 'Participant IDs and callsigns must be unique', 422);
    ids.add(participantId); callsigns.add(callsign);
    const profile = validateAgentProfile(p.profile);
    const ownedPaths = p.ownedPaths ?? [];
    if (!Array.isArray(ownedPaths) || ownedPaths.length > 64) fail('swarm_invalid', 'ownedPaths must be a bounded array', 422);
    // These are declared scope hints, never directory ownership proofs.
    for (const path of ownedPaths) assertSafePath(path);
    return { participantId, callsign, profile, profileId: profile.profileId, profileDigest: profileDigest(profile), ownedPaths };
  });
  const limits = raw.limits ?? {};
  return {participants, limits: {
    maxTurnsPerParticipant: integer(limits.maxTurnsPerParticipant, 12, 1, 100, 'turns'),
    maxRounds: integer(limits.maxRounds, 3, 1, 20, 'coordination rounds'),
    maxCatchUpRounds: integer(limits.maxCatchUpRounds, 3, 1, 20, 'catch-up rounds'),
    maxMessages: integer(limits.maxMessages, 200, 1, 10000, 'messages'),
    timeoutMin: integer(limits.timeoutMin, 10, 1, 10, 'turn timeout'),
    verifyRequired: true,
  }};
}
export function createSwarmState(runId, spec, project, now) {
  const protocol = createSwarmProtocol({runId, now: () => now});
  for (const p of spec.participants) protocol.dispatch({type: 'register_participant', participantId: p.participantId, callsign: p.callsign, role: 'peer'});
  return {version: 1, canonicalId: `sw-${runId}`, phase: 'coordinate', round: 1, epoch: 0, project, owner: null,
    participants: spec.participants.map(p => ({...p, status: 'active', attempt: null,
      budget: {turnsUsed: 0, turnsLimit: spec.limits.maxTurnsPerParticipant},
      coordinationUsed: 0, waiting: null, cursor: {lastSeenSeq: 0}, declaration: null, ready: false})),
    protocol: protocol.getState(), limits: spec.limits, ownership: [], decisions: [], messages: [],
    pendingActions: [], freeze: null, findings: [], transfers: [], edits: {}, frameReceipts: {}, broker: {recovered: false, blocked: []}, snapshots: [], history: []};
}
const participant = (s, id) => s.participants.find(p => p.participantId === id) ?? fail('participant_not_found', `Unknown participant ${id}`, 404);
const protocolFor = s => createSwarmProtocol({runId: s.protocol.runId, initialState: structuredClone(s.protocol)});
export function assertTurnAuthority(s, att, now) {
  if (!att || att.role && att.role !== SWARM_ROLE || !LIVE.has(att.status) || att.cancel || att.deadlineAt !== undefined && now >= att.deadlineAt) fail('stale_lease', 'Attempt is terminal, cancelled or past its deadline');
  const lease = s.protocol.participants[att.participantId]?.activeTurn;
  if (!lease || lease.attemptId !== att.id || lease.turnId !== att.turnId || lease.generation !== att.generation) fail('stale_lease', 'Attempt does not hold the current participant turn');
  return {runId: s.protocol.runId, participantId: att.participantId, attemptId: att.id, turnId: att.turnId, generation: att.generation};
}
export function participantCommand(s, att, command, now) {
  const auth = assertTurnAuthority(s, att, now);
  if (!obj(command) || !PARTICIPANT_COMMANDS.has(command.type) || Object.hasOwn(command, 'auth') || Object.hasOwn(command, 'lease') || Object.hasOwn(command, 'role')) fail('participant_command_forbidden', 'Participant commands cannot select authority or administrative commands', 403);
  if (s.protocol.messages.length >= s.limits.maxMessages && command.type === 'send_message') fail('messages_exhausted', 'Message budget exhausted');
  if (command.type === 'declare_consumer' && command.participantId !== undefined && command.participantId !== att.participantId) fail('participant_command_forbidden', 'A participant declares only its own consumption', 403);
  if(['request_transfer','consent_transfer'].includes(command.type)){assertSafePath(command.path);s.transfers ??=[];s.transfers.push({participantId:att.participantId,attemptId:att.id,generation:att.generation,command:structuredClone(command),status:'pending',at:now});return {queued:true};}
  const protocol = protocolFor(s);
  try {
    const result = protocol.dispatch({...command, auth});
    s.protocol = protocol.getState();
    return result;
  } catch (e) {
    // The protocol records stale ack evidence intentionally; keep the audit
    // while never counting it as agreement. Other rejected changes are dropped.
    if (e.code === 'stale_revision') s.protocol = protocol.getState();
    throw e;
  }
}
export function applyFrameToState(s, att, frame, now) {
  assertTurnAuthority(s, att, now);
  const p = participant(s, att.participantId);
  if (typeof frame.goal !== 'string' || !frame.goal.trim() || !['continue','done','question'].includes(frame.outcome)) fail('swarm_result_invalid', 'Turn requires one goal and a valid outcome', 422);
  if (s.phase==='coordinate' && frame.outcome!=='question' && (!obj(frame.declaration)||!Array.isArray(frame.declaration.files)||!['contracts','approach','risks'].every(k=>typeof frame.declaration[k]==='string'))) fail('declaration_invalid','Coordination requires files, contracts, approach and risks',422);
  p.declaration = s.phase === 'coordinate' && frame.declaration ? {goal: frame.goal, ...frame.declaration, summary: frame.summary ?? '', at: now} : p.declaration;
  p.cursor.lastSeenSeq = att.messageCursor ?? p.cursor.lastSeenSeq;
  p.ready = frame.outcome === 'done' && WRITE_PHASES.has(s.phase);
  p.waiting = frame.outcome === 'question' ? {reason: 'question', detail: String(frame.question ?? '').slice(0, 4000)} : null;
  if (frame.outcome === 'question' && !p.waiting.detail) fail('swarm_result_invalid', 'Question outcome requires question text', 422);
  p.status = p.ready ? 'done' : p.waiting ? 'waiting' : 'active';
  const protocol = protocolFor(s);
  protocol.dispatch({type: 'end_turn', auth: {participantId: att.participantId, attemptId: att.id, turnId: att.turnId, generation: att.generation}, outcome: frame.outcome});
  s.protocol = protocol.getState();
  s.history.push({type: 'turn_end', participantId: p.participantId, attemptId: att.id, outcome: frame.outcome, at: now});
}
const agreed = s => Object.values(s.protocol.decisions).every(d => ['agreed','superseded'].includes(d.status));
export function syncSwarmDerived(run) {
  const s = run.swarm;
  s.ownership = Object.values(s.protocol.files).map(f => ({path: f.path, owner: f.owner, reservedBy: f.reservedBy, version: f.version, since: f.claimedAt ?? f.reservedAt, contested: !!f.pendingTransfer}));
  s.decisions = Object.values(s.protocol.decisions).map(d => ({id: d.id, kind: d.scope?.kind === 'global' ? 'interface' : 'apply', proposer: d.openedBy ?? 'user', paths: d.scopePaths ?? [], status: d.status === 'agreed' ? 'approved' : d.status, rationale: d.revisions.at(-1).text, rev: d.revisions.at(-1).rev, revHash: d.revisions.at(-1).revHash, affected: d.affected}));
  s.messages = s.protocol.messages.map(m => ({...m, text: m.body}));
  s.pendingActions = (s.pendingActions ?? []).filter(a => a.reason==='catch_up_exhausted');
  for (const p of s.participants) {
    p.attempt = (run.attempts ?? []).filter(a => a.participantId === p.participantId && LIVE.has(a.status)).at(-1) ?? null;
    if (p.waiting?.reason === 'question') s.pendingActions.push({type: 'question', participantId: p.participantId, question: p.waiting.detail});
    if(!p.attempt && s.phase==='coordinate' && !p.waiting && p.coordinationUsed>=s.limits.maxRounds) s.pendingActions.push({type:'extend',participantId:p.participantId,reason:'coordination_exhausted'});
    if (!p.attempt && !p.ready && !p.waiting && p.budget.turnsUsed >= p.budget.turnsLimit) {p.status = 'exhausted'; s.pendingActions.push({type: 'extend', participantId: p.participantId, reason: 'turns_exhausted'});}
  }
  for (const d of s.decisions.filter(d => d.status === 'pending')) s.pendingActions.push({type: 'decision', decisionId: d.id});
  s.limits.turnsUsed = s.participants.reduce((n,p) => n+p.budget.turnsUsed, 0);
  s.limits.turnsLimit = s.participants.reduce((n,p) => n+p.budget.turnsLimit, 0);
  s.limits.messagesUsed = s.messages.length; s.limits.round = s.round;
  return s;
}
export async function buildSwarmRun(D, ctx, aggregate, payload, now) {
  const spec = validateSwarmSpec(payload.swarm);
  const approved = await D.requireApprovedInputs(ctx, aggregate, 'start');
  const inputs = D.runInputsSnapshot(aggregate, approved.reqA, approved.planA);
  const baseRef = payload.baseRef?.trim() || 'HEAD';
  const baseCommit = await D.resolveBaseCommit(aggregate.projectPath, baseRef);
  const composition = structuredClone(aggregate.composition);
  if (!composition?.preset?.members?.reviewer || !composition?.preset?.members?.checker) fail('composition_missing', 'Swarm requires the Core reviewer/checker composition', 422);
  const compat = await ctx.compat();
  for (const role of ['reviewer','checker']) composition.preset.members[role] = D.validateMember(role, composition.preset.members[role], compat);
  const run = {id: `run_${randomUUID()}`, mode: 'swarm', status: 'queued', phase: 'coordinate', createdAt: now,
    inputs, composition, reviewRules: D.snapshotReviewRules(await ctx.getDoc('roles.json'), composition.preset.limits ?? {}),
    baseRef, baseCommit, workspaceId: payload.freshWorkspace ? null : D.retainableWorkspaceId?.(aggregate) ?? null, attempts: [], events: [], eventsCursor: 0, result: null};
  run.swarm = createSwarmState(run.id, spec, {projectRoot: D.projectKeyFor(aggregate.projectPath), snapshotSha: baseCommit, sourcePath: aggregate.projectPath}, now);
  return run;
}
export async function buildSwarmContinuation(D, ctx, aggregate, payload, prev, now) {
  const run = await buildSwarmRun(D, ctx, aggregate, {...payload, swarm: payload.swarm ?? {participants: prev.swarm.participants, limits: prev.swarm.limits}}, now);
  // Ownership/decisions cannot be transplanted onto a different tree/input.
  if (run.baseCommit === prev.baseCommit && canonicalJson(run.inputs) === canonicalJson(prev.inputs) && canonicalJson(run.swarm.participants.map(p=>p.profileDigest)) === canonicalJson(prev.swarm.participants.map(p=>p.profileDigest))) {
    run.swarm.protocol.files = structuredClone(prev.swarm.protocol.files);
    run.swarm.protocol.messages = structuredClone(prev.swarm.protocol.messages);
    run.swarm.protocol.decisions = structuredClone(prev.swarm.protocol.decisions);
    run.swarm.canonicalId=prev.swarm.canonicalId;run.swarm.epoch=prev.swarm.epoch;
    for(const p of run.swarm.participants){const old=prev.swarm.participants.find(x=>x.participantId===p.participantId);p.cursor=structuredClone(old.cursor);p.declaration=structuredClone(old.declaration);}
    run.swarm.history.push({type: 'continued', fromRunId: prev.id, at: now});
  }
  return run;
}
function runFor(D, aggregate, payload) {
  const run = D.runOf(aggregate, D.reqStr(payload.runId, 'runId'));
  if (!run || run.mode !== 'swarm') throw new D.CommandError(404, 'run_not_found', 'Swarm run not found');
  return run;
}
function owned(D, run, payload) {if (!run.swarm.owner || !D.ownsResource(run.swarm.owner, payload)) throw new D.CommandError(409, 'not_swarm_owner', 'Swarm belongs to another runner');}
function liveRun(run) {if (!['queued','active','blocked'].includes(run.status) || run.stopIntent) fail('run_not_launchable', 'Swarm has stopped or is terminal');}
function save(D, ctx, aggregate, run, result = {}) {syncSwarmDerived(run); D.stageRun(aggregate, run, ctx); return {aggregate, result: {runId: run.id, swarm: run.swarm, ...result}};}
export async function cmdSwarmClaim(D, ctx, aggregate, payload, now) {
  const run = runFor(D, aggregate, payload), s = run.swarm;
  if (!s.owner || D.ownsResource(s.owner, payload)) s.owner = D.newOwner(payload, now, D.clampLeaseMs(payload.leaseMs));
  else {
    if (payload.adopt !== true) fail('not_swarm_owner', 'Adoption requires positive owner-death proof');
    D.checkAdoptionProof(s, payload, ctx.loadEnvironments ? await ctx.loadEnvironments() : null);
    s.owner = D.newOwner(payload, now, D.clampLeaseMs(payload.leaseMs));
  }
  return save(D, ctx, aggregate, run, {claimed: true});
}
export async function cmdSwarmTurnBegin(D, ctx, aggregate, payload, now) {
  const run = runFor(D, aggregate, payload); owned(D, run, payload); liveRun(run);
  const s = run.swarm, p = participant(s, payload.participantId);
  if (!['coordinate','implement','catch_up'].includes(s.phase) || s.freeze?.active || s.broker.blocked.length || s.broker.recovered !== true) fail('swarm_frozen', 'Recovery and phase barrier must clear before any launch');
  if (p.ready || p.waiting || p.budget.turnsUsed >= p.budget.turnsLimit) fail('participant_not_ready', 'Participant waits, is done or exhausted');
  if (s.phase === 'coordinate' && p.coordinationUsed >= s.limits.maxRounds) fail('coordination_exhausted', 'Coordination needs an explicit user decision');
  if ((run.attempts ?? []).some(a => a.participantId === p.participantId && LIVE.has(a.status))) fail('attempt_active', 'Old participant attempt must settle first');
  if (['active','unproven'].includes(run.validation?.status)||(run.attempts??[]).some(a=>a.role!==SWARM_ROLE&&LIVE.has(a.status)))fail('validation_active','Core readers must settle before participant turns');
  if (s.phase === 'catch_up' && !s.fixParticipants?.includes(p.participantId)) fail('participant_not_assigned', 'Only finding owners may fix');
  const attemptId = safeId(payload.attemptId, 'attemptId');
  for (const entry of await ctx.listAggregates()) for (const r of (entry.aggregate ?? entry).runs ?? []) if ((r.attempts ?? []).some(a => a.id === attemptId)) fail('attempt_exists', 'Attempt identifier is already used');
  const limits = await ctx.loadSchedulerLimits(); let activeRuns = 0, activeRole = 0;
  for (const entry of await ctx.listAggregates()) for (const r of (entry.aggregate ?? entry).runs ?? []) {
    const live = (r.attempts ?? []).filter(a => LIVE.has(a.status));
    if (r.id !== run.id && (live.length || ['active','unproven'].includes(r.validation?.status))) activeRuns++;
    activeRole += live.filter(a => a.role === SWARM_ROLE).length;
  }
  if (activeRuns >= limits.global || activeRole >= (limits.roles?.[SWARM_ROLE] ?? 3)) fail('limit_reached', 'Global or participant concurrency limit reached');
  const launch = payload.launch;
  if (!obj(launch) || launch.profileDigest !== p.profileDigest || launch.profileId !== p.profileId || !/^[0-9a-f]{64}$/.test(launch.promptSha256 ?? '') || launch.snapshotEpoch !== s.epoch) fail('launch_invalid', 'Launch must bind full profile, prompt and current snapshot', 422);
  const protocol = protocolFor(s), turnId = `turn-${attemptId}`;
  const {lease} = protocol.dispatch({type: 'start_turn', participantId: p.participantId, attemptId, turnId, phase: s.phase});
  s.protocol = protocol.getState(); p.budget.turnsUsed++; if (s.phase === 'coordinate') p.coordinationUsed++;
  const att = {id: attemptId, role: SWARM_ROLE, participantId: p.participantId, turnId, generation: lease.generation,
    phase: s.phase, status: 'launching', createdAt: now, startedAt: now, deadlineAt: now+s.limits.timeoutMin*60_000,
    owner: D.newOwner(payload, now, D.clampLeaseMs(payload.leaseMs)), launch: structuredClone(launch), messageCursor: s.protocol.messages.length,
    commandCursor: 0, frameApplied: false};
  att.runId=run.id;att.kind='turn';att.n=p.budget.turnsUsed;s.protocol.participants[p.participantId].activeTurn.expiresAt=att.deadlineAt;
  run.attempts.push(att); run.status = 'active'; p.status = 'active';
  run.events.push({seq:run.events.length+1,at:now,type:'swarm_turn_started',data:{participantId:p.participantId,attemptId,generation:lease.generation}});ctx.appendRunEvent?.(run.id,run.events);
  return save(D, ctx, aggregate, run, {attemptId, lease});
}
export async function cmdSwarmProtocol(D, ctx, aggregate, payload, now) {
  const run = runFor(D, aggregate, payload); owned(D, run, payload); liveRun(run);
  const att = D.findAttempt(run, payload.attemptId), id = safeId(payload.commandId, 'participant commandId');
  const hash = sha256(canonicalJson({attemptId: att?.id, command: payload.command}));
  const old = run.swarm.frameReceipts[id];
  if (old) {if (old.hash !== hash) fail('duplicate_differs', 'Participant command ID changed'); return save(D, ctx, aggregate, run, {receipt: old, idempotent: true});}
  const result = participantCommand(run.swarm, att, payload.command, now);
  run.swarm.frameReceipts[id] = {hash, result, at: now};
  return save(D, ctx, aggregate, run, {receipt: run.swarm.frameReceipts[id]});
}
export async function cmdSwarmApplyIntent(D, ctx, aggregate, payload, now) {
  const run = runFor(D, aggregate, payload); owned(D, run, payload); liveRun(run);
  const s = run.swarm, id = safeId(payload.editId, 'editId'), hash = sha256(canonicalJson({attemptId: payload.attemptId, ops: payload.ops}));
  const old = s.edits[id]; if (old) {if (old.hash !== hash) fail('duplicate_differs', 'Edit ID changed'); return save(D, ctx, aggregate, run, {edit: old, idempotent: true});}
  const att = D.findAttempt(run, payload.attemptId), lease = assertTurnAuthority(s, att, now);
  if (!WRITE_PHASES.has(s.phase) || s.freeze?.active) fail('edits_forbidden', 'Edits require implementation phase and agreed decisions');
  if (s.phase === 'catch_up' && !s.fixParticipants.includes(att.participantId)) fail('participant_not_assigned', 'Only assigned finding owners may edit');
  if (!Array.isArray(payload.ops) || !payload.ops.length || payload.ops.length > 64) fail('edit_invalid', 'Edit needs 1..64 operations', 422);
  const ownership = {};
  for (const op of payload.ops) {
    if (!obj(op) || !['write','create','delete','rename','chmod'].includes(op.kind)) fail('edit_invalid','Unsupported operation',422);
    if (!obj(op.expected) || (op.kind === 'create' ? op.expected.absent !== true : !/^[0-9a-f]{64}$/.test(op.expected.hash ?? '') || op.expected.type !== 'file' || ![0o100644,0o100755].includes(op.expected.mode))) fail('edit_invalid', 'Every edit needs exact hash/type/mode or explicit create absent', 422);
    for (const raw of [op.path,...(op.kind === 'rename' ? [op.to] : [])]) {
      const path = assertSafePath(raw); if (path !== raw) fail('edit_invalid', 'Paths must be normalized', 422);
      const f = s.protocol.files[path];
      if (!f || f.owner !== att.participantId && !((op.kind === 'create' || raw === op.to) && !f.owner && f.reservedBy === att.participantId)) fail('not_owner', `No current ownership/reservation for ${path}`, 403);
      ownership[path] = {owner: f.owner, reservedBy: f.reservedBy ?? null, version: f.version};
    }
  }
  if (!decisionsAgreedFor(s, Object.keys(ownership))) fail('decisions_pending','Applicable decisions must be agreed');
  s.edits[id] = {id, hash, attemptId: att.id, status: 'pending', at: now, command: {commandId: `${run.id}-${id}`, lease, phase: s.phase, ops: structuredClone(payload.ops), ownership, ownerId: att.participantId}};
  return save(D, ctx, aggregate, run, {edit: s.edits[id]});
}
export async function cmdSwarmApplyResult(D, ctx, aggregate, payload, now) {
  const run = runFor(D, aggregate, payload); owned(D, run, payload);
  const s = run.swarm, edit = s.edits[payload.editId];
  if (!edit) fail('edit_not_found', 'No durable edit intent');
  if (edit.status !== 'pending') return save(D, ctx, aggregate, run, {edit, idempotent: true});
  if (payload.result?.status === 'applied' && payload.result.commandId === edit.command.commandId) {
    edit.status = 'applied'; edit.result = structuredClone(payload.result); s.epoch++;
    for (const p of s.participants) p.ready = s.phase==='catch_up'&&!s.fixParticipants.includes(p.participantId);
    for (const op of edit.command.ops) {
      if (op.kind==='delete'){const f=s.protocol.files[op.path];f.owner=null;f.reservedBy=null;f.version++;}
      if (op.kind === 'create') {const f=s.protocol.files[op.path];f.owner=edit.command.lease.participantId;f.reservedBy=null;f.version++;}
      if (op.kind === 'rename') {const f=s.protocol.files[op.to];f.owner=edit.command.lease.participantId;f.reservedBy=null;f.version++;const source=s.protocol.files[op.path];s.protocol.files[op.path]={...source,owner:null,reservedBy:null,version:source.version+1};}
    }
    const rebound=refreshSwarmDecisionBindings(s.protocol,now);s.protocol=rebound.state;
    for(const event of rebound.events)run.events.push({...event,seq:run.events.length+1});ctx.appendRunEvent?.(run.id,run.events);
    run.acceptance = null; s.history.push({type: 'edit_applied', editId: edit.id, epoch: s.epoch, at: now});
  } else if (payload.error?.code) {edit.status = 'rejected'; edit.error = {code: payload.error.code, message: String(payload.error.message ?? '').slice(0,1000)};}
  else fail('edit_result_invalid', 'Broker result must bind the durable command', 422);
  return save(D, ctx, aggregate, run, {edit});
}
export async function cmdSwarmTurnResult(D, ctx, aggregate, payload, now) {
  const run = runFor(D, aggregate, payload); owned(D, run, payload); liveRun(run);
  const att = D.findAttempt(run, payload.attemptId);
  if (att?.frameApplied) return save(D, ctx, aggregate, run, {idempotent:true});
  assertTurnAuthority(run.swarm, att, now);
  const art = run.artifacts?.[payload.artifactId];
  if (!art || art.kind!=='swarm-result' || art.attemptId !== att.id) fail('artifact_unbound', 'Turn result needs its committed attempt artifact', 422);
  const stored = await ctx.readArtifactText(run.id, art.stored ?? art.file);
  if (sha256(stored.text ?? stored.content) !== art.sha256 || Buffer.byteLength(stored.text ?? stored.content)!==art.bytes) fail('artifact_corrupt', 'Result bytes do not match their artifact', 422);
  const parsed = parseSwarmResult(stored.text ?? stored.content);
  if (!parsed.ok) fail('swarm_result_invalid', parsed.error, 422);
  for (const [i,command] of parsed.result.commands.entries()) {
    const id = `frame-${att.id}-${i}`;
    const applied = command.type==='apply' ? run.swarm.edits[id] : run.swarm.frameReceipts[id];
    const hash = sha256(canonicalJson(command.type==='apply' ? {attemptId:att.id,ops:command.ops} : {attemptId:att.id,command}));
    if (!applied || applied.hash!==hash || applied.status==='pending') fail('command_unprocessed','Every framed command must have its durable matching receipt');
  }
  if ((run.swarm.edits && Object.values(run.swarm.edits).some(e=>e.attemptId===att.id && e.status==='pending'))) fail('edit_pending','Turn must retain authority until its accepted edits settle');
  applyFrameToState(run.swarm,att,parsed.result,now); att.frameApplied=true; att.resultArtifactId=payload.artifactId;
  return save(D,ctx,aggregate,run,{frameApplied:true});
}
export function onSwarmAttemptResolved(D, run, att, outcome, payload, now) {
  if (att.role !== SWARM_ROLE) return;
  const s=run.swarm,p=participant(s,att.participantId),lease=s.protocol.participants[p.participantId].activeTurn;
  if (lease?.attemptId===att.id) {const protocol=protocolFor(s);protocol.dispatch({type:'end_turn',auth:{participantId:p.participantId,attemptId:att.id,turnId:att.turnId,generation:att.generation},outcome});s.protocol=protocol.getState();}
  if(run.status==='stopping'||run.stopIntent){p.ready=false;p.status='stopped';p.waiting=null;}
  else if (!att.frameApplied) {p.ready=false;p.status='waiting';p.waiting={reason:'question',detail:`Turn ${outcome}; retry or clarify the participant's local goal.`};}
  flushTransfers(s,now);
  syncSwarmDerived(run);
}
function flushTransfers(s,now){for(const t of s.transfers??[]){if(t.status!=='pending')continue;const f=s.protocol.files[t.command.path];const parties=t.command.type==='request_transfer'?[t.participantId,t.command.to]:[f?.owner,f?.pendingTransfer?.to];if(parties.some(id=>s.protocol.participants[id]?.activeTurn))continue;const protocol=protocolFor(s);try{protocol.dispatch({...t.command,auth:{participantId:t.participantId}});s.protocol=protocol.getState();t.status='applied';for(const p of s.participants)p.ready=false;}catch(e){t.status='rejected';t.error={code:e.code,message:e.message};}s.history.push({type:'ownership_transfer',status:t.status,path:t.command.path,at:now});}}
export async function cmdSwarmFreeze(D,ctx,aggregate,payload,now) {
  const run=runFor(D,aggregate,payload);owned(D,run,payload);
  const s=run.swarm;
  if (payload.recovery) {s.broker={recovered:!payload.recovery.blocked?.length,blocked:structuredClone(payload.recovery.blocked ?? [])};}
  if (payload.active !== undefined) {
    if (payload.physicalConfirmed!==true && !(payload.intent===true&&payload.reason==='snapshot_admission')) fail('freeze_unproven','Physical reader barrier confirmation required');
    s.freeze=payload.active?{active:true,operationId:payload.operationId??null,physicalConfirmed:payload.physicalConfirmed===true,reason:payload.reason ?? 'apply',since:now,identities:structuredClone(payload.identities ?? [])}:null;
  }
  return save(D,ctx,aggregate,run);
}
export async function cmdSwarmPhase(D,ctx,aggregate,payload,now) {
  const run=runFor(D,aggregate,payload);owned(D,run,payload);liveRun(run);const s=run.swarm;
  if ((run.attempts ?? []).some(a=>LIVE.has(a.status)) || Object.values(s.edits).some(e=>e.status==='pending') || (s.transfers??[]).some(t=>t.status==='pending')) fail('reservation_live','Participant attempts/edits must settle before phase transition');
  if (payload.phase==='implement') {
    if (s.phase!=='coordinate' || !s.participants.every(p=>p.declaration) || !agreed(s) || !Object.values(s.protocol.decisions).some(d=>d.scope?.kind==='global' && d.status==='agreed')) fail('coordination_pending','Explicit global allocation agreement and every declaration required');
    s.phase='implement';run.phase='implement';for(const p of s.participants){p.ready=false;p.waiting=null;p.status='active';}
  } else if (payload.phase==='awaiting_validation') {
    if (!WRITE_PHASES.has(s.phase) || !s.participants.every(p=>p.ready || s.phase==='catch_up'&&!s.fixParticipants.includes(p.participantId)) || !agreed(s) || s.freeze?.active!==true || s.freeze.physicalConfirmed!==true || s.materialized?.epoch!==s.epoch) fail('convergence_pending','All owners and decisions must converge under a physical barrier');
    s.phase='verify';run.phase='awaiting_validation';run.fixContext=null;s.verifiedEpoch=s.epoch;
  } else if (payload.phase==='catch_up') {
    if (!run.fixContext || ['active','unproven'].includes(run.validation?.status)) fail('fix_unready','Core must settle validation before owner fixes');
    const round=run.fixContext.round;
    if (s.fixRound===round) return save(D,ctx,aggregate,run,{idempotent:true});
    if ((s.catchUpUsed ?? 0)>=s.limits.maxCatchUpRounds) {run.status='blocked';s.pendingActions.push({type:'extend',participantId:null,reason:'catch_up_exhausted'});return save(D,ctx,aggregate,run);}
    s.catchUpUsed=(s.catchUpUsed ?? 0)+1;s.fixRound=round;s.phase='catch_up';run.phase='catch_up';s.round++;
    const findings=run.fixContext.openFindings ?? [];
    const assigned=new Set();for(const f of findings){const paths=f.paths ?? (typeof f.where==='string'?[f.where.split(':')[0]]:[]);for(const path of paths){const owner=s.protocol.files[path]?.owner;if(owner)assigned.add(owner);}}
    if (!assigned.size) for(const p of s.participants)assigned.add(p.participantId);
    s.fixParticipants=[...assigned];s.findings=structuredClone(findings);
    for(const p of s.participants){p.ready=!assigned.has(p.participantId);p.waiting=null;p.status=p.ready?'done':'active';}
  } else if (payload.phase==='blocked') {run.status='blocked';s.history.push({type:'blocked',reason:String(payload.reason ?? ''),at:now});}
  else fail('phase_invalid','Unsupported Swarm phase transition',422);
  return save(D,ctx,aggregate,run);
}
export async function cmdSwarmInput(D,ctx,aggregate,payload,now) {
  const run=runFor(D,aggregate,payload),s=run.swarm;liveRun(run);
  const recipients=payload.participantId==='all'?s.participants:[participant(s,payload.participantId)];
  const text=D.reqStr(payload.text,'text');if(text.length>4000)fail('input_invalid','Input exceeds 4000 characters',422);
  for(const p of recipients){p.waiting=null;p.ready=false;if(p.status==='waiting')p.status='active';s.protocol.messages.push({id:randomUUID(),seq:s.protocol.messages.length+1,from:'user',to:p.participantId,kind:'answer',body:text,at:now});}
  if(run.status==='blocked')run.status='active';return save(D,ctx,aggregate,run);
}
export async function cmdSwarmExtend(D,ctx,aggregate,payload,now) {
  const run=runFor(D,aggregate,payload),s=run.swarm;liveRun(run);const turns=integer(payload.turns,undefined,1,12,'extension');
  for(const p of payload.participantId?[participant(s,payload.participantId)]:s.participants){p.budget.turnsLimit+=turns;p.coordinationUsed=0;p.status='active';p.waiting=null;}
  s.catchUpUsed=0;s.history.push({type:'extended',participantId:payload.participantId ?? null,turns,at:now});if(run.status==='blocked')run.status='active';return save(D,ctx,aggregate,run);
}
export async function cmdSwarmDecide(D,ctx,aggregate,payload,now) {
  const run=runFor(D,aggregate,payload),s=run.swarm;liveRun(run);const d=s.protocol.decisions[payload.decisionId];
  if(!d||d.status!=='pending')fail('decision_not_pending','No current pending decision');
  if(!['approve','reject'].includes(payload.outcome))fail('decision_invalid','Outcome must approve or reject',422);
  // User resolution never edits requirements or automatically approves them.
  if(d.scope?.touchesDocuments)fail('inputs_change_requires_approval','Change the documents and approve exact versions before new work');
  d.status=payload.outcome==='approve'?'agreed':'rejected';d.agreedRev=payload.outcome==='approve'?d.revisions.at(-1).rev:null;d.userResolution={outcome:payload.outcome,note:String(payload.note ?? '').slice(0,2000),at:now};
  for(const p of s.participants)if(p.waiting?.reason==='decision')p.waiting=null;
  if(run.status==='blocked')run.status='active';return save(D,ctx,aggregate,run);
}

export function decisionsAgreedFor(s, paths) {
  return Object.values(s.protocol.decisions).every(d => ['agreed','superseded'].includes(d.status) || d.scope?.kind!=='global' && !(d.scopePaths ?? d.scope?.paths ?? []).some(path=>paths.includes(path)));
}
export const cmdSwarmParticipantBegin = cmdSwarmTurnBegin;
export function checkSwarmResult(D,run,att,payload) {
  if(payload.outcome!=='completed')return null;
  const d=payload.proposal,a=run.artifacts?.[d?.artifactId];
  if(!d||!a||a.attemptId!==att.id||a.kind!=='swarm-result'||a.sha256!==d.sha256||a.bytes!==d.bytes||!att.frameApplied||att.resultArtifactId!==d.artifactId)throw new D.CommandError(422,'swarm_result_invalid','Committed and processed exact attempt result required');
  return d;
}
export function onSwarmParticipantResolved(D,aggregate,run,att,outcome,resultDesc,now,ctx) {onSwarmAttemptResolved(D,run,att,outcome,resultDesc,now);}
export function swarmOnStop(D,ctx,run,now) {
  // Keep live attempts/leases until terminal observation; clearing a lease here
  // would erase the physical cancellation obligation. No launch after intent.
  run.swarm.stoppedAt=now;run.swarm.phase='stopping';
  for(const p of run.swarm.participants)if(!p.attempt)p.status='stopped';
}
export async function cmdSwarmMaterialized(D,ctx,aggregate,payload,now) {
 const run=runFor(D,aggregate,payload);owned(D,run,payload);liveRun(run);
 if(run.swarm.freeze?.active!==true||run.swarm.freeze.physicalConfirmed!==true||payload.epoch!==run.swarm.epoch||!/^[a-f0-9]{40,64}$/.test(payload.commitSha??'')||!/^[a-f0-9]{40,64}$/.test(payload.treeSha??''))fail('materialization_invalid','Exact frozen current epoch import required');
 run.swarm.materialized={epoch:payload.epoch,commitSha:payload.commitSha,treeSha:payload.treeSha,canonicalId:payload.canonicalId,at:now};return save(D,ctx,aggregate,run);
}

export async function cmdSwarmCursor(D,ctx,aggregate,payload,now){const run=runFor(D,aggregate,payload);owned(D,run,payload);liveRun(run);const att=D.findAttempt(run,payload.attemptId);assertTurnAuthority(run.swarm,att,now);if(!Number.isSafeInteger(payload.cursor)||payload.cursor<(att.commandCursor??0))fail('cursor_invalid','Cursor must advance monotonically',422);att.commandCursor=payload.cursor;return save(D,ctx,aggregate,run);}

export async function cmdSwarmObserved(D,ctx,aggregate,payload,now){const run=runFor(D,aggregate,payload);owned(D,run,payload);const att=D.findAttempt(run,payload.attemptId);if(!att||!['failed','cancelled'].includes(payload.outcome))fail('observation_invalid','Terminal failed/cancelled observation required',422);att.observedTerminal={outcome:payload.outcome,reason:String(payload.reason??''),at:now};return save(D,ctx,aggregate,run);}
export async function cmdSwarmWorkerSettled(D,ctx,aggregate,payload,now){const run=runFor(D,aggregate,payload);owned(D,run,payload);const att=D.findAttempt(run,payload.attemptId);if(!att||!['stopped','gone'].includes(payload.state)||payload.workerId!==(att.launch?.workerId??`w-${att.id}`))fail('namespace_unproven','Exact stopped/gone worker proof required',422);att.namespace={state:payload.state,workerId:payload.workerId,settledAt:now};return save(D,ctx,aggregate,run);}
