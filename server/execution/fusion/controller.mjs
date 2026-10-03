// server/execution/fusion/controller.mjs — F2 panel driver (scheduler-side).
//
// One createPanelDriver per scheduler process; the managed scheduler calls
// drive(card, run) for every live fusion run. The driver is a state
// machine over the DURABLE record only — every mutation lands through
// `send` (the authenticated internal channel) before any runtime effect,
// so the durable-write→launch window is always recoverable:
//
//   claim   — panel_claim mints the run-level execution owner;
//   gate    — search capability check over the FULL effective profile
//             digest of every panelist BEFORE the first attempt exists;
//   begin   — panel_begin mints the attempt row (participant → 'launching');
//   start   — runtime.start inside the F1 constrained container runtime;
//   bind    — bind_attempt records the registered run id;
//   observe — wait/status until terminal, then commit the answer artifact
//             and resolve_attempt (a 0-exit without a valid structured
//             answer resolves 'failed' — the CLI exit is never the result);
//   settle  — panel_settle when nothing executable remains (the domain
//             derives the outcome — the driver never claims it);
//   stop    — cancel every live panelist attempt, then complete_run.
//
// The driver never bypasses the constrained runtime — there is NO
// fallback to unconstrained execution.

import {
  ATTEMPT_NONTERMINAL, RUN_NONTERMINAL,
} from '../execution-domain.mjs';
import { sha256, writeStagedArtifact } from '../execution-store.mjs';
import { CONTAINER_PATHS } from '../environment/container-runtime.mjs';
import { canonicalJson } from '../environment/agent-profile.mjs';
import { parsePanelAnswer } from './answer.mjs';
import { buildPanelPrompt, panelMaterials, sha256Hex } from './prompt.mjs';
import { participantAttempts } from './panel-spec.mjs';

const LIVE_ATTEMPT = ATTEMPT_NONTERMINAL;

