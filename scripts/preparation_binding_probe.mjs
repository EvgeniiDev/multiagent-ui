#!/usr/bin/env node
// scripts/preparation_binding_probe.mjs — P0 feasibility probe driver for
// idea-preparation skill bindings (plan KTD2–KTD7).
//
// Commands:
//   node scripts/preparation_binding_probe.mjs list
//   node scripts/preparation_binding_probe.mjs pin    <bindingId|all>
//   node scripts/preparation_binding_probe.mjs verify [bindingId|all]
//   node scripts/preparation_binding_probe.mjs probe  <bindingId> [--run NAME]
//   node scripts/preparation_binding_probe.mjs audit  <bindingId|all>
//   node scripts/preparation_binding_probe.mjs preflight <bindingId|all> [--ws DIR]
//   node scripts/preparation_binding_probe.mjs resources <bindingId>
//
// P2 additions: `preflight` runs the full capability/resource preflight
// (route → adapter → capabilities → manifest re-hash → gate contract →
// declared roots when --ws is given); `resources` loads the pinned original
// resources and reports their verified digests — proof that the runtime
// executes the pinned files, not a rewriting. `probe` plans its pi argv
// through the adapter layer (planInvocation) — what was probed is what a
// P3 driver would launch.
//
// `pin` is the deliberate registration step: it hashes every file under the
// binding's skill dirs + extraResources into bindings.json. `verify`
// recomputes and fails closed on drift. `probe` refuses `unsupported` and
// `candidate` bindings outright (assertRouteAvailable — a candidate must be
// flipped to `available` ONLY after a green probe is on record), then runs a
// REAL interactive pi RPC session in a private git document workspace:
//
//   * isolated PI_CODING_AGENT_DIR (copied provider/model config only) +
//     dedicated session dir — never the operator's live agent state;
//   * explicit --skill/-e/--tools flags — no discovery;
//   * the preparation-bridge extension supplies the host blocking-question
//     tool (ask_user → extension_ui_request/response) and enforces
//     write/read/bash containment BEFORE tools run;
//   * the driver answers dialogs from the binding's scripted policy, asks
//     scripted chat answers, audits every tool call, and only passes when
//     the binding's declared expectations are observed in the workspace;
//   * every run leaves raw evidence under the run dir: transcript.jsonl
//     (all frames, both directions), audit.jsonl (in-process guard log),
//     verdict.json, workspace listing + git log, stderr.
//
// Environment: ACP_P0_OUT overrides the output root (default
// ~/.cache/acp-p0). Probe children always get SIGTERM→SIGKILL cleanup; the
// workspace is a scratch git repo, never the target project.

import { spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  loadRegistry, bindingById, buildManifest,
  verifyManifest, checkToolCall, verdictFor,
} from '../server/execution/preparation/skills/registry.mjs';
import { planInvocation } from '../server/execution/preparation/skills/adapters.mjs';
import { preflightBinding } from '../server/execution/preparation/skills/preflight.mjs';
import { loadBindingResources, resourceSnapshot } from '../server/execution/preparation/skills/resources.mjs';
import { defaultHostCapabilities } from '../server/execution/preparation/skills/capabilities.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.join(ROOT, 'server/execution/preparation/skills/bindings.json');
const EXT_PATH = path.join(ROOT, 'server/execution/preparation/skills/pi-ext/preparation-bridge.ts');
const PROJECT_ROOT = ROOT; // read-only target project — never written
const OUT_ROOT = process.env.ACP_P0_OUT || path.join(os.homedir(), '.cache', 'acp-p0');
const REAL_AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');

const MODEL_PROVIDER = process.env.ACP_P0_PROVIDER || 'zen-relay';
const MODEL_ID = process.env.ACP_P0_MODEL || 'muse-spark-1.3-contributor-free';
const THINKING = process.env.ACP_P0_THINKING || 'low';

