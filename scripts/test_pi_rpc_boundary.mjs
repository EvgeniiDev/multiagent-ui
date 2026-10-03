#!/usr/bin/env node
// scripts/test_pi_rpc_boundary.mjs — focused behavioral suite for
// deploy/pi-rpc-boundary.mjs.
//
// The boundary is exercised as a real child process against a scripted FAKE
// pi cli (PI_RPC_BOUNDARY_REAL_CLI override). Assertions cover only what is
// observable on the wire — exit codes, stdout JSONL frames, stderr, argv —
// never source text: version guard / fail-closed resolution, turn_end
// disambiguation, framing reassembly, output cap, crash honesty, profile-flag
// enforcement, and the PORCH_BIN_PI shebang exec contract. No real pi, no
// network, no docker.
//
// Usage: node scripts/test_pi_rpc_boundary.mjs
//   Fixture root: $PI_RPC_BOUNDARY_TEST_TMP, else $TMPDIR, else os.tmpdir().

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOUNDARY = path.join(ROOT, 'deploy', 'pi-rpc-boundary.mjs');
const NODE = process.execPath;
const NODE_BIN = path.dirname(NODE);
const SAFE_PATH = [NODE_BIN, '/usr/bin', '/bin'].join(':');

const results = [];
let section = '';
function sect(name) { section = name; console.log(`\n== ${name}`); }
function check(name, ok, extra = '') {
  results.push([`${section} :: ${name}`, !!ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
}

// ---------- fixture: fake pi package --------------------------------------
// Layout mirrors the real install: <pkg>/package.json + <pkg>/dist/bundle/
// cli.js, so the boundary's `dirname(cli)/../../package.json` version probe
// reads the fixture version.

const tmp = fs.mkdtempSync(
  path.join(process.env.PI_RPC_BOUNDARY_TEST_TMP || os.tmpdir(), 'pi-rpc-boundary-test-'));
const PKG = path.join(tmp, 'node_modules', '@earendil-works', 'pi-coding-agent');
const FAKE_CLI = path.join(PKG, 'dist', 'bundle', 'cli.js');
fs.mkdirSync(path.dirname(FAKE_CLI), { recursive: true });

const FAKE_CLI_SOURCE = `// fake pi cli — scripted JSONL emitter; scenario from FAKE_PI_SCENARIO.
const S = process.env.FAKE_PI_SCENARIO || 'single';
const w = (s) => process.stdout.write(s);
const line = (o) => w(JSON.stringify(o) + '\\n');
const te = (stopReason, text) => ({ type: 'turn_end',
  message: { stopReason, content: [{ type: 'text', text }] } });
switch (S) {
  case 'single':
    line(te('stop', 'FINAL-TEXT'));
    line({ type: 'agent_end' });
    break;
  case 'multiturn':
    line({ type: 'turn_start' });
    line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'part' } });
    line(te('toolUse', 'CALLING-TOOL'));
    line({ type: 'turn_start' });
    line(te('stop', 'FINAL-TEXT'));
    line({ type: 'agent_end' });
    break;
  case 'twoturnend':
    line(te('toolUse', 'ONE'));
    line(te('stop', 'FINAL-TEXT'));
    line({ type: 'agent_end' });
    break;
  case 'settled':
    line(te('stop', 'FINAL-TEXT'));
    line({ type: 'agent_settled' });
    break;
  case 'crash':
    line({ type: 'turn_start' });
    line(te('toolUse', 'CALLING-TOOL'));
    process.exit(1);
    break;
  case 'garbage':
    w('this is not json\\n');
    line({ type: 'turn_start' });
    w('{"unterminated": 1\\n');
    line(te('stop', 'FINAL-TEXT'));
    line({ type: 'agent_end' });
    break;
  case 'chunked': {
    const s = JSON.stringify(te('stop', 'FINAL-TEXT'));
    w(s.slice(0, 10));
    w(s.slice(10, 25));
    w(s.slice(25) + '\\n');
    line({ type: 'agent_end' });
    break;
  }
  case 'tail':
    w(JSON.stringify(te('stop', 'FINAL-TEXT')));   // complete JSON, no newline
    break;
  case 'badtail':
    w('{"type":"turn_end","message":{"sto');        // truncated mid-frame
    break;
  case 'flood':
    w('x'.repeat(33 * 1024 * 1024) + '\\n');        // one line over the 32MiB cap
    break;
  case 'argv':
    line({ argv0: process.argv[0], argv1: process.argv[1], rest: process.argv.slice(2) });
    break;
  case 'echo-stdin': {
    let buf = '';
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => {
      line({ type: 'stdin_echo', data: buf });
      line({ type: 'agent_end' });
    });
    break;
  }
}
`;

function writeFakeCli(version = '0.85.1') {
  fs.writeFileSync(path.join(PKG, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-coding-agent', version, type: 'module' }));
  fs.writeFileSync(FAKE_CLI, FAKE_CLI_SOURCE, { mode: 0o755 });
}

function runFakeDirect(scenario) {
  return spawnSync(NODE, [FAKE_CLI], {
    env: { PATH: SAFE_PATH, HOME: tmp, FAKE_PI_SCENARIO: scenario },
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000,
  });
}

// Minimal env by construction: ambient PI_*/secret vars can never leak into
// the child or change its behavior; PATH carries node + `which` + real pi so
// only the explicit PI_RPC_BOUNDARY_REAL_CLI candidate matters.
function runBoundary({
  argv = [], env = {}, scenario = 'single', input = null,
  execDirect = false, extraPath = [],
} = {}) {
  const childEnv = {
    PATH: [...extraPath, NODE_BIN, '/usr/bin', '/bin'].join(':'),
    HOME: tmp,
    PI_RPC_BOUNDARY_REAL_CLI: FAKE_CLI,
    FAKE_PI_SCENARIO: scenario,
    DECOY_SECRET: 'hunter2-decoy-token-value',
    ...env,
  };
  const cmd = execDirect ? BOUNDARY : NODE;
  const args = execDirect ? argv : [BOUNDARY, ...argv];
  return spawnSync(cmd, args, {
    env: childEnv, input,
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000,
  });
}

const stdoutLines = (r) => r.stdout.split('\n').filter((l) => l.length);
const types = (r) => stdoutLines(r).map((l) => {
  try { return JSON.parse(l)?.type ?? '<non-json>'; } catch { return '<non-json>'; }
});

// ---------- fixture setup --------------------------------------------------

writeFakeCli('0.85.1');
const flagsFile = path.join(tmp, 'profile-flags.json');
const RPC = ['--mode', 'rpc'];

// ---------- resolution + version guard (fail closed) -----------------------

sect('resolution + version guard');

{
  writeFakeCli('0.86.0');
  const r = runBoundary({ argv: RPC, scenario: 'single' });
  check('unverified pi version exits 2, no success faked',
    r.status === 2 && /unverified pi version 0\.86\.0/.test(r.stderr),
    `status=${r.status} stderr=${r.stderr.trim().slice(0, 120)}`);
  check('failure stderr names the documented override, not the fake output',
    /PI_RPC_BOUNDARY_ALLOW_ANY_PI=1/.test(r.stderr) && r.stdout === '');
  check('failure stderr never echoes ambient env values (no token leak)',
    !r.stderr.includes('hunter2-decoy-token-value'),
    `stderr=${r.stderr.trim().slice(0, 160)}`);

  const ok = runBoundary({
    argv: RPC, scenario: 'single',
    env: { PI_RPC_BOUNDARY_ALLOW_ANY_PI: '1' },
  });
  check('documented override proceeds and announces real version',
    ok.status === 0 && /real pi 0\.86\.0/.test(ok.stderr),
    `status=${ok.status}`);

  writeFakeCli('0.85.1');
  const dir = path.join(tmp, 'not-a-cli-dir');
  fs.mkdirSync(dir, { recursive: true });
  const bogus = runBoundary({
    argv: RPC, scenario: 'single',
    env: { PI_RPC_BOUNDARY_REAL_CLI: dir },
  });
  check('configured cli path that is not a pi package fails closed',
    bogus.status === 2 && /unverified pi version unknown/.test(bogus.stderr),
    `status=${bogus.status} stderr=${bogus.stderr.trim().slice(0, 120)}`);

  fs.rmSync(path.join(PKG, 'package.json'));
  const nopkg = runBoundary({ argv: RPC, scenario: 'single' });
  check('unreadable package.json means unknown version, still fails closed',
    nopkg.status === 2 && /unverified pi version unknown/.test(nopkg.stderr));
  writeFakeCli('0.85.1');
}

// ---------- rpc stream adaptation ------------------------------------------

sect('rpc turn-boundary adaptation');

{
  const r = runBoundary({ argv: RPC, scenario: 'multiturn' });
  const lines = stdoutLines(r).map((l) => JSON.parse(l));
  check('mid-loop turn_end is renamed turn_boundary, final stays turn_end',
    r.status === 0
    && lines.map((o) => o.type).join(',')
      === 'turn_start,message_update,turn_boundary,turn_start,turn_end,agent_end',
    `types=${types(r).join(',')}`);
  const held = lines[2];
  check('turn_boundary preserves the full original payload',
    held.message?.stopReason === 'toolUse'
    && held.message?.content?.[0]?.text === 'CALLING-TOOL');
  const fin = lines[4];
  check('verbatim final turn_end keeps terminal assistant message identity',
    fin.message?.stopReason === 'stop' && fin.message?.content?.[0]?.text === 'FINAL-TEXT');
  check('stderr announces activation once with version+path+pid',
    /^pi-rpc-boundary: active, real pi 0\.85\.1 at .+cli\.js, pid \d+\n?$/m.test(r.stderr));
}

{
  const r = runBoundary({ argv: RPC, scenario: 'single' });
  check('single-turn session emits verbatim turn_end before agent_end',
    r.status === 0 && types(r).join(',') === 'turn_end,agent_end');
}

{
  const r = runBoundary({ argv: RPC, scenario: 'twoturnend' });
  check('second turn_end disambiguates the first as mid-loop',
    types(r).join(',') === 'turn_boundary,turn_end,agent_end');
}

{
  const r = runBoundary({ argv: RPC, scenario: 'settled' });
  check('agent_settled releases the held turn_end verbatim',
    types(r).join(',') === 'turn_end,agent_settled');
}

{
  const r = runBoundary({ argv: RPC, scenario: 'crash' });
  check('crash with a held turn_end emits turn_boundary, NEVER verbatim turn_end',
    r.status === 1
    && types(r).join(',') === 'turn_start,turn_boundary'
    && !types(r).includes('turn_end'),
    `status=${r.status} types=${types(r).join(',')}`);
}

{
  const r = runBoundary({ argv: RPC, scenario: 'garbage' });
  const lines = stdoutLines(r);
  check('malformed lines pass through verbatim — never swallowed',
    r.status === 0
    && lines[0] === 'this is not json'
    && lines[2] === '{"unterminated": 1'
    && lines.length === 5,
    `lines=${lines.length}`);
}

{
  const r = runBoundary({ argv: RPC, scenario: 'chunked' });
  check('frames split across writes reassemble by newline before disambiguation',
    r.status === 0 && types(r).join(',') === 'turn_end,agent_end');
}

{
  const r = runBoundary({ argv: RPC, scenario: 'tail' });
  check('complete unterminated frame at exit is released verbatim',
    r.status === 0 && types(r).join(',') === 'turn_end');
}

{
  const r = runBoundary({ argv: RPC, scenario: 'badtail' });
  check('truncated tail at exit is dropped + reported, not emitted as invalid JSONL',
    r.status === 0
    && r.stdout === ''
    && /dropped \d+B incomplete stdout tail/.test(r.stderr),
    `stdout=${r.stdout.length}B stderr=${r.stderr.trim().slice(-80)}`);
}

{
  const r = runBoundary({ argv: RPC, scenario: 'flood' });
  check('frame over the 32MiB output cap aborts loudly (bounded backlog)',
    r.status === 3
    && /stdout backlog \d+B exceeds cap; aborting/.test(r.stderr)
    && r.stdout.length < 1024 * 1024,
    `status=${r.status} stdout=${r.stdout.length}B`);
}

// ---------- channel scoping: rpc only, identity preserved -------------------

sect('channel scoping + identity');

{
  const patched = runBoundary({ argv: ['--mode=rpc'], scenario: 'multiturn' });
  check('--mode=rpc (equals form) activates the boundary patch',
    types(patched).includes('turn_boundary'));
}

{
  const viaBoundary = runBoundary({ argv: ['--print'], scenario: 'multiturn' });
  const direct = runFakeDirect('multiturn');
  check('outside --mode rpc stdout is byte-identical to the real cli',
    viaBoundary.status === 0 && viaBoundary.stdout === direct.stdout
    && viaBoundary.stdout.includes('"turn_end"')
    && !viaBoundary.stdout.includes('turn_boundary'));
}

{
  const cmd = '{"id":1,"type":"prompt","message":"hi porch"}';
  const r = runBoundary({ argv: RPC, scenario: 'echo-stdin', input: `${cmd}\n` });
  const echo = stdoutLines(r).map((l) => JSON.parse(l)).find((o) => o.type === 'stdin_echo');
  check('stdin request bytes reach pi verbatim (request identity preserved)',
    r.status === 0 && echo?.data === `${cmd}\n`);
}

{
  const r = runBoundary({ argv: ['--model', 'm'], scenario: 'argv' });
  const argv = JSON.parse(stdoutLines(r)[0]);
  check('boundary presents itself as the real cli (argv[1] = cli.js, same process)',
    r.status === 0 && argv.argv1 === fs.realpathSync(FAKE_CLI)
    && argv.rest.join(' ') === '--model m');
}

{
  const r = runBoundary({ argv: RPC, scenario: 'multiturn', execDirect: true });
  check('file is directly executable (shebang+exec bit = PORCH_BIN_PI contract)',
    r.status === 0 && types(r).includes('turn_boundary'),
    `status=${r.status} err=${String(r.error || '').slice(0, 80)}`);
}

// ---------- PI_PROFILE_FLAGS_FILE enforcement --------------------------------

sect('profile flags enforcement');

const argvOf = (r) => JSON.parse(stdoutLines(r)[0]).rest;

{
  fs.writeFileSync(flagsFile, JSON.stringify(['--no-extensions', '-e', '/work/node_modules/x', '--tools', 'read,bash']));
  const withFlags = { env: { PI_PROFILE_FLAGS_FILE: flagsFile } };
  const r = runBoundary({ argv: ['--model', 'm', ...RPC], scenario: 'argv', ...withFlags });
  check('controller flags are appended AFTER caller argv (deployment wins)',
    r.status === 0
    && argvOf(r).join(' ') === '--model m --mode rpc --no-extensions -e /work/node_modules/x --tools read,bash',
    `argv=${argvOf(r).join(' ')}`);

  const nr = runBoundary({ argv: ['--model', 'm'], scenario: 'argv', ...withFlags });
  check('profile flags apply outside rpc mode too (not channel-scoped)',
    nr.status === 0 && argvOf(nr).slice(-4).join(' ') === '-e /work/node_modules/x --tools read,bash');
}

{
  fs.writeFileSync(flagsFile, '[]');
  const r = runBoundary({ argv: RPC, scenario: 'argv', env: { PI_PROFILE_FLAGS_FILE: flagsFile } });
  check('empty flags array (probe/setup workers) leaves argv untouched',
    r.status === 0 && argvOf(r).join(' ') === '--mode rpc');
}

{
  const withFlags = { env: { PI_PROFILE_FLAGS_FILE: flagsFile } };
  fs.writeFileSync(flagsFile, '{not json');
  const r = runBoundary({ argv: RPC, scenario: 'argv', ...withFlags });
  check('malformed flags file is a hard fail, not a silent skip',
    r.status === 2 && /PI_PROFILE_FLAGS_FILE unreadable\/malformed/.test(r.stderr),
    `status=${r.status}`);

  fs.writeFileSync(flagsFile, '"--no-extensions"');
  const r2 = runBoundary({ argv: RPC, scenario: 'argv', ...withFlags });
  check('non-array flags file rejected',
    r2.status === 2 && /JSON array of non-empty strings/.test(r2.stderr));

  fs.writeFileSync(flagsFile, '["--no-extensions", ""]');
  const r3 = runBoundary({ argv: RPC, scenario: 'argv', ...withFlags });
  check('empty flag element rejected',
    r3.status === 2 && /JSON array of non-empty strings/.test(r3.stderr));

  const r4 = runBoundary({
    argv: RPC, scenario: 'argv',
    env: { PI_PROFILE_FLAGS_FILE: path.join(tmp, 'absent.json') },
  });
  check('unreadable flags file path rejected',
    r4.status === 2 && /unreadable\/malformed/.test(r4.stderr));
}

{
  fs.rmSync(flagsFile, { force: true });
  const r = runBoundary({ argv: RPC, scenario: 'argv' });
  check('unset PI_PROFILE_FLAGS_FILE is a no-op (file optional)',
    r.status === 0 && argvOf(r).join(' ') === '--mode rpc');
}

// ---------- summary -----------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });
const pass = results.filter(([, ok]) => ok).length;
const fail = results.length - pass;
console.log(`\n${pass}/${results.length} checks passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
