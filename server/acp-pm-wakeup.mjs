// acp-pm-wakeup.mjs — the alarm clock for the `pm` board-graph reviewer.
//
// The pm role (a roles.json entry with id `pm`, prompt .acp/roles/pm.md)
// used to run only when a human pushed a trigger card into a pm-bound
// stage. This script is the self-wake: fired by acp-pm-wakeup.timer (or
// by hand), it runs ONE pm session — and only when there is settled work
// to look at. Gates, in order:
//   1. board.json content is identical to the last wakeup's post-run
//      snapshot (sha256 kept in the pm-wakeup.json state doc) -> exit 0;
//   2. the board was written inside PM_QUIET_MIN (default 10) -> exit 0:
//      a burst of edits earns ONE run after it settles, not one per tick;
//   3. a live claims.json entry belongs to the pm role (a manual dispatch
//      is already reviewing) -> exit 0;
//   4. the newest pm ledger entry is younger than the same quiet window
//      (a manual run that just finished = the board was just reviewed)
//      -> exit 0.
// A skipped tick is FREE: a couple of GETs, a hash compare, exit — nothing
// is written, so a quiet night costs no model calls and no ledger rows.
//
// A run that does fire is a real pm session. The role's cli + args come
// from roles.json and are spawned exactly like acp-runner spawns them —
// args, then `--prompt-file <brief>` — but there is no card, so nothing is
// claimed and no stage binding is needed. The brief (no trigger card:
// scope defaults to --all / PM_SCOPE, report path under the run dir)
// lands in .acp/pm/wakeup/<session>/brief.md, stdout/stderr in run.log,
// and both the start and the outcome (exit, duration, report verdict) go
// to activity.json as kind:'pm' entries with role:'pm'. A crashed run
// cannot leave the board half-edited: pm only writes through
// `pmgraph apply`, which is atomic by design.
//
//   node server/acp-pm-wakeup.mjs            # guarded one-shot (timer path)
//   node server/acp-pm-wakeup.mjs --force    # run now, skip gates 1-4
//
// Env: STATE_URL (default http://127.0.0.1:25900), PM_ROLE_ID ('pm'),
// PM_SCOPE (project label; empty -> the brief asks for --all),
// PM_QUIET_MIN (default 10 — also the min gap after any pm activity),
// PM_WAKEUP_DIR (default <repo>/.acp/pm/wakeup), PM_WAKEUP_DOC (state doc
// name, default 'pm-wakeup.json'), PM_KIND/PM_SESSION_PREFIX/PM_REPORT_NAME
// (per-role overrides — default to the role id), PM_BRIEF_FILE (brief
// template path; {{session}} {{runDir}} {{reportPath}} {{promptFile}}
// {{scope}} {{digest}} placeholders, the last one from PM_DIGEST_PATH),
// DRY_RUN=1 (print the command, spawn nothing — gates still apply).
// Exit: 0 ran / nothing to do; 2 the role is not configured; 3 the state
// server is unreachable.
//
// Node only, zero dependencies.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_URL = (process.env.STATE_URL || 'http://127.0.0.1:25900').replace(/\/+$/, '');
const ROLE_ID = process.env.PM_ROLE_ID || 'pm';
// The script is generic over the role: pm defaults keep the original
// behaviour, another roles.json id (e.g. researcher) reuses the same
// guarded-spawn machinery via these envs.
const KIND = process.env.PM_KIND || ROLE_ID;          // activity.json kind
const SESSION_PREFIX = process.env.PM_SESSION_PREFIX || `${ROLE_ID}wake`;
const REPORT_NAME = process.env.PM_REPORT_NAME || `${ROLE_ID}-report.md`;
const BRIEF_FILE = (process.env.PM_BRIEF_FILE || '').trim();
const SCOPE = (process.env.PM_SCOPE || '').trim();
const QUIET_MIN =
  (process.env.PM_QUIET_MIN ?? '') !== '' &&
  Number.isFinite(Number(process.env.PM_QUIET_MIN))
    ? Math.max(0, Number(process.env.PM_QUIET_MIN))
    : 10;
const WAKE_DIR = process.env.PM_WAKEUP_DIR
  ? resolve(process.env.PM_WAKEUP_DIR)
  : join(REPO_ROOT, '.acp', 'pm', 'wakeup');
