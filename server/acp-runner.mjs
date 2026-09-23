// acp-runner.mjs — thin "board -> CLI" host service for the ACP UI panel.
//
// The runner is deliberately dumb: it knows no prompts and does no planning.
// For every card whose stage is bound to a role (roles.json `stageRoles`)
// and that holds no live claim, it:
//   1. puts a rev-safe claim into `claims.json` (lease + pid),
//   2. writes a SHORT brief to <projectPath>/.acp/cards/<cardId>/00_brief.md,
//   3. spawns the role's CLI once with cwd = projectPath,
//      stdout/stderr -> .acp/cards/<cardId>/run-<N>.log,
//   4. on exit writes one `kind: 'card'` event to activity.json,
//      releases the claim, and NEVER moves the card.
//
// Modes:
//   node server/acp-runner.mjs --once      # single pass, then exit (tests)
//   node server/acp-runner.mjs --serve     # loop with the roles' poll interval
//   node server/acp-runner.mjs --stop-all  # release own claims, kill own procs
//
// Env: STATE_URL (default http://127.0.0.1:25900), ROOT_DIR (directory the
// project paths must live under; default $HOME/projects), DRY_RUN=1 (print
// the command instead of spawning), RUNNER_ID (default `runner-<pid>`).
//
// Guards: timeoutMin -> SIGTERM, SIGKILL after 10 s; maxConcurrent per role
// is strict; cards in done/backlog or flagged blocked/cancelled are never
// taken; an unreachable state server is reported on stderr without exiting
// (in --serve); cards are never moved.
//
// Node only, zero dependencies.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const STATE_URL = (process.env.STATE_URL || 'http://127.0.0.1:25900').replace(/\/+$/, '');
const ROOT_DIR = resolve(process.env.ROOT_DIR || join(homedir(), 'projects'));
const DRY_RUN = process.env.DRY_RUN === '1';
const RUNNER_ID = process.env.RUNNER_ID || `runner-${process.pid}`;

const RETRY_TRIES = 6;
const RETRY_DELAY_MS = 300;
const KILL_GRACE_MS = 10_000;
const MAX_ENTRIES = 5000;

// pid -> ChildProcess for runs started by this process (used by --stop-all).
const liveProcs = new Map();

// ---------------------------------------------------------------------------
// State-server HTTP client (same protocol as server/acp-state-server.mjs:
// GET/PUT /api/state/:name with {data, rev}; rev mismatch -> 409).
// ---------------------------------------------------------------------------

