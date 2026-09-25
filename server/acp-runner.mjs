// acp-runner.mjs — thin "board -> CLI" host service for the ACP UI panel.
//
// The runner is deliberately dumb: it knows no prompts and does no planning.
// For every card whose stage is bound to a role (roles.json `stageRoles`)
// and that holds no live claim, it:
//   1. puts a rev-safe claim into `claims.json` (lease + pid + runnerPid +
//      the stage the card was claimed from),
//   2. writes a SHORT brief to <projectPath>/.acp/cards/<cardId>/00_brief.md
//      (first deriving 03_checklist.md from 02_plan.md's list items when it
//      is missing — an existing checklist is progress state and is never
//      regenerated — and naming the first open item in the brief),
//   3. spawns the role's CLI with cwd = projectPath (up to `maxRetries`
//      attempts on a non-zero exit), stdout/stderr -> run-<N>.log,
//   4. renews `leaseUntil` on a heartbeat while the child runs,
//   5. on exit writes `kind: 'card'` events (with `role` + `sessionId`) to
//      activity.json, releases the claim, and NEVER moves the card.
//
// Modes:
//   node server/acp-runner.mjs --once           # single pass, then exit
//   node server/acp-runner.mjs --serve          # loop with the roles' poll interval
//   node server/acp-runner.mjs stop-all         # SIGTERM own children, release own claims
//   node server/acp-runner.mjs release-all      # release own claims, kill nothing
//   node server/acp-runner.mjs cancel <cardId>  # kill that card's child + flag it blocked
//
// Env: STATE_URL (default http://127.0.0.1:25900), ROOT_DIR (directory the
// project paths must live under; default $HOME/projects), DRY_RUN=1 (print
// the command instead of spawning), RUNNER_ID (default `runner-<pid>`),
// RUNNER_DEBUG=1 (heartbeat/sweep traces on stderr — renewals never hit the
// ledger).
//
// Guards: timeoutMin -> SIGTERM, SIGKILL after 10 s; maxConcurrent per role
// is strict; maxRetries (default 1 = no retry) caps attempts per card and the
// exhausted card is flagged `blocked`; cards in done/backlog or flagged
// blocked/cancelled are never taken; a sweep on every pass drops claims
// whose lease expired while their pid is dead and returns those cards to
// the stage they were claimed from, flagged `blocked`; an unreachable state
// server is reported on stderr without exiting (in --serve); cards are
// never moved. stop-all/cancel only ever signal pids that are still
// children of the runner pid recorded in the claim (or spawned by this
// process) — a foreign runner's process is never touched.
//
// Node only, zero dependencies.

import { spawn, execFileSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const STATE_URL = (process.env.STATE_URL || 'http://127.0.0.1:25900').replace(/\/+$/, '');
const ROOT_DIR = resolve(process.env.ROOT_DIR || join(homedir(), 'projects'));
const DRY_RUN = process.env.DRY_RUN === '1';
const RUNNER_ID = process.env.RUNNER_ID || `runner-${process.pid}`;
const DEBUG = /^(1|true|yes|on)$/i.test(process.env.RUNNER_DEBUG || '');

const RETRY_TRIES = 6;
const RETRY_DELAY_MS = 300;
const KILL_GRACE_MS = 10_000;
const MAX_ENTRIES = 5000;
const MIN_HEARTBEAT_MS = 5_000;

// pid -> ChildProcess for runs started by this process (used by stop-all).
const liveProcs = new Map();

function debug(msg) {
  if (DEBUG) console.error(`[runner ${new Date().toISOString()}] ${msg}`);
}

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
  // `attempts` is the dispatcher's per-card failure counter: it survives
  // claim release so a card cannot be retaken forever. A successful run
  // clears it; exhausting `maxRetries` flags the card blocked.
  return { version: 1, claims: {}, attempts: {} };
}
function emptyActivity() {
  return { entries: [], usage: [] };
}

// Mirrors STAGE_STATUSES in src/stores/board.ts — needed to put a card back
// into the stage it was claimed from without inventing statuses.
const STAGE_STATUSES = {
  backlog: [],
  spec: ['in_progress', 'review', 'done'],
  plan: ['in_progress', 'review', 'done'],
  dev: ['in_progress', 'review', 'done'],
  reviewtest: ['in_progress', 'agent_tested', 'accepted'],
  done: [],
};
const validStage = (s) => Object.prototype.hasOwnProperty.call(STAGE_STATUSES, s);
const initialStatusFor = (s) => (STAGE_STATUSES[s] || [])[0] ?? null;

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

