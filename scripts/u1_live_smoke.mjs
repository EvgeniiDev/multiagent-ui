// scripts/u1_live_smoke.mjs — U1 live verification: real porch runs of one
// CLI profile in an isolated execution root, driven through the runtime
// adapter. No listeners; writes only under --root (default $U1_SMOKE_ROOT).
//
//   node scripts/u1_live_smoke.mjs --agent pi --mode run    [--timeout 420]
//   node scripts/u1_live_smoke.mjs --agent pi --mode cancel [--timeout 180]
//
// run    — short task, full lifecycle: start -> status -> events -> wait ->
//          reconcile. PASS requires terminal 'completed' AND the expected
//          U1-SMOKE-OK marker in the full final result.
// cancel — long task, cancel while running -> wait. PASS only on 'cancelled';
//          a run that reached terminal before the cancel landed is reported
//          as evidence, not a pass.
// All exits run bounded cleanup: any run we started is cancelled and
// waited to terminal before exiting. Only runs matched to THIS attempt's
// selectors are ever touched.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPorchRuntime } from '../server/execution/porch-runtime.mjs';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
const AGENT = arg('agent', '');
const MODE = arg('mode', 'run');
const TIMEOUT = Number(arg('timeout', MODE === 'cancel' ? 180 : 420));
const PORCH = arg('porch', process.env.ACP_PORCH_CLI
  || path.join(os.homedir(), '.pi/agent/skills/pragmatic-orchestration/scripts/porch'));
const ROOT = arg('root', process.env.U1_SMOKE_ROOT
  || path.join(os.tmpdir(), `u1-smoke-${process.pid}`));
const MARKER = `U1-SMOKE-OK-${AGENT.toUpperCase()}`;

if (!AGENT) {
  console.error('usage: u1_live_smoke.mjs --agent <porch-profile-id> [--mode run|cancel] [--timeout SEC] [--root DIR] [--porch PATH]');
  process.exit(2);
}

