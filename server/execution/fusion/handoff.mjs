// server/execution/fusion/handoff.mjs — F3 judge + integrator driver
// (scheduler-side).
//
// The panel driver's sibling: it owns every fusion run that has left
// phase 'panel'. Same rules — the durable record is the only truth and
// every mutation lands through `send` before any runtime effect:
//
//   judge      — judge_begin mints the attempt row; the runtime launches
//                the judge with the RO project snapshot, the task, the
//                accepted-answers bundle and the work-order rubric. A
//                'completed' terminal observation commits the work-order
//                artifact and resolves with the bound descriptor — the
//                domain re-parses the committed bytes and routes the run
//                (a comparison/summary is rejected by the contract).
//   integrate  — the work order binds the attempt; the integrator works
//                in the F1 private repo against the canonical worktree.
//                After a completed attempt the driver imports the private
//                repo into canonical (repo.import), materializes the
//                canonical commit into the bound workspace, then
//                record_integrate_result hands the run to the U5 gate.
//   fix        — a gate fix decision (run.fixContext) launches an
//                integrator fix attempt whose private repo is built from
//                the canonical state; the import lands the same way.
//   drift      — 'awaiting_acceptance' runs are re-hashed; workspace
//                drift annuls the parked acceptance (re-verification).
//
// The integrator NEVER receives panel answers or logs: the domain refuses
// integrate_begin whenever a declared input hash matches any panelist
// artifact — this driver simply never asks for them.
//
// The durable-write→launch recovery window is identical to the panel's:
// judge_begin/integrate_begin write the attempt first, launchRecord
// proves whether start ran, and an uncertain launch is reconciled —
// never blindly duplicated.

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import {
  ATTEMPT_NONTERMINAL, RUN_NONTERMINAL,
} from '../execution-domain.mjs';
import { sha256, writeStagedArtifact } from '../execution-store.mjs';
import { CONTAINER_PATHS } from '../environment/container-runtime.mjs';
import { canonicalJson } from '../environment/agent-profile.mjs';
import { parseWorkOrder, parseIntegratorReport, workOrderContractText } from './work-order.mjs';
import {
  buildAnswersBundle, buildJudgePrompt, judgeMaterials,
  buildIntegratorPrompt, integratorMaterials,
} from './handoff-prompt.mjs';
import { sha256Hex } from './prompt.mjs';

const LIVE_ATTEMPT = ATTEMPT_NONTERMINAL;
const HANDOFF_ROLES = new Set(['judge', 'integrator']);