// Plan-queue: 03_checklist.md is the card's in-plan progress state. It is
// DERIVED from 02_plan.md once — when a run starts and finds it missing —
// then its `- [ ]` / `- [x]` marks belong to the executor (or a hand edit)
// and are never regenerated. The runner only reads the marks: it does not
// parse plans beyond lifting list items into checkboxes.
function planItems(plan) {
  const out = [];
  for (const raw of plan.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const cb = /^[-*]\s+\[([ xX])\]\s*(.*)$/.exec(line);
    if (cb) {
      if (cb[2]) out.push(`- [${cb[1]}] ${cb[2].trim()}`); // keep its mark
      continue;
    }
    const m = /^[-*]\s+(\S.*)$/.exec(line) || /^\d+[.)]\s+(\S.*)$/.exec(line);
    if (m) out.push(`- [ ] ${m[1].trim()}`);
    // Anything else — headers, prose, tables, STATUS lines — is not an item.
  }
  return out;
}

// Returns the checklist text (existing or freshly derived), '' when there is
// no usable plan. An existing file is returned unread for edits — its content
// is the progress state.
async function ensureChecklist(dir) {
  const path = join(dir, '03_checklist.md');
  try {
    return await fs.readFile(path, 'utf-8');
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  let plan = '';
  try {
    plan = await fs.readFile(join(dir, '02_plan.md'), 'utf-8');
  } catch {
    return ''; // no plan yet — nothing to derive
  }
  const items = planItems(plan);
  if (!items.length) return ''; // a plan without list items yields no file
  const text =
    '# Checklist — derived from 02_plan.md; the executor marks items [x]\n\n' +
    `${items.join('\n')}\n`;
  await fs.writeFile(path, text, 'utf-8');
  return text;
}

function firstOpenItem(checklist) {
  for (const raw of checklist.split('\n')) {
    const m = /^\s*[-*]\s+\[ \]\s+(\S.*)$/.exec(raw);
    if (m) return m[1].trim();
  }
  return '';
}

function briefText(card, dir, role, checklist = '') {
  const open = firstOpenItem(checklist);
  return [
    `# ${card.id} — ${card.title || '(no title)'}`,
    '',
    `acceptance: ${card.acceptance || '-'}`,
    `verification: ${card.verification || '-'}`,
    `artifacts: ${dir}/`,
    `role file: ${role.promptFile || '-'}`,
    '',
    'Последней строкой отчёта пиши `STATUS: DONE|BLOCKED|CHANGES_REQUIRED`.',
    ...(open
      ? ['', `Продолжай с первого незакрытого пункта 03_checklist.md: ${open}`]
      : []),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Process liveness / ownership. The dispatcher only ever signals pids it can
// prove are children of the runner that claimed them (or spawned itself).
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

function ppidOf(pid) {
  // Linux fast path.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close > -1) {
      const ppid = Number(stat.slice(close + 1).trim().split(/\s+/)[1]);
      if (Number.isFinite(ppid)) return ppid;
    }
  } catch {
    // No /proc — fall through to `ps`.
  }
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ppid = Number(out.trim());
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

// Is `pid` our own child? True when this process spawned it, or when the
// pid is still parented to the runner pid the claim recorded at spawn time.
// Anything else — recycled pids, orphans reparented to init, other runners'
// children — is not ours and must never be signalled.
function ownChildPid(pid, claim) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (liveProcs.has(n)) return true;
  const rp = Number(claim?.runnerPid);
  return Number.isInteger(rp) && rp > 0 && ppidOf(n) === rp;
}

function ownClaim(c) {
  return (
    !!c &&
    (c.runnerId === RUNNER_ID || String(c.agentName || '').startsWith(`${RUNNER_ID}:`))
  );
}

// ---------------------------------------------------------------------------
// Ledger + claims.
// ---------------------------------------------------------------------------

async function appendActivity({ agentName, cwd, title, detail, role, sessionId }) {
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
      role: role || '',
      sessionId: sessionId || '',
    });
    doc.entries = doc.entries.slice(-MAX_ENTRIES);
    return doc;
  });
}

