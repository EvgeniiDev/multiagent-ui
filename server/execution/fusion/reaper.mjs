// server/execution/fusion/reaper.mjs — F1 terminal-worker reaper (D14).
//
// One worker container per attempt; after the work ends the container must
// be collected or it idles forever (sleep infinity). Reaping is destructive,
// so the gate is a strict proof chain — NOTHING here stops or removes a
// worker on absence-of-evidence grounds:
//
//   1. BINDING — the durable attempt row must exist inside a listed fusion
//      run (the state service is the only attempt authority); the launch
//      record's workerId must exist and equal the deterministic
//      w-<attemptId>, and the porchRunId must be recorded on BOTH the
//      attempt row and the launch record and agree exactly.
//   2. ATTEMPT TERMINAL — the persisted attempt status must be in
//      ATTEMPT_TERMINAL. Nonterminal attempts are 'live': supervised by the
//      drivers, never reap candidates, no record written.
//   3. RUN TERMINAL — the bound run's own porch registry record (meta.json
//      + state.json on the worker's host bind mount — the same bytes porch
//      status reads) must bind meta.run_id exactly to the bound porchRunId
//      and agree meta vs state on ONE terminal verdict with finished_at.
//      Directory naming alone is not identity. Every other registry row
//      whose pids enter the drain proof is held to the same bar on its own
//      runId. A scan that is incomplete, inconsistent, or missing the
//      bound row defers.
//   4. DRAIN — every worker-scoped pid the registry recorded (supervisor +
//      child, all rows) must probe positively dead via proc-probe inside
//      the worker's own pid namespace: exists===false (ENOENT) or zombie.
//      'alive', unreadable, or unverifiable probes defer — never "probably
//      dead". A RUNNING container with ZERO recorded pids defers too: an
//      empty drain set proves nothing. A container the controller reports
//      'stopped' needs no probes: its pid namespace is already down.
//   5. ACT — only then, and only after the proof is persisted to reap.json:
//      worker.stop (skip when already stopped), verify the stopped state
//      through worker.status, then worker.remove, then verify 'gone'.
//
// workerStatus 'gone' is the ONLY definitive absence answer (registry rec
// present + Docker inspect NotFound). unknown_worker, RPC failures and
// timeouts are NOT absence — the controller registry may be lost while the
// container still runs — they defer. A gone worker reaps to the idempotent
// 'already_absent' no-op ONLY when a terminalProof was durably recorded
// while the worker still existed; otherwise it defers forever (the honest
// answer — nothing was ever verified about that worker).
//
// reap.json (<envRoot>/runtime/attempts/<id>/reap.json) is the auditable
// verdict: terminalProof, actions, lastDeferred (with a stable code +
// count), bounded history. It is written BEFORE any destructive call so a
// crash between proof and remove recovers cleanly, and a retry never
// re-deletes or corrupts terminal state. Attempt dir, launch record,
// session log, porch registry and artifacts are all retained by design
// (worker.remove tears down container+network only).

import { ATTEMPT_TERMINAL } from './reaper-contract.mjs';

const RUN_DONE = new Set(['completed', 'failed', 'cancelled']);
const REAP_FINAL = new Set(['reaped', 'already_absent']);
const HISTORY_MAX = 16;
const DETAILS_MAX = 64;
// Linux pid_max is exclusive; PID_MAX_LIMIT is 2^22 (include/linux/threads.h).
const LINUX_PID_MAX_LIMIT = 4_194_304;
const isValidPid = (value) => Number.isSafeInteger(value)
  && value > 0 && value < LINUX_PID_MAX_LIMIT;

// Worker-scoped probe tri-state — the only honest drain verdicts:
//   'enoent'       — exists===false after a successful probe (positive ENOENT)
//   'zombie'       — exists, defunct (Z/X)
//   'alive'        — positively readable live entry
//   'unverifiable' — everything else: no probe, refused exec, garbage output,
//                    partial fields. Never counts as dead.
function classifyProbe(probe) {
  if (!probe || typeof probe !== 'object' || probe.unverifiable) return 'unverifiable';
  if (probe.exists === false) return 'enoent';
  if (probe.exists === true && (probe.state === 'Z' || probe.state === 'X')) return 'zombie';
  if (probe.exists === true && probe.alive === true) return 'alive';
  return 'unverifiable';
}