const git = (cwd, args) => new Promise((resolve) => {
  execFile('git', ['-C', cwd, ...args], { timeout: 30000, encoding: 'utf-8' },
    (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
});

export function createHandoffDriver(deps = {}) {
  const {
    runtime,               // REQUIRED — the F1 constrained container runtime
    send,                  // (card, type, payload, idem) => result
    recordEvent,           // (card, run, type, data, attemptId?) => ...
    self,                  // () => owner identity fields
    getRun,                // (runId) => run record | null
    getDocument,           // (cardId, versionId) => {content, sha256?}
    getArtifact,           // (runId, artifactId) => {contentBase64}
    ensureWorkspace,       // (card, run) => {ok, ws|code}
    stateDir,              // artifact staging root (writeStagedArtifact)
    canLaunch = () => true,
    adoptionProofFor = null,
    cardTitle = null,
    launchOrphanMs = 10 * 60 * 1000,
    instanceId = 'fusion-handoff',
    now = () => Date.now(),
  } = deps;
  if (!runtime) throw new Error('handoff driver requires the F1 constrained runtime');
  if (typeof send !== 'function' || typeof getRun !== 'function') {
    throw new Error('handoff driver requires send + getRun');
  }

  const inflight = new Map();
  const cancelIssued = new Set();

  const refresh = async (run) => (await getRun(run.id)) ?? run;

  const owns = (owner) => {
    const s = self();
    return !!owner && owner.runnerId === s.runnerId && owner.instanceId === s.instanceId;
  };

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

  // ---- material helpers -----------------------------------------------------

  // Verified text of a committed run artifact — the sha must match the
  // recorded descriptor or the evidence is unusable.
  async function artifactText(runId, artifactId, wantSha256) {
    const got = await getArtifact(runId, artifactId);
    const buf = Buffer.from(got?.contentBase64 ?? '', 'base64');
    const text = buf.toString('utf8');
    if (wantSha256 && sha256(buf) !== wantSha256) {
      throw new Error(`artifact ${artifactId} bytes do not hash to the recorded sha256`);
    }
    return text;
  }

  // Verified document text by versionId — same rule as the task binding.
  async function docText(cardId, doc) {
    if (!doc?.versionId) return null;
    const d = await getDocument(cardId, doc.versionId);
    if (!d || typeof d.content !== 'string') {
      throw new Error(`document ${doc.versionId} unreadable`);
    }
    if (doc.sha256 && d.sha256 && d.sha256 !== doc.sha256) {
      throw new Error(`document ${doc.versionId} no longer verifies against the recorded sha256`);
    }
    return d.content;
  }

  // The deterministic judge input set — built ONLY from durable records:
  // the pinned task document, every accepted answer's committed bytes, and
  // the exclusions record. Excluded participants contribute metadata only.
  async function judgeInputs(card, run) {
    const fz = run.fusion;
    const task = fz.snapshot?.task;
    const taskText = await docText(card.cardId, task);
    const answered = (fz.participants || []).filter((p) => p.status === 'answered' && p.answer);
    const answers = new Map();
    for (const p of answered) {
      answers.set(p.id, await artifactText(run.id, p.answer.artifactId, p.answer.sha256));
    }
    const answersBundle = buildAnswersBundle({
      participants: answered, answers, exclusions: fz.exclusions || [],
    });
    const snap = fz.snapshot.project;
    const prompt = buildJudgePrompt({
      cardTitle: typeof cardTitle === 'function' ? cardTitle(card.cardId) : null,
      taskText,
      snapshotSha: snap.snapshotSha,
      projectRoot: snap.projectRoot,
      resultKind: fz.resultKind,
      answeredCount: answered.length,
      excludedCount: (fz.exclusions || []).length,
    });
    const materials = judgeMaterials({
      projectRoot: snap.projectRoot,
      snapshotSha: snap.snapshotSha,
      taskText,
      answersBundle,
    });
    const inputs = [
      { name: 'task', sha256: task.sha256 },
      { name: 'answers', sha256: sha256Hex(answersBundle) },
      { name: 'rubric', sha256: sha256Hex(workOrderContractText()) },
    ];
    return { prompt, materials, inputs };
  }

  function currentWo(run) {
    const list = run.fusion?.workOrders || [];
    return list.length ? list[list.length - 1] : null;
  }

  // The fix-round evidence bundle — the 'results' input: gate findings +
  // check reports serialized for the integrator, never panel material.
  function resultsBundle(run) {
    const fx = run.fixContext;
    if (!fx) return null;
    return [
      `# Fix round ${fx.round} — prior verification evidence`,
      '',
      `gate reason: ${fx.reason ?? '(none)'}`,
      '',
      '## Open findings',
      ...(fx.openFindings?.length
        ? fx.openFindings.map((f) =>
            `- [${f.severity ?? '?'}] ${f.text ?? f.id}${f.where ? ` (${f.where})` : ''}`)
        : ['(none)']),
      '',
      '## Check results',
      ...(fx.checkReports?.length
        ? fx.checkReports.map((r) =>
            `- check ${r.index}: ${r.status} (exit ${r.exitCode ?? '?'})`)
        : ['(none)']),
    ].join('\n');
  }

  async function integratorInputs(card, run, wo, { fix = false, dependencies = null, sourceSnapshotSha = null } = {}) {
    const fz = run.fusion;
    const task = fz.snapshot?.task;
    const taskText = await docText(card.cardId, task);
    const woText = await artifactText(run.id, wo.artifactId, wo.sha256);
    const requirementsText = run.inputs?.requirements
      ? await docText(card.cardId, run.inputs.requirements) : null;
    const planText = run.inputs?.plan
      ? await docText(card.cardId, run.inputs.plan) : null;
    const designText = run.inputs?.design
      ? await docText(card.cardId, run.inputs.design) : null;
    const results = fix ? resultsBundle(run) : null;
    const snap = fz.snapshot.project;
    const prompt = buildIntegratorPrompt({
      cardTitle: typeof cardTitle === 'function' ? cardTitle(card.cardId) : null,
      taskText,
      workOrderText: woText,
      resultKind: fz.resultKind,
      hasRequirements: requirementsText !== null,
      hasPlan: planText !== null,
      hasDesign: designText !== null,
      fixContext: fix ? run.fixContext : null,
      dependencies,
    });
    const materials = integratorMaterials({
      projectRoot: snap.projectRoot,
      snapshotSha: sourceSnapshotSha ?? snap.snapshotSha,
      canonicalId: fz.integrate?.canonicalId ?? canonicalIdFor(run),
      taskText, workOrderText: woText,
      requirementsText, planText, designText,
      resultsBundle: results,
      fromCanonical: fix,
      dependencies,
    });
    const inputs = [
      { name: 'task', sha256: task.sha256 },
      { name: 'work-order', sha256: wo.sha256 },
      ...(run.inputs?.requirements ? [{ name: 'requirements', sha256: run.inputs.requirements.sha256 }] : []),
      ...(run.inputs?.plan ? [{ name: 'plan', sha256: run.inputs.plan.sha256 }] : []),
      ...(run.inputs?.design ? [{ name: 'design', sha256: run.inputs.design.sha256 }] : []),
      ...(results !== null ? [{ name: 'results', sha256: sha256Hex(results) }] : []),
    ];
    return { prompt, materials, inputs };
  }

  function canonicalIdFor(run) {
    return `canon-${run.id.slice(4)}`;
  }

  // ---- attempt supervision --------------------------------------------------

  // Re-issue the runtime side of a recorded 'launching' handoff attempt —
  // the same recovery semantics as the panel driver.
  async function startRuntime(card, run, att, built) {
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
          profileId: built.profileId,
          profile: built.profile,
          role: att.role,
          prompt: built.prompt,
          materials: built.materials,
          launchTimeoutMs: (run.fusion.limits?.timeoutMin ?? 45) * 60 * 1000,
        });
      } catch (e) {
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

  // Rebuild an attempt's launch material from the durable record — used by
  // BOTH the fresh launch and the post-crash reconcile path, so the two
  // can never diverge.
  async function builtFor(card, run, att) {
    const fz = run.fusion;
    const roleSpec = att.role === 'judge' ? fz.judge : fz.integrator;
    if (!roleSpec) return null;
    if (att.role === 'judge') {
      const b = await judgeInputs(card, run);
      return { ...b, profileId: roleSpec.profileId, profile: roleSpec.profile };
    }
    const wo = currentWo(run);
    if (!wo) return null;
    const b = await integratorInputs(card, run, wo, { fix: att.fix !== undefined && att.fix !== null, dependencies: att.launch?.dependencies ?? null, sourceSnapshotSha: att.launch?.snapshotSha ?? null });
    return { ...b, profileId: roleSpec.profileId, profile: roleSpec.profile };
  }

  async function reconcileLaunch(card, run, att, built) {
    if (inflight.has(att.id)) return 'launch_inflight';
    const rec = await runtime.launchRecord(att.id).catch(() => null);
    if (!rec || rec.corrupt) return 'launch_unreadable';
    if (rec.missing === true) {
      if (att.status === 'cancelling' || att.cancel || run.status === 'stopping') {
        await send(card, 'resolve_attempt', {
          runId: run.id, attemptId: att.id, outcome: 'cancelled',
          reason: att.cancel?.reason ?? 'cancelled before launch',
          ...self(),
        }, `rs-${att.id}-prelaunch-cancel-by-${instanceId}`);
        return 'cancelled';
      }
      return await startRuntime(card, run, att, built);
    }
    const evidence = rec.record ?? rec;
    const phase = evidence.phase ?? null;
    if (phase === 'launched' && evidence.porchRunId) {
      await send(card, 'bind_attempt', {
        runId: run.id, attemptId: att.id, porchRunId: evidence.porchRunId, ...self(),
      }, `bind-${att.id}-by-${instanceId}`);
      return 'bound';
    }
    if (phase === 'launch_failed') {
      await send(card, 'resolve_attempt', {
        runId: run.id, attemptId: att.id, outcome: 'failed',
        reason: `${att.role} launch failed: ${evidence.error?.code ?? 'error'} — ${String(evidence.error?.message ?? '').slice(0, 300)}`,
        ...self(),
      }, `rs-${att.id}-launchfail-by-${instanceId}`);
      return 'launch_failed';
    }
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
    const allGone = scan?.ok === true && (scan?.workers || []).every((w) => w.gone === true)
      && (scan?.workers || []).length > 0;
    const recAt = Date.parse(evidence.launch?.startedAt ?? evidence.launchStartedAt ?? evidence.createdAt ?? '') || 0;
    if (allGone && recAt && now() - recAt > launchOrphanMs) {
      await send(card, 'resolve_attempt', {
        runId: run.id, attemptId: att.id, outcome: 'failed',
        reason: `${att.role} launch orphaned — worker gone with no registered run`,
        ...self(),
      }, `rs-${att.id}-launchorphan-by-${instanceId}`);
      return 'launch_orphaned';
    }
    return 'launch_reconcile';
  }

  // Commit the role artifact + resolve a terminally-observed handoff
  // attempt. exit 0 is never the result: the judge owes a valid work
  // order, the integrator a valid report — anything else resolves failed.
  async function resolveAttempt(card, run, att, { outcome, reason, wt }) {
    let payload = {};
    if (outcome === 'completed' && att.role === 'judge') {
      const finalText = typeof wt?.finalText === 'string' ? wt.finalText : null;
      const parsed = finalText !== null ? parseWorkOrder(finalText) : { ok: false, reason: 'no_final_text' };
      if (!parsed.ok) {
        outcome = 'failed';
        reason = `work_order_invalid: ${parsed.reason}`
          + `${parsed.problems?.length ? ` (${parsed.problems.join('; ')})` : ''}`
          + `${parsed.missing?.length ? ` missing:${parsed.missing.join(',')}` : ''}`;
      } else {
        const name = `work-order-${att.id}.md`;
        const staged = await writeStagedArtifact(stateDir, att.id, name, finalText);
        const artifactId = `wo-${att.id}`;
        await send(card, 'commit_artifact', {
          runId: run.id, attemptId: att.id,
          artifact: { id: artifactId, kind: 'work-order', file: name, bytes: staged.bytes, sha256: staged.sha256 },
          stagedPath: staged.stagedPath, ...self(),
        }, `ca-${artifactId}-by-${instanceId}`);
        payload = {
          workOrder: {
            artifactId, sha256: staged.sha256, bytes: staged.bytes,
            verdict: parsed.verdict, sections: parsed.sections,
          },
        };
      }
    } else if (outcome === 'completed' && att.role === 'integrator') {
      const finalText = typeof wt?.finalText === 'string' ? wt.finalText : null;
      const parsed = finalText !== null ? parseIntegratorReport(finalText) : { ok: false, reason: 'no_final_text' };
      if (!parsed.ok) {
        outcome = 'failed';
        reason = `report_invalid: ${parsed.reason}`
          + `${parsed.problems?.length ? ` (${parsed.problems.join('; ')})` : ''}`
          + `${parsed.missing?.length ? ` missing:${parsed.missing.join(',')}` : ''}`;
      } else {
        const name = `integrator-report-${att.id}.md`;
        const staged = await writeStagedArtifact(stateDir, att.id, name, finalText);
        const artifactId = `rep-${att.id}`;
        await send(card, 'commit_artifact', {
          runId: run.id, attemptId: att.id,
          artifact: { id: artifactId, kind: 'integrator-report', file: name, bytes: staged.bytes, sha256: staged.sha256 },
          stagedPath: staged.stagedPath, ...self(),
        }, `ca-${artifactId}-by-${instanceId}`);
        payload = {
          report: {
            artifactId, sha256: staged.sha256, bytes: staged.bytes,
            behaviorChange: parsed.behaviorChange,
          },
        };
      }
    }
    const result = wt
      ? {
          status: wt.status ?? null,
          exitCode: wt.runExitCode ?? wt.exitCode ?? null,
          durationS: wt.durationS ?? null,
          summary: typeof wt.finalText === 'string' ? wt.finalText.slice(0, 1500) : null,
        }
      : null;
    await send(card, 'resolve_attempt', {
      runId: run.id, attemptId: att.id, outcome,
      ...payload,
      ...(result ? { result } : {}),
      reason: reason ?? (outcome === 'completed' ? `${att.role} completed` : `${att.role} ${outcome}`),
      ...self(),
    }, `rs-${att.id}-terminal-by-${instanceId}`);
    await recordEvent(card, run, 'handoff_terminal', {
      attemptId: att.id, role: att.role, outcome,
      reason: (reason ?? '').slice(0, 200) || null,
    }, att.id).catch(() => {});
    return outcome;
  }

  async function observeAttempt(card, run, att) {
    const timeoutMin = run.fusion.limits?.timeoutMin ?? 45;
    if (att.status === 'cancelling' || att.cancel || run.status === 'stopping') {
      if (!cancelIssued.has(att.id) && att.porchRunId) {
        const cancelled = await runtime.cancel(att.porchRunId).catch(() => null);
        if (cancelled?.ok === true && cancelled.requested === true) cancelIssued.add(att.id);
      }
      const wt = await runtime.wait(att.porchRunId, { timeoutSec: 0 }).catch(() => null);
      if (wt?.outcome === 'terminal') {
        return await resolveAttempt(card, run, att, {
          outcome: 'cancelled', reason: att.cancel?.reason ?? 'cancelled', wt,
        });
      }
      return 'cancelling';
    }
    const wt = await runtime.wait(att.porchRunId, { timeoutSec: 0 }).catch(() => null);
    if (!wt || wt.outcome === 'error') return 'observe_retry';
    if (wt.outcome === 'timeout' || wt.outcome === 'observer_timeout') {
      const deadline = (att.startedAt ?? att.createdAt) + timeoutMin * 60 * 1000;
      if (now() > deadline) {
        await send(card, 'cancel_attempt', {
          runId: run.id, attemptId: att.id,
          reason: `${att.role} exceeded the ${timeoutMin}min timeout`,
          ...self(),
        }, `cx-${att.id}-timeout-by-${instanceId}`);
        return 'timeout_cancel';
      }
      return 'observing';
    }
    if (wt.outcome !== 'terminal') return 'observe_retry';
    const code0 = (wt.runExitCode ?? wt.exitCode) === 0;
    const outcome = wt.status === 'cancelled' ? 'cancelled'
      : (wt.status === 'completed' && code0) ? 'completed'
        : 'failed';
    return await resolveAttempt(card, run, att, {
      outcome,
      reason: wt.error ?? (outcome === 'completed' ? null : `supervisor ${wt.status ?? 'terminal'} (exit ${wt.runExitCode ?? wt.exitCode ?? '?'})`),
      wt,
    });
  }

  async function superviseAttempt(card, run, att) {
    if (!HANDOFF_ROLES.has(att.role)) return 'foreign_role';
    if (!(await ensureOwned(card, run, att))) return 'foreign_attempt';
    if (att.status === 'launching' || (att.status === 'cancelling' && !att.porchRunId)) {
      const built = await builtFor(card, run, att);
      if (!built) return 'materials_unbuildable';
      return await reconcileLaunch(card, run, att, built);
    }
    return await observeAttempt(card, run, att);
  }

  // ---- the import/materialize step -------------------------------------------

  // The integrator's private repo → canonical → bound workspace. Runs
  // once per completed integrator attempt; the durable fz.integrate.import
  // record is written AFTER the workspace materialized, so a crash
  // anywhere inside re-runs the whole step (idempotent by construction).
  async function importAndMaterialize(card, run, att) {
    const fz = run.fusion;
    // 1) The workspace must exist + be ours before content lands.
    if (typeof ensureWorkspace !== 'function') return 'workspace_unwired';
    const wsRes = await ensureWorkspace(card, run);
    if (!wsRes?.ok) return wsRes?.code ?? 'workspace_unresolved';
    const ws = wsRes.ws;
    // 2) repo.import — worker private repo → canonical branch.
    const workerId = att.launch?.workerId ?? runtime.workerIdForAttempt?.(att.id) ?? `w-${att.id}`;
    const imp = await runtime.repoImport(workerId);
    if (!imp?.ok || !imp.import?.commitSha) {
      return 'import_failed';
    }
    // 3) Materialize the canonical commit into the bound workspace:
    //    fetch objects from the canonical repo, reset the worktree to the
    //    imported commit, drop foreign leftovers. Result: index+worktree
    //    EXACTLY the imported tree — deletions included.
    const canonId = att.launch?.canonicalId ?? fz.integrate?.canonicalId ?? canonicalIdFor(run);
    const st = await runtime.canonicalStatus(canonId).catch(() => null);
    const canonDir = st?.canonical?.hostDir;
    if (!canonDir) return 'canonical_unreadable';
    const repoGit = `${canonDir}/repo.git`;
    const f = await git(ws.path, ['fetch', '--no-tags', repoGit, imp.import.commitSha]);
    if (f.code !== 0) return 'materialize_fetch_failed';
    const r = await git(ws.path, ['reset', '--hard', imp.import.commitSha]);
    if (r.code !== 0) return 'materialize_reset_failed';
    await git(ws.path, ['clean', '-fdq']);
    // Dependency proof is committed with the imported result, so a changed
    // lockfile cannot enter verification with the prior dependency set.
    const prepared = await prepareDependencies(card, run, canonId);
    if (!prepared.ok || (prepared.dependencies && prepared.dependencies.snapshotSha !== imp.import.commitSha)) {
      return 'dependencies_unprepared';
    }
    // 4) Durable record — after this the U5 gate sees the run exactly like
    //    a solo implementer's finished workspace.
    await send(card, 'record_integrate_result', {
      runId: run.id, attemptId: att.id,
      ...(prepared.dependencies ? { dependencies: prepared.dependencies } : {}),
      import: {
        commitSha: imp.import.commitSha,
        treeSha: imp.import.treeSha ?? null,
        changed: imp.import.changed === true,
        diffStat: imp.import.diffStat ?? null,
      },
      ...self(),
    }, `ri-${att.id}-by-${instanceId}`);
    return 'integrate_recorded';
  }

  // ---- phase issuance --------------------------------------------------------

  async function beginJudge(card, run) {
    const built = await judgeInputs(card, run);
    const spec = run.fusion.judge;
    const n = (run.attempts || []).filter((a) => a && a.role === 'judge').length + 1;
    const attemptId = `ja-${run.id.slice(4)}-n${n}`;
    const launch = {
      profileId: spec.profileId,
      profileDigest: spec.profileDigest,
      promptSha256: sha256Hex(built.prompt),
      materialsSha256: sha256Hex(canonicalJson(built.materials)),
      cwd: CONTAINER_PATHS.project,
      artifactsDir: `${CONTAINER_PATHS.attempt}/run-${attemptId}`,
      attemptDir: CONTAINER_PATHS.attempt,
      inputs: built.inputs,
      workerId: `w-${attemptId}`,
    };
    try {
      await send(card, 'judge_begin', {
        runId: run.id, attemptId, launch, leaseMs: deps.leaseMs, ...self(),
      }, `jb-${attemptId}-by-${instanceId}`);
    } catch (e) {
      await recordEvent(card, run, 'handoff_launch_blocked', {
        role: 'judge', attemptId, code: e?.code ?? 'error',
        detail: String(e?.message ?? e).slice(0, 200),
      }, null).catch(() => {});
      return 'launch_refused';
    }
    const fresh = (await refresh(run)).attempts?.find((a) => a && a.id === attemptId);
    return await startRuntime(card, run, fresh ?? { id: attemptId, role: 'judge' }, {
      ...built, profileId: spec.profileId, profile: spec.profile,
    });
  }

  async function prepareDependencies(card, run, canonicalId) {
    if (!run.fusion.setupId) return { ok: true, dependencies: null };
    const result = typeof runtime.prepareDependencies === 'function'
      ? await runtime.prepareDependencies({ setupId: run.fusion.setupId, canonicalId }).catch(() => null)
      : null;
    if (!result?.ok || result.setupId !== run.fusion.setupId
      || !/^[0-9a-f]{32}$/.test(result.depSetId ?? '')
      || !/^[0-9a-f]{64}$/.test(result.lockHash ?? '')
      || !/^[0-9a-f]{40}$/.test(result.snapshotSha ?? '')
      || result.canonicalId !== canonicalId) {
      await recordEvent(card, run, 'dependency_preparation_blocked', {
        setupId: run.fusion.setupId, canonicalId, code: result?.error?.code ?? 'dependencies_unproven',
      }).catch(() => {});
      return { ok: false };
    }
    return { ok: true, dependencies: { setupId: result.setupId, depSetId: result.depSetId,
      lockHash: result.lockHash, snapshotSha: result.snapshotSha } };
  }

  async function beginIntegrator(card, run, { fix = false } = {}) {
    const fz = run.fusion;
    const wo = currentWo(run);
    if (!wo) return 'work_order_missing';
    // The workspace binds BEFORE the attempt — the private-repo result
    // will materialize into it after the run.
    const wsRes = await ensureWorkspace(card, run);
    if (!wsRes?.ok) return wsRes?.code ?? 'workspace_unresolved';
    // Canonical pairing first: the integrator's private repo pairs with a
    // prepared canonical worktree (fix rounds rebuild from its state).
    const canonId = fz.integrate?.canonicalId ?? canonicalIdFor(run);
    if (typeof runtime.canonicalPrepare === 'function') {
      const cp = await runtime.canonicalPrepare({
        canonicalId: canonId,
        projectRoot: fz.snapshot.project.projectRoot,
        snapshotSha: fz.snapshot.project.snapshotSha,
        branch: `acp/fusion/${canonId}`,
      }).catch((e) => ({ ok: false, error: { code: e.code ?? 'error', message: e.message } }));
      if (!cp?.ok) return 'canonical_unprepared';
    }
    const prepared = await prepareDependencies(card, run, canonId);
    if (!prepared.ok) return 'dependencies_unprepared';
    let sourceSnapshotSha = fz.snapshot.project.snapshotSha;
    if (fix) {
      const status = await runtime.canonicalStatus(canonId).catch(() => null);
      if (!status?.ok || !/^[0-9a-f]{40}$/.test(status.canonical?.head ?? '')) return 'canonical_unreadable';
      sourceSnapshotSha = status.canonical.head;
    }
    if (prepared.dependencies && prepared.dependencies.snapshotSha !== sourceSnapshotSha) return 'dependencies_unprepared';
    const built = await integratorInputs(card, run, wo, { fix, dependencies: prepared.dependencies, sourceSnapshotSha });
    const spec = fz.integrator;
    const n = (run.attempts || []).filter((a) => a && a.role === 'integrator').length + 1;
    const attemptId = `ia-${run.id.slice(4)}-n${n}`;
    const launch = {
      profileId: spec.profileId,
      profileDigest: spec.profileDigest,
      promptSha256: sha256Hex(built.prompt),
      materialsSha256: sha256Hex(canonicalJson(built.materials)),
      cwd: CONTAINER_PATHS.project,
      artifactsDir: `${CONTAINER_PATHS.attempt}/run-${attemptId}`,
      attemptDir: CONTAINER_PATHS.attempt,
      inputs: built.inputs,
      workerId: `w-${attemptId}`,
      canonicalId: canonId,
      snapshotSha: built.materials.snapshotSha,
      ...(prepared.dependencies ? { dependencies: prepared.dependencies } : {}),
    };
    try {
      await send(card, 'integrate_begin', {
        runId: run.id, attemptId, launch, fix,
        workOrder: { versionId: wo.versionId, sha256: wo.sha256 },
        leaseMs: deps.leaseMs, ...self(),
      }, `ib-${attemptId}-by-${instanceId}`);
    } catch (e) {
      await recordEvent(card, run, 'handoff_launch_blocked', {
        role: 'integrator', attemptId, fix, code: e?.code ?? 'error',
        detail: String(e?.message ?? e).slice(0, 200),
      }, null).catch(() => {});
      return 'launch_refused';
    }
    const fresh = (await refresh(run)).attempts?.find((a) => a && a.id === attemptId);
    return await startRuntime(card, run, fresh ?? { id: attemptId, role: 'integrator' }, {
      ...built, profileId: spec.profileId, profile: spec.profile,
    });
  }

  // ---- acceptance drift ------------------------------------------------------

  // The parked acceptance binds an exact result hash — a new edit to the
  // workspace annuls it and re-enters verification.
  async function driftCheck(card, run) {
    if (run.status !== 'awaiting_acceptance' || !run.acceptance?.resultSha256) {
      return null;
    }
    const wsId = run.workspaceId;
    const ws = card.workspaces?.[wsId];
    if (!ws?.path) return null;
    let manifest;
    try {
      const { computeResultManifest } = await import('../result-snapshot.mjs');
      manifest = await computeResultManifest(ws.path, { baseCommit: run.baseCommit });
    } catch {
      return 'drift_unproven'; // unreadable — never annul on a guess
    }
    if (manifest.resultSha256 === run.acceptance.resultSha256) return 'acceptance_stable';
    await send(card, 'annul_acceptance', {
      runId: run.id, observedSha256: manifest.resultSha256, ...self(),
    }, `ax-${run.id}-${manifest.resultSha256.slice(0, 12)}-by-${instanceId}`);
    return 'acceptance_annulled';
  }

  // ---- drive ------------------------------------------------------------------

  async function drive(card, run0) {
    let run = run0;
    if (!run.fusion || typeof run.fusion !== 'object') return 'not_fusion';
    const phase = run.phase ?? 'panel';
    const fz = run.fusion;

    // Panel phase or document-complete states are not ours.
    const ownPhases = new Set(['judge', 'integrate', 'awaiting_validation', 'awaiting_acceptance']);
    const handoffLive = (r) => (r.attempts || []).filter(
      (a) => a && HANDOFF_ROLES.has(a.role) && LIVE_ATTEMPT.has(a.status));

    // Terminal/blocked runs still get handoff-attempt supervision — a
    // stranded judge/integrator attempt must never be orphaned.
    if (!ownPhases.has(phase) && !handoffLive(run).length
      && run.status !== 'stopping') {
      return 'not_handoff';
    }

    // 1) Supervise every live handoff attempt.
    let acted = null;
    for (let round = 0; round < 6; round += 1) {
      const live = handoffLive(run);
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

    // 2) A failed attempt budget exhausts the phase honestly — never an
    //    automatic extra mint.
    const attemptsOf = (role) => (run.attempts || []).filter((a) => a && a.role === role);
    const lastOf = (role) => attemptsOf(role)[attemptsOf(role).length - 1] ?? null;
    const liveNow = handoffLive(run);
    if (run.status === 'stopping') {
      if (liveNow.length) return 'stopping';
      await send(card, 'complete_run', {
        runId: run.id, status: run.priorTerminal ?? 'cancelled',
        reason: 'stopped by user', ...self(),
      }, `cr-${run.id}-stop-by-${instanceId}`);
      return 'stopped';
    }
    if (!RUN_NONTERMINAL.has(run.status)) return acted ?? 'terminal_drained';
    if (run.status === 'blocked' || run.status === 'awaiting_acceptance') {
      if (run.status === 'awaiting_acceptance') {
        const d = await driftCheck(card, run);
        if (d) return d;
      }
      return acted ?? 'parked';
    }

    // 3) Post-resolve integrate step: a completed integrator attempt whose
    //    import is not yet recorded.
    const integ = lastOf('integrator');
    const importDone = fz.integrate?.import?.attemptId === integ?.id;
    if (integ && integ.status === 'completed' && !liveNow.length && !importDone
      && (run.phase === 'integrate' || run.phase === 'awaiting_validation')) {
      const r = await importAndMaterialize(card, run, integ);
      if (r === 'integrate_recorded') return r;
      if (r !== 'workspace_unresolved' && r !== 'workspace_foreign'
        && r !== 'workspace_foreign_run' && r !== 'workspace_conflict'
        && r !== 'dependencies_unprepared') {
        // The import is unrecoverable in this tick — a failed fix attempt
        // terminalizes; the initial integrate may retry via budget.
        if (integ.fix !== undefined && integ.fix !== null) {
          await send(card, 'complete_run', {
            runId: run.id, status: 'failed',
            reason: `fix import failed: ${r}`, ...self(),
          }, `cr-${run.id}-fiximport-by-${instanceId}`).catch(() => {});
          return 'fix_import_failed';
        }
        return `integrate_${r}`;
      }
      return r;
    }

    // 4) Fix attempt: gate wrote fixContext — the integrator re-enters
    //    from the canonical state.
    if (run.phase === 'awaiting_validation' && run.fixContext
      && fz.resultKind === 'implementation') {
      const round = run.fixContext.round;
      if ((fz.fixAttempts || []).includes(round)) {
        // The round's fix attempt exists but is terminal-failed — the run
        // terminalizes honestly (no silent re-mint of a consumed context).
        const fx = attemptsOf('integrator').find((a) => a.fix === round);
        if (fx && !LIVE_ATTEMPT.has(fx.status) && fx.status !== 'completed') {
          await send(card, 'complete_run', {
            runId: run.id, status: 'failed',
            reason: `fix attempt for round ${round} ended ${fx.status}`, ...self(),
          }, `cr-${run.id}-fixfail-by-${instanceId}`).catch(() => {});
          return 'fix_failed';
        }
        return 'fix_inflight';
      }
      if (!canLaunch()) return 'launch_held';
      return await beginIntegrator(card, run, { fix: true });
    }

    // 5) Judge issuance — only inside phase 'judge'.
    if (run.phase === 'judge') {
      const j = lastOf('judge');
      const jDone = j && j.status === 'completed';
      if (!jDone && !liveNow.length) {
        const used = attemptsOf('judge').length;
        const limit = fz.limits?.judgeAttempts ?? 2;
        if (used >= limit) {
          await send(card, 'complete_run', {
            runId: run.id, status: 'failed',
            reason: `judge used ${used}/${limit} attempts without a valid work order`,
            ...self(),
          }, `cr-${run.id}-judge-exhausted-by-${instanceId}`).catch(() => {});
          return 'judge_exhausted';
        }
        if (j && j.status !== 'completed') {
          // Previous judge attempt terminal-failed — the budget allows
          // exactly one more mint per tick.
        }
        if (!fz.owner || !owns(fz.owner)) return 'foreign_panel';
        if (!canLaunch()) return 'launch_held';
        return await beginJudge(card, run);
      }
      return acted ?? 'judge_waiting';
    }

    // 6) Integrator issuance — phase 'integrate' with a routed work order.
    if (run.phase === 'integrate') {
      const i = lastOf('integrator');
      const iDone = i && i.status === 'completed';
      if (!iDone && !liveNow.length) {
        const used = attemptsOf('integrator').filter((a) => a.fix === undefined || a.fix === null).length;
        const limit = fz.limits?.integratorAttempts ?? 2;
        if (used >= limit) {
          await send(card, 'complete_run', {
            runId: run.id, status: 'failed',
            reason: `integrator used ${used}/${limit} attempts without a valid report`,
            ...self(),
          }, `cr-${run.id}-integrator-exhausted-by-${instanceId}`).catch(() => {});
          return 'integrator_exhausted';
        }
        if (!fz.owner || !owns(fz.owner)) return 'foreign_panel';
        if (!canLaunch()) return 'launch_held';
        return await beginIntegrator(card, run, { fix: false });
      }
      return acted ?? 'integrate_waiting';
    }

    return acted ?? 'handoff_idle';
  }

  return { drive, _inflight: inflight };
}
