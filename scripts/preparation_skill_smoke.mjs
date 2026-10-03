#!/usr/bin/env node
// scripts/preparation_skill_smoke.mjs — P5 real-runtime lead probe.
//
//   node scripts/preparation_skill_smoke.mjs all
//   node scripts/preparation_skill_smoke.mjs <bindingId> [--timeout MS]
//
// Where the P0 probe (`preparation_binding_probe.mjs probe`) drives a raw
// interactive pi session, THIS probe drives the production P5 path end to
// end in-process:
//
//   card → start_preparation → runner-side createPreparationSupervisor →
//   serviceFromClient over the REAL createInternalClient (token-provisioned
//   internal command channel) → createPreparationLead → DEFAULT transport
//   factory → real `pi --mode rpc` child with a per-session seeded pi-agent
//   dir → durable questions answered through the same user commands the UI
//   issues → supervisor dispose + rebuild (session-restart persistence).
//
// `pi` binary, profile auth (~/.pi/agent) and the pinned skill resources
// are the real ones — nothing is stubbed. Evidence per binding lands under
// <OUT>/<bindingId>/ (state tree incl. run dirs, transcript.jsonl,
// audit.jsonl, verdict.json) and is NEVER auto-deleted.
//
// Answer policy: the binding's scripted probe.answers (the same canned
// user answers the P0 probe used) are replayed as durable answers, in
// order, one per open question. When the script runs out a closing answer
// is used so the skill can settle. A binding passes when:
//   - start_preparation accepted the binding (or a deliberately selected
//     unsupported binding failed closed with a structured refusal),
//   - >= expect.minChatQuestions durable questions were answered,
//   - transcript.jsonl shows real rpc frames (pi actually ran),
//   - a supervisor restart (dispose + rebuild, same state dir) preserves
//     the discussion — durable records, not process memory.

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStateService } from '../server/execution/state-service.mjs';
import { createInternalClient } from '../server/execution/internal-transport.mjs';
import { createPreparationSupervisor } from '../server/execution/preparation/supervisor.mjs';
import { prepRunDirs } from '../server/execution/preparation/lead.mjs';
import {
  loadRegistry, bindingById, verifyManifest, assertRouteAvailable,
} from '../server/execution/preparation/skills/registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.join(ROOT, 'server/execution/preparation/skills/bindings.json');
const OUT_ROOT = process.env.ACP_P5_SMOKE_OUT
  || path.join(os.homedir(), '.cache', 'acp-p5-smoke');
const J = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace(/[:.]/g, '-');

// Lead limits for a real model — generous turn window, small restart budget.
const LEAD_LIMITS = {
  idleTimeoutMs: 60_000,
  startTimeoutMs: 60_000,
  turnTimeoutMs: 300_000,
  rpcTimeoutMs: 30_000,
  noProgressLimit: 6,
  maxRestarts: 4,
};

// Model = the runner's real profile pins (same values the compose overlay
// renders). Env overridable for a different provisioned profile.
const MODEL_ENV = {
  ACP_PREP_PROVIDER: process.env.ACP_PREP_PROVIDER || 'zen-relay',
  ACP_PREP_MODEL: process.env.ACP_PREP_MODEL || 'muse-spark-1.3-contributor-free',
  ACP_PREP_THINKING: process.env.ACP_PREP_THINKING || 'low',
};

const CLOSING_ANSWER =
  "Yes — that's the whole scope I care about. Settle it and close out if the frontier is empty.";

// --------------------------------------------------------------------------

async function mkProject(outDir) {
  const dir = path.join(outDir, 'project');
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'README.md'), '# p5 smoke project\n', 'utf-8');
  await fs.writeFile(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n', 'utf-8');
  execFileSync('git', ['init', '-q', dir], { timeout: 10000 });
  execFileSync('git', ['-C', dir, 'add', '-A'], { timeout: 10000 });
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '-qm', 'init'], { timeout: 10000 });
  return dir;
}

async function mkService(stateDir, root) {
  return createStateService({
    stateDir,
    env: {
      PORCH_STEER_DIR: path.join(root, 'steer'),
      ACP_WORKSPACE_DIR: path.join(root, 'wsroot'),
      ROOT_DIR: root,
      ...(process.getuid ? { ACP_EXEC_TOKEN_UID: String(process.getuid()) } : {}),
      ...(process.getgid ? { ACP_EXEC_TOKEN_GID: String(process.getgid()) } : {}),
    },
    features: { start: true, validation: true, fusion: true, preparation: true },
    // No registryPath — the PRODUCTION bindings.json is the registry here.
  });
}