// Flag a card `blocked` (the board's visible mark — no new card fields) and,
// when `stage` is a valid stage the card moved away from, put it back —
// remembering per-stage statuses exactly like board.ts moveCard does.
async function markCard(cardId, { stage, blockedReason }) {
  let marked = null;
  await mutate('board.json', emptyBoard(), (doc) => {
    const card = (doc.cards || []).find((c) => c && c.id === cardId);
    if (!card) return doc;
    if (stage && validStage(stage) && card.stage !== stage) {
      if (card.status) {
        card.statusByStage = { ...(card.statusByStage || {}), [card.stage]: card.status };
      }
      const remembered = (card.statusByStage || {})[stage];
      card.stage = stage;
      card.status =
        remembered && (STAGE_STATUSES[stage] || []).includes(remembered)
          ? remembered
          : initialStatusFor(stage);
    }
    card.blocked = true;
    card.blockedReason = blockedReason || '';
    card.updatedAt = Date.now();
    marked = card;
    doc.version = 2;
    return doc;
  });
  return marked;
}

async function setAttempts(cardId, n) {
  try {
    await mutate('claims.json', emptyClaims(), (doc) => {
      doc.attempts = doc.attempts || {};
      if (n > 0) doc.attempts[cardId] = n;
      else delete doc.attempts[cardId];
      doc.version = 1;
      return doc;
    });
  } catch (e) {
    console.error(`attempts ${cardId}: ${e.message}`);
  }
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
// holds a live claim (their lease wins; we never steal). The claim records
// the stage the card was in — the lease-expiry sweep puts it back there —
// and this process's pid so kill commands can prove child ownership.
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
      runnerPid: process.pid,
      stage: card.stage,
    };
    doc.version = 1;
    return doc;
  });
  if (rival) return null;
  const { data } = await readDoc('claims.json', emptyClaims());
  const cur = (data.claims || {})[card.id];
  return cur && cur.agentName === agentName ? cur : null;
}