const now = () => new Date().toISOString();
const ts = () => now().replace(/[:.]/g, '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// registry helpers
// --------------------------------------------------------------------------

async function pinBindings(ids) {
  const rawText = await fs.readFile(REGISTRY_PATH, 'utf8');
  const raw = JSON.parse(rawText);
  const registry = await loadRegistry(REGISTRY_PATH);
  const wanted = ids ?? registry.bindings.map((b) => b.bindingId);
  const out = [];
  for (const id of wanted) {
    const binding = bindingById(registry, id);
    if (!binding.skillDirs.length && !binding.extraResources.length) {
      out.push({ bindingId: id, skipped: 'no resources' });
      continue;
    }
    const manifest = await buildManifest(binding);
    const target = raw.bindings.find((b) => b.bindingId === id);
    target.resourceManifest = manifest;
    out.push({ bindingId: id, digest: manifest.digest, files: manifest.files.length });
  }
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(raw, null, 2) + '\n');
  return out;
}

async function verifyBindings(ids) {
  const registry = await loadRegistry(REGISTRY_PATH);
  const wanted = ids ?? registry.bindings.map((b) => b.bindingId);
  const out = [];
  for (const id of wanted) {
    const binding = bindingById(registry, id);
    try {
      const r = await verifyManifest(binding);
      out.push({ bindingId: id, ok: true, digest: r.digest.slice(0, 16), files: r.fileCount });
    } catch (e) {
      out.push({ bindingId: id, ok: false, code: e.code, message: e.message, detail: { missing: e.missing, changed: e.changed, added: e.added } });
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// workspace + scoped agent dir
// --------------------------------------------------------------------------

async function setupRun(binding, runName) {
  const runDir = path.join(OUT_ROOT, `${runName ?? ts()}-${binding.bindingId}`);
  const ws = path.join(runDir, 'workspace');
  const agentDir = path.join(runDir, 'agent');
  const sessDir = path.join(runDir, 'sessions');
  const artDir = path.join(runDir, 'artifacts');
  await fs.mkdir(ws, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(sessDir, { recursive: true });
  await fs.mkdir(artDir, { recursive: true });

  // git workspace: init + identity + initial seed commit.
  const git = (args) => execFileSync('git', ['-C', ws, ...args], { encoding: 'utf8', timeout: 20000 });
  git(['init', '-q']);
  git(['config', 'user.email', 'p0-probe@local']);
  git(['config', 'user.name', 'p0-probe']);
  await fs.writeFile(path.join(ws, 'README.md'),
    `# p0 document workspace\n\nScratch repository for the ${binding.bindingId} probe. Not a real project.\n`);
  for (const seed of binding.probe?.seed ?? []) {
    const rel = seed.path;
    const abs = path.join(ws, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, seed.content.replaceAll('{ws}', ws));
  }
  git(['add', '-A']);
  git(['commit', '-qm', 'p0 workspace seed']);
  const baseCommit = git(['rev-parse', 'HEAD']).trim();

  // Scoped agent dir: provider/model config + credentials only. No skills,
  // no extensions, no sessions — discovery is disabled anyway.
  for (const f of ['models.json', 'auth.json']) {
    const src = path.join(REAL_AGENT_DIR, f);
    try { await fs.copyFile(src, path.join(agentDir, f)); }
    catch (e) { throw new Error(`cannot stage ${f} into scoped agent dir: ${e.message}`); }
  }
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: MODEL_PROVIDER,
    defaultModel: MODEL_ID,
    packages: [],
    enableInstallTelemetry: false,
  }, null, 2));

  return { runDir, ws, agentDir, sessDir, artDir, baseCommit };
}

// --------------------------------------------------------------------------
// pi RPC session driver
// --------------------------------------------------------------------------

function globToRe(glob) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = glob.split('/');
  let re = '^';
  parts.forEach((seg, i) => {
    if (i) re += '/';
    if (seg === '**') re += '.*';
    else re += seg.split('*').map(esc).join('[^/]*');
  });
  return new RegExp(re + '$');
}