async function req(method, path, body) {
  const res = await fetch(`${STATE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = {};
  try {
    payload = JSON.parse((await res.text()) || '{}');
  } catch {
    payload = {};
  }
  return { status: res.status, payload };
}

async function readDoc(name, fallback) {
  const { status, payload } = await req('GET', `/api/state/${name}`);
  if (status === 404) return { data: structuredClone(fallback), rev: 0 };
  if (status !== 200) throw new Error(`GET ${name} -> ${status}`);
  return { data: payload.data ?? structuredClone(fallback), rev: Number(payload.rev) || 0 };
}

async function writeDoc(name, data, rev) {
  const { status, payload } = await req('PUT', `/api/state/${name}`, { data, rev });
  if (status === 409) {
    const err = new Error(`rev conflict on ${name}`);
    err.code = 'REV_CONFLICT';
    throw err;
  }
  if (status !== 200) throw new Error(`PUT ${name} -> ${status}`);
  return Number(payload.rev) || 0;
}

async function mutate(name, fallback, fn, tries = RETRY_TRIES) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const { data, rev } = await readDoc(name, fallback);
    const next = fn(structuredClone(data));
    try {
      await writeDoc(name, next, rev);
      return next;
    } catch (e) {
      if (e && e.code === 'REV_CONFLICT') {
        last = e;
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`${name}: lost ${tries} revision races (${last})`);
}

// ---------------------------------------------------------------------------
// Model helpers (mirror scripts/boardctl: live claim = leaseUntil > now).
// ---------------------------------------------------------------------------

function liveClaims(claimsDoc, now = Date.now()) {
  const out = {};
  for (const [cid, claim] of Object.entries(claimsDoc.claims || {})) {
    if (Number(claim?.leaseUntil) > now) out[cid] = claim;
  }
  return out;
}

function emptyBoard() {
  return { version: 2, cards: [] };
}
function emptyProjects() {
  return { version: 1, projects: [], activeProjectId: 'all' };
}
function emptyRoles() {
  return { version: 1, roles: [], stageRoles: {} };
}
function emptyClaims() {
  return { version: 1, claims: {} };
}
function emptyActivity() {
  return { entries: [], usage: [] };
}

function underRoot(p) {
  const abs = resolve(p);
  return abs === ROOT_DIR || abs.startsWith(ROOT_DIR + sep);
}

function runDir(projectPath, cardId) {
  return join(resolve(projectPath), '.acp', 'cards', String(cardId));
}

async function nextRunIndex(dir) {
  let n = 1;
  try {
    for (const f of await fs.readdir(dir)) {
      const m = /^run-(\d+)\.log$/.exec(f);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  return n;
}

// Verdict hint: last STATUS: line of the newest 05_*/04_* artefact.
async function verdictHint(dir) {
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => /^(04_|05_)/.test(f)).sort();
  } catch {
    return '';
  }
  for (let i = files.length - 1; i >= 0; i--) {
    try {
      const lines = (await fs.readFile(join(dir, files[i]), 'utf-8')).split('\n');
      for (let j = lines.length - 1; j >= 0; j--) {
        const m = /STATUS:\s*(DONE|BLOCKED|CHANGES_REQUIRED)\s*$/.exec(lines[j].trim());
        if (m) return `${files[i]}: ${m[0]}`;
      }
    } catch {
      // Unreadable artefact — try the next one.
    }
  }
  return '';
}

function cmdForLog(cli, args) {
  return [cli, ...(args || [])].join(' ');
}

function briefText(card, dir, role) {
  return [
    `# ${card.id} — ${card.title || '(no title)'}`,
    '',
    `acceptance: ${card.acceptance || '-'}`,
    `verification: ${card.verification || '-'}`,
    `artifacts: ${dir}/`,
    `role file: ${role.promptFile || '-'}`,
    '',
    'Последней строкой отчёта пиши `STATUS: DONE|BLOCKED|CHANGES_REQUIRED`.',
    '',
  ].join('\n');
}