const WAKE_DOC = /^[a-z0-9._-]{1,64}$/.test(process.env.PM_WAKEUP_DOC || '')
  ? process.env.PM_WAKEUP_DOC
  : 'pm-wakeup.json';
const DRY_RUN = process.env.DRY_RUN === '1';
const FORCE = process.argv.includes('--force');

const RETRY_TRIES = 6;
const RETRY_DELAY_MS = 300;
const KILL_GRACE_MS = 10_000;
const MAX_ENTRIES = 5000;
const KEEP_RUNS = 20;
// A `running` slot older than this is treated as stale even if its pid is
// alive — pids get recycled, and a wedged slot must not skip forever.
const STALE_SLOT_MS = 3 * 60 * 60_000;

// ---------------------------------------------------------------------------
// State-server HTTP client (same protocol as acp-runner: GET/PUT
// /api/state/:name with {data, rev}; rev mismatch -> 409).
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
  if (status === 404) return { data: structuredClone(fallback), rev: 0, updatedAt: 0 };
  if (status !== 200) throw new Error(`GET ${name} -> ${status}`);
  return {
    data: payload.data ?? structuredClone(fallback),
    rev: Number(payload.rev) || 0,
    updatedAt: Number(payload.updatedAt) || 0,
  };
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

const emptyActivity = () => ({ entries: [], usage: [] });
const emptyWakeup = () => ({
  version: 1,
  running: null,
  lastBoardHash: '',
  lastRunAt: 0,
  lastSession: '',
  lastExit: null,
  lastVerdict: '',
});

// ---------------------------------------------------------------------------
// Helpers shared in spirit with acp-runner (kept local: the runner is a
// script, not a library — duplicating 30 lines beats importing a main()).
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

function boardHash(data) {
  // `data` is pure content (cards + version) — the doc envelope's rev /
  // updatedAt stay out of the hash on purpose.
  return createHash('sha256').update(JSON.stringify(data ?? {})).digest('hex');
}

