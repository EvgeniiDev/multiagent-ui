#!/usr/bin/env node
// scripts/retire-environment.mjs — host operator helper (U4).
//
// Proves a recorded execution environment instance is gone, then posts the
// retirement command through the ops-only route
//   POST /api/internal/environments/retire  {commandId, type, payload}
// authenticated by x-acp-ops-token. Runs on the HOST only — it needs the
// docker CLI and host /proc, neither of which exists inside containers.
//
// Safety contract (fail closed on every gap — no caller assertion trusted):
//   * the retire target must exist in the environment ledger at the EXACT
//     slot + envInstance (containerId + initStarttime) + generation, via the
//     canonical validated loader (a malformed ledger fails closed);
//   * the recorded containerId is the runner's in-container hostname — by
//     default Docker's short id, so `docker inspect <id>` resolves it
//     positively AND Config.Hostname must still equal it (short_id bind);
//   * a NON-hex recorded value (custom hostname) can never be resolved by
//     docker lookup — retirement requires a preflight receipt (--record,
//     captured while the container was verified live) pinning the full
//     64-hex docker Id. Without one the verdict refuses, even when no
//     container currently bears the hostname — absence of a name match is
//     NOT positive removal evidence for an unpinned identity;
//   * a RUNNING/PAUSED container whose host init starttime equals the
//     recorded initStarttime IS the recorded instance → refuse. A different
//     starttime proves a successor ONLY for a bound exact docker identity
//     (exact_id / short_id / receipt) — a hostname match alone is never
//     proof;
//   * only documented lifecycle states classify: running|paused|restarting
//     are live; exited|created|dead are stopped; removing or anything else
//     is unknown → refuse;
//   * daemon errors, inspect ambiguity, multiple identity-bearing
//     containers, unreadable live-init proofs and unknown statuses all
//     refuse — only a trustworthy NoSuchContainer counts as absence.
//
// The live-vs-recorded decision comes only from /proc/<State.Pid>/stat
// field 22 (host jiffies — the same value the runner recorded as
// envInstance.initStarttime for container PID 1). Nothing signals a pid.
//
// Modes:
//   --record    capture a preflight receipt binding the recorded
//               envInstance to the full docker Id + host boot_id while the
//               container is VERIFIED LIVE and uniquely bound. Required for
//               custom hostnames. Never written for a stopped/unverifiable
//               container, and --dry-run never writes anything.
//   (default)   verify lifecycle, then POST the retirement command unless
//               --dry-run (prints the command instead — still zero writes).
//               Idempotent: the domain dedupes exact slot+envInstance+
//               generation and replays commandId+payloadHash.
//
// Exit codes: 0 ok / dry-run · 2 usage, ledger, receipt or token errors ·
// 3 lifecycle refusal (live, ambiguous, unverifiable, unknown status) ·
// 4 retire POST rejected.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { procStarttime } from '../server/execution/porch-runtime.mjs';
import { loadEnvironments } from '../server/execution/execution-store.mjs';
import { SAFE_ID_RE } from '../server/execution/common.mjs';
import { COMMAND_ID_RE } from '../server/execution/execution-domain.mjs';

const execFileP = promisify(execFile);

const DEFAULT_STATE_DIR = '/home/hermes/.hermes/acp-ui-state';
// Private operator dir — deliberately OUTSIDE every path the runner mounts
// (projects, ~/.local, ~/.pi, ~/.hermes, ~/.local/share/devin, ~/.codex).
// Same-uid separation cannot come from a file inside a shared mount.
const DEFAULT_RECEIPTS_DIR = '/home/hermes/.acp-ops/env-receipts';
const DEFAULT_OPS_TOKEN_FILE = '/home/hermes/.acp-ops/ops-token';
const DEFAULT_STATE_URL = 'http://127.0.0.1:25900';
const LIVE_STATUSES = new Set(['running', 'paused', 'restarting']);
const RECORD_LIVE_STATUSES = new Set(['running', 'paused']);
const STOPPED_STATUSES = new Set(['exited', 'created', 'dead']);
const OPS_TOKEN_RE = /^[0-9a-f]{48}$/;
const FULL_ID_RE = /^[0-9a-f]{64}$/;
const RECEIPT_FORMAT = 'acp-env-receipt/1';