async function listWsFiles(ws) {
  const out = [];
  const walk = async (d, rel) => {
    for (const ent of await fs.readdir(d, { withFileTypes: true })) {
      if (ent.name === '.git') continue;
      const p = path.join(d, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(p, r);
      else if (ent.isFile()) out.push(r);
    }
  };
  await walk(ws, '');
  return out.sort();
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

class PiRpcSession {
  constructor({ argv, cwd, env, transcriptPath }) {
    this.proc = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.transcript = createWriteStream(transcriptPath);
    this.pending = new Map();       // id -> {resolve, reject, cmd}
    this.handlers = [];             // frame handlers
    this.tail = Buffer.alloc(0);
    this.stdin = this.proc.stdin;
    this.stderrBuf = [];
    this.exited = null;
    this.seq = 0;
    this.sawAgentStart = false;
    this.sawSettle = false;
    this.proc.stdout.on('data', (d) => this.#onData(d));
    this.proc.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      this.stderrBuf.push(s);
      if (this.stderrBuf.join('').length > 512 * 1024) this.stderrBuf = [this.stderrBuf.join('').slice(-256 * 1024)];
    });
    this.proc.on('exit', (code, signal) => { this.exited = { code, signal }; });
    this.proc.stdin.on('error', () => {});
  }

  #onData(d) {
    this.tail = Buffer.concat([this.tail, d]);
    for (;;) {
      const i = this.tail.indexOf(0x0a); // LF only — never U+2028/2029
      if (i < 0) break;
      const line = this.tail.subarray(0, i);
      this.tail = this.tail.subarray(i + 1);
      this.#record('out', line);
      let frame = null;
      try { frame = JSON.parse(line.toString('utf8')); } catch { /* non-JSON line */ }
      if (frame) this.#dispatch(frame);
    }
  }

  #record(dir, line) {
    try {
      const text = Buffer.isBuffer(line) ? line.toString('utf8') : String(line);
      this.transcript.write(JSON.stringify({ t: now(), dir, line: text }) + '\n');
    } catch { /* transcript is evidence; never kill the session on IO error */ }
  }

  #dispatch(frame) {
    if (frame.type === 'response' && frame.id && this.pending.has(frame.id)) {
      const p = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      p.resolve(frame);
      return;
    }
    if (frame.type === 'agent_start' || frame.type === 'turn_start') this.sawAgentStart = true;
    if (frame.type === 'agent_settled' || frame.type === 'agent_end') this.sawSettle = true;
    for (const h of this.handlers) { try { h(frame); } catch { /* handler bug != protocol event */ } }
  }

  onFrame(fn) { this.handlers.push(fn); }

  // Prompt send that also re-arms the turn-tracking flags — a fresh prompt
  // means the previous settle no longer counts.
  sendPrompt(message) {
    this.sawAgentStart = false;
    this.sawSettle = false;
    return this.send({ type: 'prompt', message });
  }

  send(obj) {
    const wire = { id: obj.id ?? `p0-${++this.seq}`, ...obj };
    const line = JSON.stringify(wire);
    this.#record('in', line);
    this.stdin.write(line + '\n');
    return wire.id;
  }

  request(cmd, params = {}, timeoutMs = 30000) {
    const id = this.send({ type: cmd, ...params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { cmd, resolve: (f) => { clearTimeout(timer); resolve(f); }, reject });
    });
  }

  async waitSettled(idleMs = 1500, timeoutMs = 120000) {
    // A turn is "settled" only after we have SEEN it start (agent_start /
    // turn_start) and get_state reports not streaming. get_state can answer
    // isStreaming:false while the prompt is still queuing — observed live
    // (state response 1ms before agent_start).
    const deadline = Date.now() + timeoutMs;
    const startWaitUntil = Date.now() + 30000;
    while (!this.sawAgentStart) {
      if (this.exited) return { settled: false, exited: this.exited };
      if (Date.now() > startWaitUntil) {
        // prompt was rejected or never started — check the ack
        return { settled: false, neverStarted: true };
      }
      if (Date.now() > deadline) return { settled: false, timeout: true };
      await sleep(150);
    }
    for (;;) {
      if (this.exited) return { settled: false, exited: this.exited };
      if (this.sawSettle) return { settled: true };
      try {
        const r = await this.request('get_state', {}, 10000);
        if (r?.data?.isStreaming !== true) return { settled: true };
      } catch { /* get_state may race shutdown; keep polling */ }
      if (Date.now() > deadline) return { settled: false, timeout: true };
      await sleep(300);
    }
  }

  async kill() {
    if (this.exited) return;
    try { this.proc.kill('SIGTERM'); } catch { /* gone */ }
    const t0 = Date.now();
    while (!this.exited && Date.now() - t0 < 3000) await sleep(100);
    if (!this.exited) { try { this.proc.kill('SIGKILL'); } catch { /* gone */ } }
    const t1 = Date.now();
    while (!this.exited && Date.now() - t1 < 2000) await sleep(50);
    try { this.transcript.end(); } catch { /* ignore */ }
  }
}