const emit = (kind, obj = {}) =>
  console.log('SMOKE ' + JSON.stringify({ kind, agent: AGENT, mode: MODE, ...obj }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Explicit profile snapshot from the *installed* porch config — the runtime
// requires one; we take the profile verbatim rather than inventing models.
// scripts/porch -> skill root is one level up.
const skillRoot = path.resolve(path.dirname(PORCH), '..');
const installedCfg = JSON.parse(await fs.readFile(path.join(skillRoot, 'config.json'), 'utf8'));
const profile = installedCfg.agents?.[AGENT];
if (!profile) {
  emit('FAIL', { msg: `profile '${AGENT}' not in installed porch config`, skillRoot });
  process.exit(1);
}
const snapshotConfig = { agents: { [AGENT]: { ...profile, enabled: true } } };
emit('profile', { backend: profile.backend, model: profile.model,
  effort: profile.effort ?? null, porch: PORCH });

const rt = createPorchRuntime({ rootDir: path.join(ROOT, 'exec'), porchPath: PORCH });
emit('environment', rt.environment());

// Tiny isolated git repo (standalone, not a git worktree — U3 owns real
// worktree lifecycle). Proves cwd handling + git presence for commit-capable
// agents.
const ws = path.join(ROOT, 'ws', AGENT);
await fs.mkdir(ws, { recursive: true });
try {
  execFileSync('git', ['init', '-q', '-b', 'u1-smoke'], { cwd: ws });
  await fs.writeFile(path.join(ws, 'README.md'), `# u1 smoke repo (${AGENT})\n`);
  execFileSync('git', ['-c', 'user.email=u1@smoke', '-c', 'user.name=u1-smoke',
    'add', 'README.md'], { cwd: ws });
  execFileSync('git', ['-c', 'user.email=u1@smoke', '-c', 'user.name=u1-smoke',
    'commit', '-qm', 'init'], { cwd: ws });
  emit('repo', { ws, git: true });
} catch (e) {
  emit('repo', { ws, git: false, error: String(e.message || e) });
}

const PROMPTS = {
  run: `Reply with exactly this marker and nothing else: ${MARKER}.
Do not create, modify, or delete any files. Do not run tests. Just answer.`,
  // Cheap-but-slow task: one shell call keeps the turn alive long enough
  // for cancel to land, without burning hundreds of tool-call steps.
  cancel: `Use your shell/terminal tool to run exactly this command and wait for it:
sleep 120 && echo done
Then reply DONE. Do nothing else — no other tools, no file changes.`,
};

let runId = null;
let terminalConfirmed = false;
let launch = null;

async function cleanup() {
  // Bounded cleanup of OUR run only. Never scan or signal anything else.
  if (!runId || terminalConfirmed) return;
  try {
    emit('cleanup_cancel', await rt.cancel(runId));
  } catch (e) {
    emit('cleanup_cancel_error', { error: String(e.message || e) });
  }
  try {
    const w = await rt.wait(runId, { timeoutSec: 45 });
    emit('cleanup_wait', { outcome: w.outcome, status: w.status });
  } catch (e) {
    emit('cleanup_wait_error', { error: String(e.message || e) });
  }
}

async function main() {
  launch = await rt.start({
    attemptId: `smoke-${AGENT}-${MODE}-${Date.now()}`,
    profileId: AGENT,
    cwd: ws,
    prompt: PROMPTS[MODE],
    config: snapshotConfig,
  });
  emit('launch', launch);
  if (launch.phase !== 'launched' || !launch.porchRunId) {
    if (launch.phase === 'launch_uncertain') {
      // Reconcile strictly with THIS attempt's unique selectors.
      const rec = await rt.reconcile({ cwd: ws, artifactsDir: launch.artifactsDir });
      emit('launch_uncertain_reconcile', {
        matches: rec.matches?.map((m) => ({ runId: m.runId, status: m.status })),
        listed: rec.listed });
      for (const m of rec.matches || []) {
        runId = m.runId; // cleanup() cancels only these matched runs
        await cleanup();
        terminalConfirmed = true;
        runId = null;
      }
    }
    emit('FAIL', { msg: 'launch did not produce a run id',
      phase: launch.phase, error: launch.error });
    return 1;
  }
  runId = launch.porchRunId;
  const deadline = Date.now() + TIMEOUT * 1000;

  let cursor = 0;
  let eventCount = 0;
  let lastStatus = null;
  let cancelIssued = false;
  while (Date.now() < deadline) {
    const st = await rt.status(runId);
    if (st.ok) lastStatus = st;
    const ev = await rt.events(runId, { cursor });
    if (ev.ok) { cursor = ev.nextCursor; eventCount += ev.events.length; }
    if (st.ok && st.terminal) { terminalConfirmed = true; break; }
    if (MODE === 'cancel' && st.ok && st.status === 'running' && !cancelIssued) {
      await sleep(8000); // let the agent get inside its turn
      const c = await rt.cancel(runId);
      emit('cancel', c);
      cancelIssued = true;
    }
    await sleep(3000);
  }
  emit('observed', { status: lastStatus?.status, events: eventCount, cursor,
    timedOut: !terminalConfirmed && MODE === 'run' ? Date.now() >= deadline : undefined });

  const w = await rt.wait(runId, { timeoutSec: 60 });
  emit('wait', { outcome: w.outcome, status: w.status, exitCode: w.exitCode,
    error: w.error, finalAvailable: w.finalAvailable,
    markerFound: (w.finalText || '').includes(MARKER),
    finalTextTail: (w.finalText || '').slice(-400), durationS: w.durationS,
    artifactsDir: w.artifactsDir });
  if (w.outcome === 'terminal') terminalConfirmed = true;

  const rec = await rt.reconcile({ cwd: ws, artifactsDir: launch.artifactsDir });
  emit('reconcile', { matches: rec.matches?.map((m) => ({
    runId: m.runId, status: m.status, effectiveStatus: m.effectiveStatus })) });

  const artifactFiles = [];
  try {
    for (const f of await fs.readdir(launch.artifactsDir)) artifactFiles.push(f);
  } catch { /* missing artifacts dir */ }
  emit('artifacts', { dir: launch.artifactsDir, entries: artifactFiles });

  if (MODE === 'run') {
    const ok = w.outcome === 'terminal' && w.status === 'completed'
      && w.finalAvailable && (w.finalText || '').includes(MARKER);
    emit(ok ? 'PASS' : 'FAIL', { runId, status: w.status,
      markerFound: (w.finalText || '').includes(MARKER), error: w.error });
    return ok ? 0 : 1;
  }
  const ok = w.outcome === 'terminal' && w.status === 'cancelled';
  emit(ok ? 'PASS' : 'FAIL', { runId, status: w.status, error: w.error,
    note: !ok && w.status === 'completed' ? 'finished before cancel landed' : undefined });
  return ok ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  emit('error', { error: String(e?.stack || e) });
} finally {
  await cleanup();
}
process.exit(code);