export function isHexId(v) {
  return typeof v === 'string' && /^[0-9a-f]{12,64}$/.test(v);
}

export function hostBootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
  catch { return null; }
}

export function classifyDockerError(e) {
  if (e?.code === 'ENOENT' && !e.stderr) return 'docker_missing';
  const msg = String(e?.stderr || e?.message || e || '');
  // Harder failures win over any embedded 'No such' text — a permission or
  // daemon failure message must never be read as 'the container is absent'.
  if (/multiple (IDs|objects|matches)/i.test(msg)) return 'ambiguous';
  if (/permission denied/i.test(msg)) return 'permission_denied';
  if (/Cannot connect to the Docker daemon|error during connect|docker\.sock/i.test(msg)) return 'daemon_unavailable';
  if (/malformed inspect|invalid inspect/i.test(msg)) return 'docker_malformed';
  if (/No such (container|object)/i.test(msg)) return 'no_such_container';
  return 'docker_failed';
}

export function normalizeInspect(raw) {
  return {
    id: raw?.Id ?? null,
    name: raw?.Name ?? null,
    hostname: raw?.Config?.Hostname ?? null,
    status: raw?.State?.Status ?? null,
    pid: raw?.State?.Pid ?? null,
    startedAt: raw?.State?.StartedAt ?? null,
    finishedAt: raw?.State?.FinishedAt ?? null,
  };
}

// `docker inspect` output must be a one-element array whose element carries
// a full 64-hex Id and a State object. An empty/multiple/malformed response
// is a daemon-error class failure — NEVER proof of absence.
export function parseInspectStdout(stdout, ref = '?') {
  let arr;
  try { arr = JSON.parse(stdout); }
  catch { throw new Error(`malformed inspect output for ${ref}`); }
  if (!Array.isArray(arr) || arr.length !== 1) {
    throw new Error(`malformed inspect output for ${ref}: expected exactly one object, got ${Array.isArray(arr) ? arr.length : typeof arr}`);
  }
  const ins = normalizeInspect(arr[0]);
  if (!FULL_ID_RE.test(ins.id || '') || typeof ins.status !== 'string') {
    throw new Error(`malformed inspect output for ${ref}: missing full Id/State.Status`);
  }
  return ins;
}

export function parseIdListStdout(stdout) {
  const ids = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    if (!FULL_ID_RE.test(id)) {
      throw new Error(`malformed inspect output: docker ps --no-trunc returned non-full id ${JSON.stringify(id.slice(0, 32))}`);
    }
  }
  return ids;
}

// Can `ins` positively BE the container that carried `recorded` as its
// in-container hostname? The recorded value came from os.hostname() inside
// the container, so identity needs the immutable docker Id (or unique
// prefix) to agree AND Config.Hostname to still equal the recorded value —
// except the full-Id case where the Id alone is already unique. A hostname
// match alone binds but is NOT proof without a pinned docker Id.
export function identityRule(recorded, ins, receiptDockerId = null) {
  if (!ins || typeof ins.id !== 'string' || typeof recorded !== 'string') return null;
  if (ins.id === recorded) return 'exact_id';
  if (receiptDockerId && ins.id === receiptDockerId && ins.hostname === recorded) return 'receipt';
  if (isHexId(recorded) && recorded.length < 64
      && ins.id.startsWith(recorded) && ins.hostname === recorded) return 'short_id';
  if (ins.hostname === recorded) return 'hostname';
  return null;
}