// --------------------------------------------------------------------------
// probe run
// --------------------------------------------------------------------------

async function runProbe(binding, { runName } = {}) {
  // Fail-closed: `unsupported` routes are never probed. `candidate` IS the
  // probeable state — the probe is what proves or disproves availability.
  if (binding.status === 'unsupported') {
    const u = binding.unsupported ?? {};
    const err = new Error(`binding ${binding.bindingId} is unsupported: ${u.reason ?? 'unspecified'} — ${u.detail ?? ''}`);
    err.code = 'route_unsupported';
    throw err;
  }
  await verifyManifest(binding);          // fail-closed on resource drift

  const env0 = await setupRun(binding, runName);
  const { runDir, ws, agentDir, sessDir, artDir, baseCommit } = env0;
  const auditPath = path.join(artDir, 'audit.jsonl');
  const transcriptPath = path.join(artDir, 'transcript.jsonl');
  const verdictPath = path.join(artDir, 'verdict.json');

  const repoStatusBefore = repoStatus();

  const evidence = {
    bindingId: binding.bindingId, runDir, workspace: ws,
    startedAt: now(), questions: [], uiRequests: 0, chatQuestions: 0,
    containmentViolations: [], toolCalls: [], deniedToolCalls: [],
    artifacts: {}, gitCommits: [], promptsSent: 0, aborts: [],
    promptLog: [], finalText: null, exit: null, errors: [],
  };
  const verdictBase = { bindingId: binding.bindingId, stage: binding.stage, runDir };

  const finish = async (status, extra = {}) => {
    evidence.endedAt = now();
    // collect expectations evidence
    const files = await listWsFiles(ws).catch(() => []);
    for (const glob of binding.expect?.artifacts ?? []) {
      const re = globToRe(glob);
      evidence.artifacts[glob] = files.filter((f) => re.test(f));
    }
    // frontmatter: parse first matched artifact per glob
    evidence.frontmatter = {};
    for (const glob of Object.keys(evidence.artifacts)) {
      const f = evidence.artifacts[glob][0];
      if (!f) continue;
      const text = await fs.readFile(path.join(ws, f), 'utf8').catch(() => '');
      Object.assign(evidence.frontmatter, parseFrontmatter(text));
    }
    try {
      const log = execFileSync('git', ['-C', ws, 'log', '--format=%H %s', `${baseCommit}..HEAD`],
        { encoding: 'utf8', timeout: 15000 }).trim();
      evidence.gitCommits = log ? log.split('\n') : [];
    } catch (e) { evidence.errors.push(`git log: ${e.message}`); }
    evidence.wsFiles = files;
    evidence.repoStatusUnchanged = repoStatus() === repoStatusBefore;
    // manifest re-verify: the probe must not have mutated upstream sources
    try { await verifyManifest(binding); evidence.resourcesIntact = true; }
    catch (e) { evidence.resourcesIntact = false; evidence.errors.push(`post-run manifest: ${e.code}`); }

    const exp = verdictFor(binding, evidence);
    const realStatus = exp.ok ? status : (status === 'pass' ? 'fail' : status);
    const verdict = {
      ...verdictBase, status: realStatus,
      expectationsOk: exp.ok, expectationFailures: exp.failures,
      evidence: {
        uiRequests: evidence.uiRequests, chatQuestions: evidence.chatQuestions,
        promptsSent: evidence.promptsSent, aborts: evidence.aborts,
        artifacts: evidence.artifacts, frontmatter: evidence.frontmatter,
        gitCommits: evidence.gitCommits, wsFiles: files,
        containmentViolations: evidence.containmentViolations,
        deniedToolCalls: evidence.deniedToolCalls,
        finalText: evidence.finalText?.slice(0, 4000) ?? null,
        interrupt: evidence.interrupt ?? null,
        resourcesIntact: evidence.resourcesIntact,
        repoStatusUnchanged: evidence.repoStatusUnchanged,
        durationMs: new Date(evidence.endedAt) - new Date(evidence.startedAt),
      },
      errors: evidence.errors, extra,
    };
    await fs.writeFile(verdictPath, JSON.stringify(verdict, null, 2) + '\n');
    return verdict;
  };

  // -- spawn pi ------------------------------------------------------------
  // The launch plan comes from the adapter layer (P2): planInvocation builds
  // the same argv/env a P3 driver would use — explicit --skill/-e/--tools,
  // scoped agent/session dirs, containment roots over env. The probe adds
  // nothing beyond it, so probe evidence IS adapter evidence.
  const plan = planInvocation(binding, {
    piBinary: bindingPiBinary(),
    model: { provider: MODEL_PROVIDER, id: MODEL_ID, thinking: THINKING },
    sessionDir: sessDir,
    agentDir,
    workspace: ws,
    auditPath,
    extensionPath: EXT_PATH,
    name: `p0-${binding.bindingId}`,
  });
  const roots = plan.roots;

  const session = new PiRpcSession({
    argv: [plan.command, ...plan.args],
    cwd: plan.cwd,
    env: { ...process.env, ...plan.env },
    transcriptPath,
  });
  evidence.pid = session.proc.pid ?? null;

  const deadline = Date.now() + binding.probe.timeoutMs;
  let finished = null;
  const finishOnce = async (status, extra) => {
    if (finished) return finished;
    finished = await finish(status, extra);
    return finished;
  };
  const timedOut = () => Date.now() > deadline;
  const guardTime = () => {
    if (timedOut()) {
      evidence.errors.push('probe timeout');
      return true;
    }
    return false;
  };

  // ui answer policy
  const uiRules = binding.probe?.ui?.rules ?? [];
  const uiDefault = binding.probe?.ui?.default ?? {};
  const answerUi = (req) => {
    const q = `${req.title ?? ''} ${req.question ?? ''} ${req.message ?? ''}`;
    const rule = uiRules.find((r) => {
      try { return new RegExp(r.match, 'i').test(q); } catch { return false; }
    });
    if (rule?.cancel) return { cancelled: true };
    const pol = rule?.answer !== undefined ? { select: rule.answer, confirm: rule.answer === true, input: rule.answer } : (rule ?? uiDefault);
    const opts = req.options ?? [];
    switch (req.method) {
      case 'confirm':
        if (pol.confirm === 'cancel') return { cancelled: true };
        return { confirmed: pol.confirm !== false };
      case 'select': {
        if (pol.select === 'cancel') return { cancelled: true };
        if (typeof pol.select === 'number') return { value: opts[pol.select] ?? opts[0] };
        if (typeof pol.select === 'string' && pol.select !== 'first' && opts.includes(pol.select)) return { value: pol.select };
        if (typeof pol.select === 'string' && pol.select.startsWith('/') && pol.select.endsWith('/')) {
          const re = new RegExp(pol.select.slice(1, -1), 'i');
          const hit = opts.find((o) => re.test(o));
          if (hit) return { value: hit };
        }
        return { value: opts[0] ?? '' }; // 'first' default — never the appended "Other"
      }
      case 'input':
      case 'editor':
      default: {
        if (pol.input === 'cancel' || pol.text === 'cancel') return { cancelled: true };
        const v = pol.text ?? pol.input ?? 'Agreed — proceed with your recommendation.';
        return { value: String(v) };
      }
    }
  };

  const chatQuestionRe = /\?|❓/;

  let answers = [...(binding.probe?.answers ?? [])];
  let streaming = false;
  let settledAtLeastOnce = false;
  let interruptDone = !binding.probe?.interruptTest;
  let lastAssistantText = '';

  session.onFrame((frame) => {
    const t = frame.type;
    if (t === 'agent_start') streaming = true;
    if (t === 'agent_settled' || t === 'agent_end') streaming = false;
    if (t === 'extension_ui_request') {
      const req = frame;
      if (req.method === 'notify' || req.method === 'setStatus' || req.method === 'setWidget' ||
          req.method === 'setTitle' || req.method === 'set_editor_text') return;
      evidence.uiRequests += 1;
      evidence.questions.push({ via: 'extension_ui', id: req.id, method: req.method,
        title: req.title ?? null, options: req.options ?? null });
      const resp = answerUi(req);
      session.send({ type: 'extension_ui_response', id: req.id, ...resp });
      evidence.promptLog.push({ kind: 'ui_response', id: req.id, ...resp });
      return;
    }
    if (t === 'turn_end' || t === 'turn_boundary') {
      const msg = frame.message;
      const text = Array.isArray(msg?.content)
        ? msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
        : '';
      if (text) {
        lastAssistantText = text;
        evidence.lastText = text;
        if (chatQuestionRe.test(text)) {
          evidence.chatQuestions += 1;
          evidence.questions.push({ via: 'chat', text: text.slice(0, 2000) });
        }
      }
      return;
    }
    if (t === 'tool_execution_start') {
      const chk = checkToolCall(frame.toolName, frame.args ?? {}, roots);
      evidence.toolCalls.push({ tool: frame.toolName, ok: chk.allow === true });
      if (chk.block) {
        // The in-process guard already blocks; reaching this branch means the
        // guard failed — a violation worth aborting over.
        evidence.containmentViolations.push({ tool: frame.toolName, args: frame.args, reason: chk.reason });
        evidence.deniedToolCalls.push(frame.toolName);
        session.send({ type: 'abort' });
      }
      return;
    }
    if (t === 'tool_execution_end' && frame.isError) {
      evidence.deniedToolCalls.push({ tool: frame.toolName, isError: true });
    }
    if (t === 'extension_error') {
      evidence.errors.push(`extension_error: ${frame.error} @ ${frame.event}`);
    }
  });

  // main loop
  try {
    // readiness: send the initial prompt as soon as the process accepts input
    const first = binding.probe.prompt?.replaceAll('{ws}', ws)
      ?? `Run the ${binding.skillNames[0]} workflow.`;
    session.sendPrompt(first);
    evidence.promptsSent += 1;
    evidence.promptLog.push({ kind: 'prompt', text: first.slice(0, 500) });

    for (;;) {
      if (session.exited) break;
      if (guardTime()) break;
      const st = await session.waitSettled(1500, 60000);
      if (session.exited) break;
      if (!st.settled) {
        if (guardTime()) break;
        continue; // still streaming — keep waiting (human-time questions are not hangs)
      }
      settledAtLeastOnce = true;

      // interrupt leg: abort once, then resume with the next scripted answer
      if (!interruptDone) {
        interruptDone = true;
        try {
          const ar = await session.request('abort', {}, 15000);
          evidence.aborts.push({ ok: ar?.success === true, response: ar?.success ?? null });
          evidence.interrupt = { aborted: ar?.success === true };
        } catch (e) {
          evidence.aborts.push({ ok: false, error: e.message });
          evidence.interrupt = { aborted: false, error: e.message };
        }
        await session.waitSettled(1000, 20000);
        if (answers.length) {
          const next = answers.shift().replaceAll('{ws}', ws);
          session.sendPrompt(next);
          evidence.promptsSent += 1;
          evidence.promptLog.push({ kind: 'prompt', afterAbort: true, text: next.slice(0, 500) });
          evidence.interrupt.resumed = true;
          continue;
        }
      }

      // expectations met?
      const expNow = await quickExpectCheck(binding, ws, evidence);
      if (expNow) { await finishOnce('pass'); break; }

      if (answers.length && evidence.promptsSent < (binding.probe?.maxPrompts ?? 12)) {
        const next = answers.shift().replaceAll('{ws}', ws);
        session.sendPrompt(next);
        evidence.promptsSent += 1;
        evidence.promptLog.push({ kind: 'prompt', text: next.slice(0, 500) });
        continue;
      }
      // nothing left to say — settle the verdict on observed evidence
      await finishOnce(evidence.containmentViolations.length ? 'fail' : 'exhausted');
      break;
    }
  } catch (e) {
    evidence.errors.push(`driver: ${e.message}`);
    await finishOnce('error');
  }

  // teardown — always
  if (!finished) await finishOnce(timedOut() ? 'timeout' : 'error');
  try {
    const lt = await session.request('get_last_assistant_text', {}, 10000);
    evidence.finalText = lt?.data?.text ?? lastAssistantText ?? null;
  } catch { evidence.finalText = lastAssistantText || null; }
  try { await session.request('export_html', { outputPath: path.join(artDir, 'session.html') }, 10000); } catch { /* optional */ }
  await session.kill();
  await fs.writeFile(path.join(artDir, 'stderr.log'), session.stderrBuf.join(''));

  // re-write verdict with finalText/exit attached
  const v0 = JSON.parse(await fs.readFile(verdictPath, 'utf8'));
  v0.evidence.finalText = evidence.finalText?.slice(0, 4000) ?? null;
  v0.evidence.exit = session.exited;
  await fs.writeFile(verdictPath, JSON.stringify(v0, null, 2) + '\n');
  return v0;
}