async function appendActivity({ title, detail, sessionId, model }) {
  await mutate('activity.json', emptyActivity(), (doc) => {
    doc.entries = doc.entries || [];
    doc.usage = doc.usage || [];
    doc.entries.push({
      id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`,
      at: Date.now(),
      kind: KIND,
      agentName: `${KIND}-wakeup`,
      cwd: REPO_ROOT,
      title,
      detail,
      role: ROLE_ID,
      sessionId: sessionId || '',
      ...(model ? { model } : {}),
    });
    doc.entries = doc.entries.slice(-MAX_ENTRIES);
    return doc;
  });
}

// The slot is live only while its pid runs AND it is younger than the
// staleness bound — pidAlive alone is fooled by a recycled pid.
function slotLive(running, now = Date.now()) {
  return (
    !!running &&
    now - Number(running.at || 0) < STALE_SLOT_MS &&
    pidAlive(running.pid)
  );
}

// A wakeup run claims no card — the "slot" is the wakeup doc itself, taken
// rev-safely so a hand-invoked copy and the timer can never double-run.
// Returns the session id, or null when another wakeup process holds it.
async function takeSlot(session) {
  let lost = false;
  await mutate(WAKE_DOC, emptyWakeup(), (doc) => {
    if (slotLive(doc.running)) {
      lost = true;
      return doc;
    }
    doc.running = { pid: process.pid, at: Date.now(), session, childPid: null };
    doc.version = 1;
    return doc;
  });
  return lost ? null : session;
}

// Publish the spawned child pid into the slot — journalctl and a human
// checking pm-wakeup.json can see exactly what is running.
async function publishChildPid(session, childPid) {
  try {
    await mutate(WAKE_DOC, emptyWakeup(), (doc) => {
      if (doc.running && doc.running.session === session) {
        doc.running.childPid = childPid;
      }
      doc.version = 1;
      return doc;
    });
  } catch (e) {
    console.error(`publish pid: ${e.message}`);
  }
}

// Record the outcome: release the slot and snapshot the board hash AFTER
// the run — a pm session that edited the board must not retrigger itself
// on the next tick (the post-apply graph is what pm just reviewed).
async function finishSlot(session, { exitCode, verdict }) {
  let hash = '';
  try {
    const board = await readDoc('board.json', { version: 2, cards: [] });
    hash = boardHash(board.data);
  } catch (e) {
    console.error(`post-run board read: ${e.message}`);
  }
  await mutate(WAKE_DOC, emptyWakeup(), (doc) => {
    if (doc.running && doc.running.session === session) doc.running = null;
    if (hash) doc.lastBoardHash = hash;
    doc.lastRunAt = Date.now();
    doc.lastSession = session;
    doc.lastExit = exitCode;
    doc.lastVerdict = verdict || '';
    doc.version = 1;
    return doc;
  });
}

// Record a consumed change without a run (e.g. role not configured): the
// hash still advances so a dead config is not re-reported every tick.
async function consumeHash(hash) {
  await mutate(WAKE_DOC, emptyWakeup(), (doc) => {
    doc.lastBoardHash = hash;
    doc.lastRunAt = Date.now();
    doc.version = 1;
    return doc;
  });
}

// Same model contract as acp-runner: role.models = {plan, execute}; a
// wakeup has no card and no stage, so the execute model applies.
const MODEL_REF_RE = /\{models\.(?:plan|execute)\}/g;
function stepModel(role) {
  const m = role?.models;
  const v = m && typeof m === 'object' ? m.execute : null;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function substArgs(args, model) {
  if (!model) return [...(args || [])];
  return (args || []).map((a) => String(a).replace(MODEL_REF_RE, model));
}

// Last STATUS: line of a report file — same convention the runner's
// verdictHint uses on 04_*/05_* artefacts.
async function verdictOf(reportPath) {
  try {
    const lines = (await fs.readFile(reportPath, 'utf-8')).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /STATUS:\s*(DONE|BLOCKED|CHANGES_REQUIRED|OK|SKIP)\s*$/.exec(lines[i].trim());
      if (m) return m[1];
    }
  } catch {
    // No report — the end row says 'verdict: none'.
  }
  return '';
}

async function pruneRuns() {
  let dirs = [];
  try {
    dirs = (await fs.readdir(WAKE_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return;
  }
  for (const old of dirs.slice(0, Math.max(0, dirs.length - KEEP_RUNS))) {
    await fs.rm(join(WAKE_DIR, old), { recursive: true, force: true }).catch(() => {});
  }
}

function briefText({ session, runDir, reportPath, promptFile }) {
  // Non-pm roles can bring their own template (PM_BRIEF_FILE) with
  // {{session}} {{runDir}} {{reportPath}} {{promptFile}} {{scope}}
  // placeholders — the pm default below keeps the original wording.
  if (BRIEF_FILE) {
    // sync read is fine here: small file, once per run
    const tpl = readFileSync(BRIEF_FILE, 'utf-8');
    return tpl
      .replaceAll('{{session}}', session)
      .replaceAll('{{runDir}}', runDir)
      .replaceAll('{{reportPath}}', reportPath)
      .replaceAll('{{promptFile}}', promptFile)
      .replaceAll('{{scope}}', SCOPE || '--all')
      .replaceAll('{{digest}}', process.env.PM_DIGEST_PATH || '');
  }
  const scopeLine = SCOPE
    ? `скоуп: проект \`${SCOPE}\` — \`pmgraph scan --project '${SCOPE}'\`, ` +
      `\`apply --project '${SCOPE}'\``
    : 'скоуп: вся доска — `pmgraph scan --all`, `pmgraph apply ... --all`';
  return [
    `# Автопрогон pm — ${session}`,
    '',
    'Это автоматический запуск роли pm по расписанию (acp-pm-wakeup).',
    'Карточки-триггера нет — `boardctl show` пропусти.',
    '',
    `- ${scopeLine}`,
    `- файл роли: ${promptFile}`,
    `- артефакты прогона: ${runDir}/`,
    `- отчёт пиши в ${reportPath} (содержание — как 04_pm_report.md;`,
    '  последняя строка `STATUS: DONE | BLOCKED | CHANGES_REQUIRED`)',
    '',
    'Прочитай файл роли и следуй его порядку прогона.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Gates (skipped by --force): a skipped tick writes nothing anywhere.
// ---------------------------------------------------------------------------

function livePmClaim(claimsDoc, now) {
  for (const [cid, claim] of Object.entries(claimsDoc.claims || {})) {
    if (Number(claim?.leaseUntil) <= now) continue;
    const rid = claim.roleId || String(claim.agentName || '').split(':').slice(1).join(':');
    if (rid === ROLE_ID || claim.agentName === ROLE_ID) return cid;
  }
  return null;
}

function lastPmActivityAt(activityDoc) {
  let at = 0;
  for (const e of activityDoc.entries || []) {
    if ((e?.role === ROLE_ID || e?.kind === KIND) && Number(e?.at) > at) {
      at = Number(e.at);
    }
  }
  return at;
}

async function main() {
  const now = Date.now();

  // Gate 0: transport. Nothing is knowable without the server.
  let board, wake, claims, activity;
  try {
    [board, wake, claims, activity] = await Promise.all([
      readDoc('board.json', { version: 2, cards: [] }),
      readDoc(WAKE_DOC, emptyWakeup()),
      readDoc('claims.json', { version: 1, claims: {}, attempts: {} }),
      readDoc('activity.json', emptyActivity()),
    ]);
  } catch (e) {
    console.error(`pm-wakeup: state server unreachable (${e.message})`);
    return 3;
  }

  if (slotLive(wake.data?.running, now)) {
    const r = wake.data.running;
    console.log(JSON.stringify({ skipped: 'running', pid: r.pid, session: r.session }));
    return 0;
  }

  if (!FORCE) {
    if (!(board.data?.cards || []).length) {
      // Nothing to review — and nothing to record: an empty board stays
      // free forever instead of consuming a hash.
      console.log(JSON.stringify({ skipped: 'empty-board' }));
      return 0;
    }
    const hash = boardHash(board.data);
    if (wake.data?.lastBoardHash && hash === wake.data.lastBoardHash) {
      console.log(
        JSON.stringify({ skipped: 'unchanged', since: wake.data.lastSession || null }),
      );
      return 0;
    }
    const quietMs = QUIET_MIN * 60_000;
    if (quietMs > 0 && board.updatedAt && now - board.updatedAt < quietMs) {
      console.log(
        JSON.stringify({
          skipped: 'settling',
          boardAgeSec: Math.round((now - board.updatedAt) / 1000),
          quietMin: QUIET_MIN,
        }),
      );
      return 0;
    }
    const claimCid = livePmClaim(claims.data, now);
    if (claimCid) {
      console.log(
        JSON.stringify({ skipped: `${ROLE_ID}-claim-live`, card: claimCid }),
      );
      return 0;
    }
    const pmAt = lastPmActivityAt(activity.data);
    if (quietMs > 0 && pmAt && now - pmAt < quietMs) {
      console.log(
        JSON.stringify({ skipped: `${KIND}-active`, ageSec: Math.round((now - pmAt) / 1000) }),
      );
      return 0;
    }
  }

  const { data: rolesDoc } = await readDoc('roles.json', { version: 1, roles: [] });
  const role = (rolesDoc.roles || []).find((r) => r && r.id === ROLE_ID);
  const preRunHash = boardHash(board.data);
  if (!role || !role.cli) {
    // A consumed change: the row names the gap once, the hash advance keeps
    // every later tick free. Register the role and the next board change
    // (or --force) runs for real.
    try {
      await appendActivity({
        title: 'pm wakeup',
        detail: `wakeup: role '${ROLE_ID}' not in roles.json — board change consumed, nothing ran`,
      });
      await consumeHash(preRunHash);
    } catch (e) {
      console.error(`pm-wakeup: ${e.message}`);
    }
    console.log(JSON.stringify({ skipped: 'no-role', role: ROLE_ID }));
    return 2;
  }

  const session = `${SESSION_PREFIX}-${now.toString(36)}`;
  if (!(await takeSlot(session))) {
    console.log(JSON.stringify({ skipped: 'slot-lost' }));
    return 0;
  }

  const runDir = join(WAKE_DIR, session);
  const reportPath = join(runDir, REPORT_NAME);
  const promptFile = role.promptFile || join(REPO_ROOT, '.acp', 'roles', `${ROLE_ID}.md`);
  await fs.mkdir(runDir, { recursive: true });
  await pruneRuns();
  const briefPath = join(runDir, 'brief.md');
  await fs.writeFile(
    briefPath,
    briefText({ session, runDir, reportPath, promptFile }),
    'utf-8',
  );

  const model = stepModel(role);
  // The prompt goes to the CLI as a FILE reference, not as a quoted
  // positional argument (long multi-line text on a command line is fragile).
  // Default is the devin/codex convention `--prompt-file <brief>`; a role
  // may override it with `promptFlag` (pi reads @file positionals, so its
  // entry carries promptFlag:"@" and the brief is appended as @<brief>).
  // NOTE: a literal '@'-only flag means "append @<brief>"; any other value
  // is used as the flag name: [...args, promptFlag, briefPath].
  const promptFlag =
    typeof role.promptFlag === 'string' ? role.promptFlag : '--prompt-file';
  const args =
    promptFlag === '@'
      ? [...substArgs(role.args, model), `@${briefPath}`]
      : [...substArgs(role.args, model), promptFlag, briefPath];
  const timeoutMin = Number(role.timeoutMin) > 0 ? Number(role.timeoutMin) : 45;
  const cmdText = [role.cli, ...args].join(' ');

  if (DRY_RUN) {
    console.log(`[dry-run] ${cmdText} (cwd=${REPO_ROOT})`);
    // Release the slot but do NOT record the hash — a dry run must not
    // consume a pending change the next real tick still owes a run for.
    await mutate(WAKE_DOC, emptyWakeup(), (doc) => {
      if (doc.running && doc.running.session === session) doc.running = null;
      doc.version = 1;
      return doc;
    });
    return 0;
  }

  const title = `${ROLE_ID} wakeup ${session}`;
  try {
    await appendActivity({
      title,
      sessionId: session,
      model,
      detail:
        `wakeup start: scope=${SCOPE || '*'} quiet=${QUIET_MIN}m ` +
        `boardRev=${board.rev} cmd: ${cmdText}`,
    });
  } catch (e) {
    console.error(`audit start: ${e.message}`);
  }

  const startedAt = Date.now();
  const child = spawn(role.cli, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // The pm drives boardctl/pmgraph; point both at OUR state server so a
      // non-default STATE_URL (tests, a second host) stays consistent, and
      // publish the run dir for wrappers that place artefacts explicitly.
      BOARD_URL: STATE_URL,
      SESSION_ID: session,
      PM_WAKEUP_RUN_DIR: runDir,
      TERM: process.env.TERM || 'dumb',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const outChunks = [];
  const errChunks = [];
  child.stdout.on('data', (c) => outChunks.push(c));
  child.stderr.on('data', (c) => errChunks.push(c));
  const exitPromise = new Promise((resolveDone) => {
    child.on('error', () => resolveDone(127));
    child.on('close', (code) => resolveDone(code ?? 127));
  });
  await publishChildPid(session, child.pid);

  // One termination path, same shape as the runner's: SIGTERM, SIGKILL
  // after the grace window.
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

  const logPath = join(runDir, 'run.log');
  await fs.writeFile(
    logPath,
    Buffer.concat([
      ...outChunks,
      ...(errChunks.length ? [Buffer.from('\n--- stderr ---\n'), ...errChunks] : []),
    ]),
  );

  const secs = Math.round((Date.now() - startedAt) / 1000);
  const verdict = await verdictOf(reportPath);
  try {
    await appendActivity({
      title,
      sessionId: session,
      model,
      detail:
        `wakeup ${session}: exit=${exitCode} dur=${secs}s ` +
        `${timedOut ? 'timeout' : 'finished'} ` +
        `verdict: ${verdict || 'none'} log: .acp/pm/wakeup/${session}/run.log`,
    });
  } catch (e) {
    console.error(`audit end: ${e.message}`);
  }
  try {
    await finishSlot(session, { exitCode, verdict });
  } catch (e) {
    console.error(`finish ${session}: ${e.message}`);
  }

  console.log(
    JSON.stringify({ ran: session, exit: exitCode, secs, verdict: verdict || null }),
  );
  return exitCode === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error(`pm-wakeup: ${e.message}`);
  process.exitCode = 1;
}