// A bound candidate's lifecycle verdict. `bound` = identity proven by exact
// docker identity (exact_id / short_id / receipt), never hostname alone.
function boundVerdict({ ins, rule, initStarttime, hostProcStarttime }) {
  if (LIVE_STATUSES.has(ins.status)) {
    if (!Number.isInteger(ins.pid) || ins.pid <= 0) {
      return { ok: false, code: 'live_unverifiable',
        detail: `container ${ins.id} is ${ins.status} but State.Pid is ${ins.pid}` };
    }
    const st = hostProcStarttime(ins.pid);
    if (typeof st !== 'string' || !st) {
      return { ok: false, code: 'live_unverifiable',
        detail: `host /proc/${ins.pid} starttime unreadable — cannot prove the live container is not the recorded instance` };
    }
    if (st === initStarttime) {
      return { ok: false, code: 'live_recorded',
        detail: `container ${ins.id} is ${ins.status} and its init starttime equals the recorded envInstance — refusing to retire a live environment` };
    }
    // Bound identity + different init starttime = a successor holds the
    // recorded identity now → the recorded instance is positively gone.
    return { ok: true, state: 'removed', rule,
      detail: `container ${ins.id.slice(0, 12)} carries the recorded identity but is a DIFFERENT live instance (init starttime ${st} != ${initStarttime})` };
  }
  if (STOPPED_STATUSES.has(ins.status)) {
    // State.FinishedAt is immutable once stopped — using it as observedAt
    // keeps the command payload byte-identical across CLI retries, so a
    // repeated --command-id hits the domain replay dedup instead of a 409.
    const fin = typeof ins.finishedAt === 'string' && ins.finishedAt && !ins.finishedAt.startsWith('0001-')
      ? ins.finishedAt : null;
    return { ok: true, state: 'stopped', rule, observedAt: fin,
      detail: `container ${ins.id.slice(0, 12)} carries the recorded identity (${rule}) and is ${ins.status}` };
  }
  return { ok: false, code: 'status_unknown',
    detail: `container ${ins.id} reports unsupported status ${JSON.stringify(ins.status)} — refusing rather than guessing` };
}