// Cheap expectations probe mid-run: artifacts present + required counts.
// Frontmatter/git checks stay in the final verdict (they only settle once
// writing stops).
async function quickExpectCheck(binding, ws, evidence) {
  const exp = binding.expect ?? {};
  const files = await listWsFiles(ws).catch(() => []);
  for (const glob of exp.artifacts ?? []) {
    const re = globToRe(glob);
    if (!files.some((f) => re.test(f))) return false;
  }
  if (exp.gitCommit) {
    try {
      const n = execFileSync('git', ['-C', ws, 'rev-list', '--count', 'HEAD'],
        { encoding: 'utf8', timeout: 10000 }).trim();
      if (parseInt(n, 10) < 2) return false; // seed commit + at least one real
    } catch { return false; }
  }
  if ((exp.minUiRequests ?? 0) > evidence.uiRequests) return false;
  if ((exp.minChatQuestions ?? 0) > evidence.chatQuestions) return false;
  if (exp.finalTextPattern) {
    const t = evidence.lastText ?? '';
    if (!new RegExp(exp.finalTextPattern, 'i').test(t)) return false;
  }
  return (exp.artifacts ?? []).length || exp.gitCommit || exp.minUiRequests || exp.minChatQuestions || exp.finalTextPattern
    ? true : false;
}

