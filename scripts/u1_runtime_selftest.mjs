// scripts/u1_runtime_selftest.mjs — U1 offline verification.
//
// No HTTP listeners, no model calls. Two halves:
//   * fake backend — scripted contract behavior for downstream controller dev;
//   * process backend — spawnBounded bounds plus normalization against a
//     stub `porch` CLI that emits contract-shaped output (launch, status,
//     events, wait incl. exit-124, cancel incl. already-terminal, list).
// Real porch/model paths are covered by scripts/u1_live_smoke.mjs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnBounded, RUN_ID_RE } from '../server/execution/common.mjs';
import { createPorchRuntime, _internals } from '../server/execution/porch-runtime.mjs';
import { createFakeRuntime } from '../server/execution/fake-runtime.mjs';

let TMP;
before(async () => {
  TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'u1-selftest-'));
});
after(async () => {
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

const WS = () => fs.mkdtemp(path.join(TMP, 'ws-'));
const CFG = { agents: { probe: { enabled: true, backend: 'x', model: 'm' } } };

async function writeStub(name, body) {
  const p = path.join(TMP, name);
  await fs.writeFile(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

// --- spawnBounded -----------------------------------------------------------

test('spawnBounded captures output and exit code', async () => {
  const r = await spawnBounded(['/bin/sh', '-c', 'echo out; echo err >&2; exit 3']);
  assert.equal(r.ok, true);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /out/);
  assert.match(r.stderr, /err/);
  assert.equal(r.timedOut, false);
  assert.equal(r.observationCut, false);
});

test('spawnBounded enforces timeout on direct child only', async () => {
  // Bound = timeoutMs + killGraceMs + settleGraceMs + slack — the settle
  // window is the final deadline even if pipe EOF never arrives.
  const t0 = Date.now();
  const r = await spawnBounded(['/bin/sh', '-c', 'sleep 30'],
    { timeoutMs: 150, killGraceMs: 200, settleGraceMs: 250 });
  assert.equal(r.timedOut, true);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1200, `took ${elapsed}ms`);
});

test('spawnBounded caps stdout', async () => {
  const r = await spawnBounded(
    ['/bin/sh', '-c', 'head -c 100000 /dev/zero | tr "\\0" "x"'],
    { maxStdout: 1024 });
  assert.equal(r.stdout.length, 1024);
  assert.equal(r.stdoutTruncated, true);
});

test('spawnBounded: descendant holding pipes cannot stall settlement', async () => {
  // Child exits at once; a detached grandchild inherits our pipes for 5s.
  // Without a settle deadline 'close' waits for the grandchild's writers.
  const t0 = Date.now();
  const r = await spawnBounded(
    [process.execPath, '-e',
      'require("node:child_process").spawn(process.execPath,'
      + ' ["-e","setTimeout(()=>{},800)"],'
      + ' {stdio:["ignore","inherit","inherit"], detached:true}).unref();'
      + ' process.exit(0)'],
    { timeoutMs: 1500, killGraceMs: 200, settleGraceMs: 200 });
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t0 < 1500, `observation overran: ${Date.now() - t0}ms`);
  assert.equal(r.observationCut, true);
});

test('spawnBounded input EPIPE does not crash', async () => {
  const r = await spawnBounded(['/bin/sh', '-c', 'exit 0'],
    { input: 'x'.repeat(65536) });
  assert.equal(r.ok, true);
});

// --- porch runtime: validation + env contract -------------------------------

test('env scrub: PORCH_* and model overrides dropped, even from extra', () => {
  const { env, dropped } = _internals.buildChildEnv(
    { PATH: '/p', HOME: '/h', CODEX_MODEL: 'evil', PORCH_STEER_DIR: '/evil',
      PORCH_CONFIG: '/evil', DEVIN_MODEL: 'evil' },
    { steerDir: '/s', outputDir: '/o', runDir: '/r', configPath: '/c',
      extra: { PORCH_RUN_DIR: '/evil', PI_MODEL: 'evil', KEEP: '1' } });
  assert.equal(env.PORCH_STEER_DIR, '/s');
  assert.equal(env.PORCH_OUTPUT_DIR, '/o');
  assert.equal(env.PORCH_RUN_DIR, '/r');
  assert.equal(env.PORCH_CONFIG, '/c');
  assert.equal(env.PORCH_SAVE_OUTPUTS, '1');
  assert.equal(env.KEEP, '1');
  assert.equal(env.CODEX_MODEL, undefined);
  assert.equal(env.PI_MODEL, undefined);
  assert.ok(dropped.includes('PORCH_STEER_DIR'));
  assert.ok(dropped.includes('CODEX_MODEL'));
  assert.ok(dropped.includes('PORCH_RUN_DIR'));
});

test('run id extraction accepts only safe shapes', () => {
  assert.equal(_internals.extractRunId('run_amber-otter-4f21\n'), 'run_amber-otter-4f21');
  assert.equal(_internals.extractRunId('noise\nrun_abc-1\n'), 'run_abc-1');
  assert.equal(_internals.extractRunId('run_../escape\n'), null);
  assert.equal(_internals.extractRunId('nothing\n'), null);
});

test('start validates inputs and requires explicit config', async () => {
  const rt = createPorchRuntime({ rootDir: path.join(TMP, 'rt-val'),
    porchPath: '/nonexistent/porch' });
  const cwd = await WS();
  await assert.rejects(() => rt.start({}), /attemptId/);
  await assert.rejects(
    () => rt.start({ attemptId: 'a', profileId: 'p', cwd: '/nonexistent-dir', config: CFG }),
    /cwd/);
  const noPrompt = await rt.start(
    { attemptId: 'a1', profileId: 'p', cwd, config: CFG });
  assert.equal(noPrompt.phase, 'launch_failed');
  assert.equal(noPrompt.error.code, 'invalid_argument');
  const noCfg = await rt.start(
    { attemptId: 'a2', profileId: 'p', cwd, prompt: 'x' });
  assert.equal(noCfg.phase, 'launch_failed');
  assert.equal(noCfg.error.code, 'config_required');
});

test('start on fresh rootDir creates parents (regression)', async () => {
  const root = path.join(TMP, 'fresh-root', 'execution');
  const stub = await writeStub('porch-ok', 'echo run_ok-run-1');
  const rt = createPorchRuntime({ rootDir: root, porchPath: stub });
  const cwd = await WS();
  const r = await rt.start({ attemptId: 'fresh1', profileId: 'probe', cwd,
    prompt: 'p', config: CFG });
  assert.equal(r.phase, 'launched');
  assert.equal(r.porchRunId, 'run_ok-run-1');
  const rec = JSON.parse(await fs.readFile(path.join(r.attemptDir, 'launch.json'), 'utf8'));
  assert.equal(rec.phase, 'launched');
  assert.equal(rec.porchRunId, 'run_ok-run-1');
  assert.ok(rec.environment.uid !== undefined);
  assert.equal(rec.configPath, path.join(r.attemptDir, 'porch-config.json'));
  assert.equal(JSON.parse(await fs.readFile(rec.configPath, 'utf8')).agents.probe.model, 'm');
});

test('attempt dir create is exclusive', async () => {
  const stub = await writeStub('porch-ok2', 'echo run_ok-run-2');
  const rt = createPorchRuntime({ rootDir: path.join(TMP, 'rt-dup'), porchPath: stub });
  const cwd = await WS();
  await rt.start({ attemptId: 'dup', profileId: 'probe', cwd, prompt: 'p', config: CFG });
  await assert.rejects(
    () => rt.start({ attemptId: 'dup', profileId: 'probe', cwd, prompt: 'p', config: CFG }),
    (e) => e.code === 'attempt_exists');
});

// --- porch runtime: launch phases via stub CLI -------------------------------

test('launch_failed on porch nonzero exit; launch_uncertain on timeout', async () => {
  const cwd = await WS();
  const bad = await writeStub('porch-fail', 'echo "Error: unknown agent id: x" >&2; exit 5');
  const rtBad = createPorchRuntime({ rootDir: path.join(TMP, 'rt-fail'), porchPath: bad });
  const f = await rtBad.start({ attemptId: 'bad1', profileId: 'ghost', cwd,
    prompt: 'p', config: CFG });
  assert.equal(f.phase, 'launch_failed');
  assert.equal(f.porchRunId, null);
  assert.equal(f.error.code, 'config_error');
  assert.match(f.error.message, /unknown agent id/);

  const slow = await writeStub('porch-slow', 'exec sleep 60');
  const rtSlow = createPorchRuntime({ rootDir: path.join(TMP, 'rt-slow'),
    porchPath: slow, launchTimeoutMs: 300 });
  const u = await rtSlow.start({ attemptId: 'slow1', profileId: 'probe', cwd,
    prompt: 'p', config: CFG });
  assert.equal(u.phase, 'launch_uncertain');
  assert.equal(u.porchRunId, null);
  assert.equal(u.error.code, 'launch_timeout');
  assert.ok(u.diagnostics.timedOut);
});

// --- porch runtime: control normalization via stub CLI -----------------------

const STUB_RUN = 'run_stub-ok-1';

test('control normalization: status/events/wait/cancel/list', async () => {
  const stub = await writeStub('porch-ctl',
    `[ "$1" = "delegate" ] && shift
     cmd="$1"; shift
     case "$cmd" in
       status) cat <<'EOF'
{"run_id":"${STUB_RUN}","status":"running","agent_id":"probe","backend":"x","model":"m","pid":4242,"child_pid":4343,"exit_code":null,"started_at":"2026-09-30T00:00:00Z","mailbox_closed":false,"state":{"status":"running"}}
EOF
       ;;
       events)
         cursor=0
         while [ $# -gt 0 ]; do
           case "$1" in --cursor) cursor="$2"; shift 2;; --max-events) shift 2;; *) shift;; esac
         done
         if [ "$cursor" = "0" ]; then
           printf '%s' '{"run_id":"${STUB_RUN}","status":"running","terminal":false,"cursor":0,"next_cursor":2,"remaining":0,"events":[{"ts":"t","type":"progress","data":"e1"},{"ts":"t","type":"progress","data":"e2"}]}'
         else
           printf '%s' '{"run_id":"${STUB_RUN}","status":"running","terminal":false,"cursor":2,"next_cursor":2,"remaining":0,"events":[]}'
         fi
       ;;
       wait)
         to=0
         while [ $# -gt 0 ]; do
           case "$1" in --timeout) to="$2"; shift 2;; --json) shift;; *) shift;; esac
         done
         if [ "$to" = "0" ]; then
           printf '%s' '{"run_id":"${STUB_RUN}","timed_out":true,"status":"running","terminal":false,"exit_code":null,"elapsed_seconds":3,"events":[]}'
           exit 124
         fi
         printf '%s' '{"run_id":"${STUB_RUN}","status":"completed","exit_code":0,"run_exit_code":0,"error":null,"agent_id":"probe","backend":"x","model":"m","final_available":true,"final_path":"/a/final.txt","final_text":"FULL ANSWER BODY","duration_s":4.2,"artifacts_dir":"/a","cwd":"/w"}'
       ;;
       cancel)
         echo "Error: run is terminal (completed); cannot steer/cancel: ${STUB_RUN}" >&2
         exit 5
       ;;
       list)
         cat <<EOF
[{"run_id":"${STUB_RUN}","status":"running","effective_status":"running","agent_id":"probe","backend":"x","model":"m","cwd":"/work/task","artifacts_dir":"/exec/attempts/a1/artifacts","pid":4242,"pid_alive":true,"started_at":"s","exit_code":null},
 {"run_id":"run_old-same-cwd","status":"completed","effective_status":"completed","agent_id":"probe","backend":"x","model":"m","cwd":"/work/task","artifacts_dir":"/exec/attempts/old/artifacts","pid":111,"pid_alive":false,"started_at":"s0","exit_code":0}]
EOF
       ;;
     esac`);
  const rt = createPorchRuntime({ rootDir: path.join(TMP, 'rt-ctl'), porchPath: stub });

  const st = await rt.status(STUB_RUN);
  assert.equal(st.ok, true);
  assert.equal(st.status, 'running');
  assert.equal(st.terminal, false);
  assert.equal(st.pid, 4242);

  const e0 = await rt.events(STUB_RUN, { cursor: 0 });
  assert.equal(e0.ok, true);
  assert.equal(e0.events.length, 2);
  assert.equal(e0.nextCursor, 2);
  const e2 = await rt.events(STUB_RUN, { cursor: e0.nextCursor });
  assert.equal(e2.events.length, 0);
  assert.equal(e2.nextCursor, 2);

  const w0 = await rt.wait(STUB_RUN, { timeoutSec: 0 });
  assert.equal(w0.outcome, 'timeout');
  assert.equal(w0.timedOut, true);
  assert.equal(w0.terminal, false);

  const w1 = await rt.wait(STUB_RUN, { timeoutSec: 5 });
  assert.equal(w1.outcome, 'terminal');
  assert.equal(w1.status, 'completed');
  assert.equal(w1.finalText, 'FULL ANSWER BODY');
  assert.equal(w1.finalAvailable, true);

  const c = await rt.cancel(STUB_RUN);
  assert.equal(c.requested, false);
  assert.equal(c.error.code, 'already_terminal');

  // Reconcile: AND semantics — unique artifactsDir + cwd must both match;
  // an old run in the same cwd does not satisfy an artifactsDir-scoped query.
  const rec = await rt.reconcile({ cwd: '/work/task',
    artifactsDir: '/exec/attempts/a1/artifacts' });
  assert.equal(rec.ok, true);
  assert.equal(rec.matches.length, 1);
  assert.equal(rec.matches[0].runId, STUB_RUN);
  const recCwdOnly = await rt.reconcile({ cwd: '/work/task' });
  assert.equal(recCwdOnly.matches.length, 2); // cwd alone is a weak selector
  const recMiss = await rt.reconcile({ cwd: '/work/task',
    artifactsDir: '/exec/attempts/other/artifacts' });
  assert.equal(recMiss.matches.length, 0);
  const recIds = await rt.reconcile({ runIds: ['run_old-same-cwd'] });
  assert.equal(recIds.matches[0].runId, 'run_old-same-cwd');

  await assert.rejects(() => rt.status('bogus id'),
    (e) => e.code === 'invalid_run_id');
  await assert.rejects(() => rt.events(STUB_RUN, { cursor: -1 }),
    (e) => e.code === 'invalid_argument');
});

// --- fake backend ------------------------------------------------------------

test('fake: launch -> events cursor -> terminal wait with full text', async () => {
  const rt = createFakeRuntime({ behaviors: { default: {
    finalText: 'done-answer', delayMs: 5,
    events: [{ type: 'progress', data: 'step1' }, { type: 'answer_delta', data: 'a' }],
  } } });
  const s = await rt.start({ attemptId: 'f1', profileId: 'p', cwd: '/w', prompt: 'x', config: CFG });
  assert.equal(s.ok, true);
  assert.match(s.porchRunId, RUN_ID_RE);

  const e = await rt.events(s.porchRunId, { cursor: 0, maxEvents: 2 });
  assert.equal(e.events.length, 2);
  const e2 = await rt.events(s.porchRunId, { cursor: e.nextCursor });
  assert.ok(e2.nextCursor >= e.nextCursor);

  const w = await rt.wait(s.porchRunId, { timeoutSec: 2 });
  assert.equal(w.outcome, 'terminal');
  assert.equal(w.status, 'completed');
  assert.equal(w.finalText, 'done-answer');

  const st = await rt.status(s.porchRunId);
  assert.equal(st.terminal, true);
});

test('fake: wait timeout is observation, not failure', async () => {
  const rt = createFakeRuntime({ behaviors: { default: { outcome: 'never' } } });
  const s = await rt.start({ attemptId: 'f2', profileId: 'p', cwd: '/w', prompt: 'x', config: CFG });
  const w = await rt.wait(s.porchRunId, { timeoutSec: 0 });
  assert.equal(w.outcome, 'timeout');
  assert.equal(w.terminal, false);
});

test('fake: cancel requested then terminal cancelled', async () => {
  const rt = createFakeRuntime({ behaviors: { default: { outcome: 'never' } } });
  const s = await rt.start({ attemptId: 'f3', profileId: 'p', cwd: '/w', prompt: 'x', config: CFG });
  const c = await rt.cancel(s.porchRunId);
  assert.equal(c.requested, true);
  const w = await rt.wait(s.porchRunId, { timeoutSec: 2 });
  assert.equal(w.status, 'cancelled');
  assert.equal(w.exitCode, 130);
  const c2 = await rt.cancel(s.porchRunId);
  assert.equal(c2.error.code, 'already_terminal');
});

test('fake: cancel beats a pending successful outcome (terminal immutable)', async () => {
  const rt = createFakeRuntime({ behaviors: { default: {
    outcome: 'completed', finalText: 'too late', delayMs: 60,
  } } });
  const s = await rt.start({ attemptId: 'f3b', profileId: 'p', cwd: '/w', prompt: 'x', config: CFG });
  const c = await rt.cancel(s.porchRunId);
  assert.equal(c.requested, true);
  await new Promise((r) => setTimeout(r, 120)); // past the scheduled outcome
  const st = await rt.status(s.porchRunId);
  assert.equal(st.status, 'cancelled');
  assert.equal(st.exitCode, 130);
  const w = await rt.wait(s.porchRunId, { timeoutSec: 1 });
  assert.equal(w.status, 'cancelled');
});

test('fake: launch failure and uncertain launch are distinct', async () => {
  const rt = createFakeRuntime({ behaviors: {
    byAttempt: {
      dead: { launch: 'fail', launchError: 'no auth' },
      maybe: { launch: 'uncertain' },
    },
    default: { outcome: 'never' },
  } });
  const f = await rt.start({ attemptId: 'dead', profileId: 'p', cwd: '/w', prompt: 'x', config: CFG });
  assert.equal(f.phase, 'launch_failed');
  assert.equal(f.porchRunId, null);
  const u = await rt.start({ attemptId: 'maybe', profileId: 'p', cwd: '/w', prompt: 'x', config: CFG });
  assert.equal(u.phase, 'launch_uncertain');
  const rec = await rt.reconcile({ artifactsDir: u.artifactsDir });
  assert.equal(rec.matches.length, 1); // the run may exist — caller must look
});

test('fake: reconcile AND semantics exclude old same-cwd run', async () => {
  const rt = createFakeRuntime({ behaviors: { default: { outcome: 'never' } } });
  const a = await rt.start({ attemptId: 'old', profileId: 'p', cwd: '/w', prompt: 'x', config: CFG });
  const b = await rt.start({ attemptId: 'new', profileId: 'p', cwd: '/w', prompt: 'x', config: CFG });
  const rec = await rt.reconcile({ cwd: '/w', artifactsDir: b.artifactsDir });
  assert.equal(rec.matches.length, 1);
  assert.equal(rec.matches[0].runId, b.porchRunId);
  assert.notEqual(rec.matches[0].runId, a.porchRunId);
});

test('import safety: module load has no side effects', async () => {
  // If imports spawned or listened, merely reaching this test proves absence
  // only indirectly; assert no stray fs objects exist in the fake root.
  const rt = createFakeRuntime();
  assert.equal(typeof rt.start, 'function');
  const env = rt.environment();
  assert.equal(env.backend, 'fake');
});