// Core lifecycle proof. All seams injectable for tests:
//   inspect(ref)           -> normalized inspect record | throws docker error
//   listIds()              -> [fullId, ...]
//   hostProcStarttime(pid) -> string jiffies | null
//   receipt                -> validated receipt {dockerId,...} | null
export async function verifyLifecycle({
  recorded, initStarttime, inspect, listIds, hostProcStarttime, receipt = null,
}) {
  if (typeof recorded !== 'string' || !recorded) {
    return { ok: false, code: 'bad_recorded', detail: 'recorded containerId missing' };
  }
  if (typeof initStarttime !== 'string' || !/^\d+$/.test(initStarttime)) {
    return { ok: false, code: 'bad_init_starttime', detail: 'recorded initStarttime missing or malformed' };
  }

  // -- receipt path: the pinned full docker Id is authoritative. ----------
  if (receipt) {
    if (receipt.containerId !== recorded || receipt.initStarttime !== initStarttime) {
      return { ok: false, code: 'receipt_mismatch',
        detail: 'receipt envInstance does not equal the retire target' };
    }
    if (!FULL_ID_RE.test(receipt.dockerId || '')) {
      return { ok: false, code: 'receipt_mismatch', detail: 'receipt dockerId missing/not a full 64-hex id' };
    }
    let ins;
    try { ins = await inspect(receipt.dockerId); }
    catch (e) {
      const code = classifyDockerError(e);
      if (code === 'no_such_container') {
        return { ok: true, state: 'removed', rule: 'receipt',
          detail: `no container carries receipt-pinned docker Id ${receipt.dockerId.slice(0, 12)} — the recorded instance is gone` };
      }
      return { ok: false, code: `docker_${code}`, detail: `docker inspect ${receipt.dockerId}: ${code}` };
    }
    if (ins?.id !== receipt.dockerId || ins.hostname !== recorded) {
      return { ok: false, code: 'receipt_mismatch',
        detail: `inspect ${receipt.dockerId.slice(0, 12)} returned id=${ins?.id?.slice(0, 12)} hostname=${ins?.hostname} — the pinned binding no longer holds` };
    }
    return boundVerdict({ ins, rule: 'receipt', initStarttime, hostProcStarttime });
  }

  // -- no receipt: only a container-id-shaped recorded value can resolve. --
  if (!isHexId(recorded)) {
    return { ok: false, code: 'unbound_custom_hostname',
      detail: `recorded containerId ${JSON.stringify(recorded)} is a custom hostname — a hostname match or absence is not positive evidence; re-run --record while the environment is live to pin the docker Id` };
  }

  // Direct id(/prefix)/name resolution first. A resolved record that does
  // not carry a full 64-hex Id is a malformed response, never "absent".
  const candidates = new Map();
  const consider = (candIns, via) => {
    if (!candIns) return;
    if (!FULL_ID_RE.test(candIns.id || '')) {
      throw Object.assign(new Error(`invalid inspect record for ${via}: id ${JSON.stringify(candIns.id)}`), { malformed: true });
    }
    const rule = identityRule(recorded, candIns);
    if (rule && !candidates.has(candIns.id)) candidates.set(candIns.id, { ins: candIns, via, rule });
  };
  try { consider(await inspect(recorded), 'lookup'); }
  catch (e) {
    if (e.malformed) return { ok: false, code: 'docker_malformed', detail: e.message };
    const code = classifyDockerError(e);
    if (code !== 'no_such_container') {
      return { ok: false, code: `docker_${code}`, detail: `docker inspect ${recorded}: ${code}` };
    }
  }
  // Enumerate every container: catches collisions where another container
  // bears the recorded hostname, and confirms no id-prefix survivor.
  let ids;
  try { ids = await listIds(); }
  catch (e) {
    const code = classifyDockerError(e);
    return { ok: false, code: `docker_${code}`, detail: `docker ps -a: ${code}` };
  }
  for (const id of ids) {
    try { consider(await inspect(id), 'enumerate'); }
    catch (e) {
      if (e.malformed) return { ok: false, code: 'docker_malformed', detail: e.message };
      const code = classifyDockerError(e);
      // A container removed between ps and inspect is a benign race; any
      // harder failure makes enumeration untrustworthy → fail closed.
      if (code !== 'no_such_container') {
        return { ok: false, code: `docker_${code}`, detail: `docker inspect ${id}: ${code}` };
      }
    }
  }

  const bound = [];
  const unbound = [];
  for (const c of candidates.values()) (c.rule === 'hostname' ? unbound : bound).push(c);
  if (bound.length > 1) {
    return { ok: false, code: 'ambiguous_identity',
      detail: `${bound.length} distinct containers bind the recorded identity (${bound.map((c) => c.ins.id.slice(0, 12)).join(',')}) — refusing to guess` };
  }
  if (bound.length === 1) {
    const v = boundVerdict({ ins: bound[0].ins, rule: bound[0].rule, initStarttime, hostProcStarttime });
    if (v.ok) v.candidates = [...candidates.values()].map((c) => ({ id: c.ins.id, rule: c.rule, status: c.ins.status }));
    return v;
  }
  // No id-bound candidate → no container's Id carries the recorded prefix →
  // the recorded instance cannot exist. Hostname-only matches are strangers
  // (their own Ids differ) and cannot resurrect the recorded instance, but
  // a LIVE one must still be disproven before 'removed' is claimed.
  for (const c of unbound) {
    if (LIVE_STATUSES.has(c.ins.status)) {
      if (!Number.isInteger(c.ins.pid) || c.ins.pid <= 0) {
        return { ok: false, code: 'live_unverifiable',
          detail: `live hostname-matched stranger ${c.ins.id.slice(0, 12)} has no readable State.Pid` };
      }
      const st = hostProcStarttime(c.ins.pid);
      if (typeof st !== 'string' || !st) {
        return { ok: false, code: 'live_unverifiable',
          detail: `host /proc/${c.ins.pid} unreadable for hostname-matched live container — cannot prove it is not the recorded instance` };
      }
      if (st === initStarttime) {
        return { ok: false, code: 'live_recorded',
          detail: `container ${c.ins.id} shares the recorded hostname AND init starttime — treat as the recorded instance and refuse` };
      }
    }
  }
  return { ok: true, state: 'removed',
    detail: unbound.length
      ? 'no container Id carries the recorded prefix; identity-bearing strangers exist but their own Ids differ — the recorded instance is gone'
      : 'no container carries the recorded identity — the recorded container is gone',
    candidates: [...candidates.values()].map((c) => ({ id: c.ins.id, rule: c.rule, status: c.ins.status })) };
}

export function findRecordedEntry(doc, { slot, envInstance, generation }) {
  const s = doc?.slots?.[slot];
  if (!s) return null;
  const matches = (r) => r && r.generation === generation
    && r.envInstance?.containerId === envInstance.containerId
    && r.envInstance?.initStarttime === envInstance.initStarttime;
  if (matches(s.current)) return { entry: s.current, where: 'current' };
  const hit = (s.history || []).find(matches);
  return hit ? { entry: hit, where: 'history' } : null;
}

