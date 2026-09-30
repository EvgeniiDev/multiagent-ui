// scripts/u1_restart_smoke.mjs — restart-proof observation gate for U1.
// Proves a porch run survives the launcher Node process exiting: a first
// `node` subprocess launches and EXITS; a second, fresh `node` subprocess
// (same container/uid/persistent root) rebuilds the runtime from the
// attempt's persisted identity, rediscovers the exact run via reconcile(),
// observes events, cancels it, and waits to terminal.
//
// Subcommands (run inside ONE compose one-off so pid-ns/uid match):
//   node u1_restart_smoke.mjs launch  --agent pi --root DIR
//   node u1_restart_smoke.mjs observe --agent pi --root DIR

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPorchRuntime } from '../server/execution/porch-runtime.mjs';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
const SUB = process.argv[2];
const AGENT = arg('agent', 'pi');
const PORCH = arg('porch', process.env.ACP_PORCH_CLI
  || path.join(os.homedir(), '.pi/agent/skills/pragmatic-orchestration/scripts/porch'));
const ROOT = arg('root', process.env.U1_SMOKE_ROOT || path.join(os.tmpdir(), 'u1-restart'));

const emit = (kind, obj = {}) =>
  console.log('RESTART ' + JSON.stringify({ sub: SUB, kind, agent: AGENT, ...obj }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const skillRoot = path.resolve(path.dirname(PORCH), '..');
const installedCfg = JSON.parse(await fs.readFile(path.join(skillRoot, 'config.json'), 'utf8'));
const profile = installedCfg.agents?.[AGENT];
if (!profile) { emit('FAIL', { msg: 'profile missing', skillRoot }); process.exit(1); }

const rt = createPorchRuntime({ rootDir: path.join(ROOT, 'exec'), porchPath: PORCH });
const ws = path.join(ROOT, 'ws', AGENT);
const infoFile = path.join(ROOT, `restart-${AGENT}.json`);

if (SUB === 'launch') {
  await fs.mkdir(ws, { recursive: true });
  try {
    execFileSync('git', ['init', '-q', '-b', 'u1-restart'], { cwd: ws });
    await fs.writeFile(path.join(ws, 'README.md'), '# u1 restart repo\n');
    execFileSync('git', ['-c', 'user.email=u1@smoke', '-c', 'user.name=u1-smoke',
      'add', 'README.md'], { cwd: ws });
    execFileSync('git', ['-c', 'user.email=u1@smoke', '-c', 'user.name=u1-smoke',
      'commit', '-qm', 'init'], { cwd: ws });
  } catch (e) { emit('repo', { git: false, error: String(e.message || e) }); }

  const launch = await rt.start({
    attemptId: `restart-${AGENT}-${Date.now()}`,
    profileId: AGENT,
    cwd: ws,
    prompt: `Use your shell/terminal tool to run exactly this command and wait for it:
sleep 120 && echo done
Then reply DONE. Do nothing else — no other tools, no file changes.`,
    config: { agents: { [AGENT]: { ...profile, enabled: true } } },
  });
  emit('launch', launch);
  if (launch.phase !== 'launched' || !launch.porchRunId) {
    emit('FAIL', { msg: 'no run id', phase: launch.phase, error: launch.error });
    process.exit(1);
  }
  // Persist ONLY what a fresh observer may rely on: attempt identity on disk.
  await fs.writeFile(infoFile, JSON.stringify({
    attemptId: launch.attemptId, cwd: ws, artifactsDir: launch.artifactsDir,
    porchRunId: launch.porchRunId, launcherPid: process.pid,
    launcherEnv: launch.environment,
  }));
  emit('launcher_exiting', { pid: process.pid, runId: launch.porchRunId });
  process.exit(0); // launcher dies here; detached porch supervisor must live on
}

if (SUB === 'observe') {
  const info = JSON.parse(await fs.readFile(infoFile, 'utf8'));
  let terminalConfirmed = false;
  // Inner function: early `return` still runs the finally cleanup below
  // (process.exit inside try would bypass it).
  const observeRun = async () => {
    const envNow = rt.environment();
    const sameNs = envNow.pidNs === info.launcherEnv?.pidNs
      && envNow.uid === info.launcherEnv?.uid;
    emit('observer_env', { env: envNow, launcherPid: info.launcherPid,
      observerPid: process.pid, samePidNs: sameNs });
    if (process.pid === info.launcherPid) {
      emit('FAIL', { msg: 'observer is the same process — no restart proof' });
      return 1;
    }
    // Rediscover strictly by this attempt's unique selectors — runId was
    // not handed over in-process, it must come from persistent state.
    const rec = await rt.reconcile({ cwd: info.cwd, artifactsDir: info.artifactsDir });
    emit('reconcile', { matches: rec.matches?.map((m) => ({
      runId: m.runId, status: m.status, effectiveStatus: m.effectiveStatus })) });
    const mine = (rec.matches || []).find((m) => m.runId === info.porchRunId);
    if (!mine) { emit('FAIL', { msg: 'reconcile did not find our run' }); return 1; }

    const st = await rt.status(info.porchRunId);
    emit('status', st);
    const ev = await rt.events(info.porchRunId, { cursor: 0 });
    emit('events', { ok: ev.ok, count: ev.events?.length, nextCursor: ev.nextCursor });

    let cancelRequested = false;
    let w;
    if (st.ok && st.terminal) {
      // Already terminal before the fresh observer could act — a
      // terminal-history datapoint, NOT a restart-recovery pass.
      emit('terminal_history', { status: st.status });
      terminalConfirmed = true;
    } else {
      const c = await rt.cancel(info.porchRunId);
      emit('cancel', c);
      cancelRequested = c.ok && c.requested === true;
      w = await rt.wait(info.porchRunId, { timeoutSec: 120 });
      emit('wait', { outcome: w.outcome, status: w.status, exitCode: w.exitCode,
        durationS: w.durationS });
      if (w.outcome === 'terminal') terminalConfirmed = true;
    }
    // PASS requires the full intended evidence chain: distinct processes in
    // the SAME pid namespace + uid, our exact run LIVE at observe time,
    // cancel explicitly requested, then confirmed terminal 'cancelled'.
    const ok = sameNs
      && st.ok && !st.terminal
      && cancelRequested
      && w?.outcome === 'terminal' && w.status === 'cancelled';
    emit(ok ? 'PASS' : 'FAIL', { runId: info.porchRunId, status: w?.status ?? st.status,
      samePidNs: sameNs, wasLive: st.ok && !st.terminal, cancelRequested });
    return ok ? 0 : 1;
  };

  let code = 1;
  try {
    code = await observeRun();
  } catch (e) {
    emit('error', { error: String(e?.stack || e) });
  } finally {
    // Bounded cleanup of OUR run only — never leave it running on exit.
    if (!terminalConfirmed && info.porchRunId) {
      try { emit('cleanup_cancel', await rt.cancel(info.porchRunId)); }
      catch (e) { emit('cleanup_cancel_error', { error: String(e.message || e) }); }
      try {
        const w = await rt.wait(info.porchRunId, { timeoutSec: 45 });
        emit('cleanup_wait', { outcome: w.outcome, status: w.status });
      } catch (e) { emit('cleanup_wait_error', { error: String(e.message || e) }); }
    }
  }
  process.exit(code);
}

console.error('usage: u1_restart_smoke.mjs launch|observe --agent ID --root DIR');
process.exit(2);
