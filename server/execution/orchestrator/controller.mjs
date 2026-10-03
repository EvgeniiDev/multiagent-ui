// server/execution/orchestrator/controller.mjs — the O1–O4 scheduler-side
// driver.
//
// One durable record is the only truth; every mutation lands through `send`
// BEFORE the runtime effect that would otherwise be unprovable:
//
//   decompose — orch_decompose_begin mints the attempt row; the decomposer
//     runs in a snapshot-ro container against the pinned baseCommit. Its
//     committed 'decomposition' artifact is the ONLY spec evidence — the
//     domain re-parses the committed bytes, the driver's parse never is.
//   work      — orch_task_begin mints worker attempts bound to the recorded
//     profile digest + the dependency snapshot the driver assembled (every
//     accepted ancestor's cumulative diff, applied in topo order — a task
//     can never launch on a snapshot missing an accepted parent). The
//     worker's private repo pairs with a per-task canonical; a completed
//     attempt freezes+imports the result, then orch_task_settle records
//     the candidate bound to the exported worker-diff artifact.
//   verify    — orch_task_begin kind 'verify' mints a snapshot-ro verifier
//     attempt; its committed 'verdict' artifact drives accept/return.
//   integrate — orch_integrate_begin mints the assembler attempt once the
//     graph is complete; the assembler merges every accepted cumulative
//     diff in the RUN canonical, the driver records the resolution
//     (recordResolution content-verifies every parent's files), imports
//     into canonical, materializes into the bound workspace, then
//     orch_integrate_record hands the run to the U5 gate.
//   stop      — durable cancel intent on every owned live attempt; the run
//     completes 'cancelled' only after positive terminal observation.
//
// Recovery is the durable-write→launch window: the attempt row exists
// before runtime.start, the flat launchRecord proves whether start ran,
// and an uncertain launch is reconciled — never blindly duplicated.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeGit } from './safe-git.mjs';
import { gitRepo } from '../workspaces.mjs';
import {
  ATTEMPT_NONTERMINAL, ATTEMPT_TERMINAL, RUN_NONTERMINAL,
} from '../execution-domain.mjs';
import { writeStagedArtifact } from '../execution-store.mjs';
import { CONTAINER_PATHS, workerIdForAttempt } from '../environment/container-runtime.mjs';
import { canonicalJson } from '../environment/agent-profile.mjs';
import {
  buildDecomposerPrompt, decomposerMaterials,
  buildWorkerPrompt, workerMaterials,
  buildVerifierPrompt, verifierMaterials,
  buildAssemblerPrompt, assemblerMaterials,
  taskBriefText, boundaryTextOf, criteriaTextOf, resultsBundleText,
  sha256Hex, parseIntegrationDeclarations,
} from './prompt.mjs';

const LIVE_ATTEMPT = ATTEMPT_NONTERMINAL;
const ORCH_ROLES = new Set(['decomposer', 'worker', 'verifier', 'assembler']);
const RUNTIME_ROLE = {
  decomposer: 'orch-decomposer',
  worker: 'orch-worker',
  verifier: 'orch-verifier',
  assembler: 'orch-integrator',
};

// Host-side git on worker-controlled repos runs through safeGit: a private
// shadow gitdir, hooks/config never loaded, alternates rejected (79b65ca).
const git = (cwd, args) => safeGit(cwd, args);

// Core workspaces are TRUSTED linked worktrees — their .git is a pointer
// file by design. Materialization (fetch/reset/clean) runs through the
// trusted gitRepo helper, exactly like the fusion integrator; safeGit's
// linked-worktree mutation guard stays intact and applies only to
// worker-controlled repos/exports.
const wsGit = gitRepo;

const SAFE_PART = (s, max = 40) =>
  String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, max) || 'x';

const taskById = (oz, id) => (oz?.tasks || []).find((t) => t && t.id === id) ?? null;

