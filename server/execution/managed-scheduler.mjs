// server/execution/managed-scheduler.mjs — U4 managed run orchestration.
//
// The scheduler turns durable `queued` runs into durable attempts and porch
// launches, then OBSERVES and STOPS them. It never awaits agent completion:
// every tick either advances a run (workspace -> attempt -> runtime.start ->
// bind), resumes an existing attempt (adopt/observe/reconcile/cancel), or —
// during a state-API outage — keeps managing already-owned local supervisors
// from a durable journal. Every state mutation goes through the
// authenticated internal command channel; the state queue is the only
// authority for slots, ownership, and transitions.
//
// Ownership model: `runnerId` is the configured DISPLAY id (compose sets a
// fixed RUNNER_ID — two Node processes may share it); `instanceId` is the
// unique per-process-start identity. Every owned update carries both plus
// pid/starttime/envKey + envInstance. A foreign owner is adopted only with
// structured proof the domain can validate:
//   process_dead        — same envKey as the recorded owner + the recorded
//                         owner pid proves absent/zombie/recycled in the
//                         original pid namespace;
//   environment_lost    — owner's bootId differs from ours (whole env gone);
//   environment_retired — a durable ops-verified retirement record exists for
//                         the owner's exact envInstance+registration
//                         generation. A caller's own registration is NEVER
//                         evidence: two live containers may register one slot.
// Adoption NEVER terminalizes an attempt or frees its slot: the adopter
// inherits the duty to reconcile the exact attempt, bind a live detached
// supervisor, or retry only with positive launcher-termination evidence.
//
// Stop model: `stop` writes a durable intent + per-attempt cancel markers.
// 'cancelling' is a LIVE state — workspace+slot stay reserved until a
// positive terminal observation. Cancellation is BY RUN ID ONLY: a pid is
// never signaled, and a cancel request/lease expiry/timeout is never proof
// of death. The launch race is fenced: begin_attempt is accepted atomically,
// the run is re-read immediately before runtime.start, and an in-flight
// start is tracked per-attempt so a stop can never leave an unobserved
// supervisor behind.
//
// Launch crash/retry matrix (after runtime.start, per attempt):
//   launched                     -> bind_attempt(porchRunId)
//   reconcile: 1 match           -> bind (or cancel-bind under stop intent)
//   reconcile: >=2 matches       -> block (ambiguous — never pick one)
//   reconcile: unreadable/err    -> block (scan incomplete != zero matches)
//   reconcile: 0 matches         -> retry ONLY with positive launcher
//                                   termination: durable pre-spawn rejection
//                                   (record spawned===false), observed porch
//                                   exit diagnostics, /proc proof (ENOENT |
//                                   zombie | recycled starttime, verified in
//                                   the original namespace), or the
//                                   never-entered proof (this instance holds
//                                   no in-flight start AND the attempt dir
//                                   is absent AND the launch owner is proven
//                                   dead or is this very instance).
//                                   Live launcher -> stay `launching`.
//                                   Missing/corrupt record, foreign
//                                   namespace, EACCES -> block (unknown).
//
// Outage model: a transport/5xx failure on the state API stops ALL new
// launches immediately, keeps observing owned supervisors locally, and at
// the RECORDED lease expiry requests cancellation of own run ids only —
// intents are journaled, never resolved without observed terminal state.
// On recovery the journal replays through the authoritative commands with
// fresh CAS/owner checks; permanent failures dead-letter, never drop.

import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { RuntimeError, SAFE_ID_RE, atomicWriteFile, atomicWriteJson, ensureDir } from './common.mjs';
import {
  workspaceRoot, workspaceBranch, workspacePath, projectKeyFor,
  validateWorkspaceRoot, ensureWorkspaceRootAccess, assertInsideRoot,
  sourceGitRoot, sourceDirtyPaths, createWorkspace, verifyWorkspace,
  gitCommonDir, WS_ID_RE,
} from './workspaces.mjs';
import { sha256, writeStagedArtifact } from './execution-store.mjs';
import { createPanelDriver } from './fusion/controller.mjs';
import { createHandoffDriver } from './fusion/handoff.mjs';
import { createOrchDriver } from './orchestrator/controller.mjs';
import { createWorkerReaper } from './fusion/reaper.mjs';
import {
  profileIdFor, porchConfigSnapshot, configSha256, buildImplementerPrompt,
  buildFixPrompt, buildReviewerPrompt, buildCheckerPrompt,
  FINDINGS_FILE, VERDICTS_FILE,
} from './prompt.mjs';
import {
  computeResultManifest, materializeResultCopy, runCheckCommand,
  killOwnedGroup, procIdentityLocal, procGroupMembers, verifyResultCopy,
  assertValidationDirs,
} from './result-snapshot.mjs';
import { envKeyEqual, envLostProof, envInstanceEqual, ATTEMPT_TERMINAL } from './execution-domain.mjs';

const RUN_LIVE = new Set(['queued', 'active', 'stopping', 'awaiting_acceptance']);
const ATTEMPT_LIVE = new Set(['launching', 'running', 'cancelling']);
// Attempt roles that live inside the F1 constrained container runtime —
// the solo process-runtime supervision must never touch them (their
// porchRunIds are only meaningful inside the container workers).
const FUSION_ATTEMPT_ROLES = new Set(['panelist', 'judge', 'integrator']);
// Validation statuses that still hold the run's global reservation unit:
// 'unproven' is nonterminal — a later positive group-death proof drains it.
const VAL_LIVE = new Set(['active', 'unproven']);
// A run needs a drive pass while it is live OR still holds live resources.
// The card summary carries `reserved` (terminal run with a live attempt or
// active/unproven validation) computed from the aggregate — status alone
// never proves the owned groups dead, so dispatch reaches those runs for
// supervision/drain (never new issuance).
function runNeedsDrive(rs) {
  if (!rs || typeof rs !== 'object') return false;
  if (RUN_LIVE.has(rs.status)) return true;
  if (rs.reserved === true) return true;
  // Full run records (tests/other callers) — check the records directly.
  if (VAL_LIVE.has(rs.validation?.status)) return true;
  return (rs.attempts || []).some((a) => a && ATTEMPT_LIVE.has(a.status));
}
const MAX_LAUNCH_RETRIES_PER_TICK = 4;
const DEFAULT_STUCK_MS = 150_000;        // AGENTS: >2–3min of true zero progress
const OBSERVE_MAX_EVENTS = 100;
const JOURNAL_MAX_REPLAY_ATTEMPTS = 8;

function isErr(e, code) {
  return e && (e.code === code || e.details?.code === code);
}

// Transport-class failure vs. domain rejection: an HTTP error always carries
// .status from the internal client (>=500 = outage, <500 = authoritative
// refusal); a bare throw with no status (fetch/socket) is also an outage.
function isOutageError(e) {
  if (!e) return false;
  if (typeof e.status === 'number') return e.status >= 500;
  return !e.code || e instanceof TypeError;
}