async function appendActivity({ agentName, cwd, title, detail }) {
  await mutate('activity.json', emptyActivity(), (doc) => {
    doc.entries = doc.entries || [];
    doc.usage = doc.usage || [];
    doc.entries.push({
      id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`,
      at: Date.now(),
      kind: 'card',
      agentName,
      cwd,
      title,
      detail,
    });
    doc.entries = doc.entries.slice(-MAX_ENTRIES);
    return doc;
  });
}

async function releaseClaim(cardId, agentName) {
  try {
    await mutate('claims.json', emptyClaims(), (doc) => {
      const cur = (doc.claims || {})[cardId];
      if (cur && cur.agentName === agentName) delete doc.claims[cardId];
      doc.version = 1;
      return doc;
    });
  } catch (e) {
    console.error(`release claim ${cardId}: ${e.message}`);
  }
}

// Claim a card rev-safely. Returns the claim, or null when someone else
// holds a live claim (their lease wins; we never steal).
async function claimCard(card, role, timeoutMin, pid) {
  const agentName = `${RUNNER_ID}:${role.id}`;
  let rival = null;
  await mutate('claims.json', emptyClaims(), (doc) => {
    doc.claims = doc.claims || {};
    const cur = doc.claims[card.id];
    if (cur && Number(cur.leaseUntil) > Date.now() && cur.agentName !== agentName) {
      rival = cur;
      return doc;
    }
    const prev = doc.claims[card.id] || {};
    const now = Date.now();
    doc.claims[card.id] = {
      agentName,
      sessionId: prev.sessionId || '',
      leaseUntil: now + timeoutMin * 60_000,
      startedAt: prev.startedAt || now,
      claimedAt: now,
      pid: pid ?? null,
      roleId: role.id,
      runnerId: RUNNER_ID,
    };
    doc.version = 1;
    return doc;
  });
  if (rival) return null;
  const { data } = await readDoc('claims.json', emptyClaims());
  const cur = (data.claims || {})[card.id];
  return cur && cur.agentName === agentName ? cur : null;
}

// ---------------------------------------------------------------------------
// One card run: brief -> claim -> spawn -> wait (with timeout) ->
// ledger -> release. The card itself is never modified.
// ---------------------------------------------------------------------------

async function runCard(card, project, role) {
  const agentName = `${RUNNER_ID}:${role.id}`;
  const timeoutMin = Number(role.timeoutMin) > 0 ? Number(role.timeoutMin) : 45;
  const dir = runDir(project.path, card.id);
  const runN = await nextRunIndex(dir);
  await fs.mkdir(dir, { recursive: true });

  const briefPath = join(dir, '00_brief.md');
  await fs.writeFile(briefPath, briefText(card, dir, role), 'utf-8');

  const promptLine = `Прочитай бриф ${briefPath} и файл роли ${role.promptFile || '(нет)'}.`;
  const args = [...(role.args || []), promptLine];

  if (DRY_RUN) {
    console.log(`[dry-run] ${cmdForLog(role.cli, args)} (cwd=${project.path})`);
    return { card: card.id, dryRun: true };
  }

  const pre = await claimCard(card, role, timeoutMin, null);
  if (!pre) return { card: card.id, skipped: 'claim-lost' };

  const startedAt = Date.now();
  const logPath = join(dir, `run-${runN}.log`);
  await fs.writeFile(logPath, '', 'utf-8');
  const outChunks = [];
  const errChunks = [];
  const child = spawn(role.cli, args, {
    cwd: resolve(project.path),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => outChunks.push(c));
  child.stderr.on('data', (c) => errChunks.push(c));
  // Attach the exit wait SYNCHRONOUSLY at spawn: a fast child can 'close'
  // before any later await yields, and a late .on('close') would never fire.
  const exitPromise = new Promise((resolveDone) => {
    child.on('error', () => resolveDone(127));
    child.on('close', (code) => resolveDone(code ?? 127));
  });
  liveProcs.set(child.pid, child);
  // Publish the real pid rev-safely (only if the claim is still ours).
  try {
    await mutate('claims.json', emptyClaims(), (doc) => {
      const cur = (doc.claims || {})[card.id];
      if (cur && cur.agentName === agentName) cur.pid = child.pid;
      return doc;
    });
  } catch (e) {
    console.error(`publish pid ${card.id}: ${e.message}`);
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already exited */
    }
    const finisher = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }, KILL_GRACE_MS);
    finisher.unref?.();
  }, timeoutMin * 60_000);
  timeout.unref?.();

  const exitCode = await exitPromise;
  clearTimeout(timeout);
  liveProcs.delete(child.pid);
  await fs.writeFile(
    logPath,
    Buffer.concat([
      ...outChunks,
      ...(errChunks.length ? [Buffer.from('\n--- stderr ---\n'), ...errChunks] : []),
    ]),
  );

  const secs = Math.round((Date.now() - startedAt) / 1000);
  const verdict = await verdictHint(dir);
  await appendActivity({
    agentName,
    cwd: resolve(project.path),
    title: card.title || card.id,
    detail: [
      `cmd: ${cmdForLog(role.cli, args)}`,
      `exit=${exitCode}`,
      `dur=${secs}s`,
      timedOut ? 'timeout' : 'finished',
      verdict ? `verdict: ${verdict}` : 'verdict: none',
      `log: run-${runN}.log`,
    ].join(' '),
  });
  await releaseClaim(card.id, agentName);
  return { card: card.id, exitCode, log: logPath };
}

// ---------------------------------------------------------------------------
// A pass: read docs, pick candidates, run them sequentially.
// ---------------------------------------------------------------------------

async function pollIntervalMs() {
  try {
    const { data } = await readDoc('roles.json', emptyRoles());
    const secs = (data.roles || [])
      .map((r) => Number(r?.pollIntervalSec))
      .filter((n) => Number.isFinite(n) && n >= 1);
    return (secs.length ? Math.min(...secs) : 15) * 1000;
  } catch {
    return 15_000;
  }
}

async function passOnce() {
  const [{ data: board }, { data: projects }, { data: roles }, { data: claims }] =
    await Promise.all([
      readDoc('board.json', emptyBoard()),
      readDoc('projects.json', emptyProjects()),
      readDoc('roles.json', emptyRoles()),
      readDoc('claims.json', emptyClaims()),
    ]);

  const now = Date.now();
  const live = liveClaims(claims, now);
  const roleById = new Map((roles.roles || []).map((r) => [r?.id, r]));
  const running = new Map(); // roleId -> live claims held now
  for (const c of Object.values(live)) {
    const rid = c.roleId || String(c.agentName || '').split(':').slice(1).join(':');
    if (rid) running.set(rid, (running.get(rid) || 0) + 1);
  }

  const results = [];
  const taken = new Map(); // roleId -> cards started this pass
  for (const card of board.cards || []) {
    const stage = card?.stage;
    if (stage === 'done' || stage === 'backlog') continue;
    if (card?.blocked || card?.cancelled) continue;
    const roleId = (roles.stageRoles || {})[stage];
    if (!roleId) continue;
    const role = roleById.get(roleId);
    if (!role || !role.cli) continue;
    if (live[card.id]) continue;
    const maxC = Number(role.maxConcurrent) >= 1 ? Math.floor(Number(role.maxConcurrent)) : 1;
    if ((running.get(roleId) || 0) + (taken.get(roleId) || 0) >= maxC) continue;
    const project = (projects.projects || []).find((p) => p?.id === card.project) || null;
    if (!project || !project.path || !underRoot(project.path)) {
      console.error(
        `skip ${card.id}: project ${JSON.stringify(card.project)} missing or outside ROOT_DIR`,
      );
      continue;
    }
    taken.set(roleId, (taken.get(roleId) || 0) + 1);
    try {
      results.push(await runCard(card, project, role));
    } catch (e) {
      console.error(`run ${card.id}: ${e.message}`);
      await releaseClaim(card.id, `${RUNNER_ID}:${role.id}`);
      results.push({ card: card.id, error: e.message });
    }
    // Refresh the live-claim view so later cards see our releases.
    try {
      const { data } = await readDoc('claims.json', emptyClaims());
      for (const k of Object.keys(live)) delete live[k];
      Object.assign(live, liveClaims(data, Date.now()));
      running.clear();
      for (const c of Object.values(live)) {
        const rid = c.roleId || String(c.agentName || '').split(':').slice(1).join(':');
        if (rid) running.set(rid, (running.get(rid) || 0) + 1);
      }
    } catch {
      /* keep going with the stale view */
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// --stop-all: kill live procs, release own claims. No live process remains.
// ---------------------------------------------------------------------------

async function stopAll() {
  let killed = 0;
  for (const [pid, child] of [...liveProcs]) {
    try {
      child.kill('SIGTERM');
      killed++;
    } catch {
      /* gone */
    }
    liveProcs.delete(pid);
  }
  // Belt and braces: our claims carry pids — SIGTERM those too (same host).
  let released = 0;
  try {
    await mutate('claims.json', emptyClaims(), (doc) => {
      for (const [cid, c] of Object.entries(doc.claims || {})) {
        if (c?.runnerId === RUNNER_ID || String(c?.agentName || '').startsWith(`${RUNNER_ID}:`)) {
          if (Number(c?.pid) > 0) {
            try {
              process.kill(Number(c.pid), 'SIGTERM');
              killed++;
            } catch {
              /* gone */
            }
          }
          delete doc.claims[cid];
          released++;
        }
      }
      return doc;
    });
  } catch (e) {
    console.error(`stop-all: ${e.message}`);
    process.exitCode = 1;
  }
  await new Promise((r) => setTimeout(r, 500));
  console.log(JSON.stringify({ killed, released }));
}

// ---------------------------------------------------------------------------
// Entry.
// ---------------------------------------------------------------------------

const mode = process.argv[2];
if (mode === '--stop-all') {
  await stopAll();
} else if (mode === '--once') {
  try {
    const results = await passOnce();
    console.log(JSON.stringify({ ok: true, runs: results }, null, 2));
  } catch (e) {
    console.error(`runner: ${e.message}`);
    process.exitCode = 1;
  }
} else if (mode === '--serve') {
  let stopped = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (stopped) process.exit(0);
      stopped = true;
      console.error(`runner: ${sig}, stopping after this pass…`);
    });
  }
  while (!stopped) {
    try {
      const results = await passOnce();
      const ran = results.filter((r) => !r.skipped && !r.dryRun && !r.error).length;
      if (ran) console.log(JSON.stringify({ at: new Date().toISOString(), runs: results }));
    } catch (e) {
      console.error(`runner: ${e.message}`);
    }
    if (stopped) break;
    const waitMs = await pollIntervalMs();
    await new Promise((r) => setTimeout(r, waitMs));
  }
} else {
  console.error('usage: node server/acp-runner.mjs --once | --serve | --stop-all');
  process.exitCode = 2;
}