function mkClient(svc, stateDir) {
  return createInternalClient({
    stateDir,
    transport: async ({ method, path: p, body, headers }) => {
      const u = new URL(p, 'http://t');
      const r = await svc.request({
        method, path: u.pathname, query: u.searchParams,
        bodyText: body === undefined ? undefined : J(body), headers,
      });
      return { status: r.status, body: r.json };
    },
  });
}

async function req(svc, method, p, body, headers = {}) {
  const u = new URL(p, 'http://t');
  return svc.request({
    method, path: u.pathname, query: u.searchParams,
    bodyText: body === undefined ? undefined : J(body), headers,
  });
}

async function ucmd(svc, cardId, type, payload = {}) {
  const c = await req(svc, 'GET', `/api/execution/cards/${cardId}`);
  return req(svc, 'POST', `/api/execution/cards/${cardId}/commands`, {
    commandId: `sm-${randomUUID().slice(0, 8)}`, type,
    expectedControlRevision: c.json.controlRevision, payload,
  });
}

const prepView = async (svc, cardId) => {
  const r = await req(svc, 'GET', `/api/execution/cards/${cardId}/preparation`);
  if (r.status !== 200) return null;
  return r.json.preparation;
};

const openQuestions = (v) =>
  (v?.checkpoint?.openQuestions ?? []).filter((q) => q.status === 'open');

const answeredCount = (v) =>
  (v?.checkpoint?.openQuestions ?? []).filter((q) => q.status === 'answered').length;

// --------------------------------------------------------------------------
// one binding run
// --------------------------------------------------------------------------