export function createManagedScheduler({
  client,                // {listCards, getCard, getRun, getRunEvents, getDocument, command(cardId, body), registerEnvironment?, getEnvironments?}
  runtime,
  runnerId = 'host-runner',
  instanceId = crypto.randomUUID(),
  leaseMs = 120_000,
  validationEnabled = null,   // U5 gate — default OFF (env flag or explicit)
  stateDir = null,        // artifact store root (shared mount); null disables artifact writes
  env = process.env,
  now = () => Date.now(),
  stuckMs = DEFAULT_STUCK_MS,
  hooks = {},
  fusion = null,           // F2: {runtime (the F1 constrained container runtime), capabilityStore} — null disables fusion driving
  orchestrator = null,     // O-unit: {runtime?} — defaults to the shared F1 runtime; null disables orchestrator driving
  swarm = null,            // S-unit: {runtime?, driver?} — the native swarm module (domain.mjs/driver.mjs) wires through here
} = {}) {
  if (!client) throw new RuntimeError('invalid_argument', 'scheduler requires a client');
  if (!runtime) throw new RuntimeError('invalid_argument', 'scheduler requires a runtime');
  validationEnabled = validationEnabled ?? env?.ACP_EXEC_VALIDATION === '1';

  // U5 dep supply: the shared constrained F1 runtime plus the controller's
  // materialized dep-set root (host view) and the declared setup depPaths.
  // A run whose integrate record declares setupId-bound dependencies gets
  // them re-bound + supplied into the validation copies; other runs are
  // entirely unaffected.
  const f1Runtime = fusion?.runtime ?? orchestrator?.runtime ?? swarm?.runtime ?? null;
  const depsDir = fusion?.depsDir ?? orchestrator?.depsDir ?? null;
  const setupDepPaths = fusion?.setupDepPaths ?? orchestrator?.setupDepPaths ?? null;

  let wsRootResolved = null;
  async function wsRoot() {
    if (!wsRootResolved) {
      const cfg = workspaceRoot(env);
      await ensureWorkspaceRootAccess(cfg);   // runner uid — we create inside
      wsRootResolved = await validateWorkspaceRoot(cfg);
    }
    return wsRootResolved;
  }

  function selfEnv() {
    const e = runtime.environment();
    return {
      uid: e.uid ?? null,
      gid: e.gid ?? null,
      hostname: e.hostname ?? null,
      bootId: e.bootId ?? null,
      pidNs: e.pidNs ?? null,
    };
  }

  function selfEnvInstance() {
    const e = runtime.environment();
    if (e.envInstance && typeof e.envInstance === 'object') return e.envInstance;
    return { containerId: e.containerId ?? null, initStarttime: e.initStarttime ?? null };
  }

  function self() {
    const e = runtime.environment();
    return {
      runnerId,
      instanceId,
      pid: Number.isInteger(e.pid) ? e.pid : process.pid,
      pidStarttime: typeof e.pidStarttime === 'string' ? e.pidStarttime : null,
      envKey: selfEnv(),
      envInstance: selfEnvInstance(),
      envSlot: runnerId,
      envGeneration: envRegistration?.generation ?? null,
    };
  }

  const owns = (owner) =>
    !!owner && owner.runnerId === runnerId && owner.instanceId === instanceId;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // ---- environment registration (identity only — never retirement) ---------
  // slot = the configured runnerId: two live containers may legitimately hold
  // the same slot concurrently; the ledger records who registered, nothing
  // more. The returned generation binds our owner records to this exact
  // registration so an ops retirement can later target it exactly.
  let envRegistration = null; // {generation, at}
  let envRegisterError = null; // {code, message, at} — durable launch-blocker
  async function ensureRegistered() {
    if (envRegistration || !client.registerEnvironment) return envRegistration;
    try {
      const res = await client.registerEnvironment({
        commandId: `envreg-${runnerId}-${instanceId}`,
        payload: {
          slot: runnerId,
          runnerId,
          instanceId,
          envInstance: selfEnvInstance(),
          envKey: selfEnv(),
          pid: self().pid,
          pidStarttime: self().pidStarttime,
        },
      });
      const generation = res?.result?.generation ?? res?.generation ?? null;
      if (!Number.isInteger(generation)) {
        // A registration that yields no generation cannot bind owner records
        // to a retirement record — treat it as a failure, never as success.
        envRegisterError = { code: 'registration_no_generation', at: now() };
        return null;
      }
      envRegistration = { generation, at: now() };
      envRegisterError = null;
      return envRegistration;
    } catch (e) {
      if (isOutageError(e)) throw e; // API loss is outage, not a local fault
      envRegisterError = {
        code: e?.code || 'register_failed',
        message: String(e?.message || e).slice(0, 300), at: now(),
      };
      return null; // retried next tick — never latching
    }
  }

  // New work requires a positively non-null registration generation when the
  // client supports the ledger (owner records bind envSlot+envGeneration for
  // exact retirement proofs). Without it the scheduler may still supervise
  // existing attempts — it just may not mint new unretirable work.
  const launchesNeedRegistration = () => !!client.registerEnvironment;
  const registrationOk = () => envRegistration !== null
    && Number.isInteger(envRegistration.generation);

  async function loadEnvironmentLedger() {
    if (client.getEnvironments) {
      const res = await client.getEnvironments().catch(() => null);
      if (res) return res.environments ?? res;
    }
    return null;
  }

  // ---- outage journal ------------------------------------------------------
  // Durable local spool, BOUND TO THIS PROCESS: the file name carries
  // runnerId+instanceId and only this scheduler writes it. A dead same-env
  // predecessor's snapshot may be inherited (see snapshotLoad), but a foreign
  // or still-live owner never gets control authority from a file's presence.
  //
  // Durability rules (fail-closed):
  //   * entries live in memory AND on disk — the in-memory list is
  //     authoritative until the atomic rewrite acknowledges;
  //   * any write/read fault sets journalDegraded: no new launches, tracked
  //     entries retained, diagnosis durable; entries are never dropped;
  //   * dead-lettering is a MOVE: the entry leaves the journal only after
  //     the deadletter write succeeded;
  //   * entries never expire — an unproven terminal still needs its proof.
  const journalDir = join(runtime.rootDir, 'journal');
  const journalFile = join(journalDir, `u4-journal-${runnerId}-${instanceId}.jsonl`);
  const deadFile = join(journalDir, `u4-deadletter-${runnerId}-${instanceId}.jsonl`);
  const recoveryFile = join(journalDir, `recovery-${runnerId}-${instanceId}.json`);
  let outage = false;
  let outageSince = null;
  let journalDegraded = false;
  let journalLoaded = false;
  let journalEntries = [];           // in-memory authoritative copy
  const tracked = new Map(); // attemptId -> {cardId, runId, attemptId, porchRunId, leaseUntil, owned, cursor, cancelSent}

  async function journalPersist() {
    try {
      await ensureDir(journalDir);
      await atomicWriteFile(journalFile,
        journalEntries.map((e) => JSON.stringify(e)).join('\n')
          + (journalEntries.length ? '\n' : ''));
    } catch (e) {
      journalDegraded = true;
      throw new RuntimeError('journal_write_failed',
        `outage journal persist failed: ${e?.code || e?.message || e}`);
    }
  }

  // Append is staged in memory first; the durable rewrite is the commit
  // point. A crash between a side effect (event drain, cancel dispatch) and
  // this persist loses the RECORD, not the effect — callers therefore keep
  // the source cursor unchanged until the write acknowledges, so the next
  // tick re-drains the same events (idempotent re-read, never skipped).
  async function journalAppend(entry) {
    journalEntries.push({ at: now(), ...entry });
    await journalPersist();
  }

  async function deadLetter(entry, cause) {
    const rec = {
      at: now(),
      cause: String(cause?.message || cause).slice(0, 300),
      entry,
    };
    try {
      await ensureDir(journalDir);
      await fsp.appendFile(deadFile, `${JSON.stringify(rec)}\n`);
      return true;
    } catch (e) {
      // Deadletter write failed — the entry stays in the journal (NOT
      // dropped); the caller keeps it in `remaining`.
      journalDegraded = true;
      return false;
    }
  }

  async function journalLoad() {
    let raw;
    try {
      raw = await fsp.readFile(journalFile, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') { journalEntries = []; return journalEntries; }
      // EACCES/EIO/other: fail closed — degrade, never pretend the journal is empty.
      journalDegraded = true;
      throw new RuntimeError('journal_read_failed',
        `outage journal unreadable: ${e?.code || e?.message || e}`);
    }
    const entries = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        entries.push(JSON.parse(t));
      } catch {
        // Torn tail (partial last line from a crashed append): preserved as
        // a corrupt entry — replay dead-letters it, never silently skips.
        entries.push({ kind: 'corrupt', raw: t.slice(0, 500) });
      }
    }
    journalEntries = entries;
    return journalEntries;
  }

  // Persisted tracking snapshot — bound to env+instance; a restart reloads
  // the same recorded values only after proving the recording process is
  // dead (see snapshotLoad). Nothing is ever invented.
  async function snapshotWrite() {
    try {
      await ensureDir(journalDir);
      await atomicWriteFile(recoveryFile, JSON.stringify({
        instanceId, runnerId, at: now(),
        envKey: selfEnv(),
        envInstance: selfEnvInstance(),
        pid: self().pid,
        pidStarttime: self().pidStarttime,
        tracked: [...tracked.values()],
      }));
    } catch (e) {
      // Externally observable: journalDegraded surfaces as
      // tick().journal_degraded + a launch hold — never silent.
      journalDegraded = true;
      lastJournalError = `snapshot write failed: ${e?.code || e?.message || e}`;
    }
  }

  // Proven-dead same-env predecessors' journal spools, awaiting ordered
  // replay. Entries keep their source provenance ({srcInstance}); a source
  // file is acknowledged (removed) only after ALL its entries replayed
  // durably against the authoritative service — file presence alone grants
  // the source no authority.
  const inheritedSpools = new Map(); // srcInstanceId -> {file, entries: []}
  const seenPredecessors = new Set(); // srcInstanceIds whose dead-snapshot was consumed
  const consumedTracked = new Set(); // tracked-merge applied once per source instance
  let lastJournalError = null;

  // Load OUR snapshot, then dead same-env predecessors' snapshots AND their
  // journal spools. A snapshot whose recorded owner process is still alive —
  // or from a different environment — is ignored entirely. Inherited tracked
  // rows carry owned:false — outageTick can only cancel attempts the
  // authoritative state proves ours.
  //
  // Our OWN snapshot file is deliberately skipped: instanceId is a fresh
  // crypto.randomUUID per process lifetime, so a recovery-<runner>-<id>.json
  // matching our id can only be stale bytes, never a live peer. Reused
  // instance ids are outside the supported contract.
  async function snapshotLoad() {
    if (journalLoaded) return;
    journalLoaded = true;
    await journalLoad().catch(() => {});
    await scanPredecessors();
  }

  // A predecessor who was ALIVE when our journal first loaded may die any
  // tick later — the scan must re-run on every tick or its durable journal
  // duties (unapplied reports, resolve proofs) stay orphaned forever even
  // though an adopter finished the work. Already-inherited sources and our
  // own snapshot are skipped; a live/unknown predecessor is hands-off each
  // pass until positive death.
  async function scanPredecessors() {
    const mine = selfEnv();
    let files = null;
    try {
      files = await fsp.readdir(journalDir);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') {
        // EACCES/EIO/etc: a spool directory we cannot read may hide a dead
        // predecessor's tracked work — degrade, never pretend "first boot".
        journalDegraded = true;
        lastJournalError = `journal dir unreadable: ${e?.code || e?.message || e}`;
      }
    }
    // Instance ids may contain '-'; the runner/instance boundary cannot be
    // split by regex on the LAST dash. The same-runner test is a PREFIX
    // match against OUR runnerId — everything prefixed 'recovery-<runnerId>-'
    // is potentially ours and must parse/degrade, never skip silently.
    const ownPrefix = `recovery-${runnerId}-`;
    for (const f of files || []) {
      if (!f.startsWith(ownPrefix) || !f.endsWith('.json')) continue;
      if (f === `recovery-${runnerId}-${instanceId}.json`) continue;
      const srcInst = f.slice(ownPrefix.length, -'.json'.length);
      // A dead predecessor is fully consumed once its journal spool state
      // is known — an unreadable spool is retried, never marked seen.
      if (seenPredecessors.has(srcInst)) continue;
      let doc = null;
      try {
        doc = JSON.parse(await fsp.readFile(join(journalDir, f), 'utf8'));
      } catch {
        // Same-runner file we cannot read: it may be a live peer's snapshot
        // we must not discard — degrade rather than silently skip.
        journalDegraded = true;
        lastJournalError = `recovery snapshot unreadable: ${f}`;
        continue;
      }
      if (!doc || typeof doc !== 'object' || doc.runnerId !== runnerId
        || !SAFE_ID_RE.test(srcInst)) {
        journalDegraded = true;
        lastJournalError = `recovery snapshot corrupt: ${f}`;
        continue;
      }
      if (!envKeyEqual(doc.envKey, mine)) continue;          // different env — never ours
      if (!envInstanceEqual(doc.envInstance, selfEnvInstance())) continue;
      // The filename suffix is the identity; a doc claiming a different
      // instanceId is corrupt — degrade, never inherit authority from it.
      if (doc.instanceId !== srcInst) {
        journalDegraded = true;
        lastJournalError = `recovery snapshot instance mismatch: ${f}`;
        continue;
      }
      // Same container, different instance: inherit ONLY when the recorded
      // owner process is proven dead in this very pid namespace.
      const probe = Number.isInteger(doc.pid)
        ? runtime.processIdentity(doc.pid) : null;
      const dead = probe && probe.exists === true
        ? (probe.state === 'Z'
          || (probe.readable && probe.starttime && doc.pidStarttime && probe.starttime !== doc.pidStarttime))
        : probe && probe.exists === false;
      if (!dead) continue;                                   // live/unknown — hands off
      // Two distinct one-shot consumptions per dead predecessor:
      //   consumedTracked — the tracked-work merge runs once (a retried
      //     scan must not resurrect entries already drained or adopted);
      //   seenPredecessors — marked only when the journal spool's state is
      //     KNOWN (read, or provably absent). An unreadable spool degrades
      //     and retries next tick — a transient EACCES can never orphan a
      //     pending duty.
      if (!consumedTracked.has(srcInst)) {
        consumedTracked.add(srcInst);
        for (const t of doc.tracked || []) {
          if (t && t.attemptId && !tracked.has(t.attemptId)) {
            tracked.set(t.attemptId, {
              ...t, owned: false, inheritedFrom: srcInst,
            });
          }
        }
      }
      // Recover the predecessor's own journal spool — durably drained
      // events/observations it recorded must not die with its instance.
      const spoolFile = join(journalDir, `u4-journal-${runnerId}-${srcInst}.jsonl`);
      let raw = null;
      try {
        raw = await fsp.readFile(spoolFile, 'utf8');
      } catch (e) {
        if (e && e.code !== 'ENOENT') {
          journalDegraded = true;
          lastJournalError = `predecessor journal unreadable: ${e?.code || e?.message || e}`;
          continue; // unreadable — retry next tick; never marked seen
        }
      }
      seenPredecessors.add(srcInst);
      if (raw) {
        const entries = [];
        for (const line of raw.split('\n')) {
          const tt = line.trim();
          if (!tt) continue;
          let entry;
          try {
            entry = JSON.parse(tt);
          } catch {
            entry = { kind: 'corrupt', raw: tt.slice(0, 500) };
          }
          entry.srcInstance = srcInst;
          entries.push(entry);
        }
        if (entries.length) {
          inheritedSpools.set(srcInst, { file: spoolFile, entries });
        }
      }
    }
  }

  // ---- internal command plumbing ------------------------------------------
  // Command envelope: {ok, internalRevision, result} — `result` holds the
  // command payload. Command IDs are deterministic per LOGICAL operation AND
  // owning instance: payloads carry owner identity, so a post-adoption
  // reissue by a different instance must NOT replay under the old key (the
  // service dedups by payload hash — same key + different owner payload
  // would be a command_conflict). Same-instance replays still dedup safely;
  // a new instance never impersonates the former owner.

  async function refreshCard(card) {
    const fresh = await client.getCard(card.cardId);
    if (fresh) {
      card.internalRevision = fresh.internalRevision;
      card.workspaces = fresh.workspaces || {};
    }
    return card;
  }

  // Commands whose loss to an API outage must be journaled for ordered
  // replay — validation mutations carry durable duties (receipts, reports,
  // endings) that a `.catch(() => {})` caller would otherwise drop.
  const JOURNALED_COMMANDS = new Set([
    'begin_validation', 'validation_progress', 'end_validation',
    'record_snapshot', 'record_report', 'accept_result', 'commit_artifact',
  ]);
  async function send(card, type, payload, idem, { journal = true } = {}) {
    const commandId = idem || `sc-${instanceId.slice(0, 8)}-${type}-${crypto.randomUUID()}`;
    // Durable-exactly-once journal append: the ORIGINAL commandId+payload
    // land in the journal at most once, whatever later retry produced the
    // final error. A failed durable append degrades the journal (fail
    // closed — no new launches) while the entry stays queued in memory for
    // this process's own replays; the thrown cause remains the API error.
    let journaled = false;
    const journalOnce = async () => {
      if (journaled || !journal || !JOURNALED_COMMANDS.has(type)) return;
      journaled = true;
      try {
        await journalAppend({
          kind: 'command', cardId: card.cardId, commandId,
          srcInstance: instanceId, type, payload,
        });
      } catch {
        // journalDegraded/lastJournalError already record the loss — the
        // caller still sees the API error, the tick still reports degraded.
      }
    };
    for (let tries = 0; ; tries += 1) {
      try {
        const res = await client.command(card.cardId, {
          commandId,
          type,
          payload,
          expectedInternalRevision: card.internalRevision,
        });
        if (res && typeof res.internalRevision === 'number') {
          card.internalRevision = res.internalRevision;
        }
        return res?.result ?? res;
      } catch (e) {
        if (e && e.status === 409 && e.code === 'revision_conflict' && tries < 8) {
          // The CAS refresh read is itself an API call — an outage there
          // loses the mutation exactly like a lost command response.
          // Jittered backoff: co-channel writers (the 300ms validation
          // heartbeat is one) retry through this same path, and an
          // immediate refresh+resend holds both loops in lockstep — each
          // retry lands in the other's CAS window and retries starve.
          // A randomized delay lands the next attempt at an unrelated
          // phase of the competing writer's cycle.
          await new Promise((r) => setTimeout(r, 20 + Math.random() * 120));
          try {
            await refreshCard(card);
          } catch (re) {
            if (isOutageError(re)) await journalOnce();
            throw re;
          }
          continue;
        }
        if (isOutageError(e)) await journalOnce();
        throw e;
      }
    }
  }

  async function recordEvent(card, run, type, data, attemptId = null) {
    // Dedup key: the event destined for seq N of this run. A 409 conflict
    // means another event already landed at that seq — refresh and retry once.
    for (let tries = 0; tries < 3; tries += 1) {
      const seq = typeof run.eventsCursor === 'number'
        ? run.eventsCursor : (run.events?.length ?? 0);
      try {
        const res = await send(card, 'record_event', {
          runId: run.id,
          attemptId: attemptId ?? undefined,
          type,
          data,
          ...self(),
        }, `ev-${run.id}-${seq}`);
        if (typeof res?.seq === 'number') run.eventsCursor = res.seq + 1;
        return res;
      } catch (e) {
        if (e && e.status === 409 && (e.code === 'command_conflict' || e.code === 'revision_conflict')) {
          const fresh = await client.getRun(run.id);
          if (fresh) run.eventsCursor = fresh.eventsCursor ?? (fresh.events?.length ?? seq + 1);
          continue;
        }
        throw e;
      }
    }
    return null;
  }

  // ---- adoption proofs -----------------------------------------------------

  // Builds a structured adoption proof for a foreign owner — or null when
  // nothing provable applies (the scheduler then leaves the resource alone).
  async function adoptionProofFor(owner) {
    const mine = selfEnv();
    if (!owner?.envKey) {
      // Even without an envKey, a recorded envInstance can still be retired
      // by the ops path — check it before declaring foreign.
      return retiredProofFor(owner);
    }
    if (envKeyEqual(owner.envKey, mine)) {
      // Same environment: only a terminally-proven recorded owner pid
      // qualifies. Probe in our (=owner's original) namespace.
      if (!Number.isInteger(owner.pid)) return null;
      const probe = runtime.processIdentity(owner.pid);
      if (!probe || probe.exists === null) return null;         // EACCES → unverifiable
      if (probe.pidNs && owner.envKey.pidNs && probe.pidNs !== owner.envKey.pidNs) return null;
      const base = {
        kind: 'process_dead',
        pid: owner.pid,
        starttime: owner.pidStarttime ?? null,
        pidNs: owner.envKey.pidNs,
      };
      if (probe.exists === false) return { ...base, finding: 'absent' };
      if (probe.exists === true && probe.state === 'Z') return { ...base, finding: 'zombie' };
      if (probe.exists === true && probe.readable
        && probe.starttime && owner.pidStarttime
        && probe.starttime !== owner.pidStarttime) {
        return { ...base, finding: 'recycled', observedStarttime: probe.starttime };
      }
      return null; // alive or unreadable — no proof
    }
    if (envLostProof(owner.envKey, mine)) {
      return { kind: 'environment_lost' };
    }
    // Different envKey + same boot: the owner may still be live in another
    // container. The ONLY remaining proof is the ops-verified retirement
    // record for the owner's EXACT envInstance+generation — never inferred
    // from our registration or a changed namespace.
    return retiredProofFor(owner);
  }

  // Ops-verified retirement proof for the owner's EXACT recorded instance —
  // slot + envInstance + generation must all match the retirement record.
  // Missing owner fields are unproven (a wildcard could match the wrong
  // generation's record); legacy owners without a recorded generation stay
  // retained until the env-lost (bootId) proof applies instead.
  async function retiredProofFor(owner) {
    const inst = owner?.envInstance;
    if (!inst?.containerId || !inst?.initStarttime
      || typeof owner?.envSlot !== 'string' || !owner.envSlot
      || !Number.isInteger(owner?.envGeneration)) {
      return null;
    }
    if (envInstanceEqual(inst, selfEnvInstance())) return null; // we ARE it
    const envs = await loadEnvironmentLedger();
    const list = Array.isArray(envs?.retirements) ? envs.retirements : [];
    const rec = list.find((r) => r && envInstanceEqual(r.envInstance, inst)
      && r.slot === owner.envSlot
      && r.generation === owner.envGeneration);
    return rec ? { kind: 'environment_retired' } : null;
  }

  // ---- workspaces ----------------------------------------------------------

  function wsIdFor(run) {
    return `ws-${run.id}`.slice(0, 61);
  }

  // Reserves/adopts the run's workspace and performs the filesystem
  // allocation as the recorded owner. Returns {ok, ws} — {ok:false, code}
  // leaves the run untouched (another tick/adopter may progress it).
  async function ensureWorkspace(card, run) {
    const cardId = card.cardId;
    const root = await wsRoot();
    let wsId = run.workspaceId || wsIdFor(run);
    for (let hop = 0; hop < 4; hop += 1) {
      const ws = card.workspaces?.[wsId] ?? null;
      if (!ws) {
        // Reserve: the domain atomically binds run.workspaceId on success.
        const branch = workspaceBranch(cardId, wsId);
        const wpath = workspacePath(root, projectKeyFor(card.project?.path || ''), cardId, wsId);
        try {
          const res = await send(card, 'begin_workspace', {
            workspaceId: wsId, runId: run.id, branch,
            baseCommit: run.baseCommit, path: wpath, ...self(),
          }, `bw-${cardId}-${wsId}-by-${instanceId}`);
          return allocateFs(card, run,
            res?.workspace ?? { id: wsId, status: 'creating', path: wpath, branch });
        } catch (e) {
          if (isErr(e, 'workspace_foreign')) {
            // Same-coordinates reservation held by another instance — adopt
            // it (proof-gated); never allocate under a foreign reservation.
            const adopted = await adoptWorkspace(card, wsId, run.id);
            if (!adopted) return { ok: false, code: 'workspace_foreign' };
            await refreshCard(card);
            continue;
          }
          if (isErr(e, 'workspace_conflict')) {
            // Bound to a different wsId — converge on the bound record.
            const freshRun = await client.getRun(run.id);
            const bound = freshRun?.workspaceId;
            if (bound && bound !== wsId) { wsId = bound; await refreshCard(card); continue; }
            return { ok: false, code: 'workspace_conflict' };
          }
          throw e;
        }
      }
      if (ws.runId !== run.id) {
        // Bound to a predecessor run: legal only via adoption, which rebinds
        // runId when the predecessor is terminal — files are preserved.
        const adopted = await adoptWorkspace(card, wsId, run.id);
        if (!adopted) return { ok: false, code: 'workspace_foreign_run', ws };
        await refreshCard(card);
        continue;
      }
      if (!owns(ws.owner)) {
        const adopted = await adoptWorkspace(card, wsId, run.id);
        if (!adopted) return { ok: false, code: 'workspace_foreign', ws };
        await refreshCard(card);
        continue;
      }
      return handleExistingWs(card, run, ws);
    }
    return { ok: false, code: 'workspace_unresolved' };
  }

  async function adoptWorkspace(card, wsId, runId) {
    await refreshCard(card); // authoritative owner/workspace, never stale
    const ws = card.workspaces?.[wsId];
    if (!ws) return false;
    if (owns(ws.owner) && ws.runId === runId) return true;
    const proof = owns(ws.owner) ? null : await adoptionProofFor(ws.owner);
    if (!owns(ws.owner) && !proof) return false; // foreign-live or unverifiable — hands off
    try {
      await send(card, 'adopt_workspace', {
        workspaceId: wsId, runId, proof: proof ?? undefined, ...self(),
      }, `adw-${wsId}-by-${instanceId}`);
      return true;
    } catch (e) {
      if (isErr(e, 'ownership_unproven') || isErr(e, 'not_workspace_owner')
        || isErr(e, 'workspace_conflict') || isErr(e, 'workspace_terminal')) {
        return false;
      }
      throw e;
    }
  }

  async function handleExistingWs(card, run, ws) {
    if (ws.status === 'ready') return { ok: true, ws };
    if (ws.status === 'failed') {
      // Deterministic failure (dirty source/git) — park the run; a fresh
      // user start is the recovery path.
      try {
        await send(card, 'complete_run', {
          runId: run.id, status: 'blocked', reason: `workspace ${ws.id} failed`, ...self(),
        }, `cr-${run.id}-ws-failed-by-${instanceId}`);
      } catch { /* ownership/terminal races are benign — state wins */ }
      return { ok: false, code: 'workspace_failed', ws };
    }
    // 'creating' — ours to allocate/resume on the filesystem.
    return allocateFs(card, run, ws);
  }

  async function failWs(card, run, ws, code, reason) {
    await send(card, 'workspace_failed', {
      workspaceId: ws.id, runId: run.id, reason: reason.slice(0, 400), ...self(),
    }, `wf-${ws.id}-by-${instanceId}`);
    // We own the workspace — park the run in the same tick so a failed
    // allocation never spins forever on a deterministic cause.
    await send(card, 'complete_run', {
      runId: run.id, status: 'blocked', reason: `workspace ${ws.id}: ${reason.slice(0, 200)}`,
      ...self(),
    }, `cr-${run.id}-${ws.id}-by-${instanceId}`).catch(() => {});
    return { ok: false, code, ws };
  }

  async function allocateFs(card, run, ws) {
    const root = await wsRoot();
    // Containment BEFORE any write: the target must be lexically inside the
    // resolved workspace root, and the realpath of its existing ancestors
    // must not escape it (a symlinked <projectKey> dir redirects otherwise).
    let normTarget;
    try {
      normTarget = assertInsideRoot(root, ws.path);
    } catch {
      return failWs(card, run, ws, 'workspace_path_escape',
        `workspace path ${ws.path} escapes workspace root ${root}`);
    }
    const parent = dirname(normTarget);
    // Probe the parent BEFORE creating it: an existing non-dir (or a dir
    // whose realpath leaves the root) is a refusal, never a follow.
    let parentStat = null;
    try { parentStat = await fsp.lstat(parent); }
    catch (e) {
      if (e.code !== 'ENOENT') {
        return failWs(card, run, ws, 'workspace_probe_failed',
          `parent probe failed: ${e.code || e.message}`);
      }
    }
    if (parentStat && !parentStat.isDirectory()) {
      return failWs(card, run, ws, 'workspace_parent_not_dir', parent);
    }
    await fsp.mkdir(parent, { recursive: true });
    const realParent = await fsp.realpath(parent).catch(() => null);
    if (!realParent || (realParent !== root && !realParent.startsWith(`${root}/`))) {
      return failWs(card, run, ws, 'workspace_path_escape',
        `parent realpath ${realParent} escapes workspace root ${root}`);
    }
    // Existing-path probe: ENOENT means absent; anything else (EACCES…)
    // is an error, never "absent".
    let exists;
    try {
      await fsp.lstat(normTarget);
      exists = true;
    } catch (e) {
      if (e.code === 'ENOENT') {
        exists = false;
      } else {
        return failWs(card, run, ws, 'workspace_probe_failed',
          `target probe failed: ${e.code || e.message}`);
      }
    }
    // Source repo must be a clean git checkout — never touched on refusal.
    const srcRoot = await sourceGitRoot(card.project?.path || '');
    if (!srcRoot) {
      return failWs(card, run, ws, 'source_not_git',
        'source path is not a git repository');
    }
    const srcCommonDir = await gitCommonDir(srcRoot).catch((e) => {
      throw new RuntimeError('worktree_failed',
        `cannot resolve source git common dir for ${srcRoot}: ${e?.message || e}`);
    });
    if (!exists) {
      const dirty = await sourceDirtyPaths(srcRoot);
      if (dirty) {
        await recordEvent(card, run, 'workspace_dirty',
          { dirtyPaths: dirty.slice(0, 10) }).catch(() => {});
        return failWs(card, run, ws, 'source_dirty',
          `source tree is dirty (${dirty.length} paths)`);
      }
      try {
        await createWorkspace({
          sourcePath: srcRoot,
          targetPath: normTarget,
          branch: ws.branch,
          baseCommit: run.baseCommit,
        });
      } catch (e) {
        return failWs(card, run, ws, e?.code || 'worktree_failed',
          String(e?.message || e));
      }
      // Post-create containment: the created worktree's realpath must stay
      // inside the resolved root (defense in depth against pre-created links).
      const realTarget = await fsp.realpath(normTarget).catch(() => null);
      if (!realTarget || (realTarget !== root && !realTarget.startsWith(`${root}/`))) {
        return failWs(card, run, ws, 'workspace_path_escape',
          `created path realpath ${realTarget} escapes workspace root ${root}`);
      }
    }
    const v = await verifyWorkspace({
      targetPath: normTarget, branch: ws.branch,
      baseCommit: run.baseCommit, expectCommonDir: srcCommonDir,
    });
    if (!v.ok) {
      return failWs(card, run, ws, 'workspace_verify_failed', `verify failed: ${v.problems.join(',')}`);
    }
    await send(card, 'workspace_ready', {
      workspaceId: ws.id, runId: run.id, head: v.head, ...self(),
    }, `wr-${ws.id}-by-${instanceId}`);
    return { ok: true, ws: { ...ws, status: 'ready' } };
  }

  // ---- attempt lifecycle -----------------------------------------------------

  // Immutable inputs: the fetched documents must be exactly the approved
  // blobs recorded on the run — versionId alone is not proof of content.
  // Verified BEFORE any workspace/attempt mutation.
  async function verifyInputs(cardId, run) {
    const reqDoc = await client.getDocument(cardId, run.inputs.requirements.versionId);
    const planDoc = await client.getDocument(cardId, run.inputs.plan.versionId);
    const checkDoc = (doc, rec, label) => {
      if (!doc || doc.sha256 !== rec.sha256
        || sha256(doc.content ?? '') !== rec.sha256) {
        throw new RuntimeError('input_hash_mismatch',
          `${label} document ${rec.versionId} does not match approved sha256 ${rec.sha256}`);
      }
    };
    checkDoc(reqDoc, run.inputs.requirements, 'requirements');
    checkDoc(planDoc, run.inputs.plan, 'plan');
    return { reqDoc, planDoc };
  }

  function sanitizeAttemptId(s) {
    const clean = s.replace(/[^A-Za-z0-9._-]/g, '-');
    return (SAFE_ID_RE.test(clean) ? clean : `a${clean}`).slice(0, 128);
  }

  // Launch termination evidence for THIS attempt. 'terminated' is the only
  // result that authorizes a retry after zero registry matches.
  function launcherTermination(record, launchRes, envRetired) {
    if (envRetired) return 'terminated'; // old env proven gone — nothing in it lives
    if (!record || record.missing || record.corrupt) return 'unknown';
    // Durable pre-spawn rejection: the record proves spawn never happened.
    if (record.spawned === false && record.phase === 'launch_failed') return 'terminated';
    // The launcher process was observed exiting (nonzero porch CLI result
    // returned by THIS runtime in THIS environment — env-safe evidence).
    if (launchRes?.phase === 'launch_failed'
      && launchRes?.diagnostics && launchRes.diagnostics.exitCode != null) {
      return 'terminated';
    }
    const l = record.launcher;
    if (!l || !Number.isInteger(l.pid)) return 'unknown'; // missing identity ≠ dead
    // Process-death inference requires a positively verified same-environment
    // observation: the record's environment must equal ours — including the
    // original pid namespace. No recorded env, or any mismatch, is unknown.
    const recEnv = record.environment ? {
      uid: record.environment.uid ?? null,
      gid: record.environment.gid ?? null,
      hostname: record.environment.hostname ?? null,
      bootId: record.environment.bootId ?? null,
      pidNs: record.environment.pidNs ?? null,
    } : null;
    if (!envKeyEqual(recEnv, selfEnv())) return 'unknown';
    if (l.pidNs && recEnv?.pidNs && l.pidNs !== recEnv.pidNs) return 'unknown';
    const probe = runtime.processIdentity(l.pid);
    if (!probe || probe.exists === null) return 'unknown';         // EACCES
    if (probe.pidNs && l.pidNs && probe.pidNs !== l.pidNs) return 'unknown';
    if (probe.exists === false) return 'terminated';               // ENOENT
    if (probe.exists === true && probe.state === 'Z') return 'terminated';
    if (probe.exists === true && probe.readable
      && probe.starttime && l.starttime && probe.starttime !== l.starttime) {
      return 'terminated';                                          // recycled pid
    }
    if (probe.exists === true && probe.readable && probe.alive
      && (!l.starttime || probe.starttime === l.starttime)) {
      return 'alive';
    }
    return 'unknown';
  }

  // NEVER-ENTERED proof — the narrow path that lets a `launching` attempt
  // with zero registry matches resolve without a recorded supervisor. It
  // requires ALL of:
  //   * no in-flight runtime.start for this attempt in THIS process (a live
  //     caller's pending async start could precede its mkdir — the absence
  //     window the parent flagged);
  //   * the attempt dir is absent (start() was never entered far enough to
  //     commit a launch record);
  //   * the launch record is missing or proves spawned===false;
  //   * the launch owner cannot still be running start(): either the owner
  //     IS this instance (it never invoked start — startedHere is empty for
  //     this id), or it was adopted with positive proof.
  // Anything less stays `launching`/`cancelling` with a durable diagnostic.
  const inflight = new Map();    // attemptId -> Promise (runtime.start in flight)
  const startedHere = new Set(); // attemptIds this instance actually invoked start() for

  async function neverEnteredProof(att, { deadOwner = false } = {}) {
    if (inflight.has(att.id)) return false;
    // An ADOPTED attempt can never use dir-absence as never-entered proof:
    // the launch record is the only holder of the launcher pid — without it
    // a live porch launcher mid-mkdir cannot be excluded, so the honest
    // outcome is the launcher_unproven block below, not a resolve.
    if (deadOwner) return false;
    const ownLaunch = owns(att.owner);
    if (!ownLaunch) return false;
    if (startedHere.has(att.id)) return false;
    const dir = await runtime.attemptDirState(att.id).catch(() => null);
    if (!dir || dir.exists !== false) return false;
    return true;
  }

  async function blockAttempt(card, run, att, code, detail) {
    await recordEvent(card, run, 'launch_blocked',
      { attemptId: att.id, code, detail }, att.id).catch(() => {});
    return 'blocked';
  }

  // Reconcile the exact attempt after an uncertain/failed/lost launch — or
  // while a cancel intent is pending (a late supervisor must be found and
  // cancelled by its run id, never left running).
  // Returns 'bound' | 'cancelled' | 'retry' | 'stayed' | 'blocked'.
  async function reconcileAttempt(card, run, att, { launchRes = null, envRetired = false, deadOwner = false } = {}) {
    const cancelling = run.status === 'stopping' || !!att.cancel;
    const match = { artifactsDir: att.launch?.artifactsDir, cwd: att.launch?.cwd };
    let scan;
    try {
      scan = await runtime.reconcile(match);
    } catch (e) {
      return blockAttempt(card, run, att, 'registry_scan_failed', String(e?.message || e));
    }
    if (!scan || scan.ok !== true) {
      return blockAttempt(card, run, att, 'registry_scan_failed', scan?.error?.code);
    }
    if ((scan.unreadable || []).length) {
      return blockAttempt(card, run, att, 'registry_incomplete',
        { unreadable: scan.unreadable.length });
    }
    const matches = scan.matches || [];
    if (matches.length === 1) {
      const found = matches[0].runId;
      if (cancelling) {
        // Late supervisor under stop intent: bind it THROUGH cancel_attempt
        // so the cancel duty owns the exact run id atomically — never a
        // second launch, never a silent running supervisor.
        await send(card, 'cancel_attempt', {
          runId: run.id, attemptId: att.id, porchRunId: found,
          reason: att.cancel?.reason ?? 'stop intent',
          ...self(),
        }, `cx-${att.id}-by-${instanceId}`);
        att.porchRunId = found;
        att.status = 'cancelling';
        return 'cancel-bound';
      }
      await send(card, 'bind_attempt', {
        runId: run.id, attemptId: att.id, porchRunId: found, ...self(),
      }, `bind-${att.id}-by-${instanceId}`);
      return 'bound';
    }
    if (matches.length >= 2) {
      return blockAttempt(card, run, att, 'registry_ambiguous',
        { matches: matches.map((m) => m.runId) });
    }
    // Zero clean matches — never alone sufficient for a retry or a resolve.
    let record = null;
    try {
      record = await runtime.launchRecord(att.id);
    } catch (e) {
      return blockAttempt(card, run, att, 'launch_record_unreadable', String(e?.message || e));
    }
    if (await neverEnteredProof(att, { deadOwner })) {
      // start() provably never ran for this attempt: no dir, no record, no
      // in-flight call, owner dead-or-us. Resolving is honest either way —
      // 'cancelled' under a stop intent, 'failed' otherwise.
      const outcome = cancelling ? 'cancelled' : 'failed';
      await send(card, 'resolve_attempt', {
        runId: run.id, attemptId: att.id, outcome,
        reason: 'launch never entered the runtime — no dir, no record, no registry match',
        ...self(),
      }, `rs-${att.id}-never-entered-by-${instanceId}`);
      return cancelling ? 'cancelled' : 'retry';
    }
    const term = launcherTermination(record, launchRes, envRetired);
    if (term === 'terminated') {
      await send(card, 'resolve_attempt', {
        runId: run.id, attemptId: att.id,
        outcome: cancelling ? 'cancelled' : 'failed',
        reason: cancelling
          ? 'cancelled: launcher provably terminated with no supervisor registered'
          : 'launch produced no registry entry; launcher provably terminated',
        ...self(),
      }, `rs-${att.id}-launch-${cancelling ? 'cancelled' : 'failed'}-by-${instanceId}`);
      return cancelling ? 'cancelled' : 'retry';
    }
    if (term === 'alive') {
      // The recorded launcher is still live — a supervisor may yet appear.
      // Stay `launching`/`cancelling`; heartbeats keep the lease. NEVER
      // start a second.
      await recordEvent(card, run, cancelling ? 'cancel_pending' : 'launcher_alive',
        { attemptId: att.id, pid: record.launcher?.pid ?? null }, att.id).catch(() => {});
      return 'stayed';
    }
    return blockAttempt(card, run, att, 'launcher_unproven',
      { missing: record?.missing === true, corrupt: record?.corrupt === true });
  }

  // Continuation context for the prompt — normalized HERE, at the single
  // boundary between the durable record schema (domain: fromRunId /
  // fromResult / priorAttempts / priorArtifacts / openFindings{type,code,
  // detail} / userNote) and the prompt's strict shape. The prior run's final
  // result is embedded COMPLETE — hash-verified artifact bytes, or the stored
  // summary labeled as a summary; a missing/corrupt artifact produces an
  // explicit unavailability marker AND a durable run event — context is
  // never silently dropped or fed unverified.
  const CONT_TEXT_MAX = 4000;
  async function continuationFor(card, run) {
    const c = run.continuation;
    if (!c || typeof c !== 'object') return null;
    const findings = [];
    // EVERY prior attempt is rendered — identity, role, outcome — completed
    // included. A continuation prompt that only names failures hides the
    // fact that work already finished from the new implementer.
    for (const a of c.priorAttempts || []) {
      if (a && a.id) {
        findings.push({
          severity: 'prior',
          text: `attempt ${a.id} (${a.role}#${a.n}) ended ${a.outcome ?? 'unknown'}${a.error ? `: ${a.error}` : ''}`,
        });
      }
    }
    const openFindings = (c.openFindings || []).map((f) => ({
      severity: f?.type ?? 'diag',
      text: f?.detail ?? `${f?.type ?? 'diagnostic'}${f?.code ? ` (${f.code})` : ''}`,
    }));
    // Prior final result: read the COMPLETE recorded artifact bytes and
    // verify them against the recorded sha256 BEFORE embedding — corrupted
    // content is never fed to the agent as verified history. The full text
    // is embedded verbatim (artifact size is already bounded at write time);
    // on verification failure the prompt gets an explicit unavailability
    // marker, never a silently truncated/dropped tail.
    let priorResultText = null;
    let priorResultUnavailable = null; // {code, detail} → explicit marker
    const priorArts = c.priorArtifacts || [];
    const finalArt = priorArts.find((a) => a && a.kind === 'final')
      || priorArts[priorArts.length - 1];
    const finalStored = finalArt?.stored ?? finalArt?.file ?? null;
    if (finalStored && stateDir) {
      try {
        // `stored` is the physical commit-bound name; `file` is only the
        // logical display name. The path must stay inside the run's
        // artifacts dir — nothing else is ever read.
        const dir = join(stateDir, 'execution', 'state', 'artifacts', String(c.fromRunId));
        const p = resolve(dir, finalStored);
        if (p !== join(dir, finalStored) || finalStored.includes('/')
          || finalStored.includes('\\')) {
          throw new RuntimeError('invalid_argument', `stored artifact name invalid: ${finalStored}`);
        }
        const raw = await fsp.readFile(p); // RAW bytes — never utf8 text
        const actual = sha256(raw);
        if (!finalArt.sha256 || actual !== finalArt.sha256
          || raw.length !== (finalArt.bytes ?? raw.length)) {
          const code = !finalArt.sha256 ? 'artifact_hash_unrecorded' : 'artifact_hash_mismatch';
          priorResultUnavailable = {
            code,
            detail: `prior artifact ${finalArt.file ?? finalStored} failed verification `
              + `(expected sha256 ${finalArt.sha256 ?? 'unrecorded'}, got ${actual.slice(0, 12)}…)`,
          };
          await recordEvent(card, run, 'artifact_corrupt', {
            runId: c.fromRunId, file: finalArt.file ?? finalStored, code,
            expected: finalArt.sha256 ?? null, actual,
          }).catch(() => {});
        } else {
          priorResultText = raw.toString('utf8'); // COMPLETE verified bytes — no excerpting
        }
      } catch (e) {
        priorResultUnavailable = {
          code: 'artifact_unreadable',
          detail: `prior artifact ${finalArt.file ?? finalStored} unreadable (${e?.code || e?.message})`,
        };
        await recordEvent(card, run, 'artifact_unreadable',
          { runId: c.fromRunId, file: finalArt.file ?? finalStored, error: e?.code ?? String(e?.message) })
          .catch(() => {});
      }
    }
    let priorResultSummary = null;
    if (priorResultText === null && !finalArt && c.fromResult?.summary) {
      // Only when NO artifact was recorded: the stored summary is itself a
      // bounded durable record — labeled a summary in the prompt. When a
      // recorded artifact exists but fails verification we do NOT fall back
      // to derived text — the unavailability marker is the honest signal.
      priorResultSummary = String(c.fromResult.summary).slice(0, CONT_TEXT_MAX);
    }
    if (priorResultText === null && priorResultSummary === null && !priorResultUnavailable
      && c.fromResult) {
      priorResultUnavailable = {
        code: 'result_unrecorded',
        detail: `prior run ${c.fromRunId} ended ${c.fromStatus ?? 'terminal'} with no readable result text`,
      };
    }
    return {
      fromRun: c.fromRunId,
      findings,
      openFindings,
      artifacts: priorArts.map((a) => ({ file: a?.file ?? a?.id ?? 'unknown' })),
      priorResultText,
      priorResultSummary,
      priorResultUnavailable,
      note: c.userNote ?? null,
    };
  }

  // Hydrate a recorded fixContext with the immutable artifact BYTES it
  // references — fetched server-mediated, then re-verified client-side
  // against the run's recorded sha256 AND byte count, and cross-bound to
  // the declaring receipt's hash and scope (attempt/validation). The fix
  // prompt is built from these verified bytes, never from mutable
  // workspace files. Throws artifact_not_found/corrupt_store/
  // artifact_evidence_unbound/artifact_provenance on absent or
  // mismatched evidence — never substitutes a fresh hash.
  async function hydrateFixContext(run) {
    const fx = run.fixContext || {};
    const hyd = { ...fx };
    const loadVerified = async (artifactId, expect = {}) => {
      const rec = run.artifacts?.[artifactId];
      if (!rec || typeof rec.file !== 'string') {
        throw new RuntimeError('artifact_not_found',
          `fix evidence artifact ${artifactId} is not recorded on run ${run.id}`);
      }
      // Recorded evidence MUST carry its full sha256 + byte count — a
      // record without them is unverifiable evidence, not something a
      // freshly-computed hash may substitute for.
      if (typeof rec.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(rec.sha256)
        || !Number.isInteger(rec.bytes) || rec.bytes < 0) {
        throw new RuntimeError('artifact_evidence_unbound',
          `artifact ${artifactId} lacks its recorded sha256/bytes — evidence unverifiable`);
      }
      // Provenance: when the reference declares an attempt or validation
      // scope, the stored record must bind exactly that scope.
      for (const k of ['attemptId', 'validationId']) {
        if (expect[k] !== undefined && rec[k] !== expect[k]) {
          throw new RuntimeError('artifact_provenance',
            `artifact ${artifactId} binds ${k}=${JSON.stringify(rec[k] ?? null)} — expected ${JSON.stringify(expect[k])}`);
        }
      }
      // Receipt cross-binding: the report/check receipt's recorded hash
      // must equal the artifact record's hash — the receipt's claim and
      // the store record cannot disagree without proof of tampering.
      if (expect.sha256 !== undefined && rec.sha256 !== expect.sha256) {
        throw new RuntimeError('artifact_provenance',
          `artifact ${artifactId} recorded hash != the receipt's recorded hash`);
      }
      const res = await client.getArtifact(run.id, artifactId);
      // Exact bytes first (contentBase64); a legacy response without it
      // falls back to the utf8 text — which can only verify when the file
      // genuinely was utf8-clean (a non-utf8 file loses bytes in the
      // text view and fails the byte-length check below — fail closed).
      let buf = null;
      if (typeof res?.contentBase64 === 'string') {
        buf = Buffer.from(res.contentBase64, 'base64');
      } else if (typeof res?.content === 'string') {
        buf = Buffer.from(res.content, 'utf8');
      } else {
        throw new RuntimeError('artifact_missing',
          `artifact ${artifactId} returned no content — evidence unverifiable`);
      }
      const got = crypto.createHash('sha256').update(buf).digest('hex');
      if (got !== rec.sha256 || buf.length !== rec.bytes) {
        throw new RuntimeError('corrupt_store',
          `artifact ${artifactId} content fails its recorded hash/byte length`);
      }
      // Deliberate text render for the prompt — AFTER the raw bytes proved.
      return { artifactId, sha256: rec.sha256, bytes: rec.bytes, content: buf.toString('utf8') };
    };
    // Prior implementer final: when the recorded result DECLARED a final
    // artifact the bytes must hydrate; when it declared none the fix
    // prompt says so honestly — never silently omitted.
    if (fx.priorResult?.finalArtifactId) {
      hyd.priorFinal = await loadVerified(fx.priorResult.finalArtifactId,
        fx.priorResult.attemptId ? { attemptId: fx.priorResult.attemptId } : {});
    } else if (fx.priorResult) {
      hyd.priorFinal = { artifactId: null, unavailable: 'not_declared' };
    }
    hyd.checkReports = await Promise.all((fx.checkReports || []).map(async (r) => ({
      ...r,
      logOut: r.logOutArtifactId
        ? await loadVerified(r.logOutArtifactId, {
          validationId: fx.validationId, sha256: r.logSha256Out })
        : null,
      logErr: r.logErrArtifactId
        ? await loadVerified(r.logErrArtifactId, {
          validationId: fx.validationId, sha256: r.logSha256Err })
        : null,
    })));
    if (fx.findingsArtifactId) {
      hyd.findingsArt = await loadVerified(fx.findingsArtifactId, {
        attemptId: fx.findingsAttemptId ?? undefined,
        sha256: fx.findingsArtifactSha256 ?? undefined });
    }
    if (fx.verdictsArtifactId) {
      hyd.verdictsArt = await loadVerified(fx.verdictsArtifactId, {
        attemptId: fx.verdictsAttemptId ?? undefined,
        sha256: fx.verdictsArtifactSha256 ?? undefined });
    }
    return hyd;
  }

  // Launch one role attempt. spec = {role, phase, cwd, prompt,
  // validationId?} — begin_attempt validates the phase/cwd binding
  // server-side (implementer→workspace path; reviewer/checker→the recorded
  // pristine copies under the validation dir).
  async function tryLaunch(card, run, ws, spec = null) {
    // Quiesce fences EVERY launch — implementer/fix/reviewer/checker all
    // funnel here; no durable attempt row is created for a refused launch.
    if (quiesced) return 'quiesced';
    const cardId = card.cardId;
    const role = spec?.role ?? 'implementer';
    const phase = spec?.phase ?? (run.fixContext ? 'fix' : 'implement');
    const cwd = spec?.cwd ?? ws.path;
    const n = (run.attempts || []).length + 1;
    const attemptId = sanitizeAttemptId(`att-${run.id}-${n}`);
    const rtEnv = runtime.environment();
    const attemptDir = `${rtEnv.attemptsDir}/${attemptId}`;
    const artifactsDir = `${attemptDir}/artifacts`;
    const config = porchConfigSnapshot(run.composition);
    const cfgSha = configSha256(config);
    let prompt = spec?.prompt ?? null;
    if (!prompt) {
      const { reqDoc, planDoc } = await verifyInputs(cardId, run);
      const promptArgs = {
        cardId,
        cardTitle: card.title || card.project?.label || null,
        runId: run.id,
        attemptId,
        workspace: { path: ws.path, branch: ws.branch },
        baseCommit: run.baseCommit,
        requirementsText: reqDoc.content,
        planText: planDoc.content,
        checks: run.inputs.plan?.checks || [],
        continuation: await continuationFor(card, run),
      };
      if (run.fixContext) {
        // The fix prompt carries the COMPLETE verified evidence — hydrated
        // from the immutable artifact store by recorded id+hash, never the
        // mutable workspace. Corrupt/missing evidence is terminal-diagnosed
        // fail-closed; an API outage propagates so the launch is retried.
        let hydrated;
        try {
          hydrated = await hydrateFixContext(run);
        } catch (e) {
          // The store's corruption/missing codes surface as 500 — they are
          // AUTHORITATIVE evidence failures, never a retryable outage.
          const terminal = ['corrupt_store', 'artifact_not_found', 'run_not_found',
            'artifact_missing', 'artifact_corrupt', 'artifact_unreadable'];
          if (isOutageError(e) && !terminal.includes(e?.code)) throw e;
          await recordEvent(card, run, 'fix_evidence_unavailable', {
            round: run.fixContext.round, code: e?.code ?? 'unknown',
            message: String(e?.message ?? e).slice(0, 300),
          }).catch(() => {});
          await send(card, 'complete_run', {
            runId: run.id, status: 'failed',
            reason: `fix evidence unavailable: ${e?.code ?? 'unreadable'}`,
            ...self(),
          }, `cr-${run.id}-fixev-${instanceId}`).catch(() => {});
          return 'evidence_unavailable';
        }
        prompt = buildFixPrompt({ ...promptArgs, fixContext: hydrated });
      } else {
        prompt = buildImplementerPrompt(promptArgs);
      }
    }
    const launch = {
      profileId: profileIdFor(role),
      cwd,
      attemptDir,
      artifactsDir,
      promptSha256: sha256(prompt),
      configSha256: cfgSha,
    };
    try {
      await send(card, 'begin_attempt', {
        runId: run.id, attemptId, role, phase,
        ...(spec?.validationId ? { validationId: spec.validationId } : {}),
        leaseMs, launch, ...self(),
      }, `ba-${attemptId}`);
    } catch (e) {
      if (isErr(e, 'attempts_exhausted')) {
        // Budget spent — the run cannot launch; we own the last attempt.
        await send(card, 'complete_run', {
          runId: run.id, status: 'failed',
          reason: `attempt budget exhausted (${e.details?.used ?? '?'}/${e.details?.limit ?? '?'})`,
          ...self(),
        }, `cr-${run.id}-exhausted-by-${instanceId}`).catch(() => {});
        return 'exhausted';
      }
      if (isErr(e, 'limit_reached') || isErr(e, 'run_not_launchable')
        || isErr(e, 'attempt_active')) {
        return 'limited';
      }
      throw e;
    }
    // Ordering contract: the attempt row is durable before runtime.start is
    // invoked. The hook lets tests verify it against the service itself.
    // A hook fault is a LOCAL crash — it must classify as an error, never an
    // API outage (a bare Error carries no status/code).
    try {
      await hooks.onAttemptDurable?.({ cardId, runId: run.id, attemptId });
    } catch (e) {
      throw new RuntimeError('hook_failed',
        `onAttemptDurable threw: ${String(e?.message || e).slice(0, 200)}`);
    }

    // STOP-FENCE: re-read the run immediately before invoking the runtime.
    // If a stop/cancel intent landed between begin_attempt and now, the
    // launch must not happen — the attempt is resolved through the
    // never-entered path (we never called start and hold no in-flight one).
    const fresh = await client.getRun(run.id).catch(() => null);
    const freshAtt = (fresh?.attempts || []).find((a) => a && a.id === attemptId) ?? null;
    if (!fresh || !freshAtt) {
      return 'launch_aborted'; // run gone — nothing spawned, nothing to cancel
    }
    if (quiesced || fresh.status === 'stopping' || freshAtt.cancel) {
      // Quiesce lands between begin_attempt and here through the SAME
      // never-entered reconciliation as a stop intent — the durable
      // attempt row is settled/retained by proof, runtime.start is never
      // invoked, nothing is faked terminal.
      return reconcileAttempt(card, fresh, freshAtt, {});
    }

    let launchRes = null;
    const p = runtime.start({
      attemptId,
      profileId: launch.profileId,
      cwd,
      prompt,
      config,
    });
    inflight.set(attemptId, p);
    startedHere.add(attemptId);
    try {
      launchRes = await p;
    } catch (e) {
      launchRes = null;
      await recordEvent(card, run, 'launch_threw',
        { attemptId, error: String(e?.message || e).slice(0, 300) }, attemptId).catch(() => {});
    } finally {
      inflight.delete(attemptId);
    }
    const att = freshAtt;
    att.launch = launch;
    if (launchRes?.ok === true && launchRes.phase === 'launched' && launchRes.porchRunId) {
      if (fresh.status === 'stopping' || att.cancel) {
        // Won the race the other way: the supervisor exists now — bind the
        // cancel duty to it so the exact run id is cancelled.
        await send(card, 'cancel_attempt', {
          runId: run.id, attemptId, porchRunId: launchRes.porchRunId,
          reason: att.cancel?.reason ?? 'stop intent', ...self(),
        }, `cx-${attemptId}-by-${instanceId}`);
        return 'cancel-bound';
      }
      await send(card, 'bind_attempt', {
        runId: run.id, attemptId, porchRunId: launchRes.porchRunId, ...self(),
      }, `bind-${attemptId}-by-${instanceId}`);
      att.porchRunId = launchRes.porchRunId;
      // Immediate first observation while the supervisor is provably live:
      // binds record-once identity + tracked duty + a durable snapshot BEFORE
      // this tick returns. The crash window between runtime.start and the
      // next tick otherwise leaves an orphan with no provable duty/identity.
      const st0 = await runtime.status(att.porchRunId).catch(() => null);
      if (st0?.ok === true) {
        const sup = supervisorIdentity(att, st0);
        if (sup) {
          att.supervisor = sup;
          await send(card, 'observe_attempt', {
            runId: run.id, attemptId, supervisor: sup, ...self(),
          }, `sup-${attemptId}-by-${instanceId}`).catch(() => {});
        }
      }
      trackOwned(cardId, run.id, att);
      await snapshotWrite().catch(() => {});
      return 'launched';
    }
    return reconcileAttempt(card, run, att, { launchRes });
  }

  // ---- observation / cancellation of owned attempts -------------------------

  function mapEventType(t) {
    return typeof t === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(t) ? t : 'runtime_event';
  }

  // Verified supervisor identity: we may only attribute/probe a pid whose
  // identity was recorded through the launch selectors (cwd+artifactsDir are
  // bound server-side) — a bare pid from status() is never trusted to mean
  // "our process", and is NEVER signaled.
  function supervisorIdentity(att, st) {
    if (!Number.isInteger(st?.pid)) return null;
    // NEVER record identity from a terminal status: a supervisor already
    // recycled/exited by first observation would capture the replacement's
    // starttime as "original", self-validating the terminal gate. Identity
    // binds only while the observed status is non-terminal.
    if (st.terminal === true) return null;
    // RECORD-ONCE: durable identity is written on first observation and never
    // rewritten — a recycled/mismatched later status must not overwrite it
    // (the terminal gate compares against the ORIGINAL recording; drift is
    // reported by the caller as a diagnostic instead).
    if (att.supervisor && Number.isInteger(att.supervisor.pid)) return null;
    const proc = st.process && typeof st.process === 'object' ? st.process : null;
    const out = {
      pid: st.pid,
      childPid: Number.isInteger(st.childPid) ? st.childPid : null,
      // Positive no-child attestation ONLY from an explicit immutable spawn
      // declaration (childSpawned===false) — a serialized status childPid
      // field is emitted unconditionally, so its null value is never proof.
      childNone: st.childSpawned === false ? true : undefined,
      cwd: att.launch?.cwd ?? undefined,
      artifactsDir: att.launch?.artifactsDir ?? undefined,
      starttime: proc?.starttime ?? null,
      pidNs: proc?.pidNs ?? null,
      state: proc?.state ?? null,
      backend: st.backend ?? undefined,
    };
    // Child identity is captured only when the child reads positively LIVE
    // and fully readable — a half-visible child is recorded as nothing rather
    // than as an unverifiable identity.
    if (out.childPid !== null) {
      const cp = runtime.processIdentity(out.childPid);
      if (cp && cp.exists === true && cp.readable === true && cp.alive
        && cp.starttime && cp.pidNs) {
        out.childStarttime = cp.starttime;
        out.childPidNs = cp.pidNs;
      }
    }
    return out;
  }

  // Fill-once eligibility for a recorded supervisor whose childPid latched
  // null because the first status raced porch's meta.child_pid write. The
  // status must be NON-terminal (same gate as record-once) and the live
  // supervisor must verify identical to the recording on every identity
  // field that was captured — a recycled or foreign process can never mint
  // a child recording. Recorded children and positive no-child
  // attestations are immutable here by construction.
  function childFillable(sup, st) {
    if (!sup || st.terminal === true) return false;
    if (sup.childPid !== null && sup.childPid !== undefined) return false;
    if (sup.childNone === true) return false;
    if (!Number.isInteger(st.childPid)) return false;
    if (!Number.isInteger(st.pid) || st.pid !== sup.pid) return false;
    const proc = st.process && typeof st.process === 'object' ? st.process : null;
    if (sup.starttime && proc?.starttime !== sup.starttime) return false;
    if (sup.pidNs && proc?.pidNs !== sup.pidNs) return false;
    return true;
  }

  // Drain the porch event log into the durable mirror + advance observer
  // state atomically. Replay-safe: src.i dedups against mirrorCursor.
  async function drainEvents(card, run, att) {
    if (!att.porchRunId) return null;
    const cursor = Number(att.observer?.cursor) || 0;
    const ev = await runtime.events(att.porchRunId, { cursor, maxEvents: OBSERVE_MAX_EVENTS });
    if (!ev || ev.ok !== true) {
      if (ev?.error?.code === 'unknown_run') return { vanished: true };
      return { error: ev?.error?.code ?? 'events_failed' };
    }
    const observer = {
      cursor: ev.nextCursor ?? cursor,
      lastStatusAt: now(),
      ...(ev.status !== undefined ? { lastStatus: ev.status } : {}),
    };
    if (ev.cursorReset) observer.mirrorReset = true;
    const events = (ev.events || []).map((e, i) => ({
      type: mapEventType(e?.type),
      data: e?.data !== undefined ? e.data : (e && typeof e === 'object' ? e : null),
      src: { i: cursor + i },
    }));
    await send(card, 'observe_attempt', {
      runId: run.id, attemptId: att.id, observer, events, ...self(),
    });
    att.observer = { ...(att.observer || {}), ...observer, mirrorReset: undefined };
    if (observer.mirrorReset) att.observer.mirrorCursor = 0;
    return { nextCursor: observer.cursor, count: events.length, terminal: ev.terminal, status: ev.status };
  }

  // ---- shared recorded-process death proof -----------------------------------
  // The ONE place a RECORDED process identity may be classified dead — the
  // terminal gate (probe carried inside status.process) and the registry-
  // vanished path (a live processIdentity probe of the recorded pid) share
  // this tri-state so they can never diverge:
  //   'dead'             — absent | zombie | positively recycled (the probe
  //                        read a DIFFERENT immutable starttime than recorded)
  //   'alive'            — positively readable+live; recorded starttime
  //                        matches or was never captured
  //   'foreign_ns'       — the recorded pid namespace is absent or not ours;
  //                        a foreign/unbound pid is NEVER probed
  //   'missing_identity' — no recorded pid
  //   'unverifiable'     — everything else (exists:null, unreadable, partial
  //                        fields) — never proof, always retained
  // `recNs` binds the namespace the pid was RECORDED in; the caller supplies
  // it from the record-once identity or the owner envKey, never from the
  // current probe alone.
  // `probe` may be a probe object OR a thunk returning one — a thunk is
  // invoked ONLY after the recorded pid + namespace binding pass, so a
  // missing/foreign recorded namespace is never probed at all.
  function classifyRecordedProcess(recPid, recStart, recNs, probe) {
    if (!Number.isInteger(recPid)) return 'missing_identity';
    const mine = selfEnv();
    if (!recNs || recNs !== mine.pidNs) return 'foreign_ns';
    const p = typeof probe === 'function' ? probe() : probe;
    if (!p || typeof p !== 'object') return 'unverifiable';
    if (p.pidNs && p.pidNs !== recNs) return 'foreign_ns';
    if (p.exists === false) return 'dead';
    if (p.exists === true && p.state === 'Z') return 'dead';
    if (p.exists === true && p.readable === true && recStart
      && p.starttime && p.starttime !== recStart) return 'dead';
    if (p.exists === true && p.readable === true && p.alive
      && (!recStart || p.starttime === recStart)) return 'alive';
    return 'unverifiable';
  }

  // Shared recorded-CHILD proof — probed LIVE via runtime.processIdentity in
  // its RECORDED namespace (a status-reported child id was never verified
  // live and is never probed). 'No recorded child' is NOT proof of none:
  // only the immutable spawn-time attestation recorded while live
  // (recorded.childNone) proves no child exists — a missed pre-observation
  // window or a runtime that never reports children is 'child_unknown' and
  // retains. {ok:true} | {ok:false, code, detail}.
  function recordedChildDeath(recorded) {
    const recChild = Number.isInteger(recorded?.childPid) ? recorded.childPid : null;
    if (recChild === null) {
      return recorded?.childNone === true
        ? { ok: true }
        : { ok: false, code: 'child_unknown',
          detail: 'no recorded child identity and no immutable no-child attestation' };
    }
    const mine = selfEnv();
    if (!mine.pidNs || recorded.childPidNs !== mine.pidNs) {
      return { ok: false, code: 'child_ns_unproven',
        detail: 'recorded child namespace is absent or foreign — never probed' };
    }
    const cls = classifyRecordedProcess(recChild,
      recorded.childStarttime ?? null, recorded.childPidNs,
      () => runtime.processIdentity(recChild));
    if (cls === 'dead') return { ok: true };
    if (cls === 'alive') {
      return { ok: false, code: 'child_alive',
        detail: `recorded child pid ${recChild} still live` };
    }
    return { ok: false, code: 'child_unverifiable' };
  }

  // Full recorded-supervisor+child death proof — the shared gate used by
  // both terminal observation and the registry-vanished path. `recorded` =
  // the durable identity {pid, starttime, pidNs, childPid, childStarttime,
  // childPidNs}; `supProbe` = {exists, readable, state, alive, starttime,
  // pidNs} from status.process or a live processIdentity. Owner-env binding
  // (envKey uid/gid/host/boot/pidNs + envInstance+generation == ours) is the
  // caller's precondition — this function never accepts foreign probes.
  // Returns {ok:true} | {ok:false, code, detail} — nothing falls through.
  function recordedProcessDeath(recorded, supProbe) {
    const cls = classifyRecordedProcess(recorded?.pid,
      recorded?.starttime ?? null, recorded?.pidNs ?? null, supProbe);
    if (cls !== 'dead') {
      return { ok: false, code: cls,
        detail: cls === 'alive' && recorded
          ? `recorded pid ${recorded.pid} still live` : null };
    }
    return recordedChildDeath(recorded);
  }

  // POSITIVE TERMINAL GATE — terminal metadata is never sufficient while a
  // supervisor or its recorded child is alive or unverifiable. Order of
  // proof, each step mandatory:
  //   1. ENV BINDING: the attempt's recorded original environment (uid/gid/
  //      host/boot/pidNs AND envInstance+generation) must equal ours. A
  //      foreign recorded namespace is NEVER probed — its pids can read
  //      "absent" here while alive. A retired original env (ops record bound
  //      to the exact envInstance+generation) is itself positive proof.
  //   2. IDENTITY: the status-reported pid must MATCH the durably recorded
  //      supervisor identity (att.supervisor, captured while live). A status
  //      with no pid at all terminalizes only via never-entered proof or a
  //      retired env — mailboxClosed alone is not process death.
  //   3. DEATH (explicit tri-state — nothing falls through):
  //      exists===false                 → absent in our (=recorded) namespace
  //      exists===true && state==='Z'   → zombie
  //      exists===true && readable && recorded starttime && starttime differs
  //                                     → positively recycled pid
  //      exists===true && readable && alive && starttime matches/unknown
  //                                     → the RECORDED process is still live
  //      anything else (exists:null, unreadable, partial fields) → unknown.
  //   4. RECORDED CHILD: the recorded child pid is probed in its RECORDED
  //      namespace (sup.childPidNs must equal ours before any probe); a
  //      status-reported child that was never recorded, or a childPid that
  //      doesn't match the recording, is unverifiable — never probed.
  // Returns {ok:true} | {ok:false, code, detail}.
  async function terminalProof(att, st) {
    if (!st || st.ok !== true || st.terminal !== true) {
      return { ok: false, code: 'not_terminal' };
    }
    const mine = selfEnv();
    const own = att?.owner ?? null;
    if (!own || !envKeyEqual(own.envKey, mine)
      || !envInstanceEqual(own.envInstance, selfEnvInstance())) {
      // Foreign/originless attempt — the only remaining proof is an
      // ops-verified retirement record for its exact envInstance+generation.
      const retired = own ? await retiredProofFor(own) : null;
      if (retired) return { ok: true, via: 'environment_retired' };
      return { ok: false, code: 'foreign_env',
        detail: 'attempt was recorded in a different environment — its processes are never probed here' };
    }
    const sup = att.supervisor && typeof att.supervisor === 'object' ? att.supervisor : null;
    // Identity sources, strongest first: the record-once supervisor identity
    // captured while the process was live (durable on the attempt), then the
    // bound run record's own immutable fields (st.pid / recordedPidStarttime
    // are written by the registry at spawn, not derived from the live probe).
    // The CURRENT probe's starttime is never its own identity evidence.
    const recPid = Number.isInteger(sup?.pid) ? sup.pid
      : (Number.isInteger(st.pid) ? st.pid : null);
    if (Number.isInteger(sup?.pid) && Number.isInteger(st.pid) && sup.pid !== st.pid) {
      return { ok: false, code: 'supervisor_id_mismatch',
        detail: `status reports pid ${st.pid}, recorded supervisor is ${sup.pid}` };
    }
    if (recPid === null) {
      // No supervisor identity anywhere: only never-entered proof (dir
      // absent + no in-flight start + own launch) terminalizes.
      if (await neverEnteredProof(att)) return { ok: true, via: 'never_entered' };
      return { ok: false, code: 'supervisor_unproven',
        detail: 'terminal metadata but no supervisor identity recorded' };
    }
    const p = st.process && typeof st.process === 'object' ? st.process : null;
    if (!p) {
      return { ok: false, code: 'supervisor_unproven', detail: 'no process probe in status' };
    }
    // Shared tri-state — the same classifier the registry-vanished path
    // uses against a live probe. `recNs` falls back to the owner envKey's
    // recorded namespace (the attempt's original environment); absent →
    // 'foreign_ns' and nothing is probed.
    const recStart = sup?.starttime ?? st.recordedPidStarttime ?? null;
    const recNs = sup?.pidNs ?? own.envKey?.pidNs ?? null;
    const cls = classifyRecordedProcess(recPid, recStart, recNs, p);
    if (cls === 'foreign_ns') {
      return { ok: false, code: 'supervisor_foreign_ns' };
    }
    if (cls === 'alive') {
      return { ok: false, code: 'supervisor_alive',
        detail: `terminal metadata but supervisor pid ${recPid} still live` };
    }
    if (cls !== 'dead') {
      return { ok: false, code: 'supervisor_unverifiable' };
    }
    const recChild = Number.isInteger(sup?.childPid) ? sup.childPid : null;
    if (recChild !== null && Number.isInteger(st.childPid) && st.childPid !== recChild) {
      return { ok: false, code: 'child_id_mismatch',
        detail: `status reports child ${st.childPid}, recorded child is ${recChild}` };
    }
    if (recChild === null && Number.isInteger(st.childPid)) {
      return { ok: false, code: 'child_unproven',
        detail: 'status reports a child that was never recorded while live' };
    }
    // EVERY terminal proof requires the recorded-child gate — a supervisor
    // with NO recorded child proves nothing without the immutable
    // no-child attestation; null is never silently "no child". The
    // attestation may come from the record-once supervisor (sup.childNone,
    // bound while live) or from this status's own explicit spawn
    // declaration (st.childSpawned===false) — a bare serialized null
    // childPid field attests nothing.
    const cd = recordedChildDeath({
      childPid: recChild,
      childStarttime: sup?.childStarttime ?? null,
      childPidNs: sup?.childPidNs ?? null,
      childNone: sup?.childNone === true || st.childSpawned === false,
    });
    if (!cd.ok) return cd;
    return { ok: true };
  }

  // Persist final output through the staged-artifact path (runner writes the
  // staging area; the SERVICE imports it inside the serialized queue with a
  // hash check — no direct store writes). Secrets never pass: the payload
  // is the agent-visible final text only.
  const artifactRetries = new Map(); // attemptId -> failed commit count
  async function commitFinalArtifact(card, run, att, finalText) {
    const staged = await writeStagedArtifact(stateDir, att.id, `final-${att.id}.txt`, finalText);
    const artifact = {
      id: `art-${att.id}`, kind: 'final',
      file: `final-${att.id}.txt`, bytes: staged.bytes, sha256: staged.sha256,
    };
    await send(card, 'commit_artifact', {
      runId: run.id, attemptId: att.id, artifact,
      stagedPath: staged.stagedPath, ...self(),
    }, `ca-${att.id}-final-by-${instanceId}`);
    return artifact.id;
  }

  // Persist final output (no secrets — the agent-visible final text only)
  // and resolve the attempt with result metadata. Artifact persistence is a
  // hard precondition: ANY commit failure keeps the attempt nonterminal with
  // a durable blocked diagnostic — the evidence is never discarded by a
  // retry counter. Failure count rides the tracked snapshot so a restart
  // preserves both the duty and the diagnosis; an operator who remedies the
  // storage fault sees the resolve complete with the full result.
  async function resolveTerminal(card, run, att, { status, exitCode, runExitCode, error, durationS, finalText }) {
    let finalArtifactId = null;
    if (stateDir && typeof finalText === 'string' && finalText.length) {
      try {
        finalArtifactId = await commitFinalArtifact(card, run, att, finalText);
      } catch (e) {
        const tr = tracked.get(att.id);
        const n = ((tr?.artifactFails ?? artifactRetries.get(att.id)) || 0) + 1;
        artifactRetries.set(att.id, n);
        if (tr) tr.artifactFails = n; // survives restart via snapshotWrite
        await recordEvent(card, run, 'artifact_write_failed', {
          attemptId: att.id, tries: n,
          error: String(e?.code || e?.message || e).slice(0, 200),
          required: true,
        }, att.id).catch(() => {});
        return 'artifact_blocked';
      }
    }
    const outcome = status === 'completed' ? 'completed'
      : status === 'cancelled' ? 'cancelled' : 'failed';
    const stopping = run.status === 'stopping' || !!att.cancel;
    // U4 park state: a terminal IMPLEMENTER moves the run's PHASE to
    // 'awaiting_validation' while the run stays 'active'. A reviewer/checker
    // completion leaves the phase exactly where the validation gate put it
    // — the role phases are advanced only by record_report.
    let runStatus = null;
    let runPhase;
    if (stopping) {
      runStatus = run.priorTerminal ?? 'cancelled';
    } else if (outcome === 'completed') {
      if (att.role === 'implementer') runPhase = 'awaiting_validation';
    } else if (outcome === 'failed') {
      runStatus = 'failed';
    } else {
      runStatus = 'interrupted'; // system-initiated cancel without a stop intent
    }
    await send(card, 'resolve_attempt', {
      runId: run.id, attemptId: att.id,
      outcome,
      ...(runStatus !== null && runStatus !== undefined ? { runStatus } : {}),
      ...(runPhase ? { runPhase } : {}),
      reason: stopping
        ? (att.cancel?.reason ?? 'stopped')
        : (error ?? (outcome === 'completed' ? 'agent finished' : 'agent failed')),
      result: {
        status: status ?? null,
        exitCode: runExitCode ?? exitCode ?? null,
        durationS: durationS ?? null,
        finalArtifactId,
        summary: typeof finalText === 'string' ? finalText.slice(0, 1500) : null,
      },
      ...self(),
    }, `rs-${att.id}-terminal-by-${instanceId}`);
    return outcome;
  }

  // Cancel an owned attempt: intent -> runtime.cancel by run id -> observe
  // until actual terminal. Nothing here terminalizes without observation.
  async function cancelOwnedAttempt(card, run, att, reason) {
    // Environment binding BEFORE any probing/cancel: an attempt recorded in
    // a different env/pid-namespace is never touched from here.
    if (!envKeyEqual(att.owner?.envKey ?? null, selfEnv())
      || !envInstanceEqual(att.owner?.envInstance ?? null, selfEnvInstance())) {
      return 'foreign';
    }
    // Durable intent first (idempotent — stop already wrote att.cancel).
    if (!att.cancel) {
      await send(card, 'cancel_attempt', {
        runId: run.id, attemptId: att.id, reason, ...self(),
      }, `cx-${att.id}-by-${instanceId}`);
      att.cancel = { requestedAt: now(), by: `${runnerId}:${instanceId}`, reason };
      att.status = 'cancelling';
    }
    if (att.status === 'launching' || !att.porchRunId) {
      // Maybe-supervisor-unknown: reconcile to find a late registration.
      const r = await reconcileAttempt(card, run, att, {});
      if (r === 'cancelled') return 'cancelled';
      if (r !== 'cancel-bound') return r; // stayed/blocked — nothing to signal
    }
    if (!att.porchRunId) return 'stayed';
    // Terminal observation FIRST — a run that already finished preserves its
    // OBSERVED outcome; a cancel dispatch failure against a dead run is not
    // a retry loop, and `already_terminal` is itself evidence to verify.
    const st0 = await runtime.status(att.porchRunId).catch(() => null);
    if (st0?.ok && st0.terminal) {
      const proof = await terminalProof(att, st0);
      if (!proof.ok) {
        await recordEvent(card, run, 'cancel_pending',
          { attemptId: att.id, error: `terminal_unproven:${proof.code}`,
            detail: proof.detail ?? null }, att.id).catch(() => {});
        return 'cancel_pending_unproven';
      }
      const h = await harvestTerminal(att.porchRunId, st0);
      if (!h.ok) {
        await recordEvent(card, run, 'cancel_pending',
          { attemptId: att.id, error: `terminal_unproven:${h.code}`,
            detail: h.detail ?? null }, att.id).catch(() => {});
        return 'cancel_pending_unproven';
      }
      return resolveTerminal(card, run, att, {
        // The observed outcome wins — a late cancel never overwrites a real
        // completed/failed result; the run-level status still reflects the
        // stop intent via resolveTerminal's stopping branch.
        status: st0.status ?? 'cancelled',
        exitCode: st0.exitCode ?? h.wt.exitCode ?? null,
        runExitCode: h.wt.runExitCode ?? null,
        error: st0.error ?? h.wt.error ?? null,
        durationS: h.wt.durationS ?? null,
        finalText: h.wt.finalText ?? null,
      });
    }
    if (st0 && st0.ok === false && st0.error?.code === 'unknown_run') {
      // Registry entry vanished while a process may still exist — retain
      // the reservation and keep diagnosing; never signal anything.
      await recordEvent(card, run, 'cancel_pending',
        { attemptId: att.id, error: 'registry_vanished' }, att.id).catch(() => {});
      return 'cancel_retry';
    }
    if (!att.cancel.dispatched) {
      const res = await runtime.cancel(att.porchRunId).catch((e) => ({
        requested: false, error: { code: e?.code || 'cancel_failed', message: String(e?.message || e) },
      }));
      if (!res || res.requested !== true) {
        // Cancel request failed (and the run is not terminal) — durable
        // diagnostic, stay cancelling, retry next tick.
        await recordEvent(card, run, 'cancel_pending',
          { attemptId: att.id, error: res?.error?.code ?? 'unreachable' }, att.id).catch(() => {});
        return 'cancel_retry';
      }
      await send(card, 'cancel_attempt', {
        runId: run.id, attemptId: att.id, dispatched: true, ...self(),
      }, `cxd-${att.id}-by-${instanceId}`).catch(() => {});
      att.cancel.dispatched = true;
    }
    return 'cancelling';
  }

  // Stuck detection per AGENTS — Pi-specific recovery, strictly positive:
  //   * ONLY for pi-cli members (other harnesses get no auto stuck-cancel);
  //   * the probe target is the RECORDED immutable Pi child (childPid +
  //     childStarttime + recorded pidNs === ours, verified live right now),
  //     never the porch supervisor and never a foreign/recycled pid;
  //   * a sample counts only when EVERY evidence channel is positively
  //     observed: finite ioSum+cpuSum deltas of exactly 0, the bound session
  //     jsonl shows zero byte growth (sessionLog verified by attempt cwd+id),
  //     AND the syscall is a positively-verified epoll wait — on BOTH samples
  //     (a single parked read isn't continuous evidence);
  //   * ANY missing/null/NaN metric, unreadable probe, absent session log,
  //     or non-epoll syscall makes the sample unknown — never stuck;
  //   * the window is measured on the injected clock (now()) and resets via
  //     an explicit null stuckSince (movement re-arms, never accumulates).
  const EPOLL_SYSCALLS = new Set(['232', '407', 'epoll_wait', 'epoll_pwait', 'epoll_pwait2', 'ep_poll']);
  async function stuckCheck(card, run, att) {
    const role = att.role || 'implementer';
    const cli = run.composition?.preset?.members?.[role]?.cli
      ?? run.composition?.preset?.members?.implementer?.cli;
    if (cli !== 'pi') return null; // non-Pi member — no Pi-specific recovery
    // A recorded stuck window only survives a CONTINUOUS run of fully-valid
    // stalled samples — any gap (identity unknown, metrics unreadable,
    // session log missing, non-epoll syscall) durably resets it so a later
    // valid stalled sample cannot count the unknown span as idle time.
    const resetWindow = async () => {
      if (!att.observer?.stuckSince) return;
      await send(card, 'observe_attempt', {
        runId: run.id, attemptId: att.id, observer: { stuckSince: null }, ...self(),
      }).catch(() => {});
    };
    const sup = att.supervisor;
    const mine = selfEnv();
    const childPid = sup && Number.isInteger(sup.childPid) ? sup.childPid : null;
    // Positive live binding of the RECORDED child before any probe — a child
    // recorded without starttime/namespace can never prove identity.
    if (childPid === null || !sup.childStarttime || !sup.childPidNs
      || sup.childPidNs !== mine.pidNs) {
      await resetWindow();
      return null;
    }
    const idp = runtime.processIdentity(childPid);
    if (!idp || idp.exists !== true || idp.readable !== true
      || !idp.starttime || idp.starttime !== sup.childStarttime) {
      await resetWindow(); // child gone/recycled/unverifiable — window dies
      return null;
    }
    const a = await runtime.activity(childPid).catch(() => null);
    const sl = runtime.sessionLog
      ? await runtime.sessionLog(att.id).catch(() => null)
      : null;
    const cur = {
      at: now(),
      ioSum: a && a.exists === true && a.readable === true && Number.isFinite(a.ioSum)
        ? a.ioSum : null,
      cpuSum: a && a.exists === true && a.readable === true && Number.isFinite(a.cpuSum)
        ? a.cpuSum : null,
      sessionBytes: sl && sl.ok === true && Number.isFinite(sl.bytes)
        ? sl.bytes : null,
      syscall: a && a.exists === true && a.readable === true
        && typeof a.syscall === 'string' ? a.syscall : null,
    };
    const prev = att.observer?.probe;
    const obs = { probe: cur };
    let stuck = false;
    const epollNow = cur.syscall !== null && EPOLL_SYSCALLS.has(cur.syscall);
    if (Number.isFinite(cur.ioSum) && Number.isFinite(cur.cpuSum)
      && Number.isFinite(cur.sessionBytes)
      && prev && Number.isFinite(prev.at)
      && Number.isFinite(prev.ioSum) && Number.isFinite(prev.cpuSum)
      && Number.isFinite(prev.sessionBytes)
      && typeof prev.syscall === 'string' && EPOLL_SYSCALLS.has(prev.syscall)) {
      const stalled = epollNow
        && cur.ioSum === prev.ioSum
        && cur.cpuSum === prev.cpuSum
        && cur.sessionBytes === prev.sessionBytes;
      if (stalled) {
        const since = Number(att.observer?.stuckSince) || cur.at;
        if (!Number(att.observer?.stuckSince)) obs.stuckSince = since;
        if (cur.at - since >= stuckMs) stuck = true;
      } else {
        obs.stuckSince = null; // explicit reset — movement re-arms the window
      }
    } else {
      // Unknown sample — never count it, never let a stale window persist.
      obs.stuckSince = null;
    }
    await send(card, 'observe_attempt', {
      runId: run.id, attemptId: att.id, observer: obs, ...self(),
    }).catch(() => {});
    if (stuck) {
      await recordEvent(card, run, 'stuck_detected',
        { attemptId: att.id, pid: childPid, windowMs: stuckMs, syscall: cur.syscall },
        att.id).catch(() => {});
      // Recovery for managed U4 = stop-equivalent: cancel intent, then the
      // normal observe-until-terminal path decides the outcome.
      return cancelOwnedAttempt(card, run, att, 'stuck: no progress, epoll-parked, zero IO/CPU');
    }
    return null;
  }

  // A live attempt exists: heartbeat if ours; then observe/cancel as the
  // attempt's durable state demands. Never frees a slot by inference alone.
  // Tracking for outage continuity must reflect the FRESHEST durable view —
  // after the heartbeat refreshed the lease and after observe_attempt landed
  // the identity — while preserving the buffered journal cursor/cancel state
  // an overwrite would drop. Entries merge; cursor only ever moves forward.
  function trackOwned(cardId, runId, att) {
    const prev = tracked.get(att.id) || {};
    tracked.set(att.id, {
      ...prev,
      cardId, runId, attemptId: att.id,
      porchRunId: att.porchRunId ?? prev.porchRunId ?? null,
      leaseUntil: att.owner?.leaseUntil ?? prev.leaseUntil ?? null,
      owned: true,
      supervisor: att.supervisor ?? prev.supervisor ?? null,
      owner: att.owner ?? prev.owner ?? null,
      cursor: Math.max(prev.cursor ?? 0, att.observer?.cursor ?? 0),
      cancelSent: prev.cancelSent === true || att.cancel?.dispatched === true,
    });
  }

  // Harvesting a terminal observation: wait() MUST succeed (it carries
  // runExitCode/durationS/finalText evidence), and a 'completed' run must
  // carry its final result. Anything less means required evidence exists but
  // was not captured — diagnose and RETAIN; the attempt never resolves on a
  // result that should exist but wasn't captured.
  async function harvestTerminal(porchRunId, st) {
    const wt = await runtime.wait(porchRunId, { timeoutSec: 0 }).catch(() => null);
    if (!wt || wt.ok !== true || wt.terminal !== true) {
      return { ok: false, code: 'result_unavailable',
        detail: `wait() ${wt?.ok === false ? wt.error?.code ?? 'failed' : 'unreachable'} — terminal evidence unharvested` };
    }
    if (st.status === 'completed'
      && wt.finalAvailable !== true && typeof wt.finalText !== 'string') {
      return { ok: false, code: 'result_missing',
        detail: 'run completed but no final result was recorded — refusing to resolve without evidence' };
    }
    return { ok: true, wt };
  }

  async function resumeAttempt(card, run, att) {
    const cardId = card.cardId;
    if (owns(att.owner)) {
      if (inflight.has(att.id)) {
        // Our own start() is still in flight for this attempt — NEVER
        // classify absence-of-dir/registry as proof while it is.
        return 'launch_inflight';
      }
      try {
        const hb = await send(card, 'heartbeat', {
          attempts: [{ runId: run.id, attemptId: att.id }], leaseMs, ...self(),
        }).catch(() => null);
        if (hb && att.owner) {
          // The durable lease is whatever the SERVER recorded (its clock and
          // its clamp, not ours) — carry the exact authoritative value so
          // outage tracking snapshots the real lease. A response without a
          // leaseUntil keeps the last durably recorded one; a snapshot never
          // invents a lease value from local time.
          const dur = Number.isInteger(hb.leaseUntil) ? hb.leaseUntil
            : (att.owner.leaseUntil ?? null);
          att.owner = { ...att.owner, leaseUntil: dur };
        }
        if (att.cancel || run.status === 'stopping') {
          return cancelOwnedAttempt(card, run, att, att.cancel?.reason ?? 'stop intent');
        }
        if (att.status === 'launching') {
          return reconcileAttempt(card, run, att, {});
        }
      // running (bound supervisor): drain events, record identity, then
      // status — terminal observation resolves the attempt.
      if (att.porchRunId) {
        const d = await drainEvents(card, run, att).catch(() => null);
        if (d?.vanished) {
          await recordEvent(card, run, 'supervisor_vanished',
            { attemptId: att.id, porchRunId: att.porchRunId }, att.id).catch(() => {});
          // A vanished registry record terminalizes ONLY on positive
          // recorded-process death in the attempt's ORIGINAL environment —
          // the same shared proof the terminal gate uses: the owner env
          // bound to ours (envKey uid/gid/host/boot/pidNs AND envInstance+
          // generation), the recorded supervisor identity (pid + immutable
          // recorded starttime + recorded pidNs — a MISSING namespace never
          // falls back and is never probed) absent/zombie/positively
          // recycled, and the recorded child dead the same way. Alive or
          // unverifiable evidence retains the duty — a missing record alone
          // is never death proof and nothing foreign is signalled.
          const own = att.owner ?? null;
          const envBound = !!own
            && envKeyEqual(own.envKey ?? null, selfEnv())
            && envInstanceEqual(own.envInstance ?? null, selfEnvInstance());
          const sup = att.supervisor && typeof att.supervisor === 'object'
            ? att.supervisor : null;
          let proof;
          if (!envBound) {
            // Foreign/originless recorded env — NEVER probed here. The only
            // remaining proof is an ops-verified retirement of the exact
            // recorded envInstance+generation (the whole environment is
            // gone → nothing inside it, supervisor or child, still runs).
            const retired = own ? await retiredProofFor(own) : null;
            proof = retired
              ? { ok: true, via: 'environment_retired' }
              : { ok: false, code: 'foreign_env',
                detail: 'owner env is not ours — recorded pids are never probed' };
          } else {
            // The probe is a THUNK — classifyRecordedProcess evaluates it
            // only after the recorded pid + namespace binding pass, so a
            // missing or foreign recorded pidNs is never probed at all.
            proof = recordedProcessDeath({
              pid: sup?.pid ?? null,
              starttime: sup?.starttime ?? null,
              pidNs: sup?.pidNs ?? null,
              childPid: sup?.childPid ?? null,
              childStarttime: sup?.childStarttime ?? null,
              childPidNs: sup?.childPidNs ?? null,
              childNone: sup?.childNone === true,
            }, () => runtime.processIdentity(sup?.pid));
          }
          if (proof.ok) {
            // A recorded stop intent keeps ITS outcome — positive death
            // under a cancel resolves 'cancelled' (restoring any prior
            // terminal status), never 'interrupted'.
            const stopping = run.status === 'stopping' || !!att.cancel;
            const outcome = stopping ? 'cancelled' : 'interrupted';
            const runStatus = stopping
              ? (run.priorTerminal ?? 'cancelled') : 'interrupted';
            const reason = att.cancel?.reason
              ?? (proof.via === 'environment_retired'
                ? 'owner environment retired; registry record gone'
                : `supervisor vanished; pid ${sup?.pid} positively dead`);
            await send(card, 'resolve_attempt', {
              runId: run.id, attemptId: att.id, outcome, runStatus,
              reason,
              ...self(),
            }, `rs-${att.id}-vanished-by-${instanceId}`);
            // complete_run carries OUR owner identity (its owner gate
            // requires it) and the result is inspected — an unexpected
            // refusal is a durable diagnostic, never swallowed.
            try {
              await send(card, 'complete_run', {
                runId: run.id, status: runStatus,
                reason: att.cancel?.reason
                  ?? 'supervisor vanished (positive process death)',
                ...self(),
              }, `cr-${run.id}-vanished-by-${instanceId}`);
            } catch (e) {
              // The resolve already terminalized the run, so a same-status
              // replay is idempotent; a differing terminal status means
              // another writer landed first — only genuinely unexpected
              // refusals (not_attempt_owner etc.) are diagnosed.
              if (!isErr(e, 'run_terminal') && !isErr(e, 'attempt_active')) {
                await recordEvent(card, run, 'run_finalize_failed',
                  { attemptId: att.id, code: e?.code ?? 'unknown',
                    detail: String(e?.message ?? e).slice(0, 300) },
                  att.id).catch(() => {});
              }
            }
            return 'resolved';
          }
          await recordEvent(card, run, 'vanished_unproven',
            { attemptId: att.id, code: proof.code,
              detail: proof.detail ?? null }, att.id).catch(() => {});
          return 'vanished';
        }
        const st = await runtime.status(att.porchRunId).catch(() => null);
        if (st?.ok) {
          const sup = supervisorIdentity(att, st);
          if (sup) {
            await send(card, 'observe_attempt', {
              runId: run.id, attemptId: att.id,
              observer: { lastStatus: st.status ?? undefined, lastStatusAt: now() },
              supervisor: sup, ...self(),
            }).catch(() => {});
            att.supervisor = sup; // local copy for tracked/snapshot fidelity
          } else if (att.supervisor && Number.isInteger(st.pid)
            && (st.pid !== att.supervisor.pid
              || (att.supervisor.starttime && st.process?.starttime
                && st.process.starttime !== att.supervisor.starttime))) {
            // A pid/starttime drift against the RECORDED identity: never
            // rewrite it — surface the drift as a durable diagnostic.
            await recordEvent(card, run, 'supervisor_identity_drift', {
              attemptId: att.id, recordedPid: att.supervisor.pid,
              recordedStarttime: att.supervisor.starttime ?? null,
              reportedPid: st.pid, reportedStarttime: st.process?.starttime ?? null,
            }, att.id).catch(() => {});
          } else if (childFillable(att.supervisor, st)) {
            // FILL-ONCE (not rewrite): porch writes meta.child_pid in a
            // second meta update AFTER adapter.start() — a status read
            // inside that gap reports child_pid absent and record-once
            // latches null forever, stranding terminalProof on
            // child_unproven (observed: codex run_wild-kestrel-4a83).
            // A child first disclosed by a NON-terminal status while the
            // recorded supervisor verifies pid+starttime+pidNs identical
            // IS "recorded while live" — same binding strength as the
            // first-observation path. Terminal-time disclosure stays
            // unproven (a dead-process pid can never be live-bound);
            // childNone attestations and any recorded childPid are never
            // touched.
            const cp = runtime.processIdentity(st.childPid);
            if (cp && cp.exists === true && cp.readable === true
                && cp.alive && cp.starttime && cp.pidNs) {
              const fill = {
                childPid: st.childPid,
                childStarttime: cp.starttime,
                childPidNs: cp.pidNs,
              };
              await send(card, 'observe_attempt', {
                runId: run.id, attemptId: att.id,
                observer: { lastStatus: st.status ?? undefined,
                            lastStatusAt: now() },
                supervisor: fill, ...self(),
              }).catch(() => {});
              Object.assign(att.supervisor, fill);
            }
          }
          if (st.terminal) {
            const proof = await terminalProof(att, st);
            if (!proof.ok) {
              // Metadata says done, the process disagrees — retain the
              // reservation and keep the durable diagnosis; never resolve.
              await recordEvent(card, run, 'terminal_unproven',
                { attemptId: att.id, code: proof.code, detail: proof.detail ?? null },
                att.id).catch(() => {});
              return 'terminal_unproven';
            }
            const h = await harvestTerminal(att.porchRunId, st);
            if (!h.ok) {
              // Terminal proven but the result evidence isn't captured —
              // never resolve a completed run while its result is missing.
              await recordEvent(card, run, 'terminal_unproven',
                { attemptId: att.id, code: h.code, detail: h.detail ?? null },
                att.id).catch(() => {});
              return 'result_unavailable';
            }
            return resolveTerminal(card, run, att, {
              status: st.status, exitCode: st.exitCode,
              runExitCode: h.wt.runExitCode ?? null,
              error: st.error ?? h.wt.error ?? null,
              durationS: h.wt.durationS ?? null,
              finalText: h.wt.finalText ?? null,
            });
          }
          const s = await stuckCheck(card, run, att);
          if (s) return s;
        }
        // Role timeout — cancels the owned attempt, durable reason; the
        // normal observe-until-terminal path decides the outcome.
        const timeoutMin = Number(run.composition?.preset?.limits?.timeoutMin) || 45;
        if (att.startedAt && now() - att.startedAt > timeoutMin * 60_000) {
          await recordEvent(card, run, 'role_timeout',
            { attemptId: att.id, timeoutMin }, att.id).catch(() => {});
          return cancelOwnedAttempt(card, run, att, `role timeout ${timeoutMin}min`);
        }
      }
      return 'observed';
      } finally {
        // Tracking snapshots the POST-observation durable view: refreshed
        // lease, newly recorded supervisor identity, preserved journal
        // cursor/cancel state — a restart mid-outage inherits exactly this.
        trackOwned(cardId, run.id, att);
      }
    }
    const proof = await adoptionProofFor(att.owner);
    if (!proof) return 'foreign'; // live/unverifiable foreign owner — hands off
    // 'environment_lost' (bootId changed) and 'environment_retired' (ops
    // record) prove the whole environment is gone — but so does
    // 'process_dead' when the dead owner process WAS the recorded
    // environment's init: envInstance.initStarttime is pid-1's starttime by
    // construction, so an init-death proof means every process inside the
    // environment died with it. Without this leg an adopted attempt keeps a
    // supervisor identity recorded in the dead namespace (pidNs that can
    // never be probed) and stays unproven-terminal forever.
    const ownerWasInit = att.owner?.pidStarttime != null
      && att.owner?.envInstance?.initStarttime != null
      && String(att.owner.pidStarttime)
        === String(att.owner.envInstance.initStarttime);
    const envGone = proof.kind === 'environment_lost'
      || proof.kind === 'environment_retired'
      || (proof.kind === 'process_dead' && ownerWasInit);
    let retiredResult = null;
    if (envGone && att.porchRunId) {
      // The dead environment proves physical settlement, but may have
      // finished and persisted its result before the owner disappeared.
      // Read before adoption so an observation failure retains the original
      // owner/death proof for a later retry instead of losing that proof.
      const st = await runtime.status(att.porchRunId).catch(() => null);
      if (!st?.ok) return 'retired_result_retry';
      if (st.terminal && ['completed', 'failed', 'cancelled'].includes(st.status)) {
        const h = await harvestTerminal(att.porchRunId, st);
        if (!h.ok) return 'retired_result_retry';
        retiredResult = {
          status: st.status, exitCode: st.exitCode,
          runExitCode: h.wt.runExitCode ?? null,
          error: st.error ?? h.wt.error ?? null,
          durationS: h.wt.durationS ?? null, finalText: h.wt.finalText ?? null,
        };
      }
    }
    try {
      await send(card, 'adopt_attempt', {
        runId: run.id, attemptId: att.id, proof, leaseMs, ...self(),
      }, `ad-${att.id}-by-${instanceId}`);
    } catch (e) {
      if (isErr(e, 'ownership_unproven') || isErr(e, 'not_attempt_owner')
        || isErr(e, 'attempt_terminal')) {
        return 'foreign';
      }
      throw e;
    }
    if (envGone) {
      if (retiredResult) return resolveTerminal(card, run, att, retiredResult);
      // Whole-environment retirement is proven (bootId changed, or an
      // ops-verified retirement record exists for the exact envInstance):
      // nothing in the old env survives, no detached supervisor can exist —
      // mark the attempt AND the run interrupted WITHOUT probing or
      // signaling old pids (foreign addresses are never touched). An
      // interrupted run is NOT auto-relaunched — explicit continue governs
      // what happens next.
      await send(card, 'resolve_attempt', {
        runId: run.id, attemptId: att.id, outcome: 'interrupted',
        reason: `owner environment retired (${proof.kind})`, ...self(),
      }, `rs-${att.id}-env-gone-by-${instanceId}`);
      await send(card, 'complete_run', {
        runId: run.id, status: 'interrupted',
        reason: 'owner environment retired — awaiting explicit continue',
        ...self(),
      }, `cr-${run.id}-env-gone-by-${instanceId}`);
      return 'interrupted';
    }
    // process_dead: only the owner Node died — the detached supervisor may
    // still be alive. An UNBOUND (`launching`) attempt reconciles; a bound
    // attempt (running/cancelling with a recorded porchRunId) instead
    // re-enters the owned observe path — the registry's status for the exact
    // run id is the evidence, and a vanished record is retention, never a
    // never-entered resolve.
    att.owner = { ...(att.owner || {}), ...self() };
    if (att.status === 'launching' || !att.porchRunId) {
      return reconcileAttempt(card, run, att, { deadOwner: true });
    }
    const inner = await resumeAttempt(card, run, att);
    return inner === 'observed' ? 'adopted-observing' : `adopted-${inner}`;
  }

  // Run-level finalize: a 'stopping' run whose attempts are all positively
  // terminal completes as cancelled — or restores its pre-stop terminal
  // status (a blocked run that still held a live attempt stays blocked).
  async function finalizeStoppingRun(card, run) {
    await send(card, 'complete_run', {
      runId: run.id, status: 'cancelled',
      reason: run.stopIntent?.reason ?? 'stopped by user',
      ...self(),
    }, `cr-${run.id}-stop-final-by-${instanceId}`);
    return 'stopped';
  }

  // ---- U5 validation pipeline ---------------------------------------------
  // A live validation (active|unproven) is a run-level reservation that the
  // scheduler itself executes: snapshot → pristine copies → approved checks
  // as owned process groups → reviewer/checker attempts → verified report
  // artifacts. Check execution is a tracked in-flight TASK (one per run);
  // its absence after a restart means our procs are unproven — the durable
  // records stay, the reservation retains, a second validator never starts.

  const valTasks = new Map(); // runId -> Promise
  // Runner quiesce (process shutdown, not a user stop): forbids EVERY new
  // piece of work — begin_attempt, begin_validation, check spawns both
  // pre-intent and post-intent — and drains what we already own:
  //   - in-flight check groups are cancelled through the same kill path as
  //     a user stop (positive group-death proof still required);
  //   - recorded proc outcomes are still reported durably;
  //   - the validation RESERVATION is retained for successor adoption —
  //     a dying runner never marks it terminal on its own say-so.
  // Nothing is resolved by the flag itself; durable duties keep replaying.
  let quiesced = false;
  function quiesce() { quiesced = true; }
  // Bounded wait for in-flight validation tasks after quiesce — returns
  // honestly about what is still pending; never resolves or drops duties.
  async function drain(ms = 15000) {
    const inflight = [...valTasks.values()];
    if (!inflight.length) return { drained: 0, pending: 0 };
    let timer = null;
    await Promise.race([
      Promise.allSettled(inflight),
      new Promise((res) => { timer = setTimeout(res, ms); timer.unref?.(); }),
    ]).finally(() => clearTimeout(timer));
    return { drained: inflight.length - valTasks.size, pending: valTasks.size };
  }

  const newValidationId = (run) =>
    `val_${run.id}_${(run.validationHistory || []).length + (run.validation ? 1 : 0) + 1}`;

  async function endValidation(card, run, valId, outcome, reason = null) {
    try {
      return await send(card, 'end_validation', {
        runId: run.id, validationId: valId, outcome,
        ...(reason ? { reason: String(reason).slice(0, 300) } : {}),
        ...self(),
      }, `ev-${valId}-${outcome}`);
    } catch (e) {
      if (isErr(e, 'validation_unproven') || isErr(e, 'procs_unproven')) {
        return await send(card, 'end_validation', {
          runId: run.id, validationId: valId, outcome: 'unproven',
          reason: String(reason || e.message).slice(0, 300), ...self(),
        }, `ev-${valId}-unproven`);
      }
      throw e;
    }
  }

  // Import bytes into the artifact store. For a ROLE report the artifact is
  // bound to the completed attempt (record_report requires attempt
  // provenance); check logs/manifest bind to the validation.
  async function importValidationArtifact(card, run, valId, file, buf, commandTag, attemptId = null) {
    const staged = await writeStagedArtifact(stateDir, valId, file, buf);
    const artId = `art_${(attemptId || valId)}_${commandTag}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const cmdId = `ca-${attemptId || valId}-${commandTag}`;
    // A resumed/adopting scheduler re-derives the SAME deterministic ids
    // but carries a different self() provenance — resending under the
    // stable key collides at dedup, and impersonating the original sender
    // is never allowed. The duty is discharged only by the immutable
    // committed record: exact id/file/kind/binding + recorded hash/bytes,
    // AND the stored bytes must re-verify through the artifact plane —
    // a record whose bytes are gone or corrupt discharges nothing.
    const discharged = async () => {
      const rec = (await client.getRun(run.id))?.artifacts?.[artId];
      if (!rec) return null;
      const bindOk = attemptId
        ? rec.attemptId === attemptId
        : rec.validationId === valId;
      if (!(rec.file === file && rec.kind === 'evidence' && bindOk
        && rec.sha256 === staged.sha256 && rec.bytes === buf.length)) {
        throw new RuntimeError('artifact_conflict',
          `committed artifact ${artId} binds different evidence — immutable records are never overwritten`);
      }
      let got;
      try {
        got = await client.getArtifact(run.id, artId);
      } catch (e) {
        // Store-mismatch failures are CORRUPT EVIDENCE, not a transient
        // outage — surfaced as a non-outage error so the caller ends the
        // validation 'unproven' with a durable diagnostic instead of
        // retrying active forever. Genuine transport outages rethrow.
        if (e && (e.status === 404 || e.status === 422 || e.code === 'corrupt_store'
          || e.code === 'artifact_evidence_unbound' || e.code === 'run_not_found')) {
          throw new RuntimeError('artifact_corrupt',
            `committed artifact ${artId} unreadable through the store (${e.code || e.status}) — retained, never rerun`);
        }
        throw e;
      }
      const raw = typeof got?.contentBase64 === 'string'
        ? Buffer.from(got.contentBase64, 'base64')
        : null;
      if (!raw || sha256(raw) !== staged.sha256 || raw.length !== buf.length) {
        throw new RuntimeError('artifact_corrupt',
          `committed artifact ${artId} bytes no longer verify — retained, never rerun`);
      }
      return rec;
    };
    const existing = await discharged();
    if (existing) return existing;
    try {
      const res = await send(card, 'commit_artifact', {
        runId: run.id, file,
        artifact: {
          id: artId,
          kind: 'evidence', file, bytes: buf.length, sha256: staged.sha256,
        },
        stagedPath: staged.stagedPath,
        ...(attemptId ? { attemptId } : { validationId: valId }),
        ...self(),
      }, cmdId);
      const art = res?.artifact ?? res?.result?.artifact;
      if (!art?.id) throw new RuntimeError('artifact_import', `commit_artifact returned no artifact for ${file}`);
      return art;
    } catch (e) {
      // The deterministic id raced: a concurrently-landed identical duty
      // verifies and discharges; genuinely different evidence refuses.
      if (e && e.status === 409) {
        const raced = await discharged();
        if (raced) return raced;
      }
      throw e;
    }
  }

  // Reconcile recorded-but-unsettled check procs after a restart (or a
  // stranded terminal-run validation): re-prove each ORIGINAL leader
  // binding; leaders still alive are killed through the strict path;
  // anything unprovable stays 'unproven' — retained, never re-run.
  // Reconcile recorded-but-unsettled check procs after a restart (or a
  // stranded terminal-run validation). `opts.spoolFor(idx)` returns the
  // VERIFIED spool record — a repaired spawn receipt is legal evidence the
  // executor ran; `opts.envKind` carries a whole-environment adoption proof
  // kind that settles leaderless intents (a dead env holds no children).
  async function reconcileValidationProcs(card, run, val, opts = {}) {
    const e = runtime.environment();
    const ourEnv = {
      pidNs: e.pidNs ?? null,
      uid: e.uid ?? null,
      envInstance: selfEnvInstance(),
    };
    // Caller-side completeness gate: a reconcile that cannot fully prove OUR
    // identity probes NOTHING — same zero-probe rule as killOwnedGroup.
    const envComplete = !!(ourEnv.pidNs && ourEnv.uid != null
      && ourEnv.envInstance?.containerId && ourEnv.envInstance?.initStarttime);
    for (const [idx, p] of Object.entries(val.procs || {})) {
      if (!p || p.state === 'settled') continue;
      // Whole-environment death evidence drains ONLY procs whose ORIGIN
      // environment the adoption proves dead — the domain re-checks the
      // full binding; here we merely pick the matching evidence.
      const envKindFor = (proc) => {
        const origin = proc.leader?.envInstance ?? proc.originEnv ?? null;
        const a = (val.adoptions || []).find((x) => x
          && (x.kind === 'environment_lost' || x.kind === 'environment_retired')
          && envInstanceEqual(x.from?.envInstance, origin));
        return a?.kind ?? null;
      };
      if (p.state === 'intent') {
        // A pre-spawn intent with no recorded leader. Three outcomes:
        //   a) the verified spool carries a leader → the receipt send died
        //      mid-flight; repair it, then drain by the ORIGINAL identity;
        //   b) whole-environment adoption proof for ITS origin env →
        //      settle (nothing the dead env could have spawned survives);
        //   c) otherwise → unprovable, retain — a spawn MAY have happened
        //      and nothing is ever probed or rerun on uncertainty.
        const sp = typeof opts.spoolFor === 'function' ? await opts.spoolFor(Number(idx)) : null;
        if (sp && Number.isInteger(sp.proc?.pid) && sp.proc.pid > 0) {
          // Repair must LAND before the leader is usable — a swallowed
          // send would leave a domain record that cannot settle.
          const rep = await send(card, 'validation_progress', {
            runId: run.id, validationId: val.id,
            proc: { index: Number(idx), leader: sp.proc, state: 'recorded' },
            ...self(),
          }, `vp-${val.id}-p${idx}-repair`).then(() => true).catch(() => false);
          if (!rep) continue; // repair refused — retain, never probe blind
          if (sp.groupDead === true) {
            // The executor already proved the group dead — settle now.
            await send(card, 'validation_progress', {
              runId: run.id, validationId: val.id,
              proc: { index: Number(idx), leader: sp.proc, state: 'settled',
                proof: { groupDead: true, via: 'spool' } },
              ...self(),
            }, `vp-${val.id}-p${idx}-recon`).catch(() => {});
            continue;
          }
          p.leader = sp.proc; // fall through to the live-probe path
        } else if (sp && (sp.spawnInvoked === false
          || (sp.childSpawned === false && typeof sp.spawnError === 'string'))) {
          // The VERIFIED spool carries the original executor's attestation
          // that no child was ever produced — the intent drains honestly.
          await send(card, 'validation_progress', {
            runId: run.id, validationId: val.id,
            proc: { index: Number(idx), state: 'settled',
              proof: { kind: 'never_spawned', via: 'spool' } },
            ...self(),
          }, `vp-${val.id}-p${idx}-nspawn`).catch(() => {});
          continue;
        } else {
          const ek = envKindFor(p);
          if (!ek) continue; // unprovable — retained, never rerun
          await send(card, 'validation_progress', {
            runId: run.id, validationId: val.id,
            proc: { index: Number(idx), state: 'settled',
              proof: { kind: ek } },
            ...self(),
          }, `vp-${val.id}-p${idx}-envsettle`).catch(() => {});
          continue;
        }
      }
      const leader = p.leader;
      // Full ORIGINAL binding must be complete AND ours — same-env, same
      // namespace, same uid — before ANY probe or signal. A foreign or
      // incomplete binding is unproven forever from here (zero probes).
      const leaderComplete = leader?.pid > 0 && leader?.pgid > 0
        && typeof leader?.starttime === 'string' && leader.starttime
        && typeof leader?.pidNs === 'string' && leader.pidNs
        && leader?.uid != null
        && leader?.envInstance?.containerId && leader?.envInstance?.initStarttime;
      const ours = envComplete && leaderComplete
        && leader.pidNs === ourEnv.pidNs
        && leader.uid === ourEnv.uid
        && envInstanceEqual(leader.envInstance, ourEnv.envInstance);
      // The proc's ORIGIN env may be proven dead by adoption evidence —
      // settle without probing the old namespace at all.
      const deadEnv = envKindFor(p);
      if (deadEnv) {
        await send(card, 'validation_progress', {
          runId: run.id, validationId: val.id,
          proc: { index: Number(idx), leader, state: 'settled',
            proof: { kind: deadEnv } },
          ...self(),
        }, `vp-${val.id}-p${idx}-envsettle`).catch(() => {});
        continue;
      }
      let outcome = 'unproven';
      if (ours) {
        const cur = procIdentityLocal(leader.pid);
        const leaderLive = cur && cur.starttime === leader.starttime
          && cur.pidNs === leader.pidNs && cur.uid === leader.uid;
        if (leaderLive) {
          // The original leader is provably alive — kill it through the
          // strict path. No captured members survived the restart, so only
          // the leader itself is signallable; group members remain orphans.
          killOwnedGroup(leader, { signal: 'SIGKILL', ourEnv, knownMembers: new Map() });
        }
        const rest = procGroupMembers(leader.pgid);
        if (Array.isArray(rest) && !rest.length) {
          try {
            process.kill(-leader.pgid, 0);
          } catch (err) {
            outcome = err && err.code === 'ESRCH' ? 'settled' : 'unproven';
          }
        }
      }
      if (outcome === 'settled') {
        await send(card, 'validation_progress', {
          runId: run.id, validationId: val.id,
          proc: { index: Number(idx), leader, state: 'settled',
            proof: { groupDead: true, via: 'reconcile' } },
          ...self(),
        }, `vp-${val.id}-p${idx}-recon`);
      } else {
        await send(card, 'validation_progress', {
          runId: run.id, validationId: val.id,
          proc: { index: Number(idx), leader, state: 'unproven' },
          ...self(),
        }, `vp-${val.id}-p${idx}-recon-unp`).catch(() => {});
      }
    }
    // Re-read — the recorded states above are what we just wrote; local val
    // is stale by construction.
    const fresh = await client.getRun(run.id).catch(() => null);
    const liveProcs = fresh?.validation?.procs ?? val.procs ?? {};
    return !Object.values(liveProcs).some((p) => p && p.state !== 'settled');
  }

  // ---- validation result spool ------------------------------------------
  // The check executor's FULL result is persisted BEFORE any progress send,
  // so a crash between execution and the check report never loses the
  // outcome. Records are schema-bound to run/validation/round/result hash,
  // the approved check definition, proc identity, and raw log hashes —
  // a mismatched or truncated record is CORRUPT, never a pass. Shared by
  // the check task and every reconcile drain path.
  const spoolDirFor = (valId) => join(stateDir, 'execution', 'spool', valId);
  const checkBinding = (chk) => ({
    run: chk.run, cwd: chk.cwd ?? null,
    timeoutSec: chk.timeoutSec ?? null, setup: chk.setup ?? null,
  });
  // A result spool is evidence, not a memo: the schema binds EVERY field a
  // corrupt or forged record could abuse — the outcome vocabulary, the exit
  // attestation, the canonical log basenames (never a path escape into the
  // logs dir join), non-negative byte counts, and the ORIGINAL recorded
  // process identity/environment. Anything less is `corrupt` — retained,
  // never converted into a completed check, a pass, or a never_spawned/env
  // proof.
  const SPOOL_STATUSES = new Set(['pass', 'fail', 'timeout', 'cancelled', 'error', 'unproven']);
  const spoolLeaderComplete = (l) => isObj(l)
    && Number.isInteger(l.pid) && l.pid > 0
    && Number.isInteger(l.pgid) && l.pgid > 0
    && typeof l.starttime === 'string' && l.starttime.length > 0
    && typeof l.pidNs === 'string' && l.pidNs.length > 0
    && Number.isInteger(l.uid)
    && isObj(l.envInstance)
    && typeof l.envInstance.containerId === 'string' && l.envInstance.containerId.length > 0
    && typeof l.envInstance.initStarttime === 'string' && l.envInstance.initStarttime.length > 0;
  const leaderSame = (a, b) => !!a && !!b
    && a.pid === b.pid && a.pgid === b.pgid
    && a.starttime === b.starttime && a.pidNs === b.pidNs && a.uid === b.uid
    && a.envInstance?.containerId === b.envInstance?.containerId
    && a.envInstance?.initStarttime === b.envInstance?.initStarttime;
  const spoolProcOk = (rec, prior) => {
    const recorded = prior?.leader ?? null;
    // rec.proc classifies EXACTLY three ways: a positive-integer pid is a
    // claimed leader; null or a pid-null object is the honest no-child
    // shape (spawn refused before a pid existed); ANYTHING else — a bad
    // pid type, a string, an array — is a malformed claim and corrupt,
    // never silently collapsed into 'no child'.
    const procIsObj = isObj(rec.proc);
    const procPidValid = procIsObj && Number.isInteger(rec.proc.pid) && rec.proc.pid > 0;
    const procNoChild = rec.proc === null
      || (procIsObj && rec.proc.pid === null);
    const claimed = procPidValid ? rec.proc : null;
    if (rec.proc !== null && !procPidValid && !procNoChild) return false;
    if (recorded) {
      // The spool must restate the ORIGINAL recorded leader exactly — a
      // record naming any other pid/env is forged evidence, not a receipt.
      return claimed !== null && spoolLeaderComplete(claimed) && leaderSame(claimed, recorded);
    }
    if (claimed === null) {
      // No leader — legal ONLY as a positive never-spawned attestation
      // bound to a recorded intent: spawn never invoked, or the OS
      // provably refused with an error. Absent the attestation the spool
      // proves nothing.
      return !!prior && (rec.spawnInvoked === false
        || (rec.childSpawned === false && typeof rec.spawnError === 'string'));
    }
    // Claimed leader with NO recorded leader — intent-repair evidence.
    // The prior intent MUST exist and carry a COMPLETE recorded origin
    // (envKey pidNs+uid, envInstance container+init, slot, generation),
    // and the claim must POSITIVELY match it — a missing or partial
    // origin accepts no foreign receipt, and the pid is never probed.
    if (!prior || !spoolLeaderComplete(claimed)) return false;
    const oek = prior.originEnvKey;
    const oe = prior.originEnv;
    return isObj(oek)
      && typeof oek.pidNs === 'string' && oek.pidNs.length > 0 && oek.pidNs === claimed.pidNs
      && Number.isInteger(oek.uid) && oek.uid === claimed.uid
      && isObj(oe)
      && typeof oe.containerId === 'string' && oe.containerId === claimed.envInstance.containerId
      && typeof oe.initStarttime === 'string' && oe.initStarttime === claimed.envInstance.initStarttime
      && typeof prior.originSlot === 'string' && prior.originSlot.length > 0
      && Number.isInteger(prior.originGen);
  };
  const readSpool = async (run, valRef, i) => {
    const path = join(spoolDirFor(valRef.id), `check-${i}.json`);
    let raw;
    try {
      raw = await fsp.readFile(path, 'utf8');
    } catch (e) {
      return e && e.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'corrupt', why: String(e?.message || e) };
    }
    let rec;
    try { rec = JSON.parse(raw); } catch (e) { return { kind: 'corrupt', why: String(e?.message || e) }; }
    const approved = run.inputs?.plan?.checks || [];
    const chk = approved[i];
    const want = chk ? checkBinding(chk) : null;
    const prior = valRef.procs?.[i] ?? null;
    // Attestation consistency — a legal vocabulary word must still agree
    // with the executor's own attestations: 'pass' can never ride exit 7,
    // a cancelled flag, or a group that was never proven dead; a never-
    // spawned attestation can never carry 'pass'/'fail'/'timeout'.
    const spawned = rec?.spawnInvoked === true && rec?.childSpawned === true;
    const noSpawnProven = rec?.spawnInvoked === false
      || (rec?.childSpawned === false && typeof rec?.spawnError === 'string');
    const spawnConsistent = isObj(rec)
      && (rec.spawnInvoked === false ? rec.childSpawned === false : true)
      && (rec.childSpawned === true ? rec.spawnInvoked === true : true);
    const statusConsistent = !isObj(rec) ? false : (() => {
      switch (rec.status) {
        case 'pass':
          return spawned && rec.groupDead === true && rec.exitCode === 0
            && rec.cancelled === false && rec.timedOut === false && rec.error === null;
        case 'fail':
          return spawned && rec.groupDead === true
            && Number.isInteger(rec.exitCode) && rec.exitCode !== 0
            && rec.cancelled === false && rec.timedOut === false;
        case 'timeout':
          return spawned && rec.timedOut === true && rec.groupDead === true
            && rec.cancelled === false;
        case 'cancelled':
          return rec.cancelled === true && rec.groupDead === true;
        case 'unproven':
          return rec.groupDead === false;
        case 'error':
          return typeof rec.error === 'string' && (spawned || noSpawnProven);
        default: return false;
      }
    })();
    const ok = isObj(rec) && rec.schema === 1
      && rec.runId === run.id && rec.validationId === valRef.id
      && Number.isInteger(rec.index) && rec.index === i
      && rec.resultSha256 === valRef.resultSha256 && rec.round === valRef.round
      && want !== null && isObj(rec.check)
      && rec.check.run === want.run && rec.check.cwd === want.cwd
      && rec.check.timeoutSec === want.timeoutSec && rec.check.setup === want.setup
      && typeof rec.status === 'string' && SPOOL_STATUSES.has(rec.status)
      && (rec.exitCode === null || (Number.isInteger(rec.exitCode) && rec.exitCode >= 0))
      && typeof rec.groupDead === 'boolean' && typeof rec.cancelled === 'boolean'
      && typeof rec.timedOut === 'boolean'
      && typeof rec.spawnInvoked === 'boolean' && typeof rec.childSpawned === 'boolean'
      && spawnConsistent && statusConsistent
      && (rec.spawnError === null || typeof rec.spawnError === 'string')
      && (rec.error === null || typeof rec.error === 'string')
      && (rec.stdoutTail === null || typeof rec.stdoutTail === 'string')
      && (rec.stderrTail === null || typeof rec.stderrTail === 'string')
      && (rec.stdoutBytes === null || (Number.isInteger(rec.stdoutBytes) && rec.stdoutBytes >= 0))
      && (rec.stderrBytes === null || (Number.isInteger(rec.stderrBytes) && rec.stderrBytes >= 0))
      // Canonical log basenames only — join(dirs.logs, rec.logX) can never
      // escape via '../' or an absolute/relative path component.
      && rec.logOut === `check-${i}-stdout.log` && rec.logErr === `check-${i}-stderr.log`
      && typeof rec.logSha256Out === 'string' && /^[0-9a-f]{64}$/.test(rec.logSha256Out)
      && typeof rec.logSha256Err === 'string' && /^[0-9a-f]{64}$/.test(rec.logSha256Err)
      && Number.isInteger(rec.logBytesOut) && rec.logBytesOut >= 0
      && Number.isInteger(rec.logBytesErr) && rec.logBytesErr >= 0
      // Original recorded process identity/environment — bound BEFORE any
      // probe or signal ever touches a pid.
      && spoolProcOk(rec, prior);
    return ok ? { kind: 'ok', rec } : { kind: 'corrupt', why: 'spool binding/schema mismatch' };
  };
  // opts.spoolFor adapter shared by every reconcile call site.
  const spoolForRun = (run, valRef) => async (idx) => {
    const sp = await readSpool(run, valRef, idx);
    return sp.kind === 'ok' ? sp.rec : null;
  };
  const writeSpool = async (run, valRef, i, res, logsDir) => {
    // Hash-bound raw logs are part of the record — written atomically,
    // mode-restricted, BEFORE any progress send.
    const outBuf = await fsp.readFile(join(logsDir, res.logOut ?? `check-${i}-stdout.log`)).catch(() => null);
    const errBuf = await fsp.readFile(join(logsDir, res.logErr ?? `check-${i}-stderr.log`)).catch(() => null);
    await ensureDir(spoolDirFor(valRef.id));
    await atomicWriteJson(join(spoolDirFor(valRef.id), `check-${i}.json`), {
      schema: 1,
      runId: run.id, validationId: valRef.id,
      round: valRef.round, resultSha256: valRef.resultSha256,
      index: i, check: checkBinding((run.inputs?.plan?.checks || [])[i]),
      proc: res.proc ?? null,                      // original leader binding
      status: res.status, exitCode: res.exitCode ?? null,
      groupDead: res.groupDead === true,
      cancelled: res.cancelled === true, timedOut: res.timedOut === true,
      spawnInvoked: res.spawnInvoked === true,
      childSpawned: res.childSpawned === true,
      spawnError: res.spawnError ?? null,
      error: res.error ?? null,
      stdoutTail: res.stdoutTail ?? null, stderrTail: res.stderrTail ?? null,
      stdoutBytes: res.stdoutBytes ?? null, stderrBytes: res.stderrBytes ?? null,
      logOut: res.logOut ?? `check-${i}-stdout.log`,
      logErr: res.logErr ?? `check-${i}-stderr.log`,
      logSha256Out: outBuf ? sha256(outBuf) : null,
      logSha256Err: errBuf ? sha256(errBuf) : null,
      logBytesOut: outBuf ? outBuf.length : null,
      logBytesErr: errBuf ? errBuf.length : null,
    });
    return { outBuf, errBuf };
  };

  async function runValidationTask(card, run, val0) {
    const valId = val0.id;
    const ws = card.workspaces?.[run.workspaceId];
    let cancelFlag = false;
    let apiSilentSince = null;
    // The authoritative lease boundary is whatever the SERVER last recorded
    // (its clock, not ours) — never a locally invented extension.
    let leaseUntil = val0.owner?.leaseUntil ?? null;
    let pollBusy = false;
    const cancelPoll = setInterval(async () => {
      if (pollBusy) return; // a slow iteration never stacks another heartbeat
      pollBusy = true;
      // Runner quiesce cancels our owned check group exactly like a stop
      // intent — but the reservation outcome stays for the drain below;
      // heartbeats keep landing while we are still supervising the drain.
      if (quiesced) cancelFlag = true;
      let healthy = true;
      try {
        const r = await client.getRun(run.id);
        if (r?.validation?.cancel || r?.stopIntent || r?.status === 'stopping') cancelFlag = true;
      } catch {
        healthy = false;
      }
      try {
        // Heartbeat the validation lease — a dead reservation can never
        // renew and a live one must prove liveness to hold its unit. The
        // response carries the AUTHORITATIVE recorded boundary.
        const hb = await send(card, 'heartbeat', {
          validations: [{ runId: run.id, validationId: valId }],
          leaseMs, ...self(),
        });
        if (hb && Number.isInteger(hb.leaseUntil)) leaseUntil = hb.leaseUntil;
      } catch {
        healthy = false;
      }
      try {
        // Silence clears ONLY when both the read AND the lease renewal landed
        // — a heartbeat that silently failed is still API loss.
        if (healthy) apiSilentSince = null; else apiSilentSince ??= Date.now();
        // API-loss discipline: no new work; our own groups cancel ONLY at the
        // AUTHORITATIVE recorded boundary — never a locally invented one.
        if (leaseUntil != null && Date.now() > leaseUntil) cancelFlag = true;
      } finally {
        pollBusy = false;
      }
    }, 300);
    const approved = run.inputs?.plan?.checks || [];
    try {
      // 0. Restart reconcile — durable records bound a restart BEFORE any
      //    re-execution. Every state read propagates API failure — a silent
      //    outage NEVER becomes "proceed on stale state".
      //    - 'intent' + verified spool leader: repair the lost receipt,
      //      then drain by the ORIGINAL identity.
      //    - 'intent' + whole-environment adoption proof: settle — nothing
      //      the dead env could have spawned survives.
      //    - 'intent' otherwise: unprovable → retain, never rerun.
      //    - 'recorded'/'unproven': probe the ORIGINAL binding.
      const fresh0 = await client.getRun(run.id);
      const v0 = fresh0?.validation ?? val0;
      const procs0 = v0.procs || {};
      if (Object.values(procs0).some((p) => p && p.state !== 'settled')) {
        const drained = await reconcileValidationProcs(card, run, v0, {
          spoolFor: spoolForRun(run, v0),
        });
        if (!drained) {
          await endValidation(card, run, valId, 'unproven', 'unproven process groups survive a restart');
          return;
        }
        run = await client.getRun(run.id);
      }
      const val = (await client.getRun(run.id))?.validation ?? v0;
      // 1. Snapshot the result exactly once (immutable in the domain).
      let manifest = val.manifest;
      let resultSha256 = val.resultSha256;
      if (!resultSha256) {
        const snap = await computeResultManifest(ws.path, { baseCommit: run.baseCommit });
        manifest = snap.manifest;
        resultSha256 = snap.resultSha256;
        const mArt = await importValidationArtifact(
          card, run, valId, 'result-manifest.json',
          Buffer.from(JSON.stringify(manifest)), 'manifest');
        const rs = await send(card, 'record_snapshot', {
          runId: run.id, validationId: valId,
          manifest, resultSha256,
          manifestArtifactId: mArt.id, ...self(),
        }, `rs-${valId}`);
        if (snap.ok === false || rs?.ok === false) {
          await endValidation(card, run, valId, 'failed', 'result contains unsupported paths');
          await send(card, 'complete_run', {
            runId: run.id, status: 'blocked',
            reason: 'result snapshot captured unsupported paths — see diagnostic',
            ...self(),
          }, `cr-${run.id}-result-unsupported`).catch(() => {});
          return;
        }
      }
      const wroot = await wsRoot();
      const dirs = val.dirs;
      // 1b. Declared dependency binding — BEFORE any copy is trusted: the
      //    controller-owned dep set must re-bind to the EXACT durable proof
      //    ({setupId, depSetId, lockHash, snapshotSha} on the integrate
      //    record). A run that declares deps but cannot bind them is
      //    unproven — never validated against pretend dependencies.
      const depsBound = await boundDepsFor(run, valId);
      if (depsBound?.error) {
        await recordEvent(card, run, 'validation_deps_unbound', {
          validationId: valId, code: depsBound.error,
          message: String(depsBound.message).slice(0, 300),
        }).catch(() => {});
        await endValidation(card, run, valId, 'unproven',
          `dependency binding failed: ${depsBound.message}`);
        return;
      }
      // 2. Pristine copies with PER-COPY durable receipts. Containment is
      //    proven by REALPATH before any rm/read/mkdir: the dir itself must
      //    not be a symlink and its nearest existing ancestor must resolve
      //    inside the real .validation/<run>/<val> tree — a preplanted
      //    ancestor symlink can never reach rm.
      assertValidationDirs(dirs, wroot, run.id, valId);
      const wrootReal = await fsp.realpath(wroot).catch(() => null);
      if (!wrootReal) {
        await endValidation(card, run, valId, 'failed',
          'workspace root does not resolve');
        return;
      }
      // Every component BELOW the workspace root must be a REAL directory
      // (or absent — to be created). wsRoot itself may legitimately resolve
      // through links; .validation descendants may never: a symlink inside
      // the tree — even one aliasing another owned run — is refused before
      // ANY read/mkdir/rm, so rm -r can never cross into foreign storage.
      const proveDescendant = async (abs) => {
        const rel = abs.startsWith(`${wroot}/`) ? abs.slice(wroot.length + 1).split('/') : null;
        if (!rel) return false;
        let cur = wroot;
        for (const c of rel) {
          cur = join(cur, c);
          const st = await fsp.lstat(cur).catch(() => null);
          if (!st) return true;          // first missing component — deeper cannot exist
          if (st.isSymbolicLink() || !st.isDirectory()) return false;
        }
        return true;
      };
      const treePath = join(wroot, '.validation', run.id, valId);
      if (!(await proveDescendant(treePath))) {
        await endValidation(card, run, valId, 'unproven',
          'validation tree contains a non-real component — refuse to touch');
        return;
      }
      await ensureDir(treePath); // every component proven real above
      const valTreeReal = await fsp.realpath(treePath).catch(() => null);
      if (!valTreeReal || !valTreeReal.startsWith(`${wrootReal}/`)) {
        await endValidation(card, run, valId, 'unproven',
          'created validation tree resolves outside the real workspace root');
        return;
      }
      const reported0 = new Set((val?.checks?.reports || []).map((r) => r.index));
      const copyLive = (key) => {
        // A copy in active use is a WORKING dir — verification applies only
        // while it is still pristine-by-design:
        //   base   — never written by the pipeline;
        //   verify — checks execute inside it;
        //   review — the reviewer attempt writes .acp-out inside it;
        //   check  — the checker attempt writes .acp-out inside it.
        if (key === 'base') return false;
        if (key === 'verify') {
          return Object.keys(val.procs || {}).length > 0 || reported0.size > 0;
        }
        const role = key === 'review' ? 'reviewer' : 'checker';
        return (run.attempts || []).some((a) => a?.role === role && a.validationId === valId);
      };
      for (const key of ['base', 'verify', 'review', 'check']) {
        if (val.copies?.[key]) {
          // Containment BEFORE any read/verify/skip: EVERY component below
          // the root must be real — a symlinked copy or tree component is
          // corruption, never a working dir.
          const clean = await proveDescendant(dirs[key]);
          const exists = clean ? await fsp.stat(dirs[key]).catch(() => null) : null;
          if (!clean || !exists) {
            await recordEvent(card, run, 'validation_copy_corrupt', {
              validationId: valId, copy: key,
              problem: clean ? 'receipted copy missing' : 'copy contains a non-real component',
            }).catch(() => {});
            await endValidation(card, run, valId, 'unproven',
              `receipted copy ${key} is missing or escapes the real validation tree — retained`);
            return;
          }
          if (copyLive(key)) continue; // working copy — expected mutations
          const v = await verifyResultCopy(
            manifest, dirs[key], { exempt: depsBound?.exempt ?? [] });
          if (!v.ok) {
            // A RECEIPTED copy that fails verification is corruption
            // evidence — retain the reservation, never wipe it.
            await recordEvent(card, run, 'validation_copy_corrupt', {
              validationId: valId, copy: key,
              problem: String(v.problems?.[0] || 'mismatch').slice(0, 300),
            }).catch(() => {});
            await endValidation(card, run, valId, 'unproven',
              `receipted copy ${key} fails manifest verification — corruption, retained`);
            return;
          }
          continue;
        }
        const lst = await fsp.lstat(dirs[key]).catch(() => null);
        if (lst) {
          // Unreceipted = only our own PARTIAL materialization may exist.
          // Every component below the root is proven real BEFORE rm — a
          // symlinked partial or alias into another run's dir is refused.
          if (!(await proveDescendant(dirs[key])) || lst.isSymbolicLink() || !lst.isDirectory()) {
            await endValidation(card, run, valId, 'unproven',
              `copy ${key} partial dir contains a non-real component — refuse to remove`);
            return;
          }
          await fsp.rm(dirs[key], { recursive: true, force: true });
        }
        await materializeResultCopy(manifest, ws.path, dirs[key], { wsRoot: wroot });
        await send(card, 'validation_progress', {
          runId: run.id, validationId: valId,
          copy: { key, receipt: { resultSha256, dir: dirs[key] } }, ...self(),
        }, `vp-${valId}-copy-${key}`);
      }
      if (!val.copiesReady) {
        await send(card, 'validation_progress', {
          runId: run.id, validationId: valId, copiesReady: true, ...self(),
        }, `vp-${valId}-copies`);
      }
      // 2b. Supply the bound dep set into the consuming copies — verify runs
      //    the approved checks, review/check host the role attempts. 'base'
      //    stays pristine forever. Injected paths are exempt from manifest
      //    verification (bound above); any occupation by non-dep content is
      //    corruption — the copy is retained unproven, never overwritten.
      if (depsBound) {
        for (const key of ['verify', 'review', 'check']) {
          const link = await ensureDepLink(dirs[key], depsBound.depPath, depsBound.hostDir);
          if (!link.ok) {
            await recordEvent(card, run, 'validation_deps_corrupt', {
              validationId: valId, copy: key,
              problem: String(link.why).slice(0, 300),
            }).catch(() => {});
            await endValidation(card, run, valId, 'unproven',
              `dependency supply into ${key} failed: ${link.why}`);
            return;
          }
        }
      }
      // 3. Approved checks in order — owned process groups, durable logs
      //    imported as artifacts before the report lands. A durable pre-spawn
      //    intent + spawn receipt + result spool bound every index: recorded
      //    evidence is never re-run; an executed check with a lost report is
      //    recovered from the verified spool or fails honestly.
      const fresh2 = await client.getRun(run.id);
      const v2 = fresh2?.validation ?? val;
      const reported = new Set((v2?.checks?.reports || []).map((r) => r.index));
      const ourEnv = {
        pidNs: runtime.environment().pidNs ?? null,
        uid: runtime.environment().uid ?? null,
        envInstance: selfEnvInstance(),
      };
      for (let i = 0; i < approved.length; i += 1) {
        if (reported.has(i)) continue; // recorded evidence is never re-run
        if (cancelFlag) break;
        const chk = approved[i];
        const prior = v2?.procs?.[i] ?? null;
        if (prior) {
          if (prior.state !== 'settled') {
            const drained = await reconcileValidationProcs(card, run, v2, {
              spoolFor: spoolForRun(run, v2),
            });
            if (!drained) {
              await endValidation(card, run, valId, 'unproven',
                `check ${i} process group still unresolved — never rerun over live doubt`);
              return;
            }
          }
          // The check EXECUTED and its group is proven dead — recover the
          // VERIFIED result spool; missing is an honest failure, corrupt
          // retains the reservation unproven — never a rerun.
          const sp = await readSpool(run, v2, i);
          if (sp.kind === 'missing') {
            await endValidation(card, run, valId, 'failed',
              `check ${i} executed (proc settled) but its result spool is missing — no rerun`);
            return;
          }
          if (sp.kind !== 'ok') {
            await recordEvent(card, run, 'validation_spool_corrupt', {
              validationId: valId, index: i, why: String(sp.why).slice(0, 300),
            }).catch(() => {});
            await endValidation(card, run, valId, 'unproven',
              `check ${i} result spool unreadable/corrupt — retained, no rerun`);
            return;
          }
          const spooled = sp.rec;
          const outBuf = await fsp.readFile(join(dirs.logs, spooled.logOut));
          const errBuf = await fsp.readFile(join(dirs.logs, spooled.logErr));
          // The logs must still match the spool's recorded hashes — a
          // mutated file is evidence corruption, not a report.
          if (sha256(outBuf) !== spooled.logSha256Out || sha256(errBuf) !== spooled.logSha256Err
            || outBuf.length !== spooled.logBytesOut || errBuf.length !== spooled.logBytesErr) {
            await endValidation(card, run, valId, 'unproven',
              `check ${i} log bytes no longer match the spool hashes — corruption, retained`);
            return;
          }
          const oArt = await importValidationArtifact(card, run, valId, `check-${i}-stdout.log`, outBuf, `c${i}o`);
          const eArt = await importValidationArtifact(card, run, valId, `check-${i}-stderr.log`, errBuf, `c${i}e`);
          // A resend by a NON-ORIGIN instance rebinds under a deterministic
          // instance-scoped key — the original sender's commandId is never
          // reused with a different provenance payload (dedup conflict),
          // and a later adopter never collides with an earlier one.
          const origInst = prior?.originOwner?.instanceId ?? null;
          const reportKey = origInst && origInst !== instanceId
            ? `vp-${valId}-c${i}-r${sha256(`resend|${instanceId}|${valId}|${i}`).slice(0, 20)}`
            : `vp-${valId}-c${i}`;
          await send(card, 'validation_progress', {
            runId: run.id, validationId: valId,
            check: {
              index: i, status: spooled.status,
              run: chk.run,
              ...(chk.cwd !== undefined ? { cwd: chk.cwd } : {}),
              ...(chk.timeoutSec !== undefined ? { timeoutSec: chk.timeoutSec } : {}),
              ...(chk.setup !== undefined ? { setup: chk.setup } : {}),
              logOutArtifactId: oArt.id, logErrArtifactId: eArt.id,
              logSha256Out: spooled.logSha256Out, logSha256Err: spooled.logSha256Err,
              exitCode: spooled.exitCode, stdoutBytes: spooled.stdoutBytes,
              stderrBytes: spooled.stderrBytes,
              stdoutTail: spooled.stdoutTail ?? null, stderrTail: spooled.stderrTail ?? null,
              groupDead: spooled.groupDead === true,
            },
            ...self(),
          }, reportKey);
          if (spooled.groupDead !== true) {
            await endValidation(card, run, valId, 'unproven',
              `check ${i} spooled without positive group death`);
            return;
          }
          continue;
        }
        // No record — fresh execution. ANY control-API loss is a hard gate:
        // no fresh work while the authoritative plane is silent (the lease
        // heartbeat failing counts even when reads succeed — silence is
        // only cleared when BOTH landed). Retain — never fall through to
        // endValidation with work undone.
        if (apiSilentSince != null) return;
        // Pre-spawn preconditions run BEFORE the durable intent: a refused
        // spawn must never create an undrainable record.
        const verifyReal = await fsp.realpath(dirs.verify).catch(() => null);
        const logsReady = await fsp.mkdir(dirs.logs, { recursive: true })
          .then(() => fsp.realpath(dirs.logs)).catch(() => null);
        if (!verifyReal || !(verifyReal === valTreeReal || verifyReal.startsWith(`${valTreeReal}/`))
          || !logsReady || !(logsReady === valTreeReal || logsReady.startsWith(`${valTreeReal}/`))) {
          await endValidation(card, run, valId, 'failed',
            `check ${i} pre-spawn refused: verify/logs dirs do not resolve inside the real validation tree`);
          return;
        }
        // Ownership/cancel gate immediately BEFORE the intent: control loss
        // propagates (no spawn), a cancel/stop settles the intent as
        // never_spawned — durable, drainable.
        const gate0 = await client.getRun(run.id);
        if (quiesced || gate0?.validation?.cancel || gate0?.stopIntent || gate0?.status === 'stopping'
          || gate0?.validation?.owner?.instanceId !== self().instanceId) {
          cancelFlag = true;
          break;
        }
        await send(card, 'validation_progress', {
          runId: run.id, validationId: valId,
          proc: { index: i, state: 'intent' }, ...self(),
        }, `vp-${valId}-p${i}-intent`);
        // Post-intent gate — the intent is durable; if cancel/ownership
        // landed between intent and spawn, settle it never_spawned.
        const gate1 = await client.getRun(run.id);
        if (quiesced || gate1?.validation?.cancel || gate1?.stopIntent || gate1?.status === 'stopping'
          || gate1?.validation?.owner?.instanceId !== self().instanceId) {
          await send(card, 'validation_progress', {
            runId: run.id, validationId: valId,
            proc: { index: i, state: 'settled', proof: { kind: 'never_spawned', via: 'gate' } },
            ...self(),
          }, `vp-${valId}-p${i}-nspawn`).catch(() => {});
          cancelFlag = true;
          break;
        }
        const res = await runCheckCommand({ ...chk, index: i }, {
          verifyDir: dirs.verify,
          ourEnv,
          logOutFile: join(dirs.logs, `check-${i}-stdout.log`),
          logErrFile: join(dirs.logs, `check-${i}-stderr.log`),
          isCancelled: () => cancelFlag,
          onProc: async (leader) => {
            await send(card, 'validation_progress', {
              runId: run.id, validationId: valId,
              proc: { index: i, leader, state: 'recorded' },
              ...self(),
            }, `vp-${valId}-p${i}-rec`);
          },
        });
        const bufs = await writeSpool(run, v2, i, res, dirs.logs); // durable BEFORE any report send
        if (res.proc?.pid != null) {
          const settled = res.groupDead === true;
          await send(card, 'validation_progress', {
            runId: run.id, validationId: valId,
            proc: {
              index: i, leader: res.proc,
              state: settled ? 'settled' : 'unproven',
              ...(settled ? { proof: { groupDead: true, via: res.cancelled ? 'kill' : 'exit' } } : {}),
            },
            ...self(),
          }, `vp-${valId}-p${i}-${settled ? 'settled' : 'unp'}`);
        } else {
          // no leader record — settle the intent ONLY on the executor's own
          // attestation: spawn never invoked (precondition refusal) or the
          // OS provably produced no child. An ambiguous res.proc==null is
          // UNKNOWN — the intent stays recorded and the reservation retains.
          const neverSpawned = res.spawnInvoked === false
            || (res.childSpawned === false && typeof res.spawnError === 'string');
          if (neverSpawned) {
            await send(card, 'validation_progress', {
              runId: run.id, validationId: valId,
              proc: {
                index: i, state: 'settled',
                proof: {
                  kind: 'never_spawned',
                  via: res.spawnInvoked === false ? 'precondition' : 'spawn_error',
                  error: String(res.spawnError || res.error || '').slice(0, 200),
                },
              },
              ...self(),
            }, `vp-${valId}-p${i}-nspawn`).catch(() => {});
          }
        }
        const outBuf = bufs.outBuf ?? await fsp.readFile(join(dirs.logs, res.logOut ?? `check-${i}-stdout.log`));
        const errBuf = bufs.errBuf ?? await fsp.readFile(join(dirs.logs, res.logErr ?? `check-${i}-stderr.log`));
        const oArt = await importValidationArtifact(card, run, valId, `check-${i}-stdout.log`, outBuf, `c${i}o`);
        const eArt = await importValidationArtifact(card, run, valId, `check-${i}-stderr.log`, errBuf, `c${i}e`);
        await send(card, 'validation_progress', {
          runId: run.id, validationId: valId,
          check: {
            index: i, status: res.status,
            run: chk.run,
            ...(chk.cwd !== undefined ? { cwd: chk.cwd } : {}),
            ...(chk.timeoutSec !== undefined ? { timeoutSec: chk.timeoutSec } : {}),
            ...(chk.setup !== undefined ? { setup: chk.setup } : {}),
            logOutArtifactId: oArt.id, logErrArtifactId: eArt.id,
            logSha256Out: sha256(outBuf), logSha256Err: sha256(errBuf),
            exitCode: res.exitCode, stdoutBytes: res.stdoutBytes, stderrBytes: res.stderrBytes,
            stdoutTail: res.stdoutTail ?? null, stderrTail: res.stderrTail ?? null,
            groupDead: res.groupDead === true,
          },
          ...self(),
        }, `vp-${valId}-c${i}`);
        if (res.groupDead !== true) {
          await endValidation(card, run, valId, 'unproven',
            `check ${i} left a live/unproven process group`);
          return;
        }
        if (cancelFlag) break;
      }
      // Runner quiesce retains the reservation for successor adoption — the
      // owned groups above are already recorded settled/unproven; a dying
      // runner never resolves the validation itself. A user stop/cancel
      // (cancelFlag without quiesce) still closes the round 'cancelled';
      // a genuinely finished pipeline still reports 'settled'.
      if (!(quiesced && cancelFlag)) {
        await endValidation(card, run, valId, cancelFlag ? 'cancelled' : 'settled');
      }
    } catch (e) {
      if (isOutageError(e)) {
        // API loss mid-pipeline — the reservation stays; the next tick
        // reconciles from the durable records.
        await recordEvent(card, run, 'validation_outage',
          { validationId: valId, error: String(e?.message || e).slice(0, 300) }).catch(() => {});
        return;
      }
      console.error(`validation ${valId} faulted: ${e?.code ?? 'unknown'}: ${String(e?.message || e)}`);
      await recordEvent(card, run, 'validation_task_fault', {
        validationId: valId, code: e?.code ?? 'unknown',
        error: String(e?.message || e).slice(0, 500),
      }).catch(() => {});
      await endValidation(card, run, valId, 'unproven',
        `validation task faulted: ${String(e?.message || e)}`).catch(() => {});
    } finally {
      clearInterval(cancelPoll);
    }
  }

  // Reviewer/checker phases: the role attempt runs in its OWN pristine copy;
  // after completion the report document is imported from that copy's
  // `.acp-out/` bound to the ATTEMPT, then recorded as verified evidence.
  async function driveRolePhase(card, run, val, role) {
    const kind = role === 'reviewer' ? 'findings' : 'verdicts';
    const file = role === 'reviewer' ? FINDINGS_FILE : VERDICTS_FILE;
    const copyDir = role === 'reviewer' ? val.dirs.review : val.dirs.check;
    if (val.reports?.[kind]) return 'report_recorded';
    const mine = (run.attempts || []).filter((a) => a
      && a.role === role && a.validationId === val.id);
    const done = mine.find((a) => a.status === 'completed');
    if (done) {
      let buf;
      try {
        buf = await fsp.readFile(join(copyDir, '.acp-out', file));
      } catch (e) {
        // A role attempt that "succeeded" without its evidence file is a
        // durable failure — never silent acceptance. All check procs are
        // proven settled by now (we're past verify), so 'failed' releases
        // the reservation honestly — no permanent unproven wedge.
        await endValidation(card, run, val.id, 'failed',
          `${role} completed but ${file} is unreadable: ${String(e?.message || e).slice(0, 200)}`);
        await send(card, 'complete_run', {
          runId: run.id, status: 'failed',
          reason: `${role} attempt produced no report evidence`,
          ...self(),
        }, `cr-${run.id}-${role}-noevidence`).catch(() => {});
        return 'report_missing';
      }
      const art = await importValidationArtifact(card, run, val.id, file, buf, kind, done.id);
      await send(card, 'record_report', {
        runId: run.id, validationId: val.id, kind,
        attemptId: done.id, artifactId: art.id, ...self(),
      }, `rr-${val.id}-${kind}`);
      return 'report_recorded';
    }
    const failedAttempt = mine.find((a) => ['failed', 'cancelled', 'interrupted', 'blocked'].includes(a.status));
    if (failedAttempt) {
      // The attempt resolve already terminalized the run 'failed' — close
      // the reservation as 'failed' too (all procs proven dead releases it).
      await endValidation(card, run, val.id, 'failed',
        `${role} attempt ${failedAttempt.id} ended ${failedAttempt.status} without a report`);
      return 'role_failed';
    }
    // Launch the role attempt (the unit the validation holds carries it) —
    // the SAME registration gate as implementer launches: a new owner record
    // without a registration generation is unretirable.
    if (launchesNeedRegistration() && !registrationOk()) {
      return 'registration_blocked';
    }
    const ws = card.workspaces?.[run.workspaceId];
    const { reqDoc, planDoc } = await verifyInputs(card.cardId, run);
    const attemptId = sanitizeAttemptId(`att-${run.id}-${(run.attempts || []).length + 1}`);
    const prompt = role === 'reviewer'
      ? buildReviewerPrompt({
          cardId: card.cardId, cardTitle: card.title || null,
          runId: run.id, attemptId, copyDir, round: val.round,
          resultSha256: val.resultSha256,
          requirementsText: reqDoc.content, planText: planDoc.content,
        })
      : buildCheckerPrompt({
          cardId: card.cardId, cardTitle: card.title || null,
          runId: run.id, attemptId, copyDir, round: val.round,
          resultSha256: val.resultSha256,
          findingsDoc: val.reports?.findings?.doc ?? null,
        });
    return await tryLaunch(card, run, ws, {
      role, phase: role === 'reviewer' ? 'review' : 'check_review',
      cwd: copyDir, prompt, validationId: val.id,
    });
  }

  // --- declared dependency binding (U5 supply) ------------------------------
  // A setup-enabled integrate result carries the durable proof record
  //   run.fusion.integrate.dependencies = {setupId, depSetId, lockHash, snapshotSha}
  // bound to the imported commit (orchestrator integrations may record the
  // same shape). U5 checks + reviewer/checker attempts run in host copies
  // of that result — the controller-owned dep set is re-prepared against
  // the declared setup + canonical binding, the returned identity must
  // EQUAL the durable proof (never silently accepted), and the materialized
  // tree is linked into each consuming copy at the setup's declared
  // depPath. A run without declared dependencies takes none of this.
  function declaredDepsFor(run) {
    const d = run?.fusion?.integrate?.dependencies
      ?? run?.orchestrator?.integration?.dependencies ?? null;
    if (!d || typeof d !== 'object' || typeof d.setupId !== 'string' || !d.setupId) return null;
    return d;
  }

  // Resolved once per (run, validation, proof) — the durable record never
  // changes inside a round and deps.prepare is itself idempotent/cached.
  const depBindCache = new Map();
  async function boundDepsFor(run, valId) {
    const declared = declaredDepsFor(run);
    if (!declared) return null;
    const key = `${run.id}:${valId}:${declared.setupId}:${declared.depSetId ?? ''}:${declared.snapshotSha ?? ''}`;
    if (depBindCache.has(key)) return depBindCache.get(key);
    const fail = (error, message) => {
      const bound = { error, message };
      depBindCache.set(key, bound);
      return bound;
    };
    if (typeof f1Runtime?.prepareDependencies !== 'function' || !depsDir) {
      return fail('deps_unsupported',
        `run declares setupId ${declared.setupId} but the constrained runtime cannot prepare dependencies`);
    }
    let prep;
    try {
      const canonicalId = run?.fusion?.integrate?.import?.canonicalId
        ?? run?.fusion?.integrate?.canonicalId
        ?? run?.orchestrator?.integration?.canonicalId ?? null;
      prep = await f1Runtime.prepareDependencies({ setupId: declared.setupId, canonicalId });
    } catch (e) {
      return fail('deps_prepare_failed', String(e?.message ?? e).slice(0, 300));
    }
    if (!prep?.ok
      || (declared.depSetId && prep.depSetId !== declared.depSetId)
      || (declared.lockHash && prep.lockHash !== declared.lockHash)
      || (declared.snapshotSha && prep.snapshotSha !== declared.snapshotSha)) {
      return fail('dependency_binding_mismatch',
        `deps.prepare returned ${JSON.stringify({
          depSetId: prep?.depSetId ?? null,
          lockHash: prep?.lockHash ?? null,
          snapshotSha: prep?.snapshotSha ?? null,
        })} — the run declares ${JSON.stringify({
          depSetId: declared.depSetId ?? null,
          lockHash: declared.lockHash ?? null,
          snapshotSha: declared.snapshotSha ?? null,
        })}`);
    }
    const depPath = setupDepPaths?.[declared.setupId] ?? null;
    if (!depPath) {
      return fail('deps_path_unknown',
        `setup ${declared.setupId} has no declared depPath in the environment config`);
    }
    const bound = {
      depSetId: prep.depSetId,
      hostDir: join(depsDir, prep.depSetId),
      depPath, exempt: [depPath], proof: prep,
    };
    depBindCache.set(key, bound);
    return bound;
  }

  // Link the materialized dep set into a validation copy at the declared
  // depPath. Every parent component must be a real dir; an occupied target
  // is corruption, never overwritten.
  async function ensureDepLink(copyDir, depPath, targetDir) {
    const parts = depPath.split('/').filter(Boolean);
    if (!parts.length) return { ok: false, why: 'empty depPath' };
    let cur = copyDir;
    for (const seg of parts.slice(0, -1)) {
      cur = join(cur, seg);
      const st = await fsp.lstat(cur).catch(() => null);
      if (!st) { await fsp.mkdir(cur); continue; }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        return { ok: false, why: `dep path component ${seg} is not a real directory` };
      }
    }
    const linkPath = join(copyDir, ...parts);
    const st = await fsp.lstat(linkPath).catch(() => null);
    if (st) {
      if (st.isSymbolicLink()
        && (await fsp.readlink(linkPath).catch(() => null)) === targetDir) {
        return { ok: true };
      }
      return { ok: false, why: `dep path ${depPath} is occupied by non-dep content` };
    }
    await fsp.symlink(targetDir, linkPath, 'dir');
    return { ok: true };
  }

  // The validation dispatcher — called whenever run.validation is live.
  // `drainOnly` (terminal run): never issues new work — only reconciles or
  // cancels the reservation.
  async function driveValidation(card, run, drainOnly = false) {
    const val = run.validation;
    if (!val || (val.status !== 'active' && val.status !== 'unproven')) return 'validation_done';
    if (quiesced) {
      // Runner quiesce: NO new work of any kind — no adoption write, no
      // role launch, no new check task. An in-flight task drains through
      // its own cancel path; the reservation keeps its recorded owner and
      // is left for successor adoption after the lease lapses.
      return valTasks.has(run.id) ? 'validation_running' : 'quiesced';
    }
    if (!owns(val.owner)) {
      // A foreign-owned live validation adopts only on a positive proof —
      // same-env dead owner (process_dead), dead environment (bootId), or
      // an ops-verified retirement record for the exact recorded instance.
      // A same-env owner that is still live retains its reservation.
      const proof = await adoptionProofFor(val.owner);
      if (!proof) return 'validation_retained';
      if (launchesNeedRegistration() && !registrationOk()) {
        return 'registration_blocked'; // adoption writes a NEW owner record
      }
      try {
        await send(card, 'validation_progress', {
          runId: run.id, validationId: val.id,
          adopt: true, proof,
          ...self(),
        }, `vadopt-${val.id}-by-${instanceId}`);
      } catch {
        return 'validation_retained';
      }
    }
    if (drainOnly || run.status === 'stopping' || val.cancel) {
      // Never issue new work — drain recorded procs, then close the
      // reservation as far as proof allows. A stopping run drains to
      // 'cancelled'; a dead run's stranded validation drains to 'failed'.
      if (valTasks.has(run.id)) return 'validation_running';
      const drained = await reconcileValidationProcs(card, run, val,
        { spoolFor: spoolForRun(run, val) });
      const outcome = (run.status === 'stopping' || val.cancel) ? 'cancelled' : 'failed';
      await endValidation(card, run, val.id, drained ? outcome : 'unproven',
        drained ? 'all groups proven dead' : 'unproven groups remain');
      return drained ? 'validation_drained' : 'validation_retained';
    }
    if (val.status === 'unproven') {
      // Drain path: recorded procs may now be provably dead — settle them
      // and let a failed outcome release the unit honestly.
      if (valTasks.has(run.id)) return 'validation_running';
      const drained = await reconcileValidationProcs(card, run, val,
        { spoolFor: spoolForRun(run, val) });
      if (drained) {
        await endValidation(card, run, val.id, 'failed', 'unproven reservation drained — evidence incomplete');
      }
      return drained ? 'validation_drained' : 'validation_retained';
    }
    if (val.phase === 'review') return await driveRolePhase(card, run, val, 'reviewer');
    if (val.phase === 'check_review') return await driveRolePhase(card, run, val, 'checker');
    // prepare/verify: the check-execution task — at most ONE in flight.
    if (!valTasks.has(run.id)) {
      valTasks.set(run.id, runValidationTask(card, run, val)
        .finally(() => valTasks.delete(run.id)));
      return 'validation_started';
    }
    return 'validation_running';
  }

  // O4/S4 — the shared U5 tail for orchestrator and swarm runs. Once the
  // mode driver has finished (decompose/graph → integrate import, or swarm
  // protocol → broker freeze → acceptance), the run rides the core
  // validation surface IDENTICALLY to a solo/fusion implementation run:
  // live-attempt supervision on a terminal run, stop-drain through
  // finalizeStoppingRun, live-validation supervision, and begin_validation
  // issuance at active+awaiting_validation with a bound workspace.
  async function driveManagedValidationTail(card, run, out) {
    // Mode workers belong to F1; reviewer/checker attempts belong to the
    // shared process runtime and must be observed before validation can
    // consume their reports (including after an owner restart).
    const liveRole = (run.attempts || []).find((a) => a
      && ['reviewer', 'checker'].includes(a.role) && ATTEMPT_LIVE.has(a.status));
    if (liveRole) {
      const rr = await resumeAttempt(card, run, liveRole).catch(() => 'resume_retry');
      out[rr] = (out[rr] || 0) + 1;
      run = await client.getRun(run.id);
      if (!run || (run.attempts || []).some((a) => a?.id === liveRole.id
        && ATTEMPT_LIVE.has(a.status))) return;
    }
    if (!RUN_LIVE.has(run.status)) {
      const v = run.validation;
      if (v && VAL_LIVE.has(v.status)) {
        const rr = await driveValidation(card, run, true).catch(() => 'validation_retry');
        out[rr] = (out[rr] || 0) + 1;
      }
      return;
    }
    if (run.status === 'stopping') {
      const valLive = run.validation && VAL_LIVE.has(run.validation.status);
      if (valLive) {
        const rr = await driveValidation(card, run).catch(() => 'validation_retry');
        out[rr] = (out[rr] || 0) + 1;
        return;
      }
      const rr = await finalizeStoppingRun(card, run).catch(() => 'stop_retry');
      out[rr] = (out[rr] || 0) + 1;
      return;
    }
    const valLive = run.validation && VAL_LIVE.has(run.validation.status);
    if (valLive) {
      const rr = await driveValidation(card, run).catch(() => 'validation_retry');
      out[rr] = (out[rr] || 0) + 1;
      return;
    }
    const prevValDone = !run.validation
      || ['settled', 'cancelled', 'failed'].includes(run.validation.status);
    const valCount = (run.validationHistory || []).length + (run.validation ? 1 : 0);
    if (validationEnabled && run.status === 'active' && run.phase === 'awaiting_validation'
        && prevValDone && !run.fixContext && run.workspaceId) {
      if (run.validation?.status === 'failed' && valCount >= 3) {
        await send(card, 'complete_run', {
          runId: run.id, status: 'blocked',
          reason: `validation failed ${valCount} times — no automatic retry`,
          ...self(),
        }, `cr-${run.id}-validation-exhausted`).catch(() => {});
        out.validation_exhausted = (out.validation_exhausted || 0) + 1;
        return;
      }
      const validationId = newValidationId(run);
      try {
        await send(card, 'begin_validation', {
          runId: run.id, validationId, leaseMs, ...self(),
        }, `bv-${validationId}`);
        out.validation_started = (out.validation_started || 0) + 1;
      } catch (e) {
        out[isErr(e, 'limit_reached') ? 'limited' : 'validation_refused']
          = (out[isErr(e, 'limit_reached') ? 'limited' : 'validation_refused'] || 0) + 1;
      }
      return;
    }
    out[`${run.mode}_parked`] = (out[`${run.mode}_parked`] || 0) + 1;
  }

  async function driveRun(card, runSummary, out) {
    let run = await client.getRun(runSummary.id);
    if (!run) return;
    if (run.mode === 'fusion') {
      // F2/F3: panelist + handoff attempts live in the F1 constrained
      // container runtime — NEVER through the solo process-runtime path.
      // Unwired fusion drives nothing (fail closed).
      if (!fusionDriver) {
        out.fusion_unwired = (out.fusion_unwired || 0) + 1;
        return;
      }
      const r = await fusionDriver.drive(card, run);
      out[r] = (out[r] || 0) + 1;
      run = await client.getRun(run.id);
      if (!run || run.mode !== 'fusion') return;
      // F3: judge → work order → integrator → canonical import. Owns every
      // judge/integrator attempt; hands the run to the U5 gate afterwards.
      const h = await (handoffDriver ?? fusionDriver).drive(card, run);
      out[h] = (out[h] || 0) + 1;
      run = await client.getRun(run.id);
      if (!run || run.mode !== 'fusion') return;
      // F3: an implementation run at 'awaiting_validation' rides the core
      // validation surface — checks, reviewer/checker on copies, the gate,
      // acceptance — IDENTICAL to a solo run. A fixContext is never
      // launched here: the integrator fix attempt is a constrained-
      // container launch owned by the handoff driver.
      if (!RUN_LIVE.has(run.status)) {
        const liveAtt = (run.attempts || []).find(
          (a) => a && ATTEMPT_LIVE.has(a.status) && !FUSION_ATTEMPT_ROLES.has(a.role));
        if (liveAtt) {
          const rr = await resumeAttempt(card, run, liveAtt).catch(() => 'resume_retry');
          out[rr] = (out[rr] || 0) + 1;
        }
        const v = run.validation;
        if (v && VAL_LIVE.has(v.status)) {
          const rr = await driveValidation(card, run, true).catch(() => 'validation_retry');
          out[rr] = (out[rr] || 0) + 1;
        }
        return;
      }
      const liveSolo = (run.attempts || []).find(
        (a) => a && ATTEMPT_LIVE.has(a.status) && !FUSION_ATTEMPT_ROLES.has(a.role));
      if (liveSolo) {
        const rr = await resumeAttempt(card, run, liveSolo);
        out[rr] = (out[rr] || 0) + 1;
        return;
      }
      const valLive = run.validation && VAL_LIVE.has(run.validation.status);
      if (run.status === 'stopping') {
        if (valLive) {
          const rr = await driveValidation(card, run).catch(() => 'validation_retry');
          out[rr] = (out[rr] || 0) + 1;
          return;
        }
        const rr = await finalizeStoppingRun(card, run).catch(() => 'stop_retry');
        out[rr] = (out[rr] || 0) + 1;
        return;
      }
      if (valLive) {
        const rr = await driveValidation(card, run).catch(() => 'validation_retry');
        out[rr] = (out[rr] || 0) + 1;
        return;
      }
      const prevValDone = !run.validation
        || ['settled', 'cancelled', 'failed'].includes(run.validation.status);
      const valCount = (run.validationHistory || []).length + (run.validation ? 1 : 0);
      if (validationEnabled && run.status === 'active' && run.phase === 'awaiting_validation'
          && prevValDone && !run.fixContext && run.workspaceId) {
        if (run.validation?.status === 'failed' && valCount >= 3) {
          await send(card, 'complete_run', {
            runId: run.id, status: 'blocked',
            reason: `validation failed ${valCount} times — no automatic retry`,
            ...self(),
          }, `cr-${run.id}-validation-exhausted`).catch(() => {});
          out.validation_exhausted = (out.validation_exhausted || 0) + 1;
          return;
        }
        const validationId = newValidationId(run);
        try {
          await send(card, 'begin_validation', {
            runId: run.id, validationId, leaseMs, ...self(),
          }, `bv-${validationId}`);
          out.validation_started = (out.validation_started || 0) + 1;
        } catch (e) {
          out[isErr(e, 'limit_reached') ? 'limited' : 'validation_refused']
            = (out[isErr(e, 'limit_reached') ? 'limited' : 'validation_refused'] || 0) + 1;
        }
        return;
      }
      // 'awaiting_validation' with a fixContext belongs to the handoff
      // driver (integrator fix); 'awaiting_acceptance' drifts via the
      // handoff drift check. Anything else parks.
      out.fusion_parked = (out.fusion_parked || 0) + 1;
      return;
    }
    if (run.mode === 'orchestrator' || run.mode === 'swarm') {
      // O-unit + S-unit: every orchestration/swarm attempt lives in the
      // shared F1 constrained runtime — NEVER the solo process path.
      // Unwired modes drive nothing (fail closed).
      const modeDriver = run.mode === 'orchestrator'
        ? orchDriver : await swarmDriver();
      if (!modeDriver) {
        out[`${run.mode}_unwired`] = (out[`${run.mode}_unwired`] || 0) + 1;
        return;
      }
      const r = await modeDriver.drive(card, run);
      out[r] = (out[r] || 0) + 1;
      run = await client.getRun(run.id);
      if (!run || run.mode !== 'orchestrator' && run.mode !== 'swarm') return;
      await driveManagedValidationTail(card, run, out);
      return;
    }
    if (!RUN_LIVE.has(run.status)) {
      // A TERMINAL run can still hold live reservations — a spawned attempt
      // or an active/unproven validation keeps its global unit until the
      // owned groups are positively proven dead. Supervise/drain only; NO
      // new work is ever issued for a terminal run.
      const liveAtt = (run.attempts || []).find((a) => a && ATTEMPT_LIVE.has(a.status));
      if (liveAtt) {
        const r = await resumeAttempt(card, run, liveAtt).catch(() => 'resume_retry');
        out[r] = (out[r] || 0) + 1;
      }
      const v = run.validation;
      if (v && VAL_LIVE.has(v.status)) {
        const r = await driveValidation(card, run, true).catch(() => 'validation_retry');
        out[r] = (out[r] || 0) + 1;
      }
      return;
    }
    const live = (run.attempts || []).find((a) => a && ATTEMPT_LIVE.has(a.status));
    if (live) {
      const r = await resumeAttempt(card, run, live);
      out[r] = (out[r] || 0) + 1;
      return;
    }
    if (quiesced) {
      // Runner quiesce: live-attempt supervision above still runs; NOTHING
      // new is issued — no validation open, no implementer/fix launch. A
      // live validation keeps its recorded owner for successor adoption.
      const v = run.validation;
      if (v && VAL_LIVE.has(v.status)) {
        const r = await driveValidation(card, run).catch(() => 'validation_retry');
        out[r] = (out[r] || 0) + 1;
      }
      out.quiesced = (out.quiesced || 0) + 1;
      return;
    }
    // Outage/journal/registration guards gate EVERY new work issuance —
    // validations, copies and role launches obey them exactly like attempts.
    if (outage || journalDegraded) {
      // No new launches during a state-API outage — or while the local
      // journal cannot durably persist. Owned work keeps supervision either
      // way; live validations drain/cancel through driveValidation below.
      const valLive0 = run.validation
        && (run.validation.status === 'active' || run.validation.status === 'unproven');
      if (valLive0) {
        const r = await driveValidation(card, run).catch(() => 'validation_retry');
        out[r] = (out[r] || 0) + 1;
      } else {
        out.outage_hold = (out.outage_hold || 0) + 1;
      }
      if (journalDegraded) out.journal_degraded = true;
      return;
    }
    const valLive = run.validation
      && (run.validation.status === 'active' || run.validation.status === 'unproven');
    if (run.status === 'stopping') {
      if (valLive) {
        // The reservation must drain before the run finalizes — cancel
        // intent is already on the durable record; the pipeline task kills
        // only its proven groups and never releases on hope.
        const r = await driveValidation(card, run).catch(() => 'validation_retry');
        out[r] = (out[r] || 0) + 1;
        return;
      }
      const r = await finalizeStoppingRun(card, run).catch(() => 'stop_retry');
      out[r] = (out[r] || 0) + 1;
      return;
    }
    if (valLive) {
      const r = await driveValidation(card, run).catch(() => 'validation_retry');
      out[r] = (out[r] || 0) + 1;
      return;
    }
    // The implementer attempt ended and parked at 'awaiting_validation' —
    // open the durable validation reservation (owned, slot-counted). A
    // terminal previous validation is pushed to history by the domain; a
    // 'failed' one retries up to 3 total validations, then blocks the run.
    const prevValDone = !run.validation
      || ['settled', 'cancelled', 'failed'].includes(run.validation.status);
    const valCount = (run.validationHistory || []).length + (run.validation ? 1 : 0);
    if (validationEnabled && run.status === 'active' && run.phase === 'awaiting_validation'
        && prevValDone && !run.fixContext && run.workspaceId) {
      if (run.validation?.status === 'failed' && valCount >= 3) {
        await send(card, 'complete_run', {
          runId: run.id, status: 'blocked',
          reason: `validation failed ${valCount} times — no automatic retry`,
          ...self(),
        }, `cr-${run.id}-validation-exhausted`).catch(() => {});
        out.validation_exhausted = (out.validation_exhausted || 0) + 1;
        return;
      }
      const validationId = newValidationId(run);
      try {
        await send(card, 'begin_validation', {
          runId: run.id, validationId, leaseMs, ...self(),
        }, `bv-${validationId}`);
        out.validation_started = (out.validation_started || 0) + 1;
      } catch (e) {
        out[isErr(e, 'limit_reached') ? 'limited' : 'validation_refused']
          = (out[isErr(e, 'limit_reached') ? 'limited' : 'validation_refused'] || 0) + 1;
      }
      return;
    }
    // Phase guard: with no live attempt, only a run still in an implementable
    // phase may launch. 'awaiting_validation' (implementer exited, awaiting
    // the U5 gate) parks UNLESS a fixContext is pending — that re-enters the
    // implementer role as a 'fix' attempt. 'awaiting_acceptance' never
    // relaunches.
    const phase = run.phase ?? null;
    const implementable = (run.status === 'queued')
      || (run.status === 'active' && (phase === null || phase === 'prepare' || phase === 'implement'))
      || (run.status === 'active' && phase === 'awaiting_validation' && !!run.fixContext);
    if (!implementable) {
      out.parked = (out.parked || 0) + 1;
      return;
    }
    if (launchesNeedRegistration() && !registrationOk()) {
      // Unregistered environment — new owner records would carry
      // envGeneration:null and be unretirable forever. Existing attempts
      // keep their supervision; only the LAUNCH is held, with a durable,
      // actionable diagnosis on the run.
      out.registration_blocked = (out.registration_blocked || 0) + 1;
      await recordEvent(card, run, 'launch_blocked', {
        code: 'environment_unregistered',
        detail: envRegisterError?.message ?? envRegisterError?.code
          ?? 'environment registration has not produced a generation yet',
      }).catch(() => {});
      return;
    }
    await verifyInputs(card.cardId, run); // immutable inputs gate allocation
    const wsRes = await ensureWorkspace(card, run);
    if (!wsRes.ok) {
      out[wsRes.code] = (out[wsRes.code] || 0) + 1;
      return;
    }
    for (let i = 0; i < MAX_LAUNCH_RETRIES_PER_TICK; i += 1) {
      const r = await tryLaunch(card, run, wsRes.ws);
      out[r] = (out[r] || 0) + 1;
      if (r !== 'retry') return;
      run = await client.getRun(run.id);
      if (!run || !RUN_LIVE.has(run.status)) return;
      if (run.status === 'stopping' || outage) return;
    }
  }

  // ---- outage mode ---------------------------------------------------------

  // The API is unreachable: continue LOCAL supervision of owned attempts —
  // read events (journaled), probe status, and at the RECORDED lease expiry
  // request cancellation of our own run ids only. Nothing resolves without
  // observed terminal state + process proof; intents are journaled for
  // ordered replay. Inherited (dead-predecessor) entries are observed but
  // NEVER cancelled — authority requires the post-recovery adoption path.
  async function outageTick() {
    const t = now();
    for (const [attemptId, tr] of tracked) {
      if (!tr.porchRunId) continue;
      // Local event drain — buffered to the journal, replayed in order.
      // The cursor advances ONLY after the durable append acknowledges; a
      // failed persist keeps the old cursor so the next drain re-reads the
      // same events (idempotent re-drain, never skipped evidence).
      try {
        const cursor = tr.cursor ?? 0;
        const ev = await runtime.events(tr.porchRunId, { cursor, maxEvents: OBSERVE_MAX_EVENTS });
        const nextCursor = ev?.ok ? (ev.nextCursor ?? cursor) : cursor;
        if (ev?.ok && (ev.events?.length || nextCursor !== cursor)) {
          await journalAppend({
            kind: 'observe', cardId: tr.cardId, runId: tr.runId, attemptId,
            observer: { cursor: nextCursor, lastStatusAt: t, lastStatus: ev.status ?? undefined },
            events: (ev.events || []).map((e, i) => ({
              type: mapEventType(e?.type),
              data: e?.data !== undefined ? e.data : null,
              src: { i: cursor + i },
            })),
          });
          tr.cursor = nextCursor;
        }
      } catch (e) {
        if (e && e.code === 'journal_write_failed') throw e; // fail closed
      }
      // Terminal = status AND process proof, same gate as the online path —
      // the tracked record carries the attempt's full original identity
      // (owner env/envInstance, supervisor) because the proof binds to it.
      let proof = null;
      let st = null;
      try {
        st = await runtime.status(tr.porchRunId);
        if (st?.ok && st.terminal) {
          proof = await terminalProof(
            { id: attemptId, owner: tr.owner ?? null, supervisor: tr.supervisor ?? null }, st);
        }
      } catch { /* unknown — remains nonterminal */ }
      if (proof?.ok) {
        // Preserve the observed result BEFORE resolving: wait() must return
        // the terminal evidence (a failed wait is never a resolve) and a
        // 'completed' run must carry its final result. The full text is
        // staged as an artifact — the staging area is a plain filesystem
        // path an API outage cannot break. Any failure here journals a
        // diagnostic and RETAINS the tracked attempt for retry; a resolve is
        // never written without its complete evidence, and the full text is
        // never truncated into a smaller "summary" passed off as the result.
        const h = await harvestTerminal(tr.porchRunId, st);
        if (!h.ok) {
          await journalAppend({
            kind: 'diagnostic', cardId: tr.cardId, runId: tr.runId, attemptId,
            code: `terminal_unproven:${h.code}`, detail: h.detail ?? null,
          });
          continue;
        }
        const finalText = h.wt.finalText ?? null;
        const durationS = h.wt.durationS ?? null;
        let staged = null;
        if (stateDir && typeof finalText === 'string' && finalText.length) {
          try {
            staged = await writeStagedArtifact(stateDir, attemptId,
              `final-${attemptId}.txt`, finalText);
          } catch (e) {
            await journalAppend({
              kind: 'diagnostic', cardId: tr.cardId, runId: tr.runId, attemptId,
              code: 'artifact_stage_failed',
              detail: String(e?.code || e?.message || e).slice(0, 300),
            });
            continue; // evidence undurable — retain for retry
          }
        }
        await journalAppend({
          kind: 'resolve', cardId: tr.cardId, runId: tr.runId, attemptId,
          porchRunId: tr.porchRunId,
          observedStatus: st.status ?? null,
          exitCode: st.exitCode ?? h.wt.exitCode ?? null,
          error: st.error ?? h.wt.error ?? null,
          durationS,
          stagedArtifact: staged
            ? { stagedPath: staged.stagedPath, bytes: staged.bytes, sha256: staged.sha256 }
            : null,
          // A bounded summary for journal forensics only — the RESULT is
          // the staged artifact, never this preview.
          summary: typeof finalText === 'string' ? finalText.slice(0, 500) : null,
          reason: tr.cancelSent
            ? 'lease-expiry cancel reached terminal during outage'
            : 'terminal observed during outage',
          owner: tr.owner ?? null,
          supervisor: tr.supervisor ?? null,
        });
        tracked.delete(attemptId);
        continue;
      }
      if (st?.ok && st.terminal && proof && !proof.ok) {
        await journalAppend({
          kind: 'diagnostic', cardId: tr.cardId, runId: tr.runId, attemptId,
          code: `terminal_unproven:${proof.code}`, detail: proof.detail ?? null,
        });
      }
      // Recorded lease expiry -> cancel own handles only (owned === true;
      // inherited entries are never cancelled by this process). The intent
      // is journaled; NOTHING is resolved without observed terminal state.
      const leaseUntil = Number(tr.leaseUntil) || 0;
      if (tr.owned === true && leaseUntil && t >= leaseUntil && !tr.cancelSent) {
        try {
          const res = await runtime.cancel(tr.porchRunId);
          await journalAppend({
            kind: 'cancel', cardId: tr.cardId, runId: tr.runId, attemptId,
            porchRunId: tr.porchRunId,
            requested: res?.requested === true,
            leaseUntil,
            reason: 'lease expired during state-API outage',
          });
          tr.cancelSent = res?.requested === true;
        } catch (e) {
          await journalAppend({
            kind: 'cancel', cardId: tr.cardId, runId: tr.runId, attemptId,
            porchRunId: tr.porchRunId, requested: false,
            error: String(e?.message || e).slice(0, 200),
          });
        }
      }
    }
    await snapshotWrite();
    return { outage: true, tracked: tracked.size };
  }

  // Recovery: replay the journal in recorded order against authoritative
  // state — refresh CAS, honor owner checks, dedupe via command ids and
  // src.i cursors. An entry leaves the journal ONLY on success, on a proven
  // authoritative-terminal equivalent (attempt_terminal = already done), or
  // on a successful dead-letter write. Unproven 'resolve' entries NEVER
  // expire — the positive-proof duty outlives any attempt counter.
  // A retained journaled duty leaves ONE durable diagnostic (deterministic
  // commandId → dedup across replay passes), never a silent drop.
  async function journalDiagOnce(e, code, detail) {
    const diagCard = { cardId: e.cardId, internalRevision: null };
    await refreshCard(diagCard).catch(() => {});
    if (!Number.isInteger(diagCard.internalRevision)) return;
    await send(diagCard, 'record_event', {
      runId: e.payload?.runId ?? e.runId, attemptId: e.payload?.attemptId ?? null,
      type: 'journal_retain',
      data: {
        code, detail: String(detail ?? '').slice(0, 300),
        commandId: e.commandId ?? null, commandType: e.type ?? null,
        srcInstance: e.srcInstance ?? null,
      },
      ...self(),
    }, `jr-ret-${e.commandId ?? `${e.kind}-${e.at}`}-${code}`, { journal: false })
      .catch(() => {});
  }

  // Apply ONE journal entry against authoritative state. Returns
  //   'applied' — durably committed server-side (or a dead-letter write
  //     succeeded, moving it off the journal),
  //   'retain'  — must stay spooled (unproven, deferred, or deadletter failed),
  //   'outage'  — the API went back down; replay must stop NOW.
  async function applyJournalEntry(e) {
    const src = e.srcInstance ?? instanceId;   // command-id provenance
    const card = { cardId: e.cardId, internalRevision: null };
    // A replayed entry arrives without a card revision — the FIRST internal
    // command must carry the CURRENT expectedInternalRevision or the domain
    // rejects with bad_command (a 400, not the retryable 409 revision
    // conflict) and the entry would dead-letter unapplied. Refresh once per
    // entry — later sends inherit the post-command revision automatically.
    if (e.kind !== 'corrupt') {
      await refreshCard(card);
    }
    if (e.kind === 'corrupt') {
      return (await deadLetter(e, 'unparseable')) ? 'applied' : 'retain';
    }
    if (e.kind === 'command') {
      // A durable mutation lost to an API outage — replayed under STRICT
      // provenance rules, never verbatim:
      //   1. Authoritative RECEIPT check first (internal command_receipt):
      //      the original commandId + server-recomputed type/payload hash.
      //      An exact receipt discharges the duty — the original landed
      //      even though its response was lost. A receipt under a
      //      DIFFERENT payload hash is an explicit conflict → retain.
      //   2. Proven unapplied → resolve the actual typed resource. The
      //      origin identity in e.payload is evidence only — never
      //      re-executed under it (no impersonating a dead owner).
      //   3. Ownership: live foreign owner → retain + diagnose; provably
      //      dead → adopt with positive proof; ours → reissue.
      //   4. Resend rebinds identity to THIS instance under a DISTINCT
      //      deterministic key (instance+source commandId+source payload
      //      hash) — it can never collide with a concurrently landing
      //      original, and replays of THIS replay still dedup.
      const rcpt = await send(card, 'command_receipt', {
        commandId: e.commandId, type: e.type, payload: e.payload, ...self(),
      }, `jr-rc-${src}-${e.commandId}`, { journal: false });
      const rec = rcpt?.result ?? rcpt ?? {};
      if (rec.exists === true && rec.matched === true) return 'applied';
      if (rec.exists === true) {
        await journalDiagOnce(e, 'command_id_conflict',
          `commandId ${e.commandId} exists under a different payload — retain-conflict, never overwrite`);
        return 'retain';
      }
      const rn = await client.getRun(e.payload?.runId); // outage propagates → 'retain'
      if (!rn) {
        // The run is gone — the duty can never be verified. Lost evidence,
        // not a discharge: retain + diagnose, never silently drop.
        await journalDiagOnce(e, 'duty_run_missing',
          'target run not found — journaled duty retained as unapplied evidence');
        return 'retain';
      }
      const p = e.payload || {};
      const liveVal = (v) => v && (v.status === 'active' || v.status === 'unproven');
      const val = liveVal(rn.validation) && rn.validation.id === p.validationId
        ? rn.validation : null;
      // Typed equivalence for a journaled CHECK report against the
      // authoritative record — live or terminal. Every semantic field must
      // equal the journaled payload, the referenced log artifacts must be
      // validation-bound evidence whose recorded hash matches the report,
      // the proc must carry its positive proof, and the stored bytes must
      // re-verify. Transport failures inside the byte check PROPAGATE —
      // an outage is retried, never counted as evidence mismatch.
      const checkReportEquivalent = async (rnView, chk) => {
        const rep = rnView?.validation?.checks?.reports
          ?.find((x) => x && x.index === chk.index);
        const SEM = ['status', 'run', 'cwd', 'timeoutSec', 'setup', 'exitCode',
          'logOutArtifactId', 'logErrArtifactId', 'logSha256Out', 'logSha256Err',
          'stdoutBytes', 'stderrBytes', 'stdoutTail', 'stderrTail', 'groupDead'];
        const proc = rnView?.validation?.procs?.[chk.index];
        let same = !!rep && rnView?.validation?.id === p.validationId
          && proc?.state === 'settled' && isObj(proc?.proof)
          && (rep?.groupDead === true ? proc.proof.groupDead === true : true)
          && SEM.every((f) => JSON.stringify(rep[f] ?? null)
            === JSON.stringify(chk[f] ?? null));
        if (same) {
          for (const [artF, shaF] of [
            ['logOutArtifactId', 'logSha256Out'],
            ['logErrArtifactId', 'logSha256Err'],
          ]) {
            const art = rnView.artifacts?.[rep[artF]];
            if (!art || art.id !== rep[artF] || art.kind !== 'evidence'
              || (art.validationId ?? null) !== (p.validationId ?? null)
              || art.sha256 !== rep[shaF]) { same = false; break; }
            let got;
            try {
              got = await client.getArtifact(rnView.id, rep[artF]);
            } catch (ge) {
              if (ge && (ge.status === 404 || ge.status === 422
                || ge.code === 'corrupt_store' || ge.code === 'artifact_evidence_unbound'
                || ge.code === 'artifact_not_found' || ge.code === 'run_not_found')) {
                same = false; break;
              }
              throw ge;
            }
            const raw = typeof got?.contentBase64 === 'string'
              ? Buffer.from(got.contentBase64, 'base64') : null;
            if (!raw || sha256(raw) !== rep[shaF] || raw.length !== art.bytes) {
              same = false; break;
            }
          }
        }
        return same;
      };
      // Replay key: deterministic + bounded — sha256 over the FULL
      // identities (replayer instanceId, source instance, original
      // commandId, canonical original payload). A different adopter never
      // collides; a restarted replay of THIS entry finds the same key.
      const rebound = { ...p, ...self() };
      const rkey = `jr-${sha256(JSON.stringify({
        i: instanceId, s: e.srcInstance ?? instanceId,
        c: e.commandId, t: e.type, p,
      })).slice(0, 40)}`;
      // Before resending under changed provenance, the replay key's OWN
      // exact receipt is checked — an earlier replay pass may have landed.
      const own = await send(card, 'command_receipt', {
        commandId: rkey, type: e.type, payload: rebound, ...self(),
      }, `jr-rr-${rkey.slice(3, 27)}`, { journal: false });
      const ownRec = own?.result ?? own ?? {};
      if (ownRec.exists === true && ownRec.matched === true) return 'applied';
      if (ownRec.exists === true) {
        await journalDiagOnce(e, 'replay_key_conflict',
          `replay key for ${e.commandId} exists under a different payload — retain-conflict`);
        return 'retain';
      }
      if (e.type === 'begin_validation') {
        // The typed resource is the run's validation SLOT: a live
        // validation (any owner) supersedes the journaled begin — a
        // duplicate live validation is NEVER issued. Resend only while the
        // run still genuinely awaits one AND the original starter is known
        // gone — own-journal entries (we are the origin; the sending task
        // died with the outage) or inherited spools (predecessor proven
        // dead by the snapshot gate) satisfy it. Anything else retains.
        const originGone = e.srcInstance === undefined
          || e.srcInstance === instanceId || inheritedSpools.has(e.srcInstance);
        if (liveVal(rn.validation) || !RUN_LIVE.has(rn.status)
          || !['awaiting_validation', 'active'].includes(rn.phase ?? 'awaiting_validation')
          || !originGone) {
          await journalDiagOnce(e, 'duty_superseded',
            'a live/terminal validation, run phase, or a live original starter supersedes the journaled begin — retained');
          return 'retain';
        }
      } else if (p.attemptId) {
        // Attempt-bound duty (role artifacts bind their ORIGINAL attempt
        // owner per the U4 contract) — the resource is the attempt.
        const att = (rn.attempts || []).find((a) => a && a.id === p.attemptId);
        if (!att) {
          await journalDiagOnce(e, 'duty_unapplied_terminal',
            'bound attempt is gone — journaled artifact duty retained as evidence');
          return 'retain';
        }
        if (!owns(att.owner)) {
          // Provably-dead attempt owner → real U4 attempt adoption, THEN
          // the rebound commit. A live foreign owner retains — never
          // rebound, never impersonated.
          const proof = await adoptionProofFor(att.owner);
          if (!proof) {
            await journalDiagOnce(e, 'duty_foreign_owned',
              'artifact binds a foreign-owned attempt — retained until its owner dies or its equivalent lands');
            return 'retain';
          }
          try {
            await send(card, 'adopt_attempt', {
              runId: rn.id, attemptId: att.id, proof, leaseMs, ...self(),
            }, `jr-ad-${att.id}-${rkey.slice(3, 27)}`, { journal: false });
          } catch (ae) {
            // Terminal attempts cannot be adopted — the artifact duty is
            // then unappliable but stays evidenced, never dropped.
            await journalDiagOnce(e, 'duty_attempt_terminal',
              `attempt adoption refused (${ae?.code ?? ae}) — journaled artifact retained`);
            return 'retain';
          }
        }
      } else {
        if (!val) {
          // Terminal/superseded validation: a journaled CHECK report is
          // still discharged by its EXACT recorded equivalent on the final
          // record — the validation object outlives its live phase. Any
          // other unapplied mutation retains as unapplied-terminal.
          if (isObj(p.check) && typeof p.check.index === 'number'
            && e.type === 'validation_progress'
            && await checkReportEquivalent(rn, p.check)) {
            return 'applied';
          }
          await journalDiagOnce(e, 'duty_unapplied_terminal',
            'validation is terminal/superseded and the journaled mutation never landed');
          return 'retain';
        }
        if (!owns(val.owner)) {
          const proof = await adoptionProofFor(val.owner);
          if (!proof) {
            // A LIVE foreign owner holds the validation — the duty still
            // owes; only its exact committed equivalent may discharge it.
            await journalDiagOnce(e, 'duty_foreign_owned',
              'validation held by a live foreign owner — duty retained until its equivalent lands');
            return 'retain';
          }
          await send(card, 'validation_progress', {
            runId: p.runId, validationId: val.id,
            adopt: true, proof, ...self(),
          }, `vadopt-${val.id}-jr-${src}-${e.commandId}`, { journal: false });
        }
      }
      try {
        await send(card, e.type, rebound, rkey, { journal: false });
        return 'applied';
      } catch (se) {
        // A check report for this index landed under ANOTHER command key
        // (the resumed task's own resend, or a concurrent replay). The
        // journaled duty discharges ONLY on an exact-match authoritative
        // record — every semantic field equal AND the recorded log
        // artifacts' stored bytes still verify; anything less retains.
        if (se && e.type === 'validation_progress' && isObj(p.check)
          && typeof p.check.index === 'number' && se.status === 409) {
          const fr = await client.getRun(rn.id);
          if (await checkReportEquivalent(fr, p.check)) return 'applied';
          await journalDiagOnce(e, 'report_conflict',
            `check[${p.check.index}] recorded under different or unverifiable evidence — journaled report retained`);
          throw se;
        }
        throw se;
      }
    }
    if (e.kind === 'observe') {
      await send(card, 'observe_attempt', {
        runId: e.runId, attemptId: e.attemptId,
        observer: e.observer ?? {}, events: e.events ?? [], ...self(),
      }, `jr-ob-${e.attemptId}-${e.observer?.cursor ?? 0}-${e.at}-${src}`);
      return 'applied';
    }
    if (e.kind === 'cancel') {
      await send(card, 'cancel_attempt', {
        runId: e.runId, attemptId: e.attemptId,
        porchRunId: e.porchRunId ?? undefined,
        dispatched: e.requested === true,
        reason: e.reason ?? 'cancel dispatched during outage',
        ...self(),
      }, `jr-cx-${e.attemptId}-${e.at}-${src}`);
      return 'applied';
    }
    if (e.kind === 'diagnostic') {
      await send(card, 'record_event', {
        runId: e.runId, attemptId: e.attemptId, type: 'outage',
        data: { code: e.code ?? null, detail: e.detail ?? null }, ...self(),
      }, `jr-dg-${e.attemptId}-${e.at}-${src}`);
      return 'applied';
    }
    if (e.kind === 'resolve') {
      // Re-verify the FULL gate FIRST: terminal status AND process proof
      // bound to the attempt's recorded original environment must still
      // hold — discharge NEVER happens on terminal metadata alone. An
      // unknown child, a foreign namespace, or a still-live child all stay
      // retained here with zero wrong probes.
      const st = e.porchRunId
        ? await runtime.status(e.porchRunId).catch(() => null) : null;
      const pr = (st?.ok && st.terminal)
        ? await terminalProof(
          { id: e.attemptId, owner: e.owner ?? null, supervisor: e.supervisor ?? null },
          st)
        : { ok: false, code: st?.ok ? 'not_terminal' : 'status_unreachable' };
      if (!pr.ok) {
        await journalDiagOnce(e, `terminal_unproven:${pr.code}`,
          pr.detail ?? 'resolve duty retained — positive process proof still owed');
        return 'retain'; // proof still owed — never expires
      }
      // The typed resource: the attempt may already be terminal with the
      // exact duty committed — its original resolver proved the outcome
      // and imported the artifact; a rebound replay then discharges by
      // EXACT equivalence (outcome + result status/exit/duration + committed
      // artifact record + re-verified stored bytes), never by a blanket
      // "already terminal" skip. A terminal attempt under different or
      // unverifiable evidence retains the duty as a durable conflict.
      const rnR = await client.getRun(e.runId);
      const att0 = (rnR?.attempts || []).find((a) => a && a.id === e.attemptId);
      if (att0 && ATTEMPT_TERMINAL.has(att0.status)) {
        const wantOutcome = e.observedStatus === 'cancelled' ? 'cancelled'
          : e.observedStatus === 'completed' ? 'completed' : 'failed';
        const res0 = att0.result ?? {};
        // The full output owed by this entry: the staged artifact's
        // recorded hash/bytes, or recomputed from the journaled full text —
        // a nonempty finalText with a missing staged record still owes the
        // complete bytes; nothing discharges on absent/absent equality.
        const owed = e.stagedArtifact
          ? { sha256: e.stagedArtifact.sha256, bytes: e.stagedArtifact.bytes }
          : (typeof e.finalText === 'string' && e.finalText.length
            ? { sha256: sha256(Buffer.from(e.finalText, 'utf8')),
              bytes: Buffer.byteLength(e.finalText, 'utf8') }
            : null);
        let exact = att0.status === wantOutcome
          && (res0.status ?? null) === (e.observedStatus ?? null)
          && (res0.exitCode ?? null) === (e.exitCode ?? null)
          && (res0.durationS ?? null) === (e.durationS ?? null);
        if (exact && owed) {
          exact = /^[0-9a-f]{64}$/.test(owed.sha256 ?? '')
            && Number.isInteger(owed.bytes) && owed.bytes >= 0;
          const aid = exact ? (res0.finalArtifactId ?? null) : null;
          const art = exact && aid ? rnR.artifacts?.[aid] : null;
          exact = !!(exact && art && art.attemptId === e.attemptId
            && art.kind === 'final'
            && art.sha256 === owed.sha256 && art.bytes === owed.bytes);
          if (exact) {
            // Re-verify the committed bytes through the artifact plane — a
            // record whose blob is gone or corrupt discharges nothing. A
            // genuine transport outage propagates for retry, never a
            // permanent conflict.
            let got;
            try {
              got = await client.getArtifact(e.runId, aid);
            } catch (ge) {
              if (ge && (ge.status === 404 || ge.status === 422
                || ge.code === 'corrupt_store' || ge.code === 'artifact_evidence_unbound'
                || ge.code === 'artifact_not_found' || ge.code === 'run_not_found')) {
                exact = false;
              } else {
                throw ge;
              }
            }
            if (exact) {
              const raw = typeof got?.contentBase64 === 'string'
                ? Buffer.from(got.contentBase64, 'base64') : null;
              exact = !!(raw && sha256(raw) === owed.sha256
                && raw.length === owed.bytes);
            }
          }
        } else if (exact) {
          // Nothing owed → the committed result must not carry one either.
          exact = (res0.finalArtifactId ?? null) === null;
        }
        if (exact) return 'applied';
        await journalDiagOnce(e, 'resolve_conflict',
          `attempt ${e.attemptId} is already terminal under different or unverifiable evidence — journaled resolve retained`);
        return 'retain';
      }
      // The captured result lands BEFORE the resolve — a resolve never
      // commits without its artifact when one exists.
      let finalArtifactId = null;
      const stagedPath = e.stagedArtifact?.stagedPath ?? null;
      let stagedBytes = e.stagedArtifact?.bytes ?? null;
      let stagedSha = e.stagedArtifact?.sha256 ?? null;
      if (!stagedPath && typeof e.finalText === 'string' && e.finalText.length && stateDir) {
        const stagedNow = await writeStagedArtifact(stateDir, e.attemptId,
          `final-${e.attemptId}.txt`, e.finalText);
        stagedBytes = stagedNow.bytes;
        stagedSha = stagedNow.sha256;
        e.stagedArtifact = { stagedPath: stagedNow.stagedPath, bytes: stagedBytes, sha256: stagedSha };
      }
      if (e.stagedArtifact?.stagedPath) {
        finalArtifactId = `art-${e.attemptId}`;
        await send(card, 'commit_artifact', {
          runId: e.runId, attemptId: e.attemptId,
          artifact: {
            id: finalArtifactId, kind: 'final', file: `final-${e.attemptId}.txt`,
            bytes: e.stagedArtifact.bytes, sha256: e.stagedArtifact.sha256,
          },
          stagedPath: e.stagedArtifact.stagedPath, ...self(),
        }, `jr-ca-${e.attemptId}-${e.at}-${src}`);
      }
      // Mirror resolveTerminal's run mapping or the run stays 'active' and
      // relaunches: a cancelled outcome terminalizes 'cancelled' only under a
      // recorded stop intent (run 'stopping', honoring its priorTerminal),
      // otherwise 'interrupted' — a lease-expiry cancel is SYSTEM-initiated,
      // never a user stop. 'failed' terminalizes 'failed'; 'completed' parks
      // the run at awaiting_validation (U5 gate). Skip the mapping when the
      // run is already terminal — never overwrite a committed status.
      const rn = await client.getRun(e.runId);
      const rnLive = rn && RUN_LIVE.has(rn.status);
      const rnAtt = (rn?.attempts || []).find((a) => a && a.id === e.attemptId);
      const replayRunStatus = !rnLive ? undefined
        : e.observedStatus === 'cancelled'
          ? (rn.status === 'stopping' ? (rn.priorTerminal ?? 'cancelled') : 'interrupted')
          : e.observedStatus === 'failed' ? 'failed' : undefined;
      const replayRunPhase = rnLive && e.observedStatus === 'completed'
        && rnAtt?.role === 'implementer'
        ? 'awaiting_validation' : undefined;
      await send(card, 'resolve_attempt', {
        runId: e.runId, attemptId: e.attemptId,
        outcome: e.observedStatus === 'cancelled' ? 'cancelled'
          : e.observedStatus === 'completed' ? 'completed' : 'failed',
        ...(replayRunStatus !== undefined ? { runStatus: replayRunStatus } : {}),
        ...(replayRunPhase !== undefined ? { runPhase: replayRunPhase } : {}),
        reason: e.reason ?? 'terminal observed during outage; resolved on recovery',
        result: {
          status: e.observedStatus ?? null,
          exitCode: e.exitCode ?? null,
          durationS: e.durationS ?? null,
          finalArtifactId,
          summary: (typeof e.finalText === 'string' ? e.finalText : e.summary ?? '')
            .slice(0, 1500) || null,
        },
        ...self(),
      }, `jr-rs-${e.attemptId}-${e.at}-${src}`);
      return 'applied';
    }
    if (e.kind === 'bind') {
      await send(card, 'bind_attempt', {
        runId: e.runId, attemptId: e.attemptId, porchRunId: e.porchRunId, ...self(),
      }, `jr-b-${e.attemptId}-${e.at}-${src}`);
      return 'applied';
    }
    return (await deadLetter(e, `unknown journal kind ${e.kind}`)) ? 'applied' : 'retain';
  }

  // Classify an apply failure: still-outage stops the pass; an authoritative
  // terminal/not-found verdict is honest dedup (someone already recorded the
  // equivalent); ownership/CAS refusals RETAIN — a foreign owner holds the
  // duty, we hold the evidence; anything else dead-letters only when the
  // dead-letter write itself succeeded.
  async function classifyEntryFailure(e, err) {
    if (isOutageError(err)) return 'outage';
    if (isErr(err, 'attempt_terminal') || isErr(err, 'attempt_not_found')
      || isErr(err, 'run_not_found')) {
      return 'applied';
    }
    if (isErr(err, 'not_attempt_owner') || isErr(err, 'not_workspace_owner')
      || isErr(err, 'ownership_unproven') || err?.status === 409) {
      return 'retain';
    }
    if (isErr(err, 'bad_command') || isErr(err, 'invalid_argument')) {
      // A KNOWN-kind entry rejected on envelope/payload validity is a code or
      // shape bug — the duty it carries (cancel/resolve/observe) is NOT
      // discharged and must never be silently discarded. Retain it for a
      // corrected replay and leave a durable diagnostic; dead-letter is only
      // for irrecoverably corrupt bytes or unknown kinds.
      const diagCard = { cardId: e.cardId, internalRevision: null };
      await refreshCard(diagCard).catch(() => {});
      if (Number.isInteger(diagCard.internalRevision)) {
        // Deterministic commandId — the diagnostic lands at most once even
        // across repeated replay passes of a persistently rejected entry.
        await send(diagCard, 'record_event', {
          runId: e.runId, attemptId: e.attemptId ?? null, type: 'outage',
          data: {
            code: 'journal_apply_rejected',
            kind: e.kind ?? null, rejected: err?.code ?? 'bad_command',
            detail: String(err?.message ?? err).slice(0, 300),
          },
          ...self(),
        }, `jr-rej-${e.kind}-${e.at}-${src}`).catch(() => {});
      }
      return 'retain';
    }
    return (await deadLetter(e, err)) ? 'applied' : 'retain';
  }

  // Recovery: replay the journal (and proven-dead predecessors' spools) in
  // recorded order — command ids dedup, owner checks honored. An entry
  // leaves storage ONLY when durably applied or dead-lettered.
  async function replayJournal() {
    if (!journalEntries.length && !inheritedSpools.size) {
      await journalLoad().catch(() => {});
      if (!journalEntries.length && !inheritedSpools.size) return { replayed: 0 };
    }
    let replayed = 0;
    // Own journal first.
    const remaining = [];
    let stop = false;
    for (const e of journalEntries) {
      if (stop) { remaining.push(e); continue; }
      let outcome;
      try {
        outcome = await applyJournalEntry(e);
      } catch (err) {
        outcome = await classifyEntryFailure(e, err);
      }
      if (outcome === 'outage') {
        remaining.push(e);
        stop = true;
      } else if (outcome === 'applied') {
        replayed += 1;
      } else {
        remaining.push(e);
      }
    }
    journalEntries = remaining;
    await journalPersist().catch(() => {}); // degrade-flag on failure
    // Proven-dead predecessor spools: apply each; a source file is
    // acknowledged only when fully replayed — partially applied sources are
    // rewritten with exactly what remains.
    for (const [srcInst, spool] of [...inheritedSpools]) {
      const leftover = [];
      for (const e of spool.entries) {
        if (stop) { leftover.push(e); continue; }
        let outcome;
        try {
          outcome = await applyJournalEntry(e);
        } catch (err) {
          outcome = await classifyEntryFailure(e, err);
        }
        if (outcome === 'outage') {
          leftover.push(e);
          stop = true;
        } else if (outcome === 'applied') {
          replayed += 1;
        } else {
          leftover.push(e);
        }
      }
      spool.entries = leftover;
      try {
        if (!leftover.length) {
          await fsp.rm(spool.file, { force: true });
          inheritedSpools.delete(srcInst);
        } else {
          await atomicWriteFile(spool.file,
            leftover.map((x) => JSON.stringify(x)).join('\n') + '\n');
        }
      } catch (err) {
        journalDegraded = true;
        lastJournalError = `predecessor spool ack failed: ${err?.code || err?.message || err}`;
      }
    }
    await snapshotWrite();
    return { replayed, remaining: remaining.length + [...inheritedSpools.values()].reduce((n, s) => n + s.entries.length, 0) };
  }

  async function tick() {
    await snapshotLoad();
    // Late predecessor deaths: a peer alive at first load is re-probed
    // every tick — when it dies, its tracked work + journal spool are
    // inherited for draining instead of orphaned.
    await scanPredecessors();
    try {
      await ensureRegistered();
    } catch (e) {
      // Registration's transport failure IS an API outage — supervise owned
      // work locally, launch nothing.
      if (isOutageError(e)) {
        if (!outage) { outage = true; outageSince = now(); }
        return outageTick();
      }
      throw e;
    }
    let listing;
    try {
      listing = await client.listCards();
    } catch (e) {
      if (isOutageError(e)) {
        if (!outage) { outage = true; outageSince = now(); }
        return outageTick();
      }
      throw e;
    }
    if (outage) {
      // API is back — replay before resuming normal scheduling.
      outage = false;
      await replayJournal();
      outageSince = null;
    } else if (journalEntries.length || inheritedSpools.size) {
      // Retained entries (unproven resolves, not-yet-adopted ownership) are
      // retried on EVERY tick until drained — retention is not expiry.
      await replayJournal();
    }
    const out = { cards: 0 };
    const reapCards = []; // card objects fetched this scan — reaper owner index
    for (const c of listing?.cards || []) {
      let card = null;
      try {
        card = await client.getCard(c.cardId);
      } catch (e) {
        // A mid-loop API loss is still an outage — enter outage mode instead
        // of aborting the tick and dropping the owned-work supervision pass.
        if (isOutageError(e)) {
          outage = true;
          outageSince = outageSince ?? now();
          out.outage = true;
          break;
        }
        throw e;
      }
      if (!card) continue;
      out.cards += 1;
      reapCards.push(card);
      for (const rs of card.runs || []) {
        // Dispatch reaches terminal runs that still hold live attempt/
        // validation reservations — driveRun drains those groups and never
        // issues new work for a terminal run.
        if (!runNeedsDrive(rs)) continue;
        try {
          await driveRun(card, rs, out);
        } catch (e) {
          if (isOutageError(e)) {
            outage = true;
            outageSince = outageSince ?? now();
            out.outage = true;
            break; // stop launching immediately; owned attempts keep local state
          }
          out.errors = out.errors || [];
          out.errors.push({ cardId: card.cardId, runId: rs.id, error: String(e?.message || e) });
          console.error(`managed run ${rs.id}: ${e?.code ?? 'drive_error'}: ${String(e?.message || e).slice(0, 500)}`);
        }
      }
    }
    // F1 worker reaper pass — independent of run dispatch: a terminal fusion
    // attempt's worker is reaped only after durable attempt + exact porch run
    // are terminal and every owned worker process is provably drained.
    // Deferrals persist per attempt (reap.json) for audit + crash recovery.
    if (workerReaper) {
      try {
        out.reaper = await workerReaper.sweep(reapCards, { listingComplete: !out.outage });
      } catch (e) {
        out.reaper_error = String(e?.code || e?.message || e);
      }
    }
    await snapshotWrite();
    if (journalDegraded) {
      // Externally observable on EVERY tick — a degraded journal gates
      // launches and must be diagnosable even when nothing tried to launch.
      out.journal_degraded = true;
      if (lastJournalError) out.journal_error = lastJournalError;
    }
    return out;
  }

  // F2 fusion panel driver — shares this scheduler's durable command path
  // (send), event recorder, owner identity, and adoption proofs; launches
  // go exclusively through the F1 constrained container runtime handed in
  // via the `fusion` dep.
  const fusionDriver = fusion?.runtime ? createPanelDriver({
    runtime: fusion.runtime,
    capabilityStore: fusion.capabilityStore ?? null,
    send,
    recordEvent,
    self,
    getRun: (id) => client.getRun(id),
    getDocument: (cardId, versionId) => client.getDocument(cardId, versionId),
    stateDir,
    canLaunch: () => !quiesced && !outage && !journalDegraded
      && (!launchesNeedRegistration() || registrationOk()),
    adoptionProofFor,
    cardTitle: fusion.cardTitle ?? null,
    launchOrphanMs: fusion.launchOrphanMs,
    leaseMs,
    instanceId,
    now,
  }) : null;

  // F3 handoff driver — judge + integrator + canonical import + fix +
  // acceptance-drift. Same durable path, same container runtime.
  const handoffDriver = fusion?.runtime ? createHandoffDriver({
    runtime: fusion.runtime,
    send,
    recordEvent,
    self,
    getRun: (id) => client.getRun(id),
    getDocument: (cardId, versionId) => client.getDocument(cardId, versionId),
    getArtifact: (runId, artifactId) => client.getArtifact(runId, artifactId),
    ensureWorkspace,
    stateDir,
    canLaunch: () => !quiesced && !outage && !journalDegraded
      && (!launchesNeedRegistration() || registrationOk()),
    adoptionProofFor,
    cardTitle: fusion.cardTitle ?? null,
    launchOrphanMs: fusion.launchOrphanMs,
    leaseMs,
    instanceId,
    now,
  }) : null;

  // O-unit orchestrator driver — decomposer → task work/verify/fix rounds →
  // assembler → canonical import → U5. Same durable command path; launches
  // go through the shared F1 constrained runtime (orchestrator.runtime
  // overrides only for a dedicated wiring — roles are disjoint).
  const orchRuntime = orchestrator?.runtime ?? fusion?.runtime ?? null;
  const orchDriver = orchRuntime ? createOrchDriver({
    runtime: orchRuntime,
    send,
    storage: orchestrator?.storage ?? null,
    projectsDir: orchestrator?.projectsDir ?? null,
    recordEvent,
    self,
    getRun: (id) => client.getRun(id),
    getDocument: (cardId, versionId) => client.getDocument(cardId, versionId),
    getArtifact: (runId, artifactId) => client.getArtifact?.(runId, artifactId),
    ensureWorkspace,
    stateDir,
    canLaunch: () => !quiesced && !outage && !journalDegraded
      && (!launchesNeedRegistration() || registrationOk()),
    adoptionProofFor,
    cardTitle: fusion?.cardTitle ?? orchestrator?.cardTitle ?? null,
    launchOrphanMs: orchestrator?.launchOrphanMs ?? fusion?.launchOrphanMs,
    leaseMs,
    instanceId,
    now,
  }) : null;

  // S-unit swarm driver — the native swarm module (swarm/driver.mjs, owned
  // by the swarm-runtime worker) is resolved LAZILY: until it lands, swarm
  // runs drive nothing and the branch answers 'swarm_unwired' (fail closed);
  // once present, the same shared F1 runtime + durable command path plug in.
  const swarmRuntime = swarm?.runtime ?? fusion?.runtime ?? null;
  let _swarmDriver = swarm?.driver ?? null;
  let _swarmInit = null;
  function swarmDriver() {
    if (_swarmDriver) return Promise.resolve(_swarmDriver);
    if (!swarmRuntime) return Promise.resolve(null);
    if (!_swarmInit) {
      _swarmInit = import('./swarm/driver.mjs')
        .then((m) => {
          _swarmDriver = m.createSwarmDriver({
            runtime: swarmRuntime,
            send,
            recordEvent,
            self,
            getRun: (id) => client.getRun(id),
            getDocument: (cardId, versionId) => client.getDocument(cardId, versionId),
            getArtifact: (runId, artifactId) => client.getArtifact?.(runId, artifactId),
            ensureWorkspace,
            stateDir,
            canLaunch: () => !quiesced && !outage && !journalDegraded
              && (!launchesNeedRegistration() || registrationOk()),
            adoptionProofFor,
            cardTitle: swarm?.cardTitle ?? fusion?.cardTitle ?? null,
            launchOrphanMs: swarm?.launchOrphanMs ?? fusion?.launchOrphanMs,
            leaseMs,
            instanceId,
            now,
          });
          return _swarmDriver;
        })
        .catch(() => null); // module absent or unconstructable — unwired, never guessed
    }
    return _swarmInit;
  }

  // F1 D14 worker reaper — same constrained runtime, driven from tick() so a
  // terminal attempt's worker is collected even after its run stops
  // dispatching. Reaping is proof-gated inside fusion/reaper.mjs. The
  // runtime is shared across fusion/orchestrator/swarm — any mode that
  // built it provides it (they are the same object in production).
  const reaperRuntime = fusion?.runtime ?? orchestrator?.runtime ?? swarm?.runtime ?? null;
  const workerReaper = reaperRuntime && typeof reaperRuntime.forAttempt === 'function'
    ? createWorkerReaper({
        runtime: reaperRuntime,
        getRun: (id) => client.getRun(id),
        now,
      })
    : null;

  return {
    tick, identity: self, instanceId, runnerId,
    quiesce, drain, quiesced: () => quiesced,
    _tracked: tracked, _journalFile: journalFile, _deadFile: deadFile,
    _recoveryFile: recoveryFile, _outage: () => outage,
    _fusionDriver: fusionDriver, _handoffDriver: handoffDriver,
    _orchDriver: orchDriver, _swarmDriver: swarmDriver,
    _workerReaper: workerReaper,
  };
}