function bindingPiBinary() {
  return process.env.ACP_P0_PI || 'pi';
}

function repoStatus() {
  try {
    return execFileSync('git', ['-C', PROJECT_ROOT, 'status', '--porcelain'],
      { encoding: 'utf8', timeout: 15000 });
  } catch (e) { return `unavailable: ${e.message}`; }
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : null;
};

try {
  switch (cmd) {
    case 'list': {
      const registry = await loadRegistry(REGISTRY_PATH);
      for (const b of registry.bindings) {
        console.log(`${b.bindingId}\t${b.status}\tstage=${b.stage}\tskills=${b.skillNames.join('+') || '-'}\tq=${b.questionChannel}\tmanifest=${b.resourceManifest ? b.resourceManifest.digest.slice(0, 12) : 'UNPINNED'}`);
      }
      break;
    }
    case 'pin': {
      const id = rest[0];
      const out = await pinBindings(id && id !== 'all' ? [id] : null);
      for (const r of out) console.log(JSON.stringify(r));
      break;
    }
    case 'verify': {
      const id = rest[0];
      const out = await verifyBindings(id && id !== 'all' ? [id] : null);
      let bad = 0;
      for (const r of out) { console.log(JSON.stringify(r)); if (!r.ok) bad++; }
      process.exitCode = bad ? 1 : 0;
      break;
    }
    case 'audit': {
      const id = rest[0];
      const out = await verifyBindings(id && id !== 'all' ? [id] : null);
      console.log(JSON.stringify({ resources: out, repoStatus: repoStatus() }, null, 2));
      process.exitCode = out.some((r) => !r.ok) ? 1 : 0;
      break;
    }
    case 'probe': {
      const id = rest[0];
      if (!id || id === 'all') { console.error('probe requires a single bindingId'); process.exit(2); }
      const registry = await loadRegistry(REGISTRY_PATH);
      const binding = bindingById(registry, id);
      const verdict = await runProbe(binding, { runName: flag('--run') });
      console.log(JSON.stringify(verdict, null, 2));
      process.exitCode = verdict.status === 'pass' ? 0 : 1;
      break;
    }
    case 'preflight': {
      // Full P2 preflight against the declared host surface: route truth →
      // adapter → capabilities → pinned-resource re-hash → gate contract →
      // declared roots (when --ws points at a workspace). Prints one JSON
      // verdict line per binding; exit 1 if any refuses.
      const id = rest[0];
      const ws = flag('--ws');
      const registry = await loadRegistry(REGISTRY_PATH);
      const wanted = id && id !== 'all' ? [id] : registry.bindings.map((b) => b.bindingId);
      let bad = 0;
      for (const bid of wanted) {
        const binding = bindingById(registry, bid);
        try {
          const pf = await preflightBinding(binding, {
            hostCapabilities: defaultHostCapabilities(),
            workspace: ws ?? undefined,
            fsCheck: !!ws,
          });
          console.log(JSON.stringify({
            bindingId: bid, ok: true, adapterId: pf.adapterId,
            digest: pf.digest.slice(0, 16), configDigest: pf.configDigest.slice(0, 16),
            capabilities: pf.capabilities.required,
            gateContract: pf.gateContract, result: pf.result,
          }));
        } catch (e) {
          bad += 1;
          console.log(JSON.stringify({ bindingId: bid, ok: false, code: e.code, message: e.message, missing: e.missing ?? null }));
        }
      }
      process.exitCode = bad ? 1 : 0;
      break;
    }
    case 'resources': {
      // Load the binding's pinned original resources — every file re-hashed
      // against the manifest as it is read. Prints the verified snapshot:
      // proof the runtime serves the pinned bytes, not a rewriting.
      const id = rest[0];
      if (!id || id === 'all') { console.error('resources requires a single bindingId'); process.exit(2); }
      const registry = await loadRegistry(REGISTRY_PATH);
      const binding = bindingById(registry, id);
      const loaded = await loadBindingResources(binding, { includeText: false });
      console.log(JSON.stringify({
        ...resourceSnapshot(binding),
        loadedAt: loaded.loadedAt,
        entries: loaded.entries.map((e) => ({
          path: e.path, sha256: e.sha256, name: e.name ?? null,
        })),
        files: loaded.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
      }, null, 2));
      break;
    }
    default:
      console.error('usage: preparation_binding_probe.mjs list|pin <id|all>|verify [id|all]|probe <id> [--run name]|audit [id|all]|preflight <id|all> [--ws dir]|resources <id>');
      process.exit(2);
  }
} catch (e) {
  console.error(JSON.stringify({ ok: false, code: e.code ?? 'error', message: e.message, detail: { missing: e.missing, changed: e.changed, added: e.added } }));
  process.exit(1);
}