export function createWorkerReaper({
  runtime,                 // REQUIRED — the F1 constrained container runtime
  getRun,                  // (runId) => durable run record | null
  now = () => Date.now(),
} = {}) {
  if (!runtime || typeof runtime.forAttempt !== 'function') {
    throw new Error('worker reaper requires the F1 container runtime');
  }
  if (typeof getRun !== 'function') throw new Error('worker reaper requires getRun');

  const iso = () => new Date(now()).toISOString();
  // launchRecord may surface fields at the top level or nested under .record
  // depending on the caller — read both, top level wins on disagreement
  // (the runtime's own canonical shape).
  const field = (rec, k) => rec?.[k] ?? rec?.record?.[k] ?? null;

  // Authenticated controller answer → 'running' | 'stopped' | 'gone'.
  // ANY error — unknown_worker, controller_unreachable, timeouts — is
  // 'worker_state_unknown': never absence, never permission to act.
  async function workerState(A) {
    try {
      const st = await A.workerStatus();
      const s = st?.state ?? st?.worker?.state ?? null;
      if (s === 'running' || s === 'stopped' || s === 'gone') return { state: s };
      return { code: 'worker_state_unknown', detail: `unrecognized worker state ${JSON.stringify(s)}` };
    } catch (e) {
      return { code: 'worker_state_unknown', detail: e?.code || e?.message || 'worker.status failed' };
    }
  }

  // Merge into the durable reap record. `cur` is the in-memory latest copy —
  // updated on every write so a 'proven'→'deferred' sequence inside one pass
  // never loses the terminalProof it just persisted.
  async function persist(A, cur, patch, { code = null, detail = null } = {}) {
    const rec = {
      schemaVersion: 1,
      kind: 'worker-reap',
      attemptId: cur?.attemptId ?? patch.attemptId,
      workerId: cur?.workerId ?? patch.workerId,
      runId: patch.runId !== undefined ? patch.runId : (cur?.runId ?? null),
      createdAt: cur?.createdAt ?? iso(),
      outcome: patch.outcome,
      terminalProof: patch.terminalProof ?? cur?.terminalProof ?? null,
      actions: { ...(cur?.actions || {}), ...(patch.actions || {}) },
      lastDeferred: code
        ? {
            code, detail: String(detail ?? '').slice(0, 300), at: iso(),
            count: cur?.lastDeferred?.code === code ? (cur.lastDeferred.count || 1) + 1 : 1,
          }
        : (cur?.lastDeferred ?? null),
      history: [...(cur?.history || []),
        { at: iso(), result: code ? `deferred:${code}` : patch.outcome }].slice(-HISTORY_MAX),
      persistedAt: iso(),
    };
    await A.writeReap(rec);
    return rec;
  }

  async function reapOne(attemptId, owner, { lookupComplete = true } = {}) {
    const A = runtime.forAttempt(attemptId);
    const workerId = A.workerId;
    const base = { attemptId, workerId };
    const prior = await A.readReap().catch(() => null);
    let cur = prior?.record && !prior.corrupt ? prior.record : null;
    let boundRun = null; // exact porch run binding — recorded on every verdict once known

    // Recorded terminal outcome: confirm the world still agrees (a record
    // saying 'reaped' next to a RUNNING container is inconsistent — fall
    // through and re-prove everything, never trust the file over reality).
    if (cur && REAP_FINAL.has(cur.outcome)) {
      const ws = await workerState(A);
      if (ws.state !== 'running') {
        return { action: cur.outcome, recorded: true, ...base };
      }
    }

    const defer = async (code, detail, extra = {}) => {
      try {
        cur = await persist(A, cur, {
          ...base, outcome: 'deferred',
          ...(boundRun ? { runId: boundRun } : {}), ...extra,
        }, { code, detail });
      } catch { /* a persist failure changes nothing about the defer itself */ }
      return { action: 'deferred', code, detail, ...base };
    };

    if (!owner?.att) {
      return defer(
        lookupComplete ? 'owner_unproven' : 'owner_lookup_incomplete',
        lookupComplete
          ? 'launch record exists but no durable attempt row in any listed run'
          : 'run lookup incomplete — ownership not decidable this pass');
    }
    const { att } = owner;
    if (!ATTEMPT_TERMINAL.has(att.status)) {
      return { action: 'live', ...base };
    }

    // ---- 1+2. exact attempt→worker / porchRunId binding ----------------------
    const rec = await A.launchRecord().catch(() => ({ missing: false, corrupt: true }));
    if (!rec || rec.missing) return defer('launch_record_missing', 'no durable launch record');
    if (rec.corrupt) return defer('launch_record_corrupt', 'launch record unreadable');
    const recWorker = field(rec, 'workerId');
    if (!recWorker) {
      return defer('worker_binding_unproven', 'launch record carries no workerId');
    }
    if (recWorker !== workerId) {
      return defer('worker_binding_mismatch', `launch record worker ${recWorker} != ${workerId}`);
    }
    const attWorker = att.launch?.workerId ?? null;
    if (attWorker && attWorker !== workerId) {
      return defer('worker_binding_mismatch', `attempt launch worker ${attWorker} != ${workerId}`);
    }
    const attRun = att.porchRunId ?? null;
    const recRun = field(rec, 'porchRunId');
    if (!attRun || !recRun) {
      return defer('run_binding_unproven',
        `porchRunId missing on ${!attRun && !recRun ? 'attempt and launch record'
          : !attRun ? 'attempt' : 'launch record'}`);
    }
    if (attRun !== recRun) {
      return defer('run_binding_mismatch', `attempt bound ${attRun} != launch record ${recRun}`);
    }
    boundRun = attRun;

    // ---- worker state (authenticated controller answer only) ------------------
    const ws = await workerState(A);
    if (ws.code) return defer(ws.code, ws.detail);
    const wstate = ws.state;

    // ---- 3. exact porch registry record — must be complete and terminal ------
    const reg = await A.registryRuns().catch(() => null);
    if (!reg || reg.ok !== true || reg.complete !== true) {
      return defer('registry_incomplete', 'porch registry scan incomplete or unreadable');
    }
    if (!Array.isArray(reg.rows)) {
      return defer('registry_incomplete', 'porch registry scan has no row list');
    }
    const rows = reg.rows;
    if (rows.some((r) => !r || r.corrupt)) {
      return defer('registry_row_corrupt', 'porch registry scan contains a corrupt row');
    }
    // Exact identity per row, bound or not: meta.run_id must exist and
    // equal the row's own directory name (the directory only addresses the
    // row — meta.json is the record), meta status and state status must
    // both exist, be terminal, and be EXACTLY equal, and a terminal row
    // must carry finished_at. Extra rows keep their own runId — they are
    // not required to equal the bound run — but their pids enter the
    // drain proof, so they are held to the same bar.
    const rowDefect = (r) => {
      const extra = r.runId !== boundRun;
      if (!r.metaRunId) {
        return ['registry_identity_unproven', `run ${r.runId} meta.json carries no run_id`];
      }
      if (r.metaRunId !== r.runId) {
        return ['registry_identity_mismatch', `run ${r.runId} meta run_id ${r.metaRunId}`];
      }
      if (!RUN_DONE.has(r.status)) {
        return extra
          ? ['registry_extra_run_live', `unbound run ${r.runId} is ${r.status ?? 'unknown'}`]
          : ['run_nonterminal', `porch run ${boundRun} is ${r.status ?? 'unknown'}`];
      }
      if (r.stateStatus !== r.status) {
        return ['registry_inconsistent',
          `run ${r.runId} meta ${r.status} vs state ${r.stateStatus ?? 'missing'}`];
      }
      if (!r.finishedAt) {
        return extra
          ? ['registry_extra_run_unproven', `unbound run ${r.runId} terminal without finished_at`]
          : ['run_terminal_unproven', `porch run ${boundRun} terminal without finished_at`];
      }
      return null;
    };
    let row = null;
    if (boundRun) {
      row = rows.find((r) => r.runId === boundRun) ?? null;
      if (!row) return defer('registry_run_missing', `bound run ${boundRun} absent from registry`);
    } else if (rows.length) {
      return defer('registry_ambiguous', 'registry holds runs but none is bound to the attempt');
    }
    // Bound row first — it is the record this attempt is bound to — then
    // every other drain-contributing row, in scan order.
    const ordered = row ? [row, ...rows.filter((r) => r !== row)] : rows;
    for (const r of ordered) {
      const d = rowDefect(r);
      if (d) return defer(d[0], d[1]);
    }

    const pids = [];
    let invalidPid = null;
    for (const r of rows) {
      for (const [value, role, invalid] of [
        [r.pid, 'supervisor', r.pidInvalid],
        [r.childPid, 'child', r.childPidInvalid],
      ]) {
        if (invalid || (value != null && !isValidPid(value))) {
          invalidPid ??= { role, runId: r.runId };
        }
      }
      if (isValidPid(r.pid)) pids.push({ pid: r.pid, role: 'supervisor', runId: r.runId });
      if (isValidPid(r.childPid)) pids.push({ pid: r.childPid, role: 'child', runId: r.runId });
    }

    // ---- already-absent: needs the prior durable proof + 'gone' --------------
    if (invalidPid && wstate === 'gone') {
      return defer('process_identity_unverifiable',
        `recorded ${invalidPid.role} pid for run ${invalidPid.runId} is invalid`);
    }
    if (wstate === 'gone') {
      const tp = cur?.terminalProof ?? null;
      const proven = !!tp
        && tp.attemptId === attemptId && tp.workerId === workerId
        && (tp.runId ?? null) === boundRun
        && (tp.workerState === 'running' || tp.workerState === 'stopped')
        && ATTEMPT_TERMINAL.has(tp.attemptStatus ?? '');
      if (!proven) {
        return defer('absent_without_prior_proof',
          'worker confirmed gone but no terminalProof was recorded while it existed');
      }
      try {
        cur = await persist(A, cur, {
          ...base, outcome: 'already_absent', runId: boundRun,
          actions: { absentConfirmedAt: iso() },
        });
      } catch { /* record stays 'proven' — outcome reporting still honest */ }
      return { action: 'already_absent', ...base, runId: boundRun };
    }

    // ---- 4. drain: every owned worker process positively dead -----------------
    const drained = [];
    if (wstate === 'stopped') {
      // Controller-confirmed namespace down — every owned process is dead;
      // no probes exist to run.
      for (const p of pids) drained.push({ ...p, evidence: 'container_stopped' });
    } else {
      // A RUNNING container needs a non-empty positive drain proof: zero
      // recorded pids means zero processes were verified dead — absence of
      // process evidence is not process-drain proof.
      if (!pids.length && !invalidPid) {
        return defer('process_identity_missing',
          'worker running but the registry recorded no supervisor/child pid — drain unproven');
      }
      for (const p of pids) {
        const probe = await A.processIdentity(p.pid).catch(() => null);
        const cls = classifyProbe(probe);
        if (cls === 'alive') {
          return defer('process_alive', `recorded ${p.role} pid ${p.pid} (run ${p.runId}) still live`);
        }
        if (cls !== 'enoent' && cls !== 'zombie') {
          return defer('process_unverifiable', `recorded ${p.role} pid ${p.pid} identity unverifiable`);
        }
        drained.push({ ...p, evidence: cls, starttime: probe.starttime ?? null, pidNs: probe.pidNs ?? null });
      }
    }
    if (invalidPid) {
      return defer('process_identity_unverifiable',
        `recorded ${invalidPid.role} pid for run ${invalidPid.runId} is invalid`);
    }

    // ---- durable proof BEFORE any destructive call -----------------------------
    const terminalProof = {
      at: iso(), attemptId, workerId, runId: boundRun,
      attemptStatus: att.status,
      runStatus: row?.status ?? null, runFinishedAt: row?.finishedAt ?? null,
      workerState: wstate, drained,
    };
    try {
      cur = await persist(A, cur, { ...base, outcome: 'proven', runId: boundRun, terminalProof });
    } catch (e) {
      return defer('reap_record_failed', e?.code || e?.message || 'reap record write failed');
    }

    // ---- 5. stop if needed → verify stopped → remove → verify gone ------------
    const actions = {};
    if (wstate === 'running') {
      try { await A.stopWorker(); }
      catch (e) { return defer('stop_failed', e?.code || e?.message || 'worker.stop failed'); }
      actions.stoppedAt = iso();
      const chk = await workerState(A);
      if (chk.code) return defer(chk.code, chk.detail, { actions });
      if (chk.state === 'running') {
        return defer('stop_unverified', 'worker still running after stop', { actions });
      }
      actions.stopVerifiedAt = iso();
      try { cur = await persist(A, cur, { ...base, outcome: 'proven', runId: boundRun, actions }); }
      catch { /* verification already recorded in-memory; remove proceeds on the fresh proof */ }
    }
    try { await A.removeWorker(); }
    catch (e) {
      return defer('remove_failed', e?.code || e?.message || 'worker.remove failed', { actions });
    }
    actions.removedAt = iso();
    const fin = await workerState(A);
    if (fin.state !== 'gone') {
      return defer('remove_unverified',
        `post-remove worker state ${fin.state ?? fin.detail ?? 'unknown'}`, { actions });
    }
    try {
      cur = await persist(A, cur, { ...base, outcome: 'reaped', runId: boundRun, actions });
    } catch (e) {
      // The worker is removed — the outcome is real even if the record could
      // not be rewritten; report honestly rather than hiding the side effect.
      return { action: 'reaped', recordFailed: e?.code || e?.message || true, ...base, runId: boundRun };
    }
    return { action: 'reaped', ...base, runId: boundRun };
  }

  // Direct per-attempt entry — the sweep's unit of work, exposed for tests.
  async function reapAttempt({ card = null, run = null, att }) {
    return reapOne(att.id, { card, run, att });
  }

  // Sweep every launch-record attempt. Owners resolve ONLY through durable
  // run rows: an attempt that no listed fusion run contains is
  // 'owner_unproven' (or 'owner_lookup_incomplete' when the scan itself was
  // partial) — the worker is never touched either way.
  async function sweep(cards = [], { listingComplete = true } = {}) {
    const out = {
      scanned: 0, live: 0, deferred: 0, reaped: 0, already_absent: 0,
      recorded: 0, errors: 0, defers: {}, details: [],
    };
    let list;
    try { list = await runtime.listAttempts(); }
    catch (e) { return { ...out, unavailable: e?.code || 'attempt_list_failed' }; }
    if (!list || list.ok !== true) return { ...out, unavailable: 'attempt_list_failed' };
    const index = new Map(); // attemptId -> {card, run, att}
    let lookupComplete = listingComplete;
    for (const card of cards || []) {
      for (const rs of card?.runs || []) {
        if (!rs || rs.mode !== 'fusion') continue;
        const run = await getRun(rs.id).catch(() => null);
        if (!run) { lookupComplete = false; continue; }
        for (const a of run.attempts || []) {
          if (a?.id) index.set(a.id, { card, run, att: a });
        }
      }
    }
    for (const entry of list.attempts || []) {
      const attemptId = entry?.attemptId;
      if (!attemptId) continue;
      out.scanned += 1;
      try {
        const r = await reapOne(attemptId, index.get(attemptId) ?? null, { lookupComplete });
        if (r.recorded) out.recorded += 1;
        else if (r.action === 'reaped') out.reaped += 1;
        else if (r.action === 'already_absent') out.already_absent += 1;
        else if (r.action === 'live') out.live += 1;
        else if (r.action === 'deferred') {
          out.deferred += 1;
          out.defers[r.code] = (out.defers[r.code] || 0) + 1;
        }
        if (r.action !== 'live' && out.details.length < DETAILS_MAX) {
          out.details.push({ attemptId, action: r.action, code: r.code ?? null });
        }
      } catch (e) {
        out.errors += 1;
        if (out.details.length < DETAILS_MAX) {
          out.details.push({ attemptId, action: 'error', code: String(e?.code || e?.message || e).slice(0, 120) });
        }
      }
    }
    return out;
  }

  return { sweep, reapAttempt };
}