// Heartbeat: extend leaseUntil while our child runs. Debug-level only —
// renewals are not a transition and never hit the ledger.
async function renewLease(cardId, agentName, timeoutMin) {
  try {
    await mutate('claims.json', emptyClaims(), (doc) => {
      const cur = (doc.claims || {})[cardId];
      if (cur && cur.agentName === agentName) {
        cur.leaseUntil = Date.now() + timeoutMin * 60_000;
        cur.hbAt = Date.now();
      }
      doc.version = 1;
      return doc;
    });
    debug(`lease renewed ${cardId} (+${timeoutMin}m)`);
  } catch (e) {
    debug(`lease renewal failed ${cardId}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Expired-lease sweep: runs at the top of every pass. A claim whose lease
// lapsed while its pid is dead is dropped, and its card goes back to the
// stage it was claimed from, visibly flagged — and into the ledger.
// ---------------------------------------------------------------------------

async function sweepExpiredClaims() {
  let claimsDoc;
  try {
    ({ data: claimsDoc } = await readDoc('claims.json', emptyClaims()));
  } catch (e) {
    debug(`sweep: claims read failed: ${e.message}`);
    return;
  }
  const now = Date.now();
  const expired = [];
  for (const [cid, claim] of Object.entries(claimsDoc.claims || {})) {
    if (Number(claim?.leaseUntil) <= now && !pidAlive(claim?.pid)) {
      expired.push([cid, claim]);
    }
  }
  if (!expired.length) return;

  await mutate('claims.json', emptyClaims(), (doc) => {
    for (const [cid] of expired) {
      const cur = (doc.claims || {})[cid];
      if (cur && Number(cur.leaseUntil) <= Date.now() && !pidAlive(cur.pid)) {
        delete doc.claims[cid];
      }
    }
    doc.version = 1;
    return doc;
  });

  for (const [cid, claim] of expired) {
    try {
      const card = await markCard(cid, {
        stage: validStage(claim?.stage) ? claim.stage : null,
        blockedReason: `claim expired (${claim?.agentName || 'unknown'})`,
      });
      await appendActivity({
        agentName: RUNNER_ID,
        title: card?.title || cid,
        role: claim?.roleId || '',
        sessionId: claim?.sessionId || '',
        detail:
          `lease expired — claim dropped for ${cid} ` +
          `(held by ${claim?.agentName || '?'}); card returned to ` +
          `${card?.stage || claim?.stage || '?'} flagged blocked`,
      });
      debug(`swept expired claim ${cid} (was held by ${claim?.agentName || '?'})`);
    } catch (e) {
      console.error(`sweep ${cid}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// One card run: brief -> claim -> spawn/wait (heartbeat + timeout), retrying
// non-zero exits up to maxRetries -> ledger -> release. Never moves a card.
// ---------------------------------------------------------------------------

// Session-id sniffing: CLIs surface it as `session_id: x`, `sessionId=x`,
// or an uppercase `SESSION: x` convention line (same style as `STATUS:`).
const SESSION_RE =
  /\bsession[\s_-]?id\s*[:=]\s*["']?([A-Za-z0-9][\w.-]{2,})|\bSESSION:\s*["']?([A-Za-z0-9][\w.-]{2,})/i;

function maxAttemptsFor(role) {
  const n = Math.floor(Number(role?.maxRetries));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

async function runCard(card, project, role, attemptsSoFar) {
  const agentName = `${RUNNER_ID}:${role.id}`;
  const timeoutMin = Number(role.timeoutMin) > 0 ? Number(role.timeoutMin) : 45;
  const maxAttempts = maxAttemptsFor(role);
  const dir = runDir(project.path, card.id);
  await fs.mkdir(dir, { recursive: true });

  const checklist = await ensureChecklist(dir);
  const briefPath = join(dir, '00_brief.md');
  await fs.writeFile(briefPath, briefText(card, dir, role, checklist), 'utf-8');

  const promptLine = `Прочитай бриф ${briefPath} и файл роли ${role.promptFile || '(нет)'}.`;
  // The prompt goes to the CLI as a FILE, not as a quoted positional argument
  // (long multi-line text on a command line is fragile). The role's args MUST
  // carry the print/one-shot flag itself (devin: `-p`, pi: `-p`, codex: exec):
  // --prompt-file alone leaves devin in interactive REPL mode, which dies with
  // "Scrollback error: io error" when there is no TTY.
  const args = [...(role.args || []), '--prompt-file', briefPath];

  if (DRY_RUN) {
    console.log(`[dry-run] ${cmdForLog(role.cli, args)} (cwd=${project.path})`);
    return { card: card.id, dryRun: true };
  }

  const pre = await claimCard(card, role, timeoutMin, null);
  if (!pre) return { card: card.id, skipped: 'claim-lost' };

  const cwd = resolve(project.path);
  const title = card.title || card.id;
  let sessionId = pre.sessionId || '';
  await appendActivity({
    agentName,
    cwd,
    title,
    role: role.id,
    sessionId,
    detail: `claimed ${card.id} lease=${timeoutMin}m role=${role.id}`,
  });

  // Heartbeat: pollIntervalSec as the tick, never below 5 s.
  const hbMs = Math.max(
    MIN_HEARTBEAT_MS,
    Math.floor((Number(role.pollIntervalSec) || 15) * 1000),
  );
  const hb = setInterval(() => {
    void renewLease(card.id, agentName, timeoutMin);
  }, hbMs);
  hb.unref?.();

  try {
    for (let attempt = attemptsSoFar + 1; attempt <= maxAttempts; attempt++) {
      const runN = await nextRunIndex(dir);
      const logPath = join(dir, `run-${runN}.log`);
      await fs.writeFile(logPath, '', 'utf-8');
      const startedAt = Date.now();
      const outChunks = [];
      const errChunks = [];
      const child = spawn(role.cli, args, {
        cwd,
        env: {
          ...process.env,
          // No TTY here (stdio are pipes): without TERM set the devin CLI's
          // scrollback layer dies with "Scrollback error: io error".
          TERM: process.env.TERM || 'dumb',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let scanTail = '';
      child.stdout.on('data', (c) => {
        outChunks.push(c);
        if (!sessionId) {
          scanTail = (scanTail + c.toString('utf8')).slice(-65536);
          const m = SESSION_RE.exec(scanTail);
          const sid = m ? m[1] || m[2] : null;
          if (sid) {
            sessionId = sid;
            void (async () => {
              try {
                await mutate('claims.json', emptyClaims(), (doc) => {
                  const cur = (doc.claims || {})[card.id];
                  if (cur && cur.agentName === agentName && !cur.sessionId) {
                    cur.sessionId = sessionId;
                  }
                  doc.version = 1;
                  return doc;
                });
              } catch (e) {
                debug(`publish sessionId ${card.id}: ${e.message}`);
              }
            })();
          }
        }
      });
      child.stderr.on('data', (c) => errChunks.push(c));
      // Attach the exit wait SYNCHRONOUSLY at spawn: a fast child can 'close'
      // before any later await yields, and a late .on('close') never fires.
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
          doc.version = 1;
          return doc;
        });
      } catch (e) {
        console.error(`publish pid ${card.id}: ${e.message}`);
      }

      await appendActivity({
        agentName,
        cwd,
        title,
        role: role.id,
        sessionId,
        detail:
          `start ${card.id} attempt=${attempt}/${maxAttempts} pid=${child.pid} ` +
          `cmd: ${cmdForLog(role.cli, args)}` +
          (attempt > 1 ? ' (retry)' : ''),
      });

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
        cwd,
        title,
        role: role.id,
        sessionId,
        detail: [
          `cmd: ${cmdForLog(role.cli, args)}`,
          `exit=${exitCode}`,
          `dur=${secs}s`,
          `attempt=${attempt}/${maxAttempts}`,
          timedOut ? 'timeout' : 'finished',
          verdict ? `verdict: ${verdict}` : 'verdict: none',
          `log: run-${runN}.log`,
          `role=${role.id}`,
          `session=${sessionId || '-'}`,
        ].join(' '),
      });

      if (exitCode === 0) {
        // A successful retry clears the counter.
        if (attemptsSoFar || attempt > 1) await setAttempts(card.id, 0);
        return { card: card.id, exitCode, log: logPath, attempts: attempt };
      }

      // A non-zero exit while our claim is already gone is not a failed
      // attempt: stop-all / release-all / cancel released it (or a sweep
      // dropped it) — the card keeps whatever mark that path left, and the
      // failure counter is untouched. Only OUR still-held claim's failures
      // count toward maxRetries.
      let claimStillOurs = true;
      try {
        const { data } = await readDoc('claims.json', emptyClaims());
        claimStillOurs = (data.claims || {})[card.id]?.agentName === agentName;
      } catch {
        // Server unreachable mid-bookkeeping — count it like a normal run.
      }
      if (!claimStillOurs) {
        return { card: card.id, exitCode, aborted: true, log: logPath };
      }

      await setAttempts(card.id, attempt);
      if (attempt < maxAttempts) {
        await appendActivity({
          agentName,
          cwd,
          title,
          role: role.id,
          sessionId,
          detail: `retry ${card.id} — exit=${exitCode}, running attempt ${attempt + 1}/${maxAttempts}`,
        });
        continue;
      }

      await markCard(card.id, {
        blockedReason: `maxRetries ${maxAttempts} exhausted (last exit ${exitCode})`,
      });
      await appendActivity({
        agentName,
        cwd,
        title,
        role: role.id,
        sessionId,
        detail: `maxRetries ${maxAttempts} exhausted on ${card.id} — card flagged blocked`,
      });
      return { card: card.id, exitCode, retriesExhausted: true, log: logPath };
    }
  } finally {
    clearInterval(hb);
    await releaseClaim(card.id, agentName);
  }
  return { card: card.id, exitCode: 127 };
}

// ---------------------------------------------------------------------------
// A pass: sweep dead claims, read docs, pick candidates, run sequentially.
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
  await sweepExpiredClaims();

  const [{ data: board }, { data: projects }, { data: roles }, { data: claims }] =
    await Promise.all([
      readDoc('board.json', emptyBoard()),
      readDoc('projects.json', emptyProjects()),
      readDoc('roles.json', emptyRoles()),
      readDoc('claims.json', emptyClaims()),
    ]);

  const now = Date.now();
  const live = liveClaims(claims, now);
  const attempts = claims.attempts || {};
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
    const maxAttempts = maxAttemptsFor(role);
    if ((Number(attempts[card.id]) || 0) >= maxAttempts) {
      // Belt and braces: an exhausted card should already be blocked from
      // the run that exhausted it — flag it again if a hand cleared the mark.
      try {
        await markCard(card.id, {
          blockedReason: `maxRetries ${maxAttempts} exhausted`,
        });
      } catch (e) {
        console.error(`mark ${card.id}: ${e.message}`);
      }
      results.push({ card: card.id, skipped: 'retries-exhausted' });
      continue;
    }
    const maxC = Number(role.maxConcurrent) >= 1 ? Math.floor(Number(role.maxConcurrent)) : 1;
    if ((running.get(roleId) || 0) + (taken.get(roleId) || 0) >= maxC) continue;
    // `card.project` is a free-text LABEL (see stores/board.ts projectIdForCard),
    // not the registry id: resolve it by name or by the path's basename,
    // case-insensitive — the same rule the panel uses, so a card written in the
    // UI and a card written by boardctl both land on the same project.
    const label = String(card.project || '').trim().toLowerCase();
    const project =
      (projects.projects || []).find((p) => String(p?.name || '').trim().toLowerCase() === label) ||
      (projects.projects || []).find((p) => {
        const base = String(p?.path || '').split('/').filter(Boolean).pop() || '';
        return base.toLowerCase() === label;
      }) ||
      null;
    if (!project || !project.path || !underRoot(project.path)) {
      console.error(
        `skip ${card.id}: project ${JSON.stringify(card.project)} missing or outside ROOT_DIR`,
      );
      continue;
    }
    taken.set(roleId, (taken.get(roleId) || 0) + 1);
    try {
      results.push(await runCard(card, project, role, Number(attempts[card.id]) || 0));
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
// Stop cranks — always available as separate invocations, even mid-pass:
// they act on claims.json + recorded pids, not on the running process.
//   kill=false -> release our claims only (cards stay where they are);
//   kill=true  -> SIGTERM our own children first, then release.
// A pid is only signalled when it is provably ours (ownChildPid).
// ---------------------------------------------------------------------------

async function killClaimChild(claim) {
  const pid = Number(claim?.pid);
  const child = liveProcs.get(pid);
  if (child) {
    try {
      child.kill('SIGTERM');
      return 'sigterm';
    } catch {
      return 'gone';
    }
  }
  if (!ownChildPid(pid, claim)) {
    return pidAlive(pid) ? 'not-our-child' : 'no-live-pid';
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return 'gone';
  }
  for (let i = 0; i < 15; i++) {
    if (!pidAlive(pid)) return 'killed';
    await new Promise((r) => setTimeout(r, 100));
  }
  return 'sigterm-sent'; // still alive after the grace window
}

async function stopAll({ kill = true } = {}) {
  let killed = 0;
  if (kill) {
    for (const [pid, child] of [...liveProcs]) {
      try {
        child.kill('SIGTERM');
        killed++;
      } catch {
        /* gone */
      }
      liveProcs.delete(pid);
    }
  }
  let released = 0;
  const outcomes = [];
  try {
    const { data: claimsDoc } = await readDoc('claims.json', emptyClaims());
    const mine = Object.entries(claimsDoc.claims || {}).filter(([, c]) => ownClaim(c));
    let titles = {};
    try {
      const { data: b } = await readDoc('board.json', emptyBoard());
      titles = Object.fromEntries((b.cards || []).map((c) => [c.id, c.title]));
    } catch {
      /* titles are cosmetic */
    }
    for (const [cid, claim] of mine) {
      let outcome = 'released';
      // Release BEFORE signalling: when the owning runner's child exits it
      // checks the claim to tell "killed on purpose" from a real failure —
      // the claim must already be gone or it would miscount an attempt.
      try {
        await mutate('claims.json', emptyClaims(), (doc) => {
          const cur = (doc.claims || {})[cid];
          if (cur && ownClaim(cur)) delete doc.claims[cid];
          doc.version = 1;
          return doc;
        });
        released++;
      } catch (e) {
        console.error(`release ${cid}: ${e.message}`);
        outcome += ' release-failed';
      }
      if (kill) {
        outcome = await killClaimChild(claim);
        if (outcome === 'killed' || outcome === 'sigterm' || outcome === 'sigterm-sent') {
          killed++;
        }
      }
      try {
        await appendActivity({
          agentName: RUNNER_ID,
          title: titles[cid] || cid,
          role: claim?.roleId || '',
          sessionId: claim?.sessionId || '',
          detail: `${kill ? 'stop-all' : 'release-all'} card=${cid} ${outcome} role=${claim?.roleId || '-'}`,
        });
      } catch (e) {
        console.error(`audit ${cid}: ${e.message}`);
      }
      outcomes.push({ card: cid, outcome });
    }
  } catch (e) {
    console.error(`stop-all: ${e.message}`);
    process.exitCode = 1;
  }
  await new Promise((r) => setTimeout(r, 300));
  console.log(JSON.stringify({ killed, released, claims: outcomes }));
}

// `cancel <cardId>`: kill the child of that card only, then flag it blocked
// (an operator-cancelled card must not be silently re-dispatched on the next
// poll) and release our claim — in that order, so the live claim keeps the
// card out of pickup until the mark is on. Refuses claims that are not ours.
async function cancelCard(ref) {
  let claimsDoc;
  try {
    ({ data: claimsDoc } = await readDoc('claims.json', emptyClaims()));
  } catch (e) {
    console.error(`cancel: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const claims = claimsDoc.claims || {};
  let cid = claims[ref] ? ref : null;
  if (!cid) {
    const matches = Object.keys(claims).filter((k) => k.startsWith(ref));
    if (matches.length === 1) cid = matches[0];
    else if (matches.length > 1) {
      console.error(`cancel: ${ref} is ambiguous (${matches.join(', ')})`);
      process.exitCode = 1;
      return;
    }
  }
  const claim = cid ? claims[cid] : null;
  if (!claim) {
    console.error(`cancel: no claim for ${ref}`);
    process.exitCode = 2;
    return;
  }
  if (!ownClaim(claim)) {
    console.error(`cancel: ${cid} is held by ${claim.agentName} — not ours, refusing`);
    process.exitCode = 3;
    return;
  }

  // Order matters: flag the card, release the claim, THEN signal the child.
  // The live claim keeps the card out of pickup until the mark is on, and a
  // released claim is what tells the owning runner's exit path this was a
  // deliberate kill, not a failed attempt.
  let card = null;
  try {
    card = await markCard(cid, { blockedReason: `turn cancelled by ${RUNNER_ID}` });
  } catch (e) {
    console.error(`cancel: mark ${cid}: ${e.message}`);
  }
  try {
    await mutate('claims.json', emptyClaims(), (doc) => {
      const cur = (doc.claims || {})[cid];
      if (cur && ownClaim(cur)) delete doc.claims[cid];
      doc.version = 1;
      return doc;
    });
  } catch (e) {
    console.error(`cancel: release ${cid}: ${e.message}`);
    process.exitCode = 1;
  }
  const outcome = await killClaimChild(claim);
  try {
    await appendActivity({
      agentName: RUNNER_ID,
      title: card?.title || cid,
      role: claim?.roleId || '',
      sessionId: claim?.sessionId || '',
      detail: `cancel ${cid}: ${outcome}; claim released; card flagged blocked`,
    });
  } catch (e) {
    console.error(`cancel: audit ${cid}: ${e.message}`);
  }
  console.log(JSON.stringify({ card: cid, outcome }));
}

// ---------------------------------------------------------------------------
// Entry.
// ---------------------------------------------------------------------------

const mode = process.argv[2];
if (mode === 'stop-all' || mode === '--stop-all') {
  await stopAll({ kill: true });
} else if (mode === 'release-all' || mode === '--release-all') {
  await stopAll({ kill: false });
} else if (mode === 'cancel' || mode === '--cancel') {
  const ref = process.argv[3];
  if (!ref) {
    console.error('usage: node server/acp-runner.mjs cancel <cardId>');
    process.exitCode = 2;
  } else {
    await cancelCard(ref);
  }
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
  console.error(
    'usage: node server/acp-runner.mjs --once | --serve | stop-all | release-all | cancel <cardId>',
  );
  process.exitCode = 2;
}