export function createPanelDriver(deps = {}) {
  const {
    runtime,               // REQUIRED — the F1 constrained container runtime
    capabilityStore = null,
    send,                  // (card, type, payload, idem) => result
    recordEvent,           // (card, run, type, data, attemptId?) => ...
    self,                  // () => owner identity fields
    getRun,                // (runId) => run record | null
    getDocument,           // (cardId, versionId) => {content,...} — task text
    stateDir,              // artifact staging root (writeStagedArtifact)
    canLaunch = () => true, // scheduler resilience gate (outage/quiesce/etc.)
    adoptionProofFor = null, // (owner) => proof|null — foreign-owner adoption
    cardTitle = null,      // (cardId) => title | null — optional prompt context
    launchOrphanMs = 10 * 60 * 1000,
    instanceId = 'fusion-driver',
    now = () => Date.now(),
  } = deps;
  if (!runtime) throw new Error('panel driver requires the F1 constrained runtime');
  if (typeof send !== 'function' || typeof getRun !== 'function') {
    throw new Error('panel driver requires send + getRun');
  }

  // In-flight runtime.start dedup — the durable attempt row plus this map
  // together guarantee an attempt is never launched twice within a tick
  // window (a second drive() for the same run returns early while the
  // start is in flight).
  const inflight = new Map(); // attemptId -> Promise
  // cancel issued this process (the durable marker is attempt.cancel; this
  // flag only dedups the runtime.cancel CALL, which is idempotent anyway).
  const cancelIssued = new Set();
  // Prompt cache — identical for every panelist of a run, computed once.
  const promptCache = new Map(); // `${run.id}` -> {fingerprint, prompt, materials, promptSha256, materialsSha256}

  const refresh = async (run) => (await getRun(run.id)) ?? run;

  // --- identity / ownership ------------------------------------------------

  const owns = (owner) => {
    const s = self();
    return !!owner && owner.runnerId === s.runnerId && owner.instanceId === s.instanceId;
  };

  // Adopt a provably-dead foreign owner so supervision can proceed — same
  // rules as attempts everywhere: no proof, no adoption, no mutation.
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

  // --- prompt + materials (identical for every panelist) ---------------------

  async function promptFor(card, run) {
    const fz = run.fusion;
    const hit = promptCache.get(run.id);
    if (hit && hit.fingerprint === fz.fingerprint) return hit;
    const task = fz.snapshot?.task;
    const doc = await getDocument(card.cardId, task.versionId);
    if (!doc || typeof doc.content !== 'string') {
      throw new Error(`task document ${task.versionId} unreadable — cannot build the panel prompt`);
    }
    if (doc.sha256 && doc.sha256 !== task.sha256) {
      throw new Error(`task document ${task.versionId} no longer verifies against the recorded sha256`);
    }
    const snap = fz.snapshot.project;
    const prompt = buildPanelPrompt({
      cardTitle: typeof cardTitle === 'function' ? cardTitle(card.cardId) : null,
      taskText: doc.content,
      snapshotSha: snap.snapshotSha,
      projectRoot: snap.projectRoot,
      resultKind: fz.resultKind,
      searchEnabled: fz.snapshot?.search?.enabled === true,
    });
    const materials = panelMaterials({
      projectRoot: snap.projectRoot,
      snapshotSha: snap.snapshotSha,
      taskText: doc.content,
    });
    const built = {
      fingerprint: fz.fingerprint,
      prompt,
      materials,
      promptSha256: sha256Hex(prompt),
      materialsSha256: sha256Hex(canonicalJson(materials)),
    };
    promptCache.set(run.id, built);
    return built;
  }

  // --- the search-capability gate (R4) --------------------------------------
  //
  // BEFORE the first attempt exists: every non-excluded panelist's FULL
  // effective profile digest must hold a positive probe. Any digest change
  // — tools, extensions, allowlist, same image/model with different
  // settings — is a different unprobed combination and fails closed.
  async function searchGate(card, run) {
    const fz = run.fusion;
    const wantSearch = fz.snapshot?.search?.enabled === true;
    const active = (fz.participants || []).filter((p) => p.status !== 'excluded');
    if (wantSearch) {
      if (!capabilityStore) {
        return { ok: false, code: 'search_gate_unwired',
          message: 'search-enabled panel but no capability store is configured' };
      }
      for (const p of active) {
        try {
          await capabilityStore.requireSearchAllowed(p.profile, p.profileDigest);
        } catch (e) {
          return {
            ok: false, code: e.code || 'search_unproven',
            participantId: p.id, digest: p.profileDigest,
            message: `panelist ${p.id}: ${e.message}`,
          };
        }
      }
    }
    return { ok: true };
  }

  // --- attempt lifecycle ----------------------------------------------------

  // (Re-)issue the runtime side of a recorded 'launching' attempt — used
  // BOTH for the fresh launch and for the reconcile path where the durable
  // row exists but the launch record proves start never ran (the crash
  // window between panel_begin and runtime.start).
  async function startRuntime(card, run, att, participant, built) {
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
          profileId: participant.profileId,
          profile: participant.profile,
          role: 'panelist',
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
        // Durable runtime evidence of a failed launch — resolve the attempt.
        await send(card, 'resolve_attempt', {
          runId: run.id, attemptId: att.id, outcome: 'failed',
          reason: `panelist launch failed: ${res.error?.code ?? 'error'} — ${String(res.error?.message ?? '').slice(0, 300)}`,
          ...self(),
        }, `rs-${att.id}-launchfail-by-${instanceId}`);
        return 'launch_failed';
      }
      // 'launch_uncertain' / unknown — reconcile next pass; never assume.
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

  // Reconcile a 'launching' attempt — the window where the durable row
  // exists but bind evidence may not.
  async function reconcileLaunch(card, run, att, participant, built) {
    if (inflight.has(att.id)) return 'launch_inflight';
    const rec = await runtime.launchRecord(att.id).catch(() => null);
    if (!rec || rec.corrupt) return 'launch_unreadable';
    if (rec.missing === true) {
      if (att.status === 'cancelling' || att.cancel || run.status === 'stopping') {
        // Cancelled before any runtime evidence — nothing exists to kill;
        // resolving 'cancelled' is the positive terminal state.
        await send(card, 'resolve_attempt', {
          runId: run.id, attemptId: att.id, outcome: 'cancelled',
          reason: att.cancel?.reason ?? 'cancelled before launch',
          ...self(),
        }, `rs-${att.id}-prelaunch-cancel-by-${instanceId}`);
        return 'cancelled';
      }
      // No launch record: the durable attempt never reached runtime.start
      // (or evidence was lost). Re-issue the launch — the attempt budget
      // was already consumed by panel_begin.
      return await startRuntime(card, run, att, participant, built);
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
        reason: `panelist launch failed: ${evidence.error?.code ?? 'error'} — ${String(evidence.error?.message ?? '').slice(0, 300)}`,
        ...self(),
      }, `rs-${att.id}-launchfail-by-${instanceId}`);
      return 'launch_failed';
    }
    // 'launching'/'launch_uncertain'/'prepared': scan the worker's porch
    // registry for a run a completed handshake left behind.
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
    // Positive proof of "nothing can still launch": the worker is gone AND
    // the record is older than the handshake bound — only then is the
    // attempt a launch failure rather than an unresolved handshake.
    const allGone = scan?.ok === true && (scan?.workers || []).every((w) => w.gone === true)
      && (scan?.workers || []).length > 0;
    const recAt = Date.parse(evidence.launch?.startedAt ?? evidence.launchStartedAt ?? evidence.createdAt ?? '') || 0;
    if (allGone && recAt && now() - recAt > launchOrphanMs) {
      await send(card, 'resolve_attempt', {
        runId: run.id, attemptId: att.id, outcome: 'failed',
        reason: 'panelist launch orphaned — worker gone with no registered run',
        ...self(),
      }, `rs-${att.id}-launchorphan-by-${instanceId}`);
      return 'launch_orphaned';
    }
    return 'launch_reconcile'; // unresolved — try again next pass
  }

  // Commit the answer bytes + resolve a terminally-observed panelist.
  async function resolvePanelist(card, run, att, { outcome, reason, wt }) {
    let answer = null;
    let result = null;
    if (outcome === 'completed') {
      const finalText = typeof wt?.finalText === 'string' ? wt.finalText : null;
      const parsed = finalText !== null ? parsePanelAnswer(finalText) : { ok: false, missing: ['<final text unavailable>'] };
      if (!parsed.ok) {
        // exit 0 without the full structured answer is NOT a result.
        outcome = 'failed';
        reason = `answer_invalid: ${[...(parsed.missing || []).map((m) => `missing ${m}`),
          ...(parsed.empty || []).map((m) => `empty ${m}`),
          ...(parsed.duplicate || []).map((m) => `duplicate ${m}`)].join('; ')
          || parsed.reason || 'incomplete'}`;
      } else {
        const name = `answer-${att.id}.md`;
        const staged = await writeStagedArtifact(stateDir, att.id, name, finalText);
        const artifactId = `ans-${att.id}`;
        await send(card, 'commit_artifact', {
          runId: run.id, attemptId: att.id,
          artifact: { id: artifactId, kind: 'answer', file: name, bytes: staged.bytes, sha256: staged.sha256 },
          stagedPath: staged.stagedPath, ...self(),
        }, `ca-${artifactId}-by-${instanceId}`);
        answer = {
          artifactId, sha256: staged.sha256, bytes: staged.bytes,
          sections: parsed.sections,
        };
      }
    }
    if (wt) {
      result = {
        status: wt.status ?? null,
        exitCode: wt.runExitCode ?? wt.exitCode ?? null,
        durationS: wt.durationS ?? null,
        summary: typeof wt.finalText === 'string' ? wt.finalText.slice(0, 1500) : null,
      };
    }
    await send(card, 'resolve_attempt', {
      runId: run.id, attemptId: att.id, outcome,
      ...(answer ? { answer } : {}),
      ...(result ? { result } : {}),
      reason: reason ?? (outcome === 'completed' ? 'panelist answered' : `panelist ${outcome}`),
      ...self(),
    }, `rs-${att.id}-terminal-by-${instanceId}`);
    await recordEvent(card, run, 'panelist_terminal', {
      attemptId: att.id, participantId: att.participantId, outcome,
      reason: (reason ?? '').slice(0, 200) || null,
    }, att.id).catch(() => {});
    return outcome;
  }

  // Observe a bound (running/cancelling) panelist attempt.
  async function observePanelist(card, run, att) {
    const timeoutMin = run.fusion.limits?.timeoutMin ?? 45;
    if (att.status === 'cancelling' || att.cancel || run.status === 'stopping') {
      if (!cancelIssued.has(att.id) && att.porchRunId) {
        const cancelled = await runtime.cancel(att.porchRunId).catch(() => null);
        if (cancelled?.ok === true && cancelled.requested === true) cancelIssued.add(att.id);
      }
      const wt = await runtime.wait(att.porchRunId, { timeoutSec: 0 }).catch(() => null);
      if (wt?.outcome === 'terminal') {
        return await resolvePanelist(card, run, att, {
          outcome: 'cancelled',
          reason: att.cancel?.reason ?? 'cancelled',
          wt,
        });
      }
      return 'cancelling'; // positive terminal observation pending
    }
    const wt = await runtime.wait(att.porchRunId, { timeoutSec: 0 }).catch(() => null);
    if (!wt || wt.outcome === 'error') return 'observe_retry';
    if (wt.outcome === 'timeout' || wt.outcome === 'observer_timeout') {
      // Per-participant timeout — a live attempt past its bound is cancelled
      // through the durable intent path first (same as stop).
      const deadline = (att.startedAt ?? att.createdAt) + timeoutMin * 60 * 1000;
      if (now() > deadline) {
        await send(card, 'cancel_attempt', {
          runId: run.id, attemptId: att.id,
          reason: `panelist exceeded the ${timeoutMin}min timeout`,
          ...self(),
        }, `cx-${att.id}-timeout-by-${instanceId}`);
        return 'timeout_cancel';
      }
      return 'observing';
    }
    // Terminal observation: 'completed' with run/exit code 0 is the only
    // candidate for an answer — everything else is a failed/cancelled
    // participant attempt.
    if (wt.outcome !== 'terminal') return 'observe_retry';
    const code0 = (wt.runExitCode ?? wt.exitCode) === 0;
    const outcome = wt.status === 'cancelled' ? 'cancelled'
      : (wt.status === 'completed' && code0) ? 'completed'
        : 'failed';
    return await resolvePanelist(card, run, att, {
      outcome,
      reason: wt.error ?? (outcome === 'completed' ? null : `supervisor ${wt.status ?? 'terminal'} (exit ${wt.runExitCode ?? wt.exitCode ?? '?'})`),
      wt,
    });
  }

  // One live attempt, one supervision decision. Panel-phase supervision
  // touches PANELIST attempts only — F3 handoff roles (judge/integrator)
  // and U5 roles (reviewer/checker) belong to their own drivers/runtimes.
  async function superviseAttempt(card, run, att) {
    if (att.role !== 'panelist') return 'foreign_role';
    if (!(await ensureOwned(card, run, att))) return 'foreign_attempt';
    // 'launching' OR a cancel that raced the launch (no bound run id yet)
    // both go through the reconcile path — it binds a proven run or proves
    // none exists; it never issues a fresh start for a cancelling attempt.
    if (att.status === 'launching' || (att.status === 'cancelling' && !att.porchRunId)) {
      const p = (run.fusion.participants || []).find((x) => x.id === att.participantId);
      if (!p) return 'participant_missing';
      const built = await promptFor(card, run);
      return await reconcileLaunch(card, run, att, p, built);
    }
    return await observePanelist(card, run, att);
  }

  // --- launches --------------------------------------------------------------

  async function launchPending(card, run, built) {
    const fz = run.fusion;
    const launchable = (fz.participants || []).filter((p) => {
      if (p.status !== 'pending') return false;
      const used = p.attemptsUsed || 0;
      const limit = (fz.limits?.maxAttemptsPerParticipant ?? 2) + (p.extraAttempts || 0);
      return used < limit
        && !participantAttempts(run, p.id).some((a) => LIVE_ATTEMPT.has(a.status));
    });
    if (!launchable.length) return null;
    // Phase 1 — durable rows for every launchable participant (serial
    // sends: the internal queue serializes them anyway).
    const begun = [];
    for (const p of launchable) {
      const n = (p.attemptsUsed || 0) + 1;
      const attemptId = `pa-${run.id.slice(4)}-${p.id}-n${n}`;
      const launch = {
        profileId: p.profileId,
        profileDigest: p.profileDigest,
        promptSha256: built.promptSha256,
        materialsSha256: built.materialsSha256,
        cwd: CONTAINER_PATHS.project,
        artifactsDir: `${CONTAINER_PATHS.attempt}/run-${attemptId}`,
        attemptDir: `${CONTAINER_PATHS.attempt}`,
      };
      try {
        await send(card, 'panel_begin', {
          runId: run.id, participantId: p.id, attemptId,
          launch, leaseMs: deps.leaseMs, ...self(),
        }, `pb-${attemptId}-by-${instanceId}`);
        begun.push({ p, attemptId });
      } catch (e) {
        // One refused participant never blocks the rest — the failure is
        // durable evidence on the attempt/run and retried next pass.
        await recordEvent(card, run, 'panel_launch_blocked', {
          participantId: p.id, attemptId,
          code: e?.code ?? 'error', detail: String(e?.message ?? e).slice(0, 200),
        }, null).catch(() => {});
      }
    }
    if (!begun.length) return 'launch_refused';
    // Phase 2 — the runtime starts land in PARALLEL: the durable rows are
    // already minted, the handshakes race independently.
    const res = await Promise.all(begun.map(async ({ p, attemptId }) => {
      const fresh = participantAttempts(await refresh(run), p.id)
        .find((a) => a.id === attemptId);
      return { attemptId, tag: await startRuntime(card, run, fresh ?? { id: attemptId, participantId: p.id }, p, built) };
    }));
    return res.every((r) => r.tag === 'bound') ? 'launched' : 'launch_partial';
  }

  // --- drive ------------------------------------------------------------------

  async function drive(card, run0) {
    let run = run0;
    if (!run.fusion || typeof run.fusion !== 'object') return 'not_fusion';

    // 1) Supervise every live PANELIST attempt first — observation beats
    //    issuance, and terminal runs keep supervising their stranded
    //    attempts. Handoff roles are invisible here.
    let acted = null;
    for (let round = 0; round < 8; round += 1) {
      const live = (run.attempts || []).filter(
        (a) => a && a.role === 'panelist' && LIVE_ATTEMPT.has(a.status));
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
    if (acted) run = await refresh(run); // downstream decisions see the post-supervision record
    const fz = run.fusion;

    // 2) Stopping: supervision done — issue durable cancel intent for any
    //    surviving attempt (ALL roles — a stop drains the whole run), then
    //    drain to terminal.
    if (run.status === 'stopping') {
      const live = (run.attempts || []).filter((a) => LIVE_ATTEMPT.has(a.status));
      for (const att of live) {
        if (!owns(att.owner)) continue;
        await send(card, 'cancel_attempt', {
          runId: run.id, attemptId: att.id,
          reason: 'stop intent', ...self(),
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
    // The panel driver owns phase 'panel' only — once the settle hands the
    // run to the judge phase the F3 handoff driver takes over.
    if ((run.phase ?? 'panel') !== 'panel') return acted ?? 'panel_done';

    // 3) Run-level execution authority before any new issuance.
    if (!fz.owner) {
      await send(card, 'panel_claim', {
        runId: run.id, leaseMs: deps.leaseMs, ...self(),
      }, `pc-${run.id}-by-${instanceId}`);
      return 'panel_claimed';
    }
    if (!owns(fz.owner)) {
      // A foreign runner owns the panel — we supervise only what we own.
      return 'foreign_panel';
    }

    // 4) Settle check — nothing executable left? The domain derives the
    //    outcome (decision_pending / complete / quorum_failed).
    //    The commandId carries a signature of the durable participant state:
    //    a settle decision is only idempotent against the EXACT state it
    //    judged — a later participant change (retry, exclusion, a newly
    //    resolved answer) mints a fresh command instead of replaying a
    //    stale verdict.
    const parts = fz.participants || [];
    const pendingWork = parts.filter((p) => p.status === 'pending');
    const liveNow = (run.attempts || []).filter(
      (a) => a && a.role === 'panelist' && LIVE_ATTEMPT.has(a.status));
    if (!pendingWork.length && !liveNow.length) {
      if (fz.settledAt) return acted ?? 'settled';
      const sig = sha256Hex(parts.map((p) => `${p.id}:${p.status}:${p.attemptsUsed}`).join('|'));
      await send(card, 'panel_settle', {
        runId: run.id, ...self(),
      }, `ps-${run.id}-${sig.slice(0, 16)}-by-${instanceId}`);
      return 'panel_settled';
    }

    // 5) The search gate — before ANY participant's first attempt. The run-
    //    level "zero attempts" shortcut is not enough: a partial begin
    //    (one panelist minted, another refused) must still leave the
    //    unstarted panelists gated on their own first launch.
    const unstarted = pendingWork.some((p) => !participantAttempts(run, p.id).length);
    if (unstarted) {
      const gate = await searchGate(card, run);
      if (!gate.ok) {
        await recordEvent(card, run, 'panel_launch_blocked', {
          code: gate.code, participantId: gate.participantId ?? null,
          digest: gate.digest ?? null,
          detail: String(gate.message ?? '').slice(0, 300),
        }).catch(() => {});
        await send(card, 'complete_run', {
          runId: run.id, status: 'failed',
          reason: `search capability gate: ${gate.code} — ${String(gate.message ?? '').slice(0, 200)}`,
          ...self(),
        }, `cr-${run.id}-gate-${gate.code}-by-${instanceId}`);
        return 'gate_blocked';
      }
    }

    // 6) New launches only when the scheduler's resilience gates allow.
    if (!canLaunch()) return 'launch_held';
    const built = await promptFor(card, run);
    const tag = await launchPending(card, run, built);
    if (tag) return tag;
    return acted ?? 'idle';
  }

  return { drive, _inflight: inflight };
}