// Extract the single JSON document out of a role's final text — the
// contract is "one JSON doc" possibly fenced. Delimiters occupy their own
// lines, so Markdown backticks inside JSON strings remain ordinary bytes.
export function extractJsonDoc(finalText) {
  if (typeof finalText !== 'string' || !finalText.trim()) return null;
  const fences = [...finalText.matchAll(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)]
    .map((m) => m[1]).filter((s) => s.trim().startsWith('{'));
  if (fences.length > 1) return null;
  if (!fences.length && /^```(?:json)?[ \t]*\r?$/m.test(finalText)) return null;
  const candidates = fences.length ? [fences[0]] : [finalText];
  for (const c of candidates) {
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try { return JSON.parse(c.slice(start, end + 1)); } catch { /* try next */ }
  }
  return null;
}

export function createOrchDriver(deps = {}) {
  const {
    runtime,               // REQUIRED — the F1 constrained container runtime
    send: sendRaw,         // (card, type, payload, idem) => result
    recordEvent,           // (card, run, type, data, attemptId?) => ...
    self,                  // () => owner identity fields
    getRun,                // (runId) => run record | null
    getDocument,           // (cardId, versionId) => {content, sha256}
    ensureWorkspace,       // (card, run) => {ok, ws|code}
    stateDir,              // artifact staging root (writeStagedArtifact)
    canLaunch = () => true,
    adoptionProofFor = null,
    cardTitle = null,
    launchOrphanMs = 10 * 60 * 1000,
    instanceId = 'orch-driver',
    now = () => Date.now(),
    storage = null,        // injectable; defaults to the O2 storage modules
    projectsDir = null,    // controller's registered projects root (snapshot binding)
  } = deps;
  if (!runtime) throw new Error('orchestrator driver requires the F1 constrained runtime');
  if (typeof sendRaw !== 'function' || typeof getRun !== 'function') {
    throw new Error('orchestrator driver requires send + getRun');
  }

  const send = (card, command, payload, id, options) => sendRaw(card, command, payload,
    typeof id === 'string' && id.length > 120 ? `orch-${sha256Hex(id)}` : id, options);

  const inflight = new Map();
  const cancelIssued = new Set();
  const docCache = new Map(); // `${cardId}:${versionId}` -> {content, sha256}

  const refresh = async (run) => (await getRun(run.id)) ?? run;

  // ---- O2 storage seam -------------------------------------------------------
  // The storage modules (workspaces/snapshots/integration-artifacts) are the
  // storage worker's files — imported lazily so O1-only paths (decompose,
  // approvals, user commands) never touch them. Tests inject `deps.storage`.
  let _storage = storage;
  async function stor() {
    if (_storage) return _storage;
    const [ws, sn, ia] = await Promise.all([
      import('./workspaces.mjs'),
      import('./snapshots.mjs'),
      import('./integration-artifacts.mjs'),
    ]);
    _storage = { ...ws, ...sn, ...ia };
    return _storage;
  }
  const storageDir = () => path.join(stateDir ?? '.', 'orch-integration');

  // ---- identity ---------------------------------------------------------------

  const owns = (owner) => {
    const s = self();
    return !!owner && owner.runnerId === s.runnerId && owner.instanceId === s.instanceId;
  };

  // Server-mediated artifact read — the response verifies the stored bytes
  // against the recorded sha256/bytes. The file-path fallback exists only
  // for harnesses that drive the driver without a state service.
  async function artifactText(run, artifactId) {
    if (typeof deps.getArtifact === 'function') {
      const res = await deps.getArtifact(run.id, artifactId);
      if (res && typeof res.content === 'string') return res.content;
      if (res && typeof res.text === 'string') return res.text;
      throw new Error(`artifact ${artifactId} unreadable via getArtifact`);
    }
    const art = run.artifacts?.[artifactId];
    const stored = art?.stored ?? art?.file;
    if (!stored) throw new Error(`artifact ${artifactId} unknown`);
    const base = path.join(stateDir, 'runs', run.id, 'artifacts');
    const p = path.join(base, stored);
    if (!p.startsWith(path.resolve(base))) throw new Error(`artifact path escapes store: ${stored}`);
    return fs.readFile(p, 'utf8');
  }

  async function ensureOwned(card, run, att) {
    if (owns(att.owner)) return true;
    if (typeof adoptionProofFor !== 'function') return false;
    const proof = await adoptionProofFor(att.owner);
    if (!proof) return false;
    try {
      await send(card, 'adopt_attempt', {
        runId: run.id, attemptId: att.id, proof, leaseMs: deps.leaseMs, ...self(),
      }, `ad-${att.id}-by-${instanceId}`, { journal: false });
      att.owner = { ...att.owner, ...self() };
      return true;
    } catch {
      return false;
    }
  }

  // ---- documents / inputs -----------------------------------------------------

  async function docText(card, { versionId, sha256 } = {}) {
    const key = `${card.cardId}:${versionId}`;
    let doc = docCache.get(key);
    if (!doc) {
      doc = await getDocument(card.cardId, versionId);
      docCache.set(key, doc ?? null);
    }
    if (!doc || typeof doc.content !== 'string') {
      throw new Error(`input document ${versionId} unreadable`);
    }
    if (doc.sha256 && sha256 && doc.sha256 !== sha256) {
      throw new Error(`input document ${versionId} no longer verifies against the recorded sha256`);
    }
    return doc.content;
  }

  async function runDocTexts(card, run) {
    const inputs = run.orchestrator.graph.inputs;
    const requirements = await docText(card, inputs.requirements);
    const plan = await docText(card, inputs.plan);
    const design = inputs.design ? await docText(card, inputs.design) : null;
    return { requirements, plan, design };
  }

  const titleOf = (card) =>
    (typeof cardTitle === 'function' ? cardTitle(card.cardId) : card?.title) ?? null;

  const workersBrief = (oz) => canonicalJson(Object.fromEntries(
    Object.entries(oz.workers || {}).map(([name, w]) => [
      name, { profileId: w.profileId, provider: w.provider, model: w.model },
    ])), '  ');

  // ---- canonical / snapshot ids -------------------------------------------------

  const runShort = (run) => SAFE_PART(run.id.slice(4), 16);
  const taskCanonicalId = (run, taskId) => `ocan-${runShort(run)}-${SAFE_PART(taskId, 48)}`;
  const integrateCanonicalId = (run) => `ocan-${runShort(run)}-integrate`;
  const attemptIdOf = (run, role, taskId, n) =>
    `oa-${runShort(run)}-${taskId ? `${SAFE_PART(taskId, 24)}-` : ''}${role}-n${n}`;

  const workerRepoPath = (attemptId) =>
    path.join(runtime.environment().workersDir, workerIdForAttempt(attemptId), 'project');
  const singleRootCommit = async (repoPath) => {
    const r = await git(repoPath, ['rev-list', '--max-parents=0', 'HEAD']);
    if (r.code !== 0) throw new Error(`private repo root unreadable: ${r.stderr.slice(0, 200)}`);
    const roots = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (roots.length !== 1) throw new Error(`private repo has ${roots.length} roots — isolation violated`);
    return roots[0];
  };

  // Accepted ancestors' diff exports — read back from the durable diff
  // artifacts the settle step committed (never from live state). The set is
  // the FULL transitive closure of task.dependsOn: assembleDependencySnapshot
  // requires a proof for EVERY predecessor, not just direct parents.
  async function parentDiffsFor(card, run, task) {
    const out = [];
    const oz = run.orchestrator;
    const want = new Set();
    const visit = (id) => {
      if (want.has(id)) return;
      want.add(id);
      for (const d of taskById(oz, id)?.dependsOn || []) visit(d);
    };
    for (const id of task.dependsOn || []) visit(id);
    for (const id of (oz.order || []).filter((x) => want.has(x))) {
      const p = taskById(oz, id);
      const artId = p?.state?.diffArtifactId;
      if (!artId || !run.artifacts?.[artId]) {
        throw new Error(`parent ${id} has no committed worker-diff artifact`);
      }
      let rec;
      try { rec = JSON.parse(await artifactText(run, artId)); }
      catch (e) { throw new Error(`parent ${id} diff artifact unreadable: ${e.message}`); }
      // The COMPLETE raw exportWorkerDiff record — every field the settle
      // step committed (repoPath, changed[], diffStat, files[], modes,
      // patchSha256). APIv2 requires full proofs; nothing is filtered.
      out.push({
        taskId: id,
        ...rec,
        inputCommit: rec.inputCommit ?? p.state.inputCommit ?? null,
        resultCommit: rec.resultCommit ?? p.state.resultCommit,
        patchSha256: rec.patchSha256 ?? p.state.patchSha256,
        files: Array.isArray(rec.files) ? rec.files : [],
      });
    }
    return out;
  }

  // ---- materials + prompt builders ----------------------------------------------

  async function builtFor(card, run, att) {
    const oz = run.orchestrator;
    const inputs = oz.graph.inputs;
    const docs = await runDocTexts(card, run);
    const kind = att.kind ?? att.role;
    if (att.role === 'decomposer') {
      let rejections = (oz.specHistory ?? []).filter((r) => r.rejected === true).slice(-3);
      // A fresh continuation resets graph evidence, but its predecessor's
      // diagnostic still explains why the same output contract was refused.
      if (!rejections.length && run.continuation?.fromRunId) {
        const prior = await getRun(run.continuation.fromRunId).catch(() => null);
        if (prior?.mode === 'orchestrator' && prior.cardId === card.cardId) {
          rejections = (prior.orchestrator?.specHistory ?? [])
            .filter((r) => r.rejected === true).slice(-3);
        }
      }
      return {
        prompt: buildDecomposerPrompt({
          cardTitle: titleOf(card), baseCommit: inputs.baseCommit,
          workers: oz.workers, limits: oz.limits,
          rejections,
        }),
        materials: decomposerMaterials({
          projectRoot: oz.project.projectRoot, snapshotSha: inputs.baseCommit,
          requirementsText: docs.requirements, planText: docs.plan,
          designText: docs.design, workersText: workersBrief(oz),
        }),
      };
    }
    const task = taskById(oz, att.taskId);
    if (!task && att.role !== 'assembler') throw new Error(`attempt ${att.id} binds task ${att.taskId} that is gone`);
    if (att.role === 'worker') {
      const isFix = att.kind === 'fix';
      const depsText = task.dependsOn.length
        ? `Depends on accepted: ${(att.launch?.snapshotOf || []).join(', ')}` : null;
      return {
        prompt: buildWorkerPrompt({
          cardTitle: titleOf(card), kind: isFix ? 'fix' : 'work', task,
          inputCommit: att.launch?.inputCommit ?? task.state.inputCommit,
          snapshotOf: att.launch?.snapshotOf ?? task.state.snapshotOf,
          findings: isFix ? (task.state.evidence?.findings ?? []) : null,
        }),
        materials: workerMaterials({
          projectRoot: att.launch?.projectRoot ?? oz.project.projectRoot,
          snapshotSha: att.launch?.snapshotSha ?? att.launch?.inputCommit ?? inputs.baseCommit,
          snapshotId: att.launch?.snapshotId,
          canonicalId: att.launch?.canonicalId ?? taskCanonicalId(run, task.id),
          fromCanonical: isFix && !att.launch?.snapshotId,
          taskText: taskBriefText(task),
          briefText: `Subtask ${task.id}: ${task.outcome}`,
          boundaryText: boundaryTextOf(task),
          criteriaText: criteriaTextOf(task),
          depsText,
          requirementsText: docs.requirements,
          planText: docs.plan,
          contextText: isFix ? `Fix round ${task.state.fixesUsed} — prior candidate returned` : null,
        }),
      };
    }
    if (att.role === 'verifier') {
      const cand = task.state.resultCandidate;
      const diffText = cand?.diffArtifactId
        ? JSON.parse(await artifactText(run, cand.diffArtifactId)).formatPatch ?? '(empty diff)'
        : '(no candidate diff)';
      const reportText = cand?.reportArtifactId
        ? await artifactText(run, cand.reportArtifactId)
        : canonicalJson({ note: 'no freeze report recorded' });
      return {
        prompt: buildVerifierPrompt({ cardTitle: titleOf(card), task }),
        materials: verifierMaterials({
          // The registered immutable CANDIDATE snapshot — bound at issue
          // time by prepareCandidateBasis (controller materializes the task
          // canonical's exact candidate commit). Never the inputCommit:
          // the verifier evaluates the RESULT, not the launch basis.
          projectRoot: att.launch?.projectRoot ?? oz.project.projectRoot,
          snapshotSha: att.launch?.snapshotSha ?? inputs.baseCommit,
          snapshotId: att.launch?.snapshotId,
          taskText: taskBriefText(task), diffText,
          criteriaText: criteriaTextOf(task), boundaryText: boundaryTextOf(task),
          contextText: docs.plan, reportText,
        }),
      };
    }
    // assembler
    const accepted = (oz.order || []).map((id) => taskById(oz, id))
      .filter((t) => t && t.state.status === 'accepted');
    const parentDiffs = await parentDiffsFor(card, run,
      { dependsOn: accepted.map((t) => t.id) });
    const resultsText = resultsBundleText(parentDiffs.map((p) => ({
      taskId: p.taskId, resultCommit: p.resultCommit, formatPatch: p.formatPatch,
    })));
    return {
      prompt: buildAssemblerPrompt({ cardTitle: titleOf(card), taskCount: accepted.length }),
      materials: assemblerMaterials({
        projectRoot: oz.project.projectRoot, snapshotSha: inputs.baseCommit,
        canonicalId: integrateCanonicalId(run),
        taskText: `Integrate ${accepted.length} accepted subtask results`,
        workOrderText: canonicalJson({
          order: accepted.map((t) => t.id),
          baseCommit: inputs.baseCommit,
          tasks: accepted.map((t) => ({
            taskId: t.id, resultCommit: t.state.resultCommit, patchSha256: t.state.patchSha256,
          })),
        }, '  '),
        requirementsText: docs.requirements, planText: docs.plan,
        designText: docs.design, resultsText,
      }),
    };
  }

  const launchFields = (att, built, extra = {}) => ({
    profileId: extra.profileId ?? att._profileId,
    profileDigest: extra.profileDigest ?? att._profileDigest,
    promptSha256: sha256Hex(built.prompt),
    materialsSha256: sha256Hex(canonicalJson(built.materials)),
    cwd: CONTAINER_PATHS.project,
    artifactsDir: `${CONTAINER_PATHS.attempt}/run-${att.id}`,
    attemptDir: CONTAINER_PATHS.attempt,
    ...extra.launch,
  });

  // ---- attempt lifecycle ----------------------------------------------------------

  async function startRuntime(card, run, att, profileEntry, built) {
    if (inflight.has(att.id)) return 'launch_inflight';
    const p = (async () => {
      try {
        // Durable stop/quiesce fence, including recovered launch attempts.
        // A failed read cannot grant permission to spawn a worker.
        const fresh = await getRun(run.id).catch(() => null);
        const freshAtt = fresh?.attempts?.find((a) => a?.id === att.id);
        if (!freshAtt || !owns(freshAtt.owner) || freshAtt.status !== 'launching'
          || freshAtt.cancel || fresh.status === 'stopping'
          || !RUN_NONTERMINAL.has(fresh.status) || !canLaunch()) {
          return { held: true };
        }
        return await runtime.start({
          attemptId: att.id,
          profileId: profileEntry.profileId,
          profile: profileEntry.profile,
          role: RUNTIME_ROLE[att.role],
          prompt: built.prompt,
          materials: built.materials,
          launchTimeoutMs: (run.orchestrator.limits?.timeoutMin ?? 45) * 60 * 1000,
        });
      } catch (e) {
        // A throw is UNCERTAIN — the spawn may have happened. Never resolve
        // 'failed' on it; reconcile decides from durable evidence.
        return { ok: false, phase: 'launch_uncertain', error: { code: 'start_threw', message: String(e?.message || e) } };
      } finally {
        inflight.delete(att.id);
      }
    })();
    inflight.set(att.id, p);
    const res = await p;
    if (res?.held) return 'launch_held';
    if (!res?.ok) {
      if (res?.phase === 'launch_failed') {
        await send(card, 'resolve_attempt', {
          runId: run.id, attemptId: att.id, outcome: 'failed',
          reason: `${att.role} launch failed: ${res.error?.code ?? 'error'} — ${String(res.error?.message ?? '').slice(0, 300)}`,
          ...self(),
        }, `rs-${att.id}-launchfail-by-${instanceId}`);
        return 'launch_failed';
      }
      return 'launch_uncertain';
    }
    if (res.porchRunId) {
      await send(card, 'bind_attempt', {
        runId: run.id, attemptId: att.id, porchRunId: res.porchRunId, ...self(),
      }, `bind-${att.id}-by-${instanceId}`);
      return 'bound';
    }
    return 'launch_uncertain';
  }

  // Positive-absence proof: a CLEAN completed registry scan where every
  // scanned worker is 'gone' (dead namespace). 'running', transitional,
  // 'unknown' or failed-status workers prove NOTHING — never treated as
  // absent, never acted on. A failed/incomplete porch list proves nothing
  // either: scan.ok must be true.
  function verifiableAbsence(scan) {
    return !!scan && scan.ok === true
      && Array.isArray(scan.workers) && scan.workers.length > 0
      && scan.workers.every((w) => w.gone === true);
  }

  // Physical namespace settle: the attempt's worker must be STOPPED before
  // any host read of its private repo (freeze/export/import) and before any
  // terminal resolve — a live container can keep writing while the host
  // reads. Positive proof = worker.status 'stopped'/'gone' after
  // worker.stop; the durable record lands via orch_worker_settled. Retried
  // calls are idempotent; a missing registry row never proves physical absence.
  async function settleWorkerNamespace(card, run, att) {
    if (att.namespace
      && (att.namespace.state === 'stopped' || att.namespace.state === 'gone')) {
      return { settled: true, state: att.namespace.state };
    }
    const scoped = typeof runtime.forAttempt === 'function'
      ? runtime.forAttempt(att.id) : null;
    const workerId = att.launch?.workerId ?? scoped?.workerId ?? workerIdForAttempt(att.id);
    if (!scoped || typeof scoped.workerStatus !== 'function'
      || typeof scoped.stopWorker !== 'function') {
      return { settled: false, code: 'runtime_unscoped' };
    }
    let st = await scoped.workerStatus()
      .catch((e) => ({ ok: false, error: e }));
    let state = st?.ok === true ? (st?.state ?? null) : null;
    if (state !== 'gone' && state !== 'stopped' && state !== 'removed') {
      const stop = await scoped.stopWorker().catch((e) => ({ ok: false, error: e }));
      if (stop?.ok !== true && stop?.state !== 'stopped') {
        return { settled: false, code: 'worker_stop_unproven',
          detail: String(stop?.error?.message ?? stop?.error ?? 'worker.stop unconfirmed').slice(0, 200) };
      }
      const after = await scoped.workerStatus()
        .catch((e) => ({ ok: false, error: e }));
      state = after?.ok === true ? (after?.state ?? null) : null;
    }
    if (state !== 'stopped' && state !== 'gone' && state !== 'removed') {
      return { settled: false, code: 'worker_state_unproven',
        detail: `worker ${workerId} state ${JSON.stringify(state)} is not a settled namespace` };
    }
    try {
      await send(card, 'orch_worker_settled', {
        runId: run.id, attemptId: att.id, workerId,
        state: state === 'removed' ? 'gone' : state, ...self(),
      }, `ows-${att.id}-${state}-by-${instanceId}`);
      att.namespace = { state, workerId, settledAt: now() };
      return { settled: true, state };
    } catch (e) {
      return { settled: false, code: 'settle_record_failed', detail: String(e?.message ?? e).slice(0, 200) };
    }
  }

  // Positive-absence check for a bound porchRunId that wait/status can no
  // longer resolve (record file lost). The porch registry inside the
  // attempt's own worker is the authority — a failed scan proves nothing.
  async function provenRunAbsent(att) {
    const scan = await runtime.reconcile(
      { attemptId: att.id, runIds: [att.porchRunId] }).catch(() => null);
    if (scan?.matches?.some((m) => m?.runId === att.porchRunId)) return false;
    return verifiableAbsence(scan);
  }

  // Reconcile a 'launching' attempt against the FLAT launchRecord surface:
  //   {attemptId, missing, corrupt, phase, spawned, porchRunId, workerId,
  //    diagnostics, error} — never the pre-fix nested `record` envelope.
  // A launchRecord READ FAILURE is 'launch_unreadable', never 'missing' —
  // a failed read cannot become permission to spawn a second worker. The
  // record write precedes the porch spawn, so `missing === true` is the
  // positive absence proof; everything else scans the porch registry.
  async function reconcileLaunch(card, run, att, profileEntry, built) {
    if (inflight.has(att.id)) return 'launch_inflight';
    const cancelling = att.status === 'cancelling' || !!att.cancel || run.status === 'stopping';
    const rec = await runtime.launchRecord(att.id).catch(() => null);
    if (!rec || rec.corrupt) return 'launch_unreadable';
    if (rec.missing === true) {
      if (cancelling) {
        // A cancelled launch whose record is missing can STILL have raced a
        // worker spawn — 'cancelled' requires the porch registry to prove
        // absence, not just the missing record file.
        if (!await provenRunAbsent(att)) return 'launch_reconcile';
        await send(card, 'resolve_attempt', {
          runId: run.id, attemptId: att.id, outcome: 'cancelled',
          reason: att.cancel?.reason ?? 'cancelled before launch',
          ...self(),
        }, `rs-${att.id}-prelaunch-cancel-by-${instanceId}`);
        return 'cancelled';
      }
      return await startRuntime(card, run, att, profileEntry, built);
    }
    const phase = rec.phase ?? null;
    if (phase === 'launched' && rec.porchRunId) {
      await send(card, 'bind_attempt', {
        runId: run.id, attemptId: att.id, porchRunId: rec.porchRunId, ...self(),
      }, `bind-${att.id}-by-${instanceId}`);
      return 'bound';
    }
    if (phase === 'launch_failed') {
      await send(card, 'resolve_attempt', {
        runId: run.id, attemptId: att.id, outcome: 'failed',
        reason: `${att.role} launch failed: ${rec.error?.code ?? 'error'} — ${String(rec.error?.message ?? '').slice(0, 300)}`,
        ...self(),
      }, `rs-${att.id}-launchfail-by-${instanceId}`);
      return 'launch_failed';
    }
    // 'prepared'/'launching'/uncertain — scan the worker's porch registry
    // for a run a completed handshake left behind. Ambiguous or failed
    // scans prove nothing: a bind requires exactly one match on a clean
    // scan; absence requires every worker verifiably accounted for.
    const scan = await runtime.reconcile({ attemptId: att.id }).catch(() => null);
    const matches = (scan?.matches || []).filter((m) => m?.runId);
    if (matches.length > 1) return 'launch_reconcile';
    const match = scan?.ok === true && matches.length === 1 ? matches[0] : null;
    if (match) {
      await send(card, 'bind_attempt', {
        runId: run.id, attemptId: att.id, porchRunId: match.runId, ...self(),
      }, `bind-${att.id}-by-${instanceId}`);
      return 'bound';
    }
    if (!verifiableAbsence(scan)) return 'launch_reconcile'; // fail closed
    const allGone = scan.workers.every((w) => w.gone === true);
    const recAt = Date.parse(rec.launchStartedAt ?? rec.createdAt ?? '') || 0;
    const attAt = recAt || Number(att.startedAt ?? att.createdAt)
      || Date.parse(att.startedAt ?? att.createdAt ?? '') || 0;
    if (cancelling) {
      // Positive absence — nothing will ever arrive to cancel. A mid-phase
      // record with a late-registering porch leaves an orphan the worker
      // reaper collects; the stop itself never wedges.
      await send(card, 'resolve_attempt', {
        runId: run.id, attemptId: att.id, outcome: 'cancelled',
        reason: att.cancel?.reason ?? 'cancelled before launch',
        ...self(),
      }, `rs-${att.id}-prelaunch-cancel-by-${instanceId}`);
      return 'cancelled';
    }
    if (allGone && attAt && now() - attAt > launchOrphanMs) {
      await send(card, 'resolve_attempt', {
        runId: run.id, attemptId: att.id, outcome: 'failed',
        reason: `${att.role} launch orphaned — worker gone with no registered run`,
        ...self(),
      }, `rs-${att.id}-launchorphan-by-${instanceId}`);
      return 'launch_orphaned';
    }
    return 'launch_reconcile';
  }

  // ---- terminal resolution --------------------------------------------------------

  async function commitArtifact(card, run, att, { kind, name, text }) {
    const staged = await writeStagedArtifact(stateDir, att.id, name, text);
    // Content-bound id: identical bytes replay idempotently under the same
    // id; a settle-recovery retry whose re-export differs by even a byte
    // lands under a fresh id instead of dead-looping on artifact_immutable.
    const artifactId = `${kind}-${att.id}-${staged.sha256.slice(0, 12)}`.slice(0, 120);
    await send(card, 'commit_artifact', {
      runId: run.id, attemptId: att.id,
      artifact: { id: artifactId, kind, file: name, bytes: staged.bytes, sha256: staged.sha256 },
      stagedPath: staged.stagedPath, ...self(),
    }, `ca-${artifactId}-by-${instanceId}`);
    return { artifactId, sha256: staged.sha256, bytes: staged.bytes };
  }

  // A completed decomposer: commit its spec doc, then resolve binding the
  // artifact descriptor — the domain re-parses and routes the run.
  async function resolveDecomposer(card, run, att, { outcome, reason, wt }) {
    let spec = null;
    if (outcome === 'completed') {
      const doc = extractJsonDoc(wt?.finalText);
      if (!doc || typeof doc !== 'object' || !doc.decomposition) {
        outcome = 'failed';
        reason = 'decomposition_invalid: final text carries no JSON decomposition document';
      } else {
        const a = await commitArtifact(card, run, att, {
          kind: 'decomposition', name: `decomposition-${att.id}.json`,
          text: canonicalJson(doc, '  '),
        });
        spec = { artifactId: a.artifactId, sha256: a.sha256, bytes: a.bytes };
      }
    }
    await send(card, 'resolve_attempt', {
      runId: run.id, attemptId: att.id, outcome,
      ...(spec ? { spec } : {}),
      result: wt ? { status: wt.status, exitCode: wt.runExitCode ?? wt.exitCode ?? null } : undefined,
      reason: reason ?? (outcome === 'completed' ? 'decomposition committed' : `decomposer ${outcome}`),
      ...self(),
    }, `rs-${att.id}-terminal-by-${instanceId}`);
    return outcome;
  }

  // A completed verifier: commit the verdict doc, resolve binding it.
  async function resolveVerifier(card, run, att, { outcome, reason, wt }) {
    let verdict = null;
    if (outcome === 'completed') {
      const doc = extractJsonDoc(wt?.finalText);
      if (!doc || !['accept', 'return'].includes(doc.decision)
        || (doc.decision === 'return' && !(Array.isArray(doc.findings) && doc.findings.length))) {
        outcome = 'failed';
        reason = 'verdict_invalid: final text carries no {decision:accept|return,findings[]} document';
      } else {
        const a = await commitArtifact(card, run, att, {
          kind: 'verdict', name: `verdict-${att.id}.json`, text: canonicalJson(doc, '  '),
        });
        verdict = {
          decision: doc.decision, artifactId: a.artifactId, sha256: a.sha256, bytes: a.bytes,
          findings: Array.isArray(doc.findings) ? doc.findings : [],
          summary: typeof doc.summary === 'string' ? doc.summary.slice(0, 2000) : null,
        };
      }
    }
    await send(card, 'resolve_attempt', {
      runId: run.id, attemptId: att.id, outcome,
      ...(verdict ? { verdict } : {}),
      result: wt ? { status: wt.status, exitCode: wt.runExitCode ?? wt.exitCode ?? null } : undefined,
      reason: reason ?? (outcome === 'completed' ? `verdict ${verdict.decision}` : `verifier ${outcome}`),
      ...self(),
    }, `rs-${att.id}-terminal-by-${instanceId}`);
    return outcome;
  }

  // ---- worker import / settle ------------------------------------------------------
  //
  // A completed worker attempt is only a RESULT once the private repo is
  // proven isolated, the result frozen, imported into the task canonical and
  // the cumulative input→canonical diff exported + committed as an artifact.
  // Any failure resolves the attempt 'failed' — it never silently settles.

  async function importWorkerResult(card, run, att) {
    const oz = run.orchestrator;
    const task = taskById(oz, att.taskId);
    if (!task) return { code: 'task_missing' };
    const s = await stor();
    const workerId = workerIdForAttempt(att.id);
    const repoPath = workerRepoPath(att.id);
    // 0) Physical namespace settle — the worker container must be STOPPED
    //    before any host read of its private repo. A live writer racing
    //    freeze/export/import stages mutable bytes into "immutable" proof.
    const ns = await settleWorkerNamespace(card, run, att);
    if (!ns.settled) return { code: 'worker_unsettled', detail: ns.detail ?? ns.code };
    // 1) Freeze + isolation proof on the worker's private repo.
    const root = await singleRootCommit(repoPath).catch((e) => ({ err: e }));
    if (root?.err) return { code: 'repo_unproven', detail: String(root.err.message) };
    const parentCommits = Object.fromEntries((task.dependsOn || []).map((id) => {
      const p = taskById(oz, id);
      return [id, p?.state?.resultCommit ?? null];
    }).filter(([, c]) => c));
    let freeze;
    try {
      freeze = await s.freezeResult({
        repoPath, taskId: task.id, inputCommit: root,
        generation: att.n ?? 1, parentCommits, note: `orchestrator ${att.kind} round ${att.n}`,
      });
      // Provenance gate: the candidate is stale when an accepted parent's
      // result moved after this attempt's snapshot — the task must re-run
      // on a fresh assembled basis, never settle on the old one.
      if (typeof s.assertProvenanceCurrent === 'function') {
        s.assertProvenanceCurrent(freeze.report ?? freeze,
          { generation: att.n ?? 1, parentCommits });
      }
    } catch (e) {
      return { code: e?.code === 'stale_input' || e?.code === 'stale_generation' ? 'stale_input' : 'freeze_failed', detail: String(e?.message || e).slice(0, 300) };
    }
    const iso = await s.verifyPrivateRepo(repoPath).catch(() => ({ ok: false, problems: ['verify threw'] }));
    if (!iso?.ok) {
      return { code: 'repo_isolation', detail: (iso?.problems || []).join('; ').slice(0, 300) };
    }
    // 2) repo.import — worker private tree → task canonical (durable, out
    //    of the ephemeral worker dir).
    const canonicalId = att.launch?.canonicalId ?? taskCanonicalId(run, task.id);
    const imp = await runtime.repoImport(workerId).catch((e) => ({ ok: false, error: { message: String(e?.message || e) } }));
    if (!imp?.ok || !imp.import?.commitSha) {
      return { code: 'import_failed', detail: String(imp?.error?.message ?? 'repo.import failed').slice(0, 300) };
    }
    // 3) The cumulative input→result diff comes from the CANONICAL side:
    //    baseSha..HEAD — for fix rounds this is the end-to-end change the
    //    verifier judges and dependents assemble.
    const cst = await runtime.canonicalStatus(canonicalId).catch(() => null);
    const canon = cst?.canonical;
    if (!canon?.hostDir || !canon.baseSha) return { code: 'canonical_unreadable' };
    const wtHost = path.join(canon.hostDir, 'worktree');
    let exportDiff;
    try {
      exportDiff = await s.exportWorkerDiff({
        repoPath: wtHost, inputCommit: canon.baseSha, resultCommit: imp.import.commitSha,
      });
    } catch (e) {
      return { code: 'diff_failed', detail: String(e?.message || e).slice(0, 300) };
    }
    // 4) Commit the durable evidence artifacts before the resolve lands.
    const diffArt = await commitArtifact(card, run, att, {
      kind: 'worker-diff', name: `worker-diff-${task.id}-n${att.n ?? 1}.json`,
      text: canonicalJson(exportDiff, '  '),
    });
    const repArt = await commitArtifact(card, run, att, {
      kind: 'worker-report', name: `worker-report-${task.id}-n${att.n ?? 1}.json`,
      text: canonicalJson(freeze.report ?? freeze, '  '),
    });
    return {
      code: 'ok',
      settle: {
        taskId: task.id, attemptId: att.id,
        resultCommit: imp.import.commitSha,
        canonicalId,
        canonicalCommit: imp.import.commitSha,
        diffArtifactId: diffArt.artifactId,
        diffSha256: diffArt.sha256,
        reportArtifactId: repArt.artifactId,
        patchSha256: exportDiff.patchSha256,
        resultSha256: freeze.resultHash ?? freeze.report?.resultHash ?? null,
        diffStat: exportDiff.diffStat ?? imp.import.diffStat ?? null,
        changed: imp.import.changed === true,
      },
    };
  }

  async function resolveWorker(card, run, att, { outcome, reason, wt }) {
    if (outcome === 'completed') {
      const imp = await importWorkerResult(card, run, att);
      if (imp.code !== 'ok') {
        outcome = 'failed';
        reason = `result unverifiable (${imp.code}): ${imp.detail ?? ''}`;
      } else {
        att._settle = imp.settle; // carried to the post-resolve settle step
      }
    }
    await send(card, 'resolve_attempt', {
      runId: run.id, attemptId: att.id, outcome,
      result: wt ? { status: wt.status, exitCode: wt.runExitCode ?? wt.exitCode ?? null } : undefined,
      reason: reason ?? (outcome === 'completed' ? 'worker result imported' : `worker ${outcome}`),
      ...self(),
    }, `rs-${att.id}-terminal-by-${instanceId}`);
    return outcome;
  }

  // orch_task_settle for every completed-but-unsettled worker attempt —
  // covers both the same-tick post-resolve path and the crash window where
  // the resolve landed but the settle did not.
  async function settlePendingWorkers(card, run0) {
    let run = run0;
    const oz = run.orchestrator;
    for (const task of oz.tasks || []) {
      if (task.state?.status !== 'running' && task.state?.status !== 'verifying') continue;
      const doneAtt = (run.attempts || []).filter(
        (a) => a && a.taskId === task.id && a.role === 'worker').at(-1);
      if (!doneAtt || doneAtt.status !== 'completed'
        || task.state.resultCandidate?.attemptId === doneAtt.id) continue;
      const s = doneAtt._settle ?? await (async () => {
        // Recover the settle descriptor by re-running the import step —
        // freeze/import/export are all idempotent on identical content.
        const r = await importWorkerResult(card, run, doneAtt);
        return r.code === 'ok' ? r.settle : null;
      })();
      if (!s) continue;
      try {
        await send(card, 'orch_task_settle', { ...s, runId: run.id, ...self() }, `os-${doneAtt.id}-by-${instanceId}`);
        run = await refresh(run);
      } catch (e) {
        await recordEvent(card, run, 'task_settle_blocked', {
          taskId: task.id, attemptId: doneAtt.id,
          code: e?.code ?? 'error', detail: String(e?.message ?? e).slice(0, 200),
        }, doneAtt.id).catch(() => {});
      }
    }
    return run;
  }

  // ---- assembler integrate / record ------------------------------------------------

  async function integrateAssembler(card, run, att) {
    const oz = run.orchestrator;
    const s = await stor();
    if (typeof ensureWorkspace !== 'function') return { code: 'workspace_unwired' };
    const wsRes = await ensureWorkspace(card, run);
    if (!wsRes?.ok) return { code: wsRes?.code ?? 'workspace_unresolved' };
    const ws = wsRes.ws;
    const workerId = workerIdForAttempt(att.id);
    const repoPath = workerRepoPath(att.id);
    // The assembler's worker is the resolution repo's writer — it must be
    // physically stopped before the resolution proofs are derived.
    const ns = await settleWorkerNamespace(card, run, att);
    if (!ns.settled) return { code: 'worker_unsettled', detail: ns.detail ?? ns.code };
    const root = await singleRootCommit(repoPath).catch((e) => ({ err: e }));
    if (root?.err) return { code: 'repo_unproven', detail: String(root.err.message) };
    const accepted = (oz.order || []).map((id) => taskById(oz, id))
      .filter((t) => t && t.state.status === 'accepted');
    const parentDiffs = await parentDiffsFor(card, run,
      { dependsOn: accepted.map((t) => t.id) }).catch((e) => ({ err: e }));
    if (parentDiffs?.err) return { code: 'parents_unproven', detail: String(parentDiffs.err.message) };
    let freeze;
    try {
      freeze = await s.freezeResult({
        repoPath, taskId: '__integrate__', inputCommit: root,
        generation: att.n ?? 1,
        parentCommits: Object.fromEntries(accepted.map((t) => [t.id, t.state.resultCommit])),
      });
    } catch (e) {
      return { code: 'freeze_failed', detail: String(e?.message || e).slice(0, 300) };
    }
    const iso = await s.verifyPrivateRepo(repoPath).catch(() => ({ ok: false }));
    if (!iso?.ok) return { code: 'repo_isolation', detail: (iso?.problems || []).join('; ').slice(0, 300) };
    // The COMPLETE exported proofs go to recordResolution — every accepted
    // parent's raw {inputCommit,resultCommit,files,patchSha256} including
    // empty diffs and superseded paths. inputs declare each parent's
    // inputCommit + declared dependsOn so the storage helper can validate
    // causal-graph supersession itself; the driver never filters proof
    // arrays or drops parents to bypass a storage rejection.
    const order = accepted.map((t) => t.id);
    // Only the assembler's committed explicit declaration authorizes
    // additional edits and semantic overlap resolution. Never infer consent
    // from the changes we are about to accept.
    const declarationArtifacts = Object.values(run.artifacts ?? {}).filter(
      (a) => a.attemptId === att.id && a.kind === 'integration-declarations');
    if (declarationArtifacts.length !== 1) return { code: 'declarations_unrecorded' };
    let declarations;
    try {
      declarations = parseIntegrationDeclarations(await artifactText(run, declarationArtifacts[0].id));
    } catch (e) { return { code: 'declarations_invalid', detail: e.message }; }
    let record;
    try {
      const baseTree = await s.treeHashFor(repoPath, root);
      record = await s.recordResolution({
        storeDir: storageDir(),
        inputs: order.map((id) => {
          const p = taskById(oz, id);
          const pd = parentDiffs.find((x) => x.taskId === id);
          return {
            taskId: id,
            // The EXPORT's inputCommit — the recorded diff basis the parent
            // proof is bound to, not the launch-time basis.
            inputCommit: pd?.inputCommit ?? p.state.inputCommit ?? null,
            resultCommit: p.state.resultCommit,
            // The declared dependency graph restricted to included parents.
            dependsOn: (p.dependsOn || []).filter((d) => order.includes(d)),
          };
        }),
        order,
        baseCommit: root,
        baseTree,
        repoPath,
        parentDiffs,
        additionalPaths: declarations.additionalPaths,
        resolvedPaths: declarations.resolvedPaths,
        resolutionNote: `orchestrator run ${run.id} assembler attempt ${att.id}`,
      });
    } catch (e) {
      return { code: 'resolution_failed', detail: String(e?.code ? `${e.code}: ` : '') + String(e?.message || e).slice(0, 300) };
    }
    const imp = await runtime.repoImport(workerId).catch((e) => ({ ok: false, error: { message: String(e?.message || e) } }));
    if (!imp?.ok || !imp.import?.commitSha) {
      return { code: 'import_failed', detail: String(imp?.error?.message ?? 'repo.import failed').slice(0, 300) };
    }
    // Materialize the canonical commit into the bound workspace — identical
    // fetch/reset/clean semantics as the fusion integrator. ws.path is a
    // recorded Core linked worktree (ensureWorkspace): trusted gitRepo, not
    // safeGit, whose linked-worktree mutation guard is intentionally strict.
    const canonId = att.launch?.canonicalId ?? oz.integrate?.canonicalId ?? integrateCanonicalId(run);
    const cst = await runtime.canonicalStatus(canonId).catch(() => null);
    const canonDir = cst?.canonical?.hostDir;
    if (!canonDir) return { code: 'canonical_unreadable' };
    const f = await wsGit(ws.path, ['fetch', '--no-tags', `${canonDir}/repo.git`, imp.import.commitSha]);
    if (f.code !== 0) return { code: 'materialize_fetch_failed' };
    const r = await wsGit(ws.path, ['reset', '--hard', imp.import.commitSha]);
    if (r.code !== 0) return { code: 'materialize_reset_failed' };
    await wsGit(ws.path, ['clean', '-fdq']);
    await commitArtifact(card, run, att, {
      kind: 'integration-resolution', name: `integration-${att.id}.json`,
      text: canonicalJson(record?.record ?? record, '  '),
    });
    return { code: 'ok', import: imp.import };
  }

  async function resolveAssembler(card, run, att, { outcome, reason, wt }) {
    if (outcome === 'completed') {
      try {
        const declarations = parseIntegrationDeclarations(wt?.finalText);
        await commitArtifact(card, run, att, {
          kind: 'integration-declarations', name: 'integration-declarations.json',
          text: canonicalJson(declarations),
        });
        run = await refresh(run);
      } catch (e) {
        outcome = 'failed';
        reason = `integration declarations invalid: ${String(e.message).slice(0, 200)}`;
      }
      const integ = outcome === 'completed' ? await integrateAssembler(card, run, att)
        : { code: 'declarations_invalid', detail: reason };
      if (integ.code !== 'ok') {
        outcome = 'failed';
        reason = `integration failed (${integ.code}): ${integ.detail ?? ''}`;
      } else {
        att._import = integ.import;
      }
    }
    await send(card, 'resolve_attempt', {
      runId: run.id, attemptId: att.id, outcome,
      result: wt ? { status: wt.status, exitCode: wt.runExitCode ?? wt.exitCode ?? null } : undefined,
      reason: reason ?? (outcome === 'completed' ? 'integration imported' : `assembler ${outcome}`),
      ...self(),
    }, `rs-${att.id}-terminal-by-${instanceId}`);
    return outcome;
  }

  // orch_integrate_record for a completed-but-unrecorded assembler attempt.
  async function recordPendingIntegrate(card, run0) {
    let run = run0;
    const oz = run.orchestrator;
    if (run.phase !== 'integrate' || !oz.integrate?.attemptId || oz.integrate?.import) return run;
    const att = (run.attempts || []).find((a) => a && a.id === oz.integrate.attemptId);
    if (!att || att.status !== 'completed') return run;
    const imp = att._import ?? await (async () => {
      const r = await integrateAssembler(card, run, att);
      return r.code === 'ok' ? r.import : null;
    })();
    if (!imp) return run;
    try {
      await send(card, 'orch_integrate_record', {
        runId: run.id, attemptId: att.id,
        import: {
          commitSha: imp.commitSha, treeSha: imp.treeSha ?? null,
          changed: imp.changed === true, diffStat: imp.diffStat ?? null,
        },
        ...self(),
      }, `oir-${att.id}-by-${instanceId}`);
      run = await refresh(run);
    } catch (e) {
      await recordEvent(card, run, 'integrate_record_blocked', {
        attemptId: att.id, code: e?.code ?? 'error',
        detail: String(e?.message ?? e).slice(0, 200),
      }, att.id).catch(() => {});
    }
    return run;
  }

  // ---- observe / supervise ------------------------------------------------------------

  const resolveFor = { decomposer: resolveDecomposer, worker: resolveWorker, verifier: resolveVerifier, assembler: resolveAssembler };

  async function observeAttempt(card, run, att) {
    if (!att.porchRunId) return 'awaiting_binding'; // unreachable by routing; fail closed
    const timeoutMin = run.orchestrator.limits?.timeoutMin ?? 45;
    if (att.status === 'cancelling' || att.cancel || run.status === 'stopping') {
      if (!cancelIssued.has(att.id)) {
        // Retry-safe: only a confirmed request counts as issued — a failed
        // cancel retries next pass instead of silently marking done.
        const cancelled = await runtime.cancel(att.porchRunId).catch(() => null);
        if (cancelled?.ok === true && cancelled.requested === true) cancelIssued.add(att.id);
      }
      const wt = await runtime.wait(att.porchRunId, { timeoutSec: 0 }).catch(() => null);
      if (wt?.outcome === 'terminal') {
        const ns = await settleWorkerNamespace(card, run, att);
        if (!ns.settled) return 'settle_pending';
        return await resolveFor[att.role](card, run, att, {
          outcome: 'cancelled',
          reason: att.cancel?.reason ?? 'cancelled',
          wt,
        });
      }
      // A bound run that can no longer be resolved (lost launch record)
      // resolves cancelled only on POSITIVE porch-registry absence —
      // 'unknown_run' alone proves nothing.
      if (wt?.error?.code === 'unknown_run' && await provenRunAbsent(att)) {
        return await resolveFor[att.role](card, run, att, {
          outcome: 'cancelled',
          reason: att.cancel?.reason ?? 'cancelled — run proven absent from the porch registry',
          wt: null,
        });
      }
      return 'cancelling';
    }
    const wt = await runtime.wait(att.porchRunId, { timeoutSec: 0 }).catch(() => null);
    // observer_timeout means OUR observer gave up — the run is untouched
    // and must NEVER be resolved on it; 'error' (incl. unknown_run) retries
    // unless the porch registry positively proves the run is gone.
    if (!wt || wt.outcome === 'error' || wt.outcome === 'observer_timeout') {
      if (wt?.error?.code === 'unknown_run' && await provenRunAbsent(att)) {
        return await resolveFor[att.role](card, run, att, {
          outcome: 'failed',
          reason: `${att.role} run ${att.porchRunId} vanished — porch registry proves absence`,
          wt: null,
        });
      }
      return 'observe_retry';
    }
    if (wt.outcome === 'timeout') {
      const attAt = Number(att.startedAt ?? att.createdAt)
        || Date.parse(att.startedAt ?? att.createdAt ?? '') || 0;
      if (attAt && now() > attAt + timeoutMin * 60 * 1000) {
        await send(card, 'cancel_attempt', {
          runId: run.id, attemptId: att.id,
          reason: `${att.role} exceeded the ${timeoutMin}min timeout`,
          ...self(),
        }, `cx-${att.id}-timeout-by-${instanceId}`);
        return 'timeout_cancel';
      }
      return 'observing';
    }
    // Any non-terminal outcome that slipped through resolves nothing.
    if (wt.outcome !== 'terminal') return 'observe_retry';
    // Positive terminal porch → physical namespace settle BEFORE the
    // resolve: the worker must be provably stopped/gone (its repo becomes
    // read-only evidence) and the durable orch_worker_settled lands first.
    const ns = await settleWorkerNamespace(card, run, att);
    if (!ns.settled) return 'settle_pending';
    const code0 = (wt.runExitCode ?? wt.exitCode) === 0;
    const outcome = wt.status === 'cancelled' ? 'cancelled'
      : (wt.status === 'completed' && code0) ? 'completed'
        : 'failed';
    return await resolveFor[att.role](card, run, att, {
      outcome,
      reason: wt.error ?? (outcome === 'completed' ? null : `supervisor ${wt.status ?? 'terminal'} (exit ${wt.runExitCode ?? wt.exitCode ?? '?'})`),
      wt,
    });
  }

  async function superviseAttempt(card, run, att) {
    if (!ORCH_ROLES.has(att.role)) return 'foreign_role';
    if (!(await ensureOwned(card, run, att))) return 'foreign_attempt';
    if (att.status === 'launching' || !att.porchRunId) {
      const built = await builtFor(card, run, att).catch((e) => {
        recordEvent(card, run, 'rebuild_failed', {
          attemptId: att.id, detail: String(e?.message || e).slice(0, 200),
        }, att.id).catch(() => {});
        return null;
      });
      if (!built) return 'rebuild_failed';
      const oz = run.orchestrator;
      const profileEntry = att.role === 'decomposer' ? oz.decomposer
        : att.role === 'verifier' ? oz.verifier
          : att.role === 'assembler' ? oz.integrator
            : oz.workers[taskById(oz, att.taskId)?.worker?.profileId];
      if (!profileEntry) return 'profile_missing';
      return await reconcileLaunch(card, run, att, profileEntry, built);
    }
    return await observeAttempt(card, run, att);
  }

  // ---- issuance -------------------------------------------------------------------

  async function issueDecompose(card, run) {
    const oz = run.orchestrator;
    const used = (run.attempts || []).filter((a) => a && a.role === 'decomposer').length;
    const attemptId = attemptIdOf(run, 'dec', null, used + 1);
    const att = { id: attemptId, role: 'decomposer', kind: 'decompose' };
    const built = await builtFor(card, run, att);
    const launch = launchFields(att, built, {
      profileId: oz.decomposer.profileId, profileDigest: oz.decomposer.profileDigest,
    });
    try {
      await send(card, 'orch_decompose_begin', {
        runId: run.id, attemptId, launch, leaseMs: deps.leaseMs, ...self(),
      }, `odb-${attemptId}-by-${instanceId}`);
    } catch (e) {
      return isErr(e, 'attempts_exhausted') ? 'decompose_exhausted'
        : isErr(e, 'limit_reached') ? 'limited' : 'launch_refused';
    }
    const fresh = (await refresh(run)).attempts?.find((a) => a && a.id === attemptId);
    return await startRuntime(card, run, fresh ?? { id: attemptId, role: 'decomposer', kind: 'decompose' },
      oz.decomposer, built);
  }

  // Prepare the durable launch basis for a work attempt: for dependent
  // tasks assemble the snapshot repo from accepted ancestors' cumulative
  // diffs; then pair the per-task canonical. Both steps are idempotent.
  async function prepareTaskBasis(card, run, task) {
    const oz = run.orchestrator;
    const inputs = oz.graph.inputs;
    const canonicalId = taskCanonicalId(run, task.id);
    if (!task.dependsOn.length) {
      // Base task — canonical pairs the project at baseCommit.
      const cp = await runtime.canonicalPrepare({
        canonicalId, projectRoot: oz.project.projectRoot,
        snapshotSha: inputs.baseCommit, branch: `acp/orch/${run.id}`,
      }).catch((e) => ({ ok: false, error: { message: String(e?.message || e) } }));
      if (!cp?.ok) return { code: 'canonical_unprepared', detail: cp?.error?.message };
      return { code: 'ok', projectRoot: oz.project.projectRoot, inputCommit: inputs.baseCommit, canonicalId };
    }
    const s = await stor();
    const parentDiffs = await parentDiffsFor(card, run, task);
    const baseDir = projectsDir ?? path.dirname(oz.project.sourcePath);
    const identity = {
      runId: run.id, taskId: task.id, dependsOn: task.dependsOn, sourcePath: path.resolve(oz.project.sourcePath),
      baseCommit: inputs.baseCommit,
      order: parentDiffs.map((p) => p.taskId),
      parents: parentDiffs.map((p) => ({ taskId: p.taskId, inputCommit: p.inputCommit,
        resultCommit: p.resultCommit, patchSha256: p.patchSha256,
        dependsOn: taskById(oz, p.taskId)?.dependsOn ?? [] })),
    };
    let basis;
    try {
      basis = await immutableDependencyBasis({ identity, baseDir,
        cacheDir: path.join(stateDir, 'orch-dependency-bases'), storage: s,
        assemble: (name) => s.assembleDependencySnapshot({
          sourcePath: oz.project.sourcePath, baseCommit: inputs.baseCommit,
          taskId: task.id, tasks: oz.tasks, parentDiffs, name, baseDir,
        }),
      });
    } catch (e) {
      return { code: 'snapshot_failed', detail: String(e.message).slice(0, 300) };
    }
    const name = basis.projectRoot;
    const snap = basis;
    const dependencyCanonicalId = `${canonicalId.slice(0, 55)}-${basis.key.slice(0, 16)}`;
    const cp = await runtime.canonicalPrepare({
      canonicalId: dependencyCanonicalId, projectRoot: name,
      snapshotSha: snap.inputCommit, branch: `acp/orch/${run.id}`,
    }).catch((e) => ({ ok: false, error: { message: String(e?.message || e) } }));
    if (!cp?.ok) return { code: 'canonical_unprepared', detail: cp?.error?.message };
    return { code: 'ok', projectRoot: name, inputCommit: snap.inputCommit, canonicalId: dependencyCanonicalId };
  }

  // Prepare the verifier's candidate binding: the task canonical's head
  // MUST equal the recorded candidate commit (nothing else writes the
  // canonical between settle and verify), then the controller materializes
  // an immutable snapshot of it. The verifier launches against the returned
  // materials — projectRoot/snapshotSha/snapshotId — never a caller path.
  async function prepareCandidateBasis(card, run, task, generation) {
    const oz = run.orchestrator;
    const cand = task.state?.resultCandidate;
    const canonicalId = cand?.canonicalId ?? taskCanonicalId(run, task.id);
    if (!cand?.commit) return { code: 'candidate_unrecorded' };
    const cst = await runtime.canonicalStatus(canonicalId).catch(() => null);
    const head = cst?.canonical?.head ?? null;
    if (!head) return { code: 'canonical_unreadable' };
    if (head !== cand.commit) {
      return { code: 'candidate_unbound',
        detail: `canonical head ${String(head).slice(0, 12)} != recorded candidate ${String(cand.commit).slice(0, 12)}` };
    }
    if (typeof runtime.swarmSnapshot !== 'function') return { code: 'snapshot_unwired' };
    const snap = await runtime.swarmSnapshot({ canonicalId, generation })
      .catch((e) => ({ ok: false, error: e }));
    if (!snap?.ok || snap.materials?.snapshotSha !== cand.commit || !snap.materials?.snapshotId) {
      return { code: 'snapshot_failed',
        detail: String(snap?.error?.message ?? 'swarm.snapshot rejected').slice(0, 300) };
    }
    return {
      code: 'ok', projectRoot: snap.materials.projectRoot,
      snapshotSha: snap.materials.snapshotSha,
      snapshotId: snap.materials.snapshotId ?? null,
      inputCommit: snap.snapshotSha ?? snap.materials.snapshotSha,
      canonicalId,
    };
  }

  async function issueTaskAttempt(card, run, task, kind) {
    const oz = run.orchestrator;
    const profileEntry = kind === 'verify' ? oz.verifier : oz.workers[task.worker.profileId];
    if (!profileEntry) return 'profile_missing';
    const isWork = kind === 'work';
    const isFix = kind === 'fix';
    const n = kind === 'verify' ? (task.state.verifyUsed ?? 0) + 1
      : isFix ? (task.state.fixesUsed ?? 0) + 1 : (task.state.attemptsUsed ?? 0) + 1;
    let basis = null;
    if (isFix) {
      basis = await prepareCandidateBasis(card, run, task,
        (task.state.attemptsUsed ?? 0) + (task.state.fixesUsed ?? 0) + (task.state.verifyUsed ?? 0) + 1);
      if (basis.code !== 'ok') return basis.code;
    } else if (isWork) {
      basis = await prepareTaskBasis(card, run, task);
      if (basis.code !== 'ok') {
        await recordEvent(card, run, 'task_basis_blocked', {
          taskId: task.id, code: basis.code, detail: String(basis.detail ?? '').slice(0, 300),
        }, null).catch(() => {});
        return basis.code;
      }
    } else {
      // verify — the registered immutable candidate snapshot, bound to the
      // exact canonical head == recorded candidate commit.
      basis = await prepareCandidateBasis(card, run, task,
        (task.state.attemptsUsed ?? 0) + (task.state.fixesUsed ?? 0) + (task.state.verifyUsed ?? 0) + 1);
      if (basis.code !== 'ok') {
        await recordEvent(card, run, 'candidate_basis_blocked', {
          taskId: task.id, code: basis.code, detail: String(basis.detail ?? '').slice(0, 300),
        }, null).catch(() => {});
        return basis.code;
      }
    }
    const attemptId = attemptIdOf(run, kind === 'verify' ? 'v' : isFix ? 'f' : 'w', task.id, n);
    const att = {
      id: attemptId, role: kind === 'verify' ? 'verifier' : 'worker', kind,
      taskId: task.id, n,
      launch: {
        inputCommit: basis?.inputCommit ?? task.state.inputCommit,
        projectRoot: basis?.projectRoot ?? undefined,
        snapshotSha: basis?.snapshotSha ?? undefined,
        snapshotId: basis?.snapshotId ?? undefined,
        snapshotOf: isFix || isWork ? oz.order.filter((id) => task.dependsOn.includes(id)) : [],
        canonicalId: basis?.canonicalId,
        fromCanonical: isFix && !basis?.snapshotId || undefined,
      },
    };
    const built = await builtFor(card, run, att).catch((e) => {
      recordEvent(card, run, 'prompt_build_failed', {
        taskId: task.id, kind, detail: String(e?.message || e).slice(0, 200),
      }, null).catch(() => {});
      return null;
    });
    if (!built) return 'build_failed';
    const launch = launchFields(att, built, {
      profileId: profileEntry.profileId, profileDigest: profileEntry.profileDigest,
      launch: {
        ...(basis ? {
          inputCommit: basis.inputCommit, canonicalId: basis.canonicalId,
          ...(basis.projectRoot ? { projectRoot: basis.projectRoot } : {}),
          ...(basis.snapshotSha ? { snapshotSha: basis.snapshotSha } : {}),
          ...(basis.snapshotId ? { snapshotId: basis.snapshotId } : {}),
        } : {}),
        ...(isFix && !basis.snapshotId ? { inputCommit: basis.inputCommit, canonicalId: basis.canonicalId, fromCanonical: true } : {}),
        ...(isWork || isFix
          ? { snapshotOf: oz.order.filter((id) => task.dependsOn.includes(id)) }
          : {}),
      },
    });
    try {
      await send(card, 'orch_task_begin', {
        runId: run.id, taskId: task.id, kind, attemptId,
        launch, leaseMs: deps.leaseMs, ...self(),
      }, `otb-${attemptId}-by-${instanceId}`);
    } catch (e) {
      if (isErr(e, 'limit_reached')) return 'limited';
      if (isErr(e, 'attempts_exhausted')) return 'attempts_exhausted';
      await recordEvent(card, run, 'task_launch_blocked', {
        taskId: task.id, kind, attemptId, code: e?.code ?? 'error',
        detail: String(e?.message ?? e).slice(0, 200),
      }, null).catch(() => {});
      return 'launch_refused';
    }
    const fresh = (await refresh(run)).attempts?.find((a) => a && a.id === attemptId);
    return await startRuntime(card, run,
      fresh ?? { id: attemptId, role: att.role, kind, taskId: task.id, launch: att.launch },
      profileEntry, built);
  }

  async function issueIntegrate(card, run) {
    const oz = run.orchestrator;
    const wsRes = await ensureWorkspace(card, run);
    if (!wsRes?.ok) return wsRes?.code ?? 'workspace_unresolved';
    const canonicalId = oz.integrate?.canonicalId ?? integrateCanonicalId(run);
    const cp = await runtime.canonicalPrepare({
      canonicalId, projectRoot: oz.project.projectRoot,
      snapshotSha: oz.graph.inputs.baseCommit, branch: `acp/orch/${run.id}`,
    }).catch((e) => ({ ok: false, error: { message: String(e?.message || e) } }));
    if (!cp?.ok) return 'canonical_unprepared';
    const used = (run.attempts || []).filter((a) => a && a.role === 'assembler').length;
    const attemptId = attemptIdOf(run, 'int', null, used + 1);
    const att = { id: attemptId, role: 'assembler', kind: 'integrate' };
    const built = await builtFor(card, run, att);
    const launch = launchFields(att, built, {
      profileId: oz.integrator.profileId, profileDigest: oz.integrator.profileDigest,
      launch: { canonicalId },
    });
    try {
      await send(card, 'orch_integrate_begin', {
        runId: run.id, attemptId, launch, leaseMs: deps.leaseMs, ...self(),
      }, `oib-${attemptId}-by-${instanceId}`);
    } catch (e) {
      return isErr(e, 'attempts_exhausted') ? 'integrate_exhausted'
        : isErr(e, 'limit_reached') ? 'limited' : 'launch_refused';
    }
    const fresh = (await refresh(run)).attempts?.find((a) => a && a.id === attemptId);
    return await startRuntime(card, run, fresh ?? { id: attemptId, role: 'assembler' },
      oz.integrator, built);
  }

  // ---- acceptance drift ----------------------------------------------------------

  async function driftCheck(card, run) {
    if (run.status !== 'awaiting_acceptance' || !run.acceptance?.resultSha256) return null;
    const ws = card.workspaces?.[run.workspaceId];
    if (!ws?.path) return null;
    let manifest;
    try {
      const { computeResultManifest } = await import('../result-snapshot.mjs');
      manifest = await computeResultManifest(ws.path, { baseCommit: run.baseCommit });
    } catch {
      return 'drift_unproven';
    }
    if (manifest.resultSha256 === run.acceptance.resultSha256) return 'acceptance_stable';
    await send(card, 'orch_annul', {
      runId: run.id, observedSha256: manifest.resultSha256, ...self(),
    }, `oax-${run.id}-${manifest.resultSha256.slice(0, 12)}-by-${instanceId}`);
    return 'acceptance_annulled';
  }

  // ---- drive ---------------------------------------------------------------------

  const isErr = (e, code) => e && (e.code === code || e.details?.code === code);

  async function drive(card, run0) {
    let run = run0;
    if (!run.orchestrator || typeof run.orchestrator !== 'object') return 'not_orchestrator';
    let oz = run.orchestrator;

    // The graph has its own durable owner, independently of its attempts.
    // A restart must adopt it before settlement or issuance can continue.
    // Lease age grants no authority: the authenticated claim verifies the
    // exact recorded process/environment death proof in the domain.
    if (RUN_NONTERMINAL.has(run.status) && oz.owner && !owns(oz.owner)) {
      if (typeof adoptionProofFor !== 'function') return 'foreign_owner';
      let proof;
      try { proof = await adoptionProofFor(oz.owner); } catch { return 'foreign_owner'; }
      if (!proof) return 'foreign_owner';
      const claimKey = sha256Hex(canonicalJson({
        owner: { runnerId: oz.owner.runnerId, instanceId: oz.owner.instanceId }, proof,
      })).slice(0, 16);
      try {
        await send(card, 'orch_claim', {
          runId: run.id, adopt: true, proof, leaseMs: deps.leaseMs, ...self(),
        }, `oca-${run.id}-${claimKey}-by-${instanceId}`);
      } catch { return 'foreign_owner'; }
      const fresh = await getRun(run.id).catch(() => null);
      if (!fresh?.orchestrator || !owns(fresh.orchestrator.owner)) return 'foreign_owner';
      run = fresh;
      oz = run.orchestrator;
    }

    // 1) Supervise every live orch attempt — observation beats issuance.
    let acted = null;
    for (let round = 0; round < 8; round += 1) {
      const live = (run.attempts || []).filter(
        (a) => a && ORCH_ROLES.has(a.role) && LIVE_ATTEMPT.has(a.status));
      if (!live.length) break;
      let progressed = false;
      for (const att of live) {
        const tag = await superviseAttempt(card, run, att);
        if (tag === 'bound' || tag === 'launch_failed' || tag === 'launch_orphaned'
          || tag === 'completed' || tag === 'failed' || tag === 'cancelled') {
          run = await refresh(run);
          progressed = true;
          acted = acted ?? (tag === 'bound' ? 'bound' : `resolved_${tag}`);
        }
      }
      if (!progressed) { acted ??= 'supervising'; break; }
    }
    if (acted) run = await refresh(run);

    // 1b) Post-terminal bookkeeping: completed-but-unsettled worker attempts
    //     and a completed-but-unrecorded integration — covers the crash
    //     window between resolve_attempt and the settle/record command.
    //     Every terminal attempt must ALSO carry a durable namespace-settle
    //     record — historical rows resolved before this gate get drained
    //     here (stop/status are idempotent on a dead worker).
    for (const att of (run.attempts || []).filter(
      (a) => a && ORCH_ROLES.has(a.role) && ATTEMPT_TERMINAL.has(a.status)
        && !(a.namespace && (a.namespace.state === 'stopped' || a.namespace.state === 'gone')))) {
      const settled = await settleWorkerNamespace(card, run, att);
      if (!settled.settled) return 'namespace_settlement_pending';
      run = await refresh(run);
    }
    run = await settlePendingWorkers(card, run);
    run = await recordPendingIntegrate(card, run);
    oz = run.orchestrator;

    // 2) Stopping — durable cancel intent on every surviving owned attempt,
    //    drain to positive terminal, then complete the run.
    if (run.status === 'stopping') {
      const live = (run.attempts || []).filter((a) => LIVE_ATTEMPT.has(a.status));
      for (const att of live) {
        if (!owns(att.owner)) continue;
        await send(card, 'cancel_attempt', {
          runId: run.id, attemptId: att.id, reason: 'stop intent', ...self(),
        }, `cx-${att.id}-stop-by-${instanceId}`).catch(() => {});
      }
      if (live.length) return 'stopping';
      await send(card, 'complete_run', {
        runId: run.id, status: run.priorTerminal ?? 'cancelled',
        reason: 'stopped by user', ...self(),
      }, `cr-${run.id}-stop-by-${instanceId}`);
      return 'stopped';
    }
    if (!RUN_NONTERMINAL.has(run.status)) return acted ?? 'terminal_drained';

    // 3) Run-level execution authority before any issuance.
    if (!oz.owner) {
      if (!['queued', 'active'].includes(run.status)) return acted ?? 'parked';
      await send(card, 'orch_claim', {
        runId: run.id, leaseMs: deps.leaseMs, ...self(),
      }, `oc-${run.id}-by-${instanceId}`);
      return 'orch_claimed';
    }
    if (!owns(oz.owner)) return acted ?? 'foreign_owner';

    const phase = run.phase ?? 'decompose';
    if (phase === 'awaiting_acceptance') {
      const drift = await driftCheck(card, run);
      return drift ?? acted ?? 'awaiting_acceptance';
    }
    if (phase === 'awaiting_validation') {
      return acted ?? 'awaiting_validation'; // U5 rides the core surface
    }
    if (!['queued', 'active'].includes(run.status)) return acted ?? 'parked';
    if (!canLaunch()) return acted ?? 'launch_held';

    if (phase === 'decompose') {
      if (oz.graph.status !== 'awaiting_decomposition') return acted ?? 'decompose_blocked';
      const live = (run.attempts || []).find(
        (a) => a && ORCH_ROLES.has(a.role) && LIVE_ATTEMPT.has(a.status));
      if (live) return acted ?? 'supervising';
      return await issueDecompose(card, run);
    }

    if (phase === 'work' && oz.graph.status === 'active') {
      // Deterministic issuance: walk the recorded topo order; launch every
      // launchable task attempt this pass (global slot caps gate inside
      // orch_task_begin).
      let issued = null;
      for (const id of oz.order || []) {
        const task = taskById(oz, id);
        if (!task) continue;
        const st = task.state.status;
        const live = (run.attempts || []).find(
          (a) => a && a.taskId === id && LIVE_ATTEMPT.has(a.status));
        if (live) continue;
        let kind = null;
        if (st === 'verifying' && task.state.resultCandidate
          && (task.state.verifyUsed ?? 0) < (oz.limits?.verifyAttempts ?? 2)) kind = 'verify';
        else if (st === 'ready') kind = 'work';
        else if (st === 'returned') kind = 'fix';
        if (!kind) continue;
        const tag = await issueTaskAttempt(card, run, task, kind);
        if (tag === 'bound' || tag === 'launch_inflight' || tag === 'launch_uncertain') {
          issued = issued ?? 'issued';
        } else if (tag === 'limited') {
          return 'limited';
        }
        run = await refresh(run);
      }
      return issued ?? acted ?? 'idle';
    }

    if (phase === 'integrate' && oz.graph.status === 'complete' && !oz.integrate?.import) {
      const live = (run.attempts || []).find(
        (a) => a && a.role === 'assembler' && LIVE_ATTEMPT.has(a.status));
      if (live) return acted ?? 'supervising';
      return await issueIntegrate(card, run);
    }

    return acted ?? 'idle';
  }

  return { drive, _inflight: inflight };
}

// The immutable receipt is the publication point. Builds use unique private
// names, so concurrent creators and a crash before publication cannot expose
// a partial repository to a retry. Published receipts never get overwritten.
export async function immutableDependencyBasis({ identity, baseDir, cacheDir, storage, assemble }) {
  const identityText = canonicalJson(identity);
  const key = sha256Hex(identityText);
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(cacheDir, `${key}.json`);
  async function validated() {
    const stat = await fs.lstat(receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('dependency receipt is not a regular file');
    const rec = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    if (canonicalJson(rec.identity) !== identityText || rec.key !== key
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(rec.projectRoot)
      || rec.repoPath !== path.join(path.resolve(baseDir), rec.projectRoot)) {
      throw new Error('dependency receipt identity mismatch');
    }
    const repoStat = await fs.lstat(rec.repoPath);
    if (!repoStat.isDirectory() || repoStat.isSymbolicLink()
      || await fs.realpath(rec.repoPath) !== rec.repoPath) throw new Error('dependency repo path mismatch');
    const iso = await storage.verifyPrivateRepo(rec.repoPath);
    const head = await git(rec.repoPath, ['rev-parse', 'HEAD']);
    const dirty = await git(rec.repoPath, ['status', '--porcelain', '--untracked-files=all']);
    if (!iso.ok || head.code !== 0 || head.stdout.trim() !== rec.inputCommit
      || dirty.code !== 0 || dirty.stdout.trim()
      || await storage.treeHashFor(rec.repoPath, rec.inputCommit) !== rec.treeHash) {
      throw new Error('immutable dependency basis was changed');
    }
    return rec;
  }
  try { return await validated(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const name = `osnap-${key.slice(0, 24)}-${randomUUID().slice(0, 18)}`;
  const snap = await assemble(name);
  const repoPath = path.join(path.resolve(baseDir), name);
  if (snap.repoPath !== repoPath) throw new Error('assembled dependency repo escaped registered projects');
  const rec = { key, identity, projectRoot: name, repoPath,
    inputCommit: snap.inputCommit, treeHash: await storage.treeHashFor(repoPath, snap.inputCommit) };
  // Persist git objects/index and tree before publishing the receipt.
  async function syncTree(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await syncTree(child);
      else if (entry.isFile()) { const file = await fs.open(child, 'r'); try { await file.sync(); } finally { await file.close(); } }
    }
    const handle = await fs.open(dir, 'r'); try { await handle.sync(); } finally { await handle.close(); }
  }
  await syncTree(repoPath);
  const projectsHandle = await fs.open(path.dirname(repoPath), 'r');
  try { await projectsHandle.sync(); } finally { await projectsHandle.close(); }
  const tmp = `${receiptPath}.${randomUUID()}.tmp`;
  const fh = await fs.open(tmp, 'wx', 0o600);
  try { await fh.writeFile(canonicalJson(rec)); await fh.sync(); } finally { await fh.close(); }
  try { await fs.link(tmp, receiptPath); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  finally { await fs.unlink(tmp); }
  const dirHandle = await fs.open(cacheDir, 'r');
  try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  return validated();
}