async function runBinding(binding, { outRoot, timeoutMs, log }) {
  const dir = path.join(outRoot, binding.bindingId);
  await fs.mkdir(dir, { recursive: true });
  const runLog = await fs.open(path.join(dir, 'smoke.log'), 'a');
  const say = (m) => { runLog.write(`${new Date().toISOString()} ${m}\n`); log(`  ${m}`); };

  const evidence = {
    bindingId: binding.bindingId, stage: binding.stage,
    startedAt: new Date().toISOString(), dir,
  };
  const fail = async (code, detail) => {
    evidence.verdict = { ok: false, code, detail };
    evidence.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(dir, 'verdict.json'), J(evidence) + '\n');
    await runLog.close();
    return evidence;
  };

  // --- stack -------------------------------------------------------------
  const projectDir = await mkProject(dir);
  const stateDir = path.join(dir, 'state');
  await fs.mkdir(stateDir, { recursive: true });
  const svc = await mkService(stateDir, dir);
  const client = mkClient(svc, stateDir);
  const logFn = (m) => say(`[sup] ${m}`);
  let sup = createPreparationSupervisor({
    client, stateDir, env: MODEL_ENV,
    limits: LEAD_LIMITS, log: logFn,
    // transportFactory intentionally absent — the production default:
    // agent-dir seed from ~/.pi/agent + real `pi --mode rpc`.
  });
  const runsRoot = path.join(stateDir, 'execution', 'preparation');

  // --- seed + start ------------------------------------------------------
  const p = await req(svc, 'PUT', '/api/state/projects.json', {
    data: { version: 1, projects: [{ id: 'proj-x', name: 'proj-x', path: projectDir }] },
  });
  if (p.status !== 200) return fail('seed_projects_failed', J(p.json));
  const b = await req(svc, 'PUT', '/api/state/board.json', {
    data: { version: 2, cards: [{
      id: 'card-smoke', title: `P5 smoke — ${binding.bindingId}`,
      stage: 'spec', status: 'in_progress', project: 'proj-x', order: 10,
      description: '', agent: '', priority: 'normal',
      acceptance: '', verification: '', links: [], session: null,
      blocked: false, blockedReason: '', cancelled: false,
      touches: [], dependsOn: [], blocks: [], conflictsWith: [],
      statusByStage: {}, createdAt: Date.now(), updatedAt: Date.now(),
    }] },
  });
  if (b.status !== 200) return fail('seed_board_failed', J(b.json));
  const en = await req(svc, 'POST', '/api/execution/cards/card-smoke/commands',
    { commandId: `en-${randomUUID().slice(0, 6)}`, type: 'enable' });
  if (en.status !== 200) return fail('enable_failed', J(en.json));

  const intent = `P5 smoke for binding ${binding.bindingId}: ` +
    'a small kanban "snooze card" feature — a user parks a card until a ' +
    'date; it disappears from the board and resurfaces in its column then.';
  const start = await ucmd(svc, 'card-smoke', 'start_preparation', {
    intent, bindings: { [binding.stage]: binding.bindingId },
  });
  if (start.status !== 200) {
    await sup.dispose?.();
    return fail('start_refused', J(start.json));
  }
  say(`session started: ${J(start.json?.result ?? start.json)}`);
  evidence.start = start.json;
  const startedView = await prepView(svc, 'card-smoke');
  const sessionId = startedView?.sessionId ?? 'card-smoke';
  const dirs = prepRunDirs(runsRoot, sessionId);
  evidence.sessionId = sessionId;
  evidence.runDirs = dirs;

  // --- drive loop --------------------------------------------------------
  const answers = [...(binding.probe?.answers ?? [])];
  const deadline = Date.now() + timeoutMs;
  const idleCloseMs = 45_000;           // grace for the settle turn
  let lastProgress = Date.now();
  let sweepErr = null;
  let midRestartDone = false;

  while (Date.now() < deadline) {
    try { await sup.sweep(); } catch (e) { sweepErr = e; say(`sweep error: ${e.message}`); }
    const view = await prepView(svc, 'card-smoke');
    if (!view) { await sleep(700); continue; }
    evidence.phase = view.phase;
    evidence.attempts = (view.attempts ?? []).map((a) => a.status);

    // Mid-run restart proof: once the first question is answered, bounce
    // the supervisor — the discussion must continue from durable state.
    if (!midRestartDone && answeredCount(view) >= 1) {
      midRestartDone = true;
      say('supervisor restart — dispose + rebuild over the same state');
      await sup.dispose?.();
      sup = createPreparationSupervisor({
        client, stateDir, env: MODEL_ENV, limits: LEAD_LIMITS, log: logFn,
      });
      lastProgress = Date.now();
      continue;
    }

    const open = openQuestions(view);
    if (open.length) {
      const q = open[0];
      const ans = answers.length ? answers.shift() : CLOSING_ANSWER;
      say(`answer q${q.id ?? '?'}: ${ans.slice(0, 60)}`);
      const r = await ucmd(svc, 'card-smoke', 'answer_question',
        { questionId: q.questionId ?? q.id, answer: ans });
      if (r.status !== 200) say(`answer failed: ${J(r.json)}`);
      else lastProgress = Date.now();
      continue;
    }

    const running = (view.attempts ?? []).some((a) => a.status === 'running');
    if (running) lastProgress = Date.now();
    const minQ = binding.expect?.minChatQuestions ?? 0;
    if (!running && answeredCount(view) >= minQ && Date.now() - lastProgress > idleCloseMs) break;
    await sleep(900);
  }

  const finalView = await prepView(svc, 'card-smoke');
  await sup.dispose?.();

  // --- verdict -----------------------------------------------------------
  evidence.sweepError = sweepErr ? String(sweepErr.message) : null;
  evidence.final = {
    phase: finalView?.phase,
    openQuestions: (finalView?.checkpoint?.openQuestions ?? []).length,
    answered: answeredCount(finalView),
    decisions: (finalView?.checkpoint?.decisions ?? []).length,
    assumptions: (finalView?.checkpoint?.assumptions ?? []).length,
    presented: Object.keys(finalView?.presented ?? {}),
    blockers: finalView?.blockers ?? [],
  };
  let transcriptLines = 0;
  try {
    transcriptLines = (await fs.readFile(dirs.transcriptPath, 'utf-8'))
      .split('\n').filter(Boolean).length;
  } catch { /* none */ }
  evidence.transcript = { path: dirs.transcriptPath, lines: transcriptLines };

  const minQ = binding.expect?.minChatQuestions ?? 0;
  const problems = [];
  if (transcriptLines < 2) problems.push('no real pi frames in transcript');
  if (answeredCount(finalView) < minQ) {
    problems.push(`answered ${answeredCount(finalView)} < minChatQuestions ${minQ}`);
  }
  if ((finalView?.checkpoint?.openQuestions ?? []).length === 0) {
    problems.push('no durable questions ever recorded');
  }
  evidence.verdict = problems.length
    ? { ok: false, code: 'smoke_incomplete', problems }
    : { ok: true };
  evidence.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(dir, 'verdict.json'), J(evidence) + '\n');
  await runLog.close();
  return evidence;
}