// The route stamps type=retire_environment itself; the domain command needs
// {commandId, payload}. commandId is unique per invocation → retries of a
// lost response must reuse the SAME printed commandId (dry-run output).
export function buildRetireCommand({ slot, by, envInstance, generation, evidence, commandId }) {
  return {
    commandId: commandId || `ret-${randomUUID()}`,
    type: 'retire_environment',
    payload: { slot, by, target: { envInstance, generation }, evidence },
  };
}

export function readOpsTokenFile(file) {
  const tok = fs.readFileSync(file, 'utf8').trim();
  if (!OPS_TOKEN_RE.test(tok)) throw new Error(`ops token at ${file} is malformed (need 48 lowercase hex)`);
  return tok;
}

export function receiptPath(dir, slot, generation) {
  if (!SAFE_ID_RE.test(slot)) throw new Error(`unsafe slot id for receipt path: ${JSON.stringify(slot)}`);
  return path.join(dir, `${slot}--g${generation}.json`);
}

// Receipts are proof material: must be a regular file (never a symlink),
// owner-only permissions, and bind slot + generation + envInstance + the
// host boot_id captured at --record time (jiffies starttimes only compare
// within one boot).
export function loadReceipt(file, { slot, envInstance, generation, bootId }) {
  let st;
  try { st = fs.lstatSync(file); }
  catch (e) {
    // Only ENOENT means "no optional receipt". EACCES/ELOOP/etc must refuse
    // — silently degrading to no-receipt hides a tampered proof store.
    return { ok: false, code: e?.code === 'ENOENT' ? 'receipt_absent' : 'receipt_unreadable',
      detail: e?.code === 'ENOENT' ? null : `${file}: ${e.code || e.message}` };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { ok: false, code: 'receipt_unsafe', detail: `${file} is not a regular file` };
  }
  if (st.mode & 0o077) {
    return { ok: false, code: 'receipt_unsafe', detail: `${file} permissions ${(st.mode & 0o777).toString(8)} are not owner-only` };
  }
  let r;
  try { r = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { ok: false, code: 'receipt_corrupt', detail: e.message }; }
  if (r?.format !== RECEIPT_FORMAT) return { ok: false, code: 'receipt_corrupt', detail: 'bad format tag' };
  if (r.slot !== slot || r.generation !== generation
      || r.containerId !== envInstance.containerId || r.initStarttime !== envInstance.initStarttime) {
    return { ok: false, code: 'receipt_mismatch',
      detail: 'receipt does not bind this slot/generation/envInstance' };
  }
  if (!FULL_ID_RE.test(r.dockerId || '')) {
    return { ok: false, code: 'receipt_corrupt', detail: 'dockerId must be a full 64-hex id' };
  }
  if (typeof r.bootId !== 'string' || !r.bootId) {
    return { ok: false, code: 'receipt_corrupt', detail: 'receipt has no boot identity' };
  }
  if (typeof bootId !== 'string' || !bootId) {
    return { ok: false, code: 'boot_id_unknown',
      detail: 'host /proc/sys/kernel/random/boot_id unreadable — cannot compare init starttimes across a possible reboot' };
  }
  if (r.bootId !== bootId) {
    return { ok: false, code: 'receipt_mismatch',
      detail: 'host rebooted since the receipt was recorded — init starttimes are incomparable' };
  }
  return { ok: true, receipt: r };
}