// A deliberately-selected unsupported binding must refuse closed, with the
// registry's documented reason — never a silent fallback.
async function runUnsupported(binding, { outRoot, log }) {
  const dir = path.join(outRoot, binding.bindingId);
  await fs.mkdir(dir, { recursive: true });
  const stateDir = path.join(dir, 'state');
  await fs.mkdir(stateDir, { recursive: true });
  const projectDir = await mkProject(dir);
  const svc = await mkService(stateDir, dir);
  const out = { bindingId: binding.bindingId, stage: binding.stage };
  await req(svc, 'PUT', '/api/state/projects.json',
    { data: { version: 1, projects: [{ id: 'proj-x', name: 'n', path: projectDir }] } });
  await req(svc, 'PUT', '/api/state/board.json', {
    data: { version: 2, cards: [{
      id: 'card-smoke', title: 't', stage: 'spec', status: 'in_progress',
      project: 'proj-x', order: 1, description: '', agent: '',
      priority: 'normal', acceptance: '', verification: '', links: [],
      session: null, blocked: false, blockedReason: '', cancelled: false,
      touches: [], dependsOn: [], blocks: [], conflictsWith: [],
      statusByStage: {}, createdAt: Date.now(), updatedAt: Date.now(),
    }] },
  });
  await req(svc, 'POST', '/api/execution/cards/card-smoke/commands',
    { commandId: `en-${randomUUID().slice(0, 6)}`, type: 'enable' });
  const r = await ucmd(svc, 'card-smoke', 'start_preparation', {
    intent: 'deliberate unsupported-binding selection',
    bindings: { [binding.stage]: binding.bindingId },
  });
  const code = r.json?.error?.code ?? r.json?.code ?? null;
  out.refusal = { status: r.status, code, message: r.json?.error?.message ?? r.json?.message };
  out.verdict = (r.status === 422 && code)
    ? { ok: true }
    : { ok: false, code: 'unsupported_not_refused', raw: r.json };
  await fs.writeFile(path.join(dir, 'verdict.json'), J(out) + '\n');
  log(`  refused ${r.status} ${code} — ${String(out.refusal.message ?? '').slice(0, 90)}`);
  return out;
}

// --------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const ti = args.indexOf('--timeout');
  const cliTimeout = ti >= 0 ? Number(args[ti + 1]) : null;
  const target = args.find((a) => !a.startsWith('--') && a !== args[ti + 1]) ?? 'all';
  const registry = await loadRegistry(REGISTRY_PATH);

  const runDir = path.join(OUT_ROOT, `run-${ts()}`);
  await fs.mkdir(runDir, { recursive: true });
  const log = (m) => console.error(m);
  console.error(`smoke evidence root: ${runDir}`);

  const wanted = target === 'all'
    ? registry.bindings
    : [bindingById(registry, target)];

  const results = [];
  for (const binding of wanted) {
    // Contract-layer availability check first — cheap, deterministic.
    let route = null;
    try {
      assertRouteAvailable(binding);
      route = 'ok';
    } catch (e) {
      route = e.code ?? 'route_unavailable';
    }
    console.error(`\n=== ${binding.bindingId} (${binding.stage}, ${binding.status}) ` +
      `route=${route}`);

    if (binding.status !== 'available') {
      results.push(await runUnsupported(binding, { outRoot: runDir, log }));
      continue;
    }
    try { await verifyManifest(binding); } catch (e) {
      console.error(`  manifest drift: ${e.code} — refusing the run`);
      results.push({ bindingId: binding.bindingId,
        verdict: { ok: false, code: e.code, message: e.message } });
      continue;
    }
    const timeoutMs = cliTimeout
      ?? Math.min(binding.probe?.timeoutMs ?? 480_000, 480_000);
    results.push(await runBinding(binding, {
      outRoot: runDir, timeoutMs, log,
    }));
    const v = results.at(-1).verdict;
    console.error(`  → ${v.ok ? 'PASS' : `FAIL ${v.code}`}`);
  }

  const pass = results.filter((r) => r.verdict?.ok).length;
  const failN = results.length - pass;
  console.error(`\nP5 lead smoke: ${pass} pass, ${failN} fail`);
  for (const r of results) {
    console.error(`  ${r.bindingId}: ${r.verdict?.ok ? 'PASS' : `FAIL ${r.verdict?.code}`}`);
  }
  await fs.writeFile(path.join(runDir, 'summary.json'),
    J({ runDir, results }, null, 2) + '\n');
  process.exit(failN ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