// Atomic owner-only write that never follows a pre-existing path: write a
// unique tmp sibling with mode 0600, then rename over the target. A stale
// symlink or broad-mode file at the target is replaced, not followed.
// Every ancestor of the receipts dir is lstat-checked — a symlinked
// ancestor would silently relocate proof material.
export function writeReceiptAtomic(file, receipt) {
  const dir = path.resolve(path.dirname(file));
  const comps = dir.split(path.sep).filter(Boolean);
  let cur = path.sep;
  for (const c of comps) {
    cur = path.join(cur, c);
    let st;
    try { st = fs.lstatSync(cur); }
    catch (e) {
      if (e?.code === 'ENOENT') break; // created below by mkdirSync(recursive)
      throw new Error(`receipts path ancestor ${cur}: ${e.code || e.message}`);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`receipts path ancestor ${cur} is not a real directory`);
    }
  }
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function usage() {
  return `usage: retire-environment.mjs --slot <name> --container-id <v> --init-starttime <jiffies> --generation <n>
    [--command-id <id>] [--docker-id <full64hex>] [--by <name>]
    [--state-dir <p>] [--receipts-dir <p>] [--receipt <p>]
    [--ops-token-file <p>] [--state-url <u>] [--docker <bin>]
    [--dry-run] [--record]`;
}

const KNOWN_FLAGS = new Set(['dry-run', 'record']);
const KNOWN_OPTS = new Set(['slot', 'container-id', 'init-starttime', 'generation',
  'command-id', 'docker-id', 'by', 'state-dir', 'receipts-dir', 'receipt',
  'ops-token-file', 'state-url', 'docker']);

export async function main(argv, deps = {}) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._err = `unexpected argument ${JSON.stringify(a)}`; break; }
    const k = a.slice(2);
    if (KNOWN_FLAGS.has(k)) { args[k] = true; continue; }
    if (!KNOWN_OPTS.has(k)) { args._err = `unknown flag ${a}`; break; }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) { args._err = `missing value for ${a}`; break; }
    args[k] = v;
  }
  const out = deps.stdout || ((s) => console.log(s));
  const err = deps.stderr || ((s) => console.error(s));
  const envInstance = { containerId: args['container-id'], initStarttime: args['init-starttime'] };
  const generation = Number(args.generation);
  if (args._err) { err(`refuse: ${args._err}`); err(usage()); return 2; }
  if (!args.slot || !SAFE_ID_RE.test(args.slot)
      || !envInstance.containerId || !/^\d+$/.test(envInstance.initStarttime || '')
      || !Number.isInteger(generation) || generation < 1) {
    err(usage());
    return 2;
  }
  if (args['command-id'] !== undefined && !COMMAND_ID_RE.test(args['command-id'])) {
    err(`refuse: --command-id must match ${COMMAND_ID_RE}`);
    return 2;
  }
  if (args['docker-id'] !== undefined && !FULL_ID_RE.test(args['docker-id'])) {
    err('refuse: --docker-id must be a full 64-hex docker Id');
    return 2;
  }
  const stateDir = args['state-dir'] || DEFAULT_STATE_DIR;
  const receiptsDir = args['receipts-dir'] || DEFAULT_RECEIPTS_DIR;
  const dockerBin = args.docker || 'docker';
  const runDocker = deps.runDocker || ((bin, dargs) => execFileP(bin, dargs, { maxBuffer: 32 << 20 }));
  // Strict adapters: malformed/empty/multi-element docker output throws a
  // docker_malformed-class error — never collapses into "no match".
  const inspect = deps.inspect || (async (ref) => {
    const { stdout } = await runDocker(dockerBin, ['inspect', ref]);
    return parseInspectStdout(stdout, ref);
  });
  const listIds = deps.listIds || (async () => {
    const { stdout } = await runDocker(dockerBin, ['ps', '-a', '--no-trunc', '--format', '{{.ID}}']);
    return parseIdListStdout(stdout);
  });
  const hostProcStarttime = deps.hostProcStarttime || procStarttime;
  const bootId = deps.bootId !== undefined ? deps.bootId : hostBootId();

  // Ledger binding through the canonical VALIDATED loader — a malformed
  // ledger throws and the run fails closed before any docker call.
  let doc;
  if (deps.ledger) doc = deps.ledger;
  else {
    try { doc = await loadEnvironments(stateDir); }
    catch (e) { err(`refuse: environment ledger unreadable/malformed: ${e.message}`); return 2; }
  }
  const found = findRecordedEntry(doc, { slot: args.slot, envInstance, generation });
  if (!found) {
    err(`refuse: no recorded registration at slot=${args.slot} envInstance=${envInstance.containerId}/${envInstance.initStarttime} generation=${generation}`);
    return 2;
  }
  if (!args.record) {
    // Already-retired short-circuit: the ledger IS the authoritative
    // record, so a retry after a lost response is a clean success — no
    // docker call, no POST, no chance of a commandId payload conflict.
    const prior = (doc.retirements || []).find((r) => r
      && r.slot === args.slot
      && r.envInstance?.containerId === envInstance.containerId
      && r.envInstance?.initStarttime === envInstance.initStarttime
      && r.generation === generation);
    if (prior) {
      out(`already retired: ${prior.retirementId} slot=${args.slot} g${generation} retiredAt=${prior.retiredAt} — idempotent no-op`);
      return 0;
    }
  }

  if (args.record) {
    // Preflight receipt: pin the recorded envInstance to a full docker Id —
    // ONLY while the container is verifiably live with the recorded init
    // starttime. Resolution precedence:
    //   --docker-id <full64hex>   operator-pinned exact identity
    //   hex recorded              docker inspect resolves the id-prefix
    //   custom hostname           enumerate; exactly ONE container may carry
    //                             that Config.Hostname, and it must be the
    //                             live instance with the recorded init time.
    let ins = null;
    let rule = null;
    if (args['docker-id']) {
      try { ins = await inspect(args['docker-id']); }
      catch (e) { err(`refuse: docker inspect --docker-id (${classifyDockerError(e)})`); return 2; }
      if (ins.id !== args['docker-id'] || ins.hostname !== envInstance.containerId) {
        err(`refuse: --docker-id container hostname=${ins.hostname} does not equal recorded ${envInstance.containerId}`);
        return 2;
      }
      rule = 'docker_id';
    } else if (isHexId(envInstance.containerId)) {
      try { ins = await inspect(envInstance.containerId); }
      catch (e) { err(`refuse: cannot inspect recorded containerId (${classifyDockerError(e)}) — receipt not written`); return 2; }
      rule = identityRule(envInstance.containerId, ins);
      if (!rule || rule === 'hostname') {
        err(`refuse: inspected container ${ins.id.slice(0, 12)} does not positively bind recorded value ${envInstance.containerId} (rule=${rule})`);
        return 2;
      }
    } else {
      // Custom hostname: enumerate for the unique bearer.
      let ids;
      try { ids = await listIds(); }
      catch (e) { err(`refuse: cannot enumerate containers (${classifyDockerError(e)})`); return 2; }
      const matches = [];
      for (const id of ids) {
        let other;
        try { other = await inspect(id); }
        catch (e) {
          if (classifyDockerError(e) !== 'no_such_container') {
            err(`refuse: enumerate inspect ${id.slice(0, 12)} failed (${classifyDockerError(e)})`);
            return 2;
          }
          continue;
        }
        if (other.hostname === envInstance.containerId) matches.push(other);
      }
      if (matches.length !== 1) {
        err(`refuse: ${matches.length} containers carry hostname ${envInstance.containerId} — need exactly one, or pass --docker-id`);
        return 2;
      }
      ins = matches[0];
      rule = 'hostname';
    }
    if (!RECORD_LIVE_STATUSES.has(ins.status) || !Number.isInteger(ins.pid) || ins.pid <= 0) {
      err(`refuse: container ${ins.id.slice(0, 12)} is ${ins.status} — a receipt can only bind a verified live instance`);
      return 2;
    }
    const hostSt = hostProcStarttime(ins.pid);
    if (hostSt !== envInstance.initStarttime) {
      err(`refuse: live container ${ins.id.slice(0, 12)} init starttime ${hostSt} != recorded ${envInstance.initStarttime} — not the recorded instance`);
      return 2;
    }
    if (typeof bootId !== 'string' || !bootId) {
      err('refuse: host /proc/sys/kernel/random/boot_id unreadable — cannot write a comparable receipt');
      return 2;
    }
    // Uniqueness across ALL containers (id-bound path still needs it: a
    // second container could carry the same hostname string).
    let dup = 0;
    let ids;
    try { ids = await listIds(); }
    catch (e) { err(`refuse: cannot enumerate containers for uniqueness check (${classifyDockerError(e)})`); return 2; }
    for (const id of ids) {
      if (id === ins.id) continue;
      let other;
      try { other = await inspect(id); }
      catch (e) {
        // Only a trustworthy NoSuchContainer is a benign race; everything
        // else makes the uniqueness proof untrustworthy → refuse.
        if (classifyDockerError(e) !== 'no_such_container') {
          err(`refuse: uniqueness inspect ${id.slice(0, 12)} failed (${classifyDockerError(e)})`);
          return 2;
        }
        continue;
      }
      if (other?.hostname === envInstance.containerId) dup += 1;
    }
    if (dup) {
      err(`refuse: ${dup} other container(s) bear the recorded hostname — binding would be ambiguous`);
      return 2;
    }
    const receipt = {
      format: RECEIPT_FORMAT,
      slot: args.slot, generation,
      containerId: envInstance.containerId, initStarttime: envInstance.initStarttime,
      dockerId: ins.id, hostname: ins.hostname, name: ins.name,
      bootId, recordedAt: new Date().toISOString(),
    };
    if (args['dry-run']) {
      out(`dry-run receipt (not written): ${JSON.stringify(receipt)}`);
      return 0;
    }
    fs.mkdirSync(receiptsDir, { recursive: true, mode: 0o700 });
    const p = receiptPath(receiptsDir, args.slot, generation);
    try { writeReceiptAtomic(p, receipt); }
    catch (e) { err(`refuse: cannot write receipt: ${e.message}`); return 2; }
    out(`receipt written ${p} dockerId=${ins.id.slice(0, 12)} rule=${rule}`);
    return 0;
  }

  // Receipt: only usable when present AND fully validated — corrupt,
  // foreign, mismatched or symlinked receipts refuse rather than degrade.
  let receipt = null;
  const rp = args.receipt || receiptPath(receiptsDir, args.slot, generation);
  const lr = loadReceipt(rp, { slot: args.slot, envInstance, generation, bootId });
  if (!lr.ok) {
    if (lr.code === 'receipt_absent' && !args.receipt) {
      // no optional receipt present — fine for container-id-shaped targets
    } else {
      err(`refuse: receipt ${rp}: ${lr.code}${lr.detail ? ` — ${lr.detail}` : ''}`);
      return 2;
    }
  } else receipt = lr.receipt;

  const verdict = await verifyLifecycle({
    recorded: envInstance.containerId, initStarttime: envInstance.initStarttime,
    inspect, listIds, hostProcStarttime, receipt,
  });
  if (!verdict.ok) {
    err(`refuse: ${verdict.code} — ${verdict.detail}`);
    return 3;
  }
  const evidence = {
    source: 'compose_lifecycle',
    containerId: envInstance.containerId,
    state: verdict.state,
    // 'stopped' derives observedAt from the immutable State.FinishedAt so a
    // repeated invocation with the same --command-id replays byte-identical.
    observedAt: verdict.observedAt || new Date().toISOString(),
    detail: verdict.detail,
  };
  const command = buildRetireCommand({
    slot: args.slot, by: args.by || 'retire-environment.mjs',
    envInstance, generation, evidence, commandId: args['command-id'],
  });
  out(`lifecycle ${verdict.state} :: ${verdict.detail}`);
  out(`commandId=${command.commandId}`);
  if (args['dry-run']) { out(JSON.stringify(command, null, 2)); return 0; }

  let opsToken;
  try { opsToken = deps.opsToken || readOpsTokenFile(args['ops-token-file'] || DEFAULT_OPS_TOKEN_FILE); }
  catch (e) { err(`refuse: ${e.message}`); return 2; }
  const stateUrl = deps.stateUrl || args['state-url'] || DEFAULT_STATE_URL;
  const doPost = deps.post || (async (url, b, tok) => {
    const r = await fetch(url, {
      method: 'POST',
      // The ops credential must NEVER follow a redirect to another host.
      redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-acp-ops-token': tok },
      body: JSON.stringify(b),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  const res = await doPost(`${stateUrl}/api/internal/environments/retire`, command, opsToken);
  out(`retire ${args.slot} g${generation} -> ${res.status} ${JSON.stringify(res.body)}`);
  return (res.status === 200 && res.body?.ok === true) ? 0 : 4;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((c) => process.exit(c))
    .catch((e) => { console.error(`retire-environment: ${e.message}`); process.exit(2); });
}
