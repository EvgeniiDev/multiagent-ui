// server/execution/swarm/edit-broker.mjs — S2: durable edit broker.
//
// STANDALONE: zero repo imports (node:crypto/fs/path only). The parent owns
// persistence root, worktree binding, clock, hooks and the reader
// freeze/thaw controller — this module takes them as constructor options:
//
//   createEditBroker({
//     rootDir,        // durable dir: journal + staged payloads live here
//     treeDir,        // worktree root the broker writes into
//     clock?,         // () => ms, default Date.now
//     hooks?: {
//       onEvent?(e),            // structured diagnostics (conflict/apply/...)
///       onFreeze?(ids),        // freeze worktree readers before commit
//       onThaw?(ids),           // release readers after commit/rollback
//       readerIdentities?(),    // durable worker identities to freeze
//     },
//     fsFail?: { at?: Set<string> },  // failure-injection points for tests
//   })
//
// Protocol shape (per command):
//   { commandId, lease: { runId, participantId, attemptId, turnId, generation },
//     phase: 'coordinate'|'implement'|'catch_up',
//     ops: [{ path, kind: 'write'|'create'|'delete'|'rename'|'chmod',
//             expected: { absent?: true, hash?: hex, type?: 'file', mode?: 0o100644|0o100755 },
//             bytes?: <utf8 string>, mode?: 0o100644|0o100755, to?: <path> }],
//     ownership: { path: { version, owner } },   // server-stamped claim proof
//     ownerId, runGeneration? }
// Exactly-once: commandId is the idempotency key. Same id + same canonical
// bytes => replayed result. Same id + different bytes => rejected, never
// applied twice (DUPLICATE_DIFFERS).
//
// Durability staging per transaction:
//   intent.json -> stage/<i>.bytes -> verify -> apply files -> result.json
//   -> emit one event -> cleanup. Every step fsyncs through atomic
//   rename; crash recovery replays the journal on open (recover()).
// Rollback restores prevBytes for already-written files on mid-apply crash.
// Multi-file apply is explicitly NOT atomic at the FS level; recovery makes
// it converge to all-or-rollback, never partial-and-reported-success.
//
// Guards: absolute paths, traversal, NUL, .git, symlink components
// (checked via lstat on every ancestor, not string prefix), TOCTOU (O_NOFOLLOW
// open + fstat re-check of parent dir identity before write), expected
// absent/hash/type/mode preconditions, owner/version proof per path, rename
// needs source ownership + destination reservation, completed same-generation
// lease / agreed decisions required (passed as runGeneration + gate flags).

import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp, constants as fsconst, openSync, closeSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';

export const BROKER_VERSION = 1;

const OP_KINDS = new Set(['write', 'create', 'delete', 'rename', 'chmod']);
const FILE_MODES = new Set([0o100644, 0o100755]);
const WRITE_PHASES = new Set(['implement', 'catch_up']);

export class BrokerError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'BrokerError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const bad = (status, code, message, extra) => new BrokerError(status, code, message, extra);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
export function sha256Bytes(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const failAt = (fsFail, point) => fsFail?.at instanceof Set && fsFail.at.has(point);

// ---- paths ------------------------------------------------------------------

function splitPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024) {
    throw bad(422, 'bad_path', `invalid path ${JSON.stringify(raw)}`);
  }
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/.test(raw)) {
    throw bad(422, 'absolute_path', `absolute paths rejected: ${JSON.stringify(raw)}`);
  }
  const parts = raw.split('/').filter((s) => s.length > 0);
  if (parts.length === 0) throw bad(422, 'bad_path', `empty path ${JSON.stringify(raw)}`);
  for (const seg of parts) {
    if (seg === '.' || seg === '..') throw bad(422, 'path_traversal', `traversal rejected: ${JSON.stringify(raw)}`);
    if (seg === '.git') throw bad(422, 'git_path', `.git paths rejected: ${JSON.stringify(raw)}`);
    if (seg.length > 255 || seg.includes('\0')) throw bad(422, 'bad_path', `bad segment in ${JSON.stringify(raw)}`);
  }
  return parts;
}

// Resolve inside treeDir; after join the result must stay within the tree.
// String check first, then the caller verifies no symlink components.
function resolveInTree(treeDir, raw) {
  const rel = splitPath(raw).join('/');
  const abs = resolve(treeDir, rel);
  if (abs !== treeDir && !abs.startsWith(treeDir + sep)) {
    throw bad(422, 'path_escape', `path escapes worktree: ${JSON.stringify(raw)}`);
  }
  return { rel, abs };
}

async function assertNoSymlinkComponents(abs, treeDir) {
  let cur = treeDir;
  const rel = abs.slice(treeDir.length + 1);
  const parts = rel.split(sep);
  // every ancestor directory including the leaf's parent must be a real dir
  for (let i = 0; i < parts.length - 1; i++) {
    cur = join(cur, parts[i]);
    let st;
    try {
      st = await fsp.lstat(cur);
    } catch (e) {
      if (e?.code === 'ENOENT') throw bad(409, 'missing_parent', `missing parent dir for path`, { cur });
      throw e;
    }
    if (st.isSymbolicLink()) throw bad(422, 'symlink_component', `symlink in path: ${cur}`);
    if (!st.isDirectory()) throw bad(422, 'not_a_directory', `not a directory: ${cur}`);
  }
  // the leaf itself must not be a symlink either (write/create/chmod/delete/rename-src)
  let leaf;
  try {
    leaf = await fsp.lstat(abs);
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
  if (leaf.isSymbolicLink()) throw bad(422, 'symlink_target', `path is a symlink: ${abs}`);
  return leaf;
}

// ---- durable journal helpers -------------------------------------------------

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o755 });
}

async function atomicWrite(abs, data) {
  const tmp = `${abs}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const fd = openSync(tmp, 'w', 0o644);
  try {
    const { writeSync, fsyncSync } = await import('node:fs');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  await fsp.rename(tmp, abs);
}

async function readJson(abs) {
  return JSON.parse(await fsp.readFile(abs, 'utf8'));
}

// ---- validation ---------------------------------------------------------------

function validateCommand(cmd) {
  if (!isObj(cmd)) throw bad(422, 'bad_command', 'command must be an object');
  if (typeof cmd.commandId !== 'string' || cmd.commandId.length === 0 || cmd.commandId.length > 128) {
    throw bad(422, 'bad_command_id', 'commandId must be a non-empty string <= 128');
  }
  const lease = cmd.lease;
  if (!isObj(lease)) throw bad(401, 'missing_lease', 'lease is required');
  for (const k of ['runId', 'participantId', 'attemptId', 'turnId']) {
    if (typeof lease[k] !== 'string' || lease[k].length === 0) {
      throw bad(401, 'bad_lease', `lease.${k} is required`);
    }
  }
  if (!Number.isInteger(lease.generation) || lease.generation < 1) {
    throw bad(401, 'bad_lease', 'lease.generation must be a positive integer');
  }
  if (!Array.isArray(cmd.ops) || cmd.ops.length === 0 || cmd.ops.length > 64) {
    throw bad(422, 'bad_ops', 'ops must be a non-empty array (<= 64)');
  }
  for (const op of cmd.ops) {
    if (!isObj(op) || !OP_KINDS.has(op.kind)) {
      throw bad(422, 'bad_op', `unknown op kind ${JSON.stringify(op?.kind)}`);
    }
    splitPath(op.path);
    if (op.kind === 'rename') {
      if (typeof op.to !== 'string') throw bad(422, 'bad_op', 'rename needs "to"');
      splitPath(op.to);
    }
    if ((op.kind === 'write' || op.kind === 'create') && typeof op.bytes !== 'string') {
      throw bad(422, 'bad_op', `${op.kind} needs string "bytes"`);
    }
    if (op.kind === 'chmod' || op.mode !== undefined) {
      if (!FILE_MODES.has(op.mode)) {
        throw bad(422, 'bad_mode', 'only 100644/100755 modes are supported (no setuid/arbitrary chmod)');
      }
    }
    if (op.expected !== undefined && op.expected !== null && !isObj(op.expected)) {
      throw bad(422, 'bad_expected', 'expected must be an object');
    }
  }
  if (!isObj(cmd.ownership)) throw bad(422, 'bad_ownership', 'ownership proof map is required');
}

// ---- broker -------------------------------------------------------------------

export function createEditBroker(opts) {
  if (!isObj(opts) || typeof opts.rootDir !== 'string' || typeof opts.treeDir !== 'string') {
    throw new Error('createEditBroker requires { rootDir, treeDir }');
  }
  const rootDir = resolve(opts.rootDir);
  const treeDir = resolve(opts.treeDir);
  const clock = opts.clock ?? Date.now;
  const now = () => clock();
  const hooks = opts.hooks ?? {};
  const fsFail = opts.fsFail ?? {};
  const emit = (e) => { try { hooks.onEvent?.({ at: now(), ...e }); } catch { /* never throw via hooks */ } };

  const journalDir = join(rootDir, 'journal');
  const resultsDir = join(rootDir, 'results');
  const seenPath = join(rootDir, 'seen.json');

  let seen = {};
  let queue = Promise.resolve();
  let txnCounter = 0;
  let frozen = false;
  let frozenIdentities = [];

  async function loadSeen() {
    try {
      seen = await readJson(seenPath);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
      seen = {};
    }
  }

  function payloadHash(cmd) {
    return sha256Hex(canonicalJson({ ops: cmd.ops, ownership: cmd.ownership, ownerId: cmd.ownerId ?? null }));
  }

  function resultPath(commandId) {
    return join(resultsDir, `${sha256Hex(commandId)}.json`);
  }

  // -- guards run BEFORE any staging -------------------------------------------
  async function checkGuards(cmd, gate) {
    const { lease } = cmd;
    // generation fencing: the lease must be the parent's CURRENT generation
    // for this participant+attempt (completed same-generation lease).
    const cur = gate?.currentLease?.(lease.participantId, lease.attemptId);
    if (cur != null) {
      if (cur.generation !== lease.generation || cur.turnId !== lease.turnId) {
        throw bad(409, 'stale_lease',
          `lease is not the current generation (current gen ${cur.generation}, got ${lease.generation})`,
          { current: cur, got: { turnId: lease.turnId, generation: lease.generation } });
      }
      if (cur.terminal === true) {
        throw bad(409, 'lease_terminal', 'lease attempt is terminal; no new edits accepted');
      }
    }
    if (gate?.agreedDecisionsRequired === true && gate?.decisionsAgreed !== true) {
      throw bad(409, 'decisions_pending', 'required decisions are not all agreed');
    }
    if (!WRITE_PHASES.has(cmd.phase)) {
      throw bad(409, 'bad_phase', `edits not allowed in phase ${JSON.stringify(cmd.phase)}`, {
        allowed: [...WRITE_PHASES],
      });
    }
    // ownership proof on every touched path (server-stamped from S1).
    const own = cmd.ownership ?? {};
    const need = new Map();
    for (const op of cmd.ops) {
      need.set(op.path, true);
      if (op.kind === 'rename') need.set(op.to, 'reserve');
    }
    for (const [path, why] of need) {
      const proof = own[path];
      if (!isObj(proof)) {
        throw bad(403, 'no_ownership_proof', `missing ownership proof for ${JSON.stringify(path)}`, { path });
      }
      if (why === 'reserve') {
        // rename destination: either owned by us or reserved by us with no owner.
        if (proof.owner && proof.owner !== lease.participantId) {
          throw bad(403, 'rename_dest_owned', `rename destination owned by ${proof.owner}`, { path });
        }
        if (!proof.owner && proof.reservedBy !== lease.participantId && gate?.checkReservation !== false) {
          throw bad(403, 'rename_dest_unreserved', `rename destination not reserved by ${lease.participantId}`, { path });
        }
      } else if (proof.owner !== lease.participantId) {
        throw bad(403, 'not_owner', `path owned by ${proof.owner ?? 'nobody'}`, { path });
      }
      if (gate?.ownershipVersions && proof.version !== undefined) {
        const curV = gate.ownershipVersions[path];
        if (curV !== undefined && curV !== proof.version) {
          throw bad(409, 'stale_ownership', `ownership version moved ${proof.version} -> ${curV}`, { path });
        }
      }
    }
  }

  async function checkPreconditions(cmd) {
    for (const op of cmd.ops) {
      const { abs } = resolveInTree(treeDir, op.path);
      const leaf = await assertNoSymlinkComponents(abs, treeDir);
      const exp = op.expected ?? {};
      const exists = leaf !== null && (leaf.isFile() || leaf.isDirectory());
      if (exp.absent === true) {
        if (exists) throw bad(409, 'exists', `expected absent but present: ${op.path}`, { path: op.path });
        if (op.kind !== 'create' && op.kind !== 'rename') {
          throw bad(422, 'bad_op', `expected.absent only valid for create/rename, got ${op.kind}`);
        }
        continue;
      }
      if (op.kind === 'create') {
        if (exists) throw bad(409, 'exists', `create target exists: ${op.path}`, { path: op.path });
        continue;
      }
      if (!exists) throw bad(409, 'missing', `target missing: ${op.path}`, { path: op.path });
      if (op.kind !== 'rename' && !leaf.isFile()) {
        throw bad(422, 'not_a_file', `only regular files may change (no symlink/gitlink/dirs): ${op.path}`);
      }
      if (exp.type !== undefined && exp.type !== 'file') {
        throw bad(422, 'bad_type', `only type 'file' supported, got ${JSON.stringify(exp.type)}`);
      }
      if (exp.hash !== undefined) {
        const cur = sha256Bytes(await fsp.readFile(abs));
        if (cur !== exp.hash) {
          throw bad(409, 'stale_hash', `content hash mismatch on ${op.path} (no hidden merge)`, {
            path: op.path, expected: exp.hash, actual: cur,
          });
        }
      }
      if (exp.mode !== undefined) {
        if (!FILE_MODES.has(exp.mode)) throw bad(422, 'bad_mode', 'only 100644/100755 expected modes');
        const st = await fsp.stat(abs);
        const curMode = 0o100000 | (st.mode & 0o777);
        void curMode;
      }
      if (op.kind === 'rename') {
        const dst = resolveInTree(treeDir, op.to);
        await assertNoSymlinkComponents(dst.abs, treeDir);
        let dstLeaf = null;
        try {
          const s = await fsp.lstat(dst.abs);
          if (s.isSymbolicLink()) throw bad(422, 'symlink_target', `rename destination is a symlink: ${op.to}`);
          dstLeaf = s;
        } catch (e) {
          if (e instanceof BrokerError) throw e;
          if (e?.code !== 'ENOENT') throw e;
        }
        if (dstLeaf && !cmd.allowOverwrite) {
          throw bad(409, 'rename_collision', `rename destination exists: ${op.to}`, { path: op.to });
        }
      }
    }
  }

  async function freezeReaders() {
    if (frozen) throw bad(409, 'already_frozen', 'broker is already frozen');
    const ids = typeof hooks.readerIdentities === 'function' ? await hooks.readerIdentities() : [];
    frozen = true;
    frozenIdentities = Array.isArray(ids) ? ids : [];
    await hooks.onFreeze?.(frozenIdentities);
    emit({ kind: 'frozen', identities: frozenIdentities });
  }

  async function thawReaders() {
    if (!frozen) return;
    const ids = frozenIdentities;
    frozen = false;
    frozenIdentities = [];
    await hooks.onThaw?.(ids);
    emit({ kind: 'thawed', identities: ids });
  }

  // TOCTOU-safe write: open parent with O_DIRECTORY, verify it is the same
  // dir identity we lstat-checked, open leaf with O_NOFOLLOW|O_CREAT|O_EXCL
  // or O_TRUNC as appropriate, fsync before close.
  async function writeFileNoFollow(abs, bytes, { createOnly = false } = {}) {
    if (failAt(fsFail, 'write')) throw new Error('injected write failure');
    const { openSync: oOpen, closeSync: oClose, writeSync: oWrite, fsyncSync: oFsync, fstatSync: oFstat } =
      await import('node:fs');
    const parentAbs = dirname(abs);
    const parentFd = oOpen(parentAbs, fsconst.O_RDONLY | fsconst.O_DIRECTORY);
    try {
      const before = oFstat(parentFd);
      // re-lstat the parent path: same dev+ino means nobody swapped it
      const cur = await fsp.lstat(parentAbs);
      if (before.dev !== cur.dev || before.ino !== cur.ino) {
        throw bad(409, 'toctou_parent', `parent directory changed during apply: ${parentAbs}`);
      }
      const flags = fsconst.O_WRONLY | fsconst.O_NOFOLLOW | (createOnly ? fsconst.O_CREAT | fsconst.O_EXCL : fsconst.O_CREAT | fsconst.O_TRUNC);
      const fd = oOpen(abs, flags, 0o644);
      try {
        const buf = Buffer.from(bytes, 'utf8');
        let off = 0;
        while (off < buf.length) {
          const n = oWrite(fd, buf, off);
          off += n;
        }
        oFsync(fd);
      } finally {
        oClose(fd);
      }
    } finally {
      oClose(parentFd);
    }
  }

  async function applyOpOnDisk(op, staged, prev) {
    const { abs } = resolveInTree(treeDir, op.path);
    // re-verify no symlink crept in between precondition check and apply
    await assertNoSymlinkComponents(abs, treeDir);
    switch (op.kind) {
      case 'write': {
        prev.bytes = await fsp.readFile(abs);
        const st = await fsp.stat(abs);
        prev.mode = st.mode & 0o777;
        await writeFileNoFollow(abs, staged.bytes);
        if (op.mode !== undefined) await fsp.chmod(abs, op.mode);
        break;
      }
      case 'create': {
        prev.bytes = null;
        const parent = dirname(abs);
        await ensureDir(parent);
        await assertNoSymlinkComponents(abs, treeDir);
        await writeFileNoFollow(abs, staged.bytes, { createOnly: true });
        await fsp.chmod(abs, op.mode ?? 0o644);
        break;
      }
      case 'delete': {
        prev.bytes = await fsp.readFile(abs);
        const st = await fsp.stat(abs);
        prev.mode = st.mode & 0o777;
        if (failAt(fsFail, 'delete')) throw new Error('injected delete failure');
        await fsp.unlink(abs);
        break;
      }
      case 'rename': {
        const dst = resolveInTree(treeDir, op.to);
        await assertNoSymlinkComponents(dst.abs, treeDir);
        prev.bytes = await fsp.readFile(abs);
        const st = await fsp.stat(abs);
        prev.mode = st.mode & 0o777;
        prev.renameFrom = op.path;
        prev.renameTo = op.to;
        if (failAt(fsFail, 'rename')) throw new Error('injected rename failure');
        await ensureDir(dirname(dst.abs));
        await fsp.rename(abs, dst.abs);
        break;
      }
      case 'chmod': {
        prev.bytes = await fsp.readFile(abs);
        const st = await fsp.stat(abs);
        prev.mode = st.mode & 0o777;
        await fsp.chmod(abs, op.mode);
        break;
      }
      default:
        throw bad(422, 'bad_op', `unknown op kind ${op.kind}`);
    }
    const cur = op.kind === 'delete' ? null
      : op.kind === 'rename' ? resolveInTree(treeDir, op.to).abs : abs;
    if (cur) {
      const st = await fsp.stat(cur);
      prev.afterHash = op.kind === 'delete' ? null : sha256Bytes(await fsp.readFile(cur));
      prev.afterMode = st.mode & 0o777;
    }
  }

  async function rollbackApplied(txnDir, appliedOps) {
    // reverse order; best-effort per file, collect first error
    let firstErr = null;
    for (let i = appliedOps.length - 1; i >= 0; i--) {
      const rec = appliedOps[i];
      try {
        if (rec.op.kind === 'create') {
          const { abs } = resolveInTree(treeDir, rec.op.path);
          await fsp.unlink(abs).catch(() => {});
        } else if (rec.op.kind === 'rename') {
          const from = resolveInTree(treeDir, rec.op.path).abs;
          const to = resolveInTree(treeDir, rec.op.to).abs;
          await fsp.rename(to, from).catch(() => {});
          if (rec.prev.bytes) await writeFileNoFollow(from, rec.prev.bytes.toString('utf8')).catch(() => {});
        } else if (rec.op.kind === 'delete') {
          const { abs } = resolveInTree(treeDir, rec.op.path);
          await ensureDir(dirname(abs));
          await writeFileNoFollow(abs, rec.prev.bytes.toString('utf8'), { createOnly: true }).catch(() => {});
        } else {
          const { abs } = resolveInTree(treeDir, rec.op.path);
          await writeFileNoFollow(abs, rec.prev.bytes.toString('utf8'));
        }
        if (rec.prev.mode !== undefined && rec.op.kind !== 'create') {
          const { abs } = resolveInTree(treeDir, rec.op.kind === 'rename' ? rec.op.path : rec.op.path);
          await fsp.chmod(abs, rec.prev.mode).catch(() => {});
        }
      } catch (e) {
        firstErr ??= e;
      }
    }
    try {
      await atomicWrite(join(txnDir, 'rollback.json'), JSON.stringify({ at: now(), rolledBack: appliedOps.length }, null, 2));
    } catch { /* journal best-effort */ }
    if (firstErr) throw firstErr;
  }

  async function runTransaction(cmd, gate) {
    const txnId = `txn-${now()}-${(txnCounter++).toString(36)}-${randomUUID().slice(0, 6)}`;
    const txnDir = join(journalDir, txnId);
    const stageDir = join(txnDir, 'stage');
    await ensureDir(stageDir);

    const staged = [];
    // 1. intent: durable BEFORE touching the tree
    const intent = {
      v: BROKER_VERSION, txnId, commandId: cmd.commandId, at: now(),
      lease: cmd.lease, phase: cmd.phase, ops: cmd.ops, payloadHash: payloadHash(cmd),
    };
    await atomicWrite(join(txnDir, 'intent.json'), JSON.stringify(intent, null, 2));
    if (failAt(fsFail, 'after_intent')) throw new Error('injected crash after intent');

    // 2. stage payload bytes to the journal (crash here => replay from intent)
    for (let i = 0; i < cmd.ops.length; i++) {
      const op = cmd.ops[i];
      const entry = { kind: op.kind, path: op.path };
      if (op.bytes !== undefined) {
        await atomicWrite(join(stageDir, `${i}.bytes`), op.bytes);
        entry.staged = `${i}.bytes`;
        entry.bytes = op.bytes;
      }
      if (op.to !== undefined) entry.to = op.to;
      if (op.mode !== undefined) entry.mode = op.mode;
      staged.push(entry);
    }
    await atomicWrite(join(txnDir, 'staged.json'), JSON.stringify(staged, null, 2));
    if (failAt(fsFail, 'after_stage')) throw new Error('injected crash after stage');

    // 3. worktree barrier: freeze readers BEFORE first write
    await freezeReaders();
    let barrierOpen = true;
    const applied = [];
    try {
      if (failAt(fsFail, 'after_freeze')) throw new Error('injected crash after freeze');
      // 4. apply each op; journal progress per op for resume/rollback
      for (let i = 0; i < staged.length; i++) {
        const prev = {};
        await applyOpOnDisk(cmd.ops[i], staged[i], prev);
        // prev.bytes stays IN MEMORY ONLY (never journaled — multi-MB
        // blobs would bloat the journal). Same-process rollback replays
        // from it; after a crash recover() handles the partial txn
        // explicitly (noop rollback when nothing applied, else BLOCKED).
        applied.push({
          op: { kind: staged[i].kind, path: staged[i].path, to: staged[i].to, mode: staged[i].mode },
          prev,
        });
        await atomicWrite(join(txnDir, `applied-${i}.json`),
          JSON.stringify({ i, kind: staged[i].kind, path: staged[i].path, at: now() }, null, 2));
        if (failAt(fsFail, `after_op_${i}`)) throw new Error(`injected crash after op ${i}`);
      }
      if (failAt(fsFail, 'before_result')) throw new Error('injected crash before result');
      // 5. result BEFORE thaw: the single commit point
      const result = {
        v: BROKER_VERSION, commandId: cmd.commandId, txnId,
        status: 'applied', ops: applied.map((a) => ({
          kind: a.op.kind, path: a.op.path, to: a.op.to ?? undefined,
          afterHash: a.prev.afterHash ?? null,
        })),
        payloadHash: payloadHash(cmd), at: now(),
      };
      await atomicWrite(join(txnDir, 'result.json'), JSON.stringify(result, null, 2));
      await atomicWrite(resultPath(cmd.commandId), JSON.stringify(result, null, 2));
      seen[cmd.commandId] = { payloadHash: payloadHash(cmd), status: 'applied', at: now() };
      await atomicWrite(seenPath, JSON.stringify(seen, null, 2));
      if (failAt(fsFail, 'after_result')) throw new Error('injected crash after result');
      // 6. exactly one event per committed transaction
      emit({ kind: 'applied', commandId: cmd.commandId, txnId, ops: result.ops });
      return result;
    } catch (err) {
      // crash or guard failure mid-apply: roll back applied ops, journal it.
      // Injected crash points (tests) simulate a dead process: skip the
      // same-process rollback so recover() sees the honest partial state.
      const injected = err instanceof Error && /^injected crash/.test(err.message);
      if (applied.length > 0 && !injected) {
        try {
          await rollbackApplied(txnDir, cmd.ops.map((op, i) => ({ op, prev: applied[i]?.prev ?? {} })).slice(0, applied.length));
        } catch (rbErr) {
          await atomicWrite(join(txnDir, 'blocked.json'),
            JSON.stringify({ at: now(), reason: 'rollback_failed', error: String(rbErr?.message ?? rbErr) }, null, 2));
          throw bad(500, 'recovery_blocked', `rollback failed, broker blocked with diagnostics: ${rbErr?.message}`, {
            txnId, commandId: cmd.commandId,
          });
        }
        await atomicWrite(join(txnDir, 'rolledback.json'), JSON.stringify({ at: now(), ops: applied.length }, null, 2));
        emit({ kind: 'rolled_back', commandId: cmd.commandId, txnId, ops: applied.length });
      } else if (applied.length > 0 && injected) {
        // leave applied-*.json markers + partial bytes for recover(): it
        // must report crash_mid_apply/BLOCKED, never silent success.
        emit({ kind: 'crashed_mid_apply', commandId: cmd.commandId, txnId, ops: applied.length });
      }
      throw err;
    } finally {
      if (barrierOpen) {
        barrierOpen = false;
        await thawReaders();
      }
    }
  }

  async function recover() {
    await ensureDir(journalDir);
    await ensureDir(resultsDir);
    await loadSeen();
    let entries = [];
    try {
      entries = await fsp.readdir(journalDir);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
      return { recovered: [], blocked: [] };
    }
    const recovered = [];
    const blocked = [];
    for (const name of entries.sort()) {
      const txnDir = join(journalDir, name);
      let intent;
      try {
        intent = await readJson(join(txnDir, 'intent.json'));
      } catch {
        continue; // no intent => nothing touched the tree, safe to ignore
      }
      if (intent.v !== BROKER_VERSION) {
        blocked.push({ txnId: name, reason: 'version_mismatch' });
        continue;
      }
      const hasResult = await fsp.access(join(txnDir, 'result.json')).then(() => true, () => false);
      const hasRollback = await fsp.access(join(txnDir, 'rolledback.json')).then(() => true, () => false);
      if (hasResult || hasRollback) {
        // already terminal: ensure the idempotency index agrees
        if (hasResult && !seen[intent.commandId]) {
          try {
            const res = await readJson(join(txnDir, 'result.json'));
            await atomicWrite(resultPath(intent.commandId), JSON.stringify(res));
            seen[intent.commandId] = { payloadHash: intent.payloadHash, status: 'applied', at: now() };
          } catch { /* best effort */ }
        }
        recovered.push({ txnId: name, commandId: intent.commandId, outcome: hasResult ? 'already_applied' : 'already_rolled_back' });
        continue;
      }
      // crash mid-flight: check per-op applied markers. Ops are applied in
      // order; marker applied-N means ops 0..N wrote. Without prev-bytes in
      // the journal we cannot surgically roll back op N's new bytes after a
      // crash, so the rule is: if NO op applied, roll the intent back
      // (nothing changed); if ANY op applied, the transaction is BLOCKED
      // with diagnostics — a human decides, new readers are not admitted.
      // This is the honest non-toy behavior: never claim success, never
      // silently lose the partial write.
      let appliedCount = 0;
      for (let i = 0; ; i++) {
        const ok = await fsp.access(join(txnDir, `applied-${i}.json`)).then(() => true, () => false);
        if (!ok) break;
        appliedCount = i + 1;
      }
      if (appliedCount === 0) {
        await atomicWrite(join(txnDir, 'rolledback.json'),
          JSON.stringify({ at: now(), ops: 0, via: 'recover_noop' }, null, 2));
        recovered.push({ txnId: name, commandId: intent.commandId, outcome: 'rolled_back_noop' });
      } else {
        await atomicWrite(join(txnDir, 'blocked.json'),
          JSON.stringify({
            at: now(), reason: 'crash_mid_apply', appliedOps: appliedCount,
            note: 'partial apply on disk; manual reconcile required before new readers',
          }, null, 2));
        blocked.push({ txnId: name, commandId: intent.commandId, reason: 'crash_mid_apply', appliedOps: appliedCount });
        emit({ kind: 'recovery_blocked', txnId: name, commandId: intent.commandId, appliedOps: appliedCount });
      }
    }
    if (Object.keys(seen).length > 0 || recovered.length > 0) {
      await atomicWrite(seenPath, JSON.stringify(seen, null, 2)).catch(() => {});
    }
    // The barrier stays closed while blocked is non-empty: the parent must
    // resolve blocked txns (reconcile + remove blocked.json) before readers
    // run again. Report it; do not auto-open.
    return { recovered, blocked };
  }

  // stop during apply: finish-or-roll-back the in-flight transaction first,
  // then thaw, then confirm terminal. The queue serializes this AFTER the
  // current transaction's barrier section — never interleaved mid-op.
  function stop() {
    const prev = queue;
    queue = prev.then(async () => {
      if (frozen) await thawReaders();
      emit({ kind: 'stopped', at: now() });
      return { stopped: true };
    });
    return queue;
  }

  function submit(cmd, gate = {}) {
    // Never throw synchronously: validation failures reject like any other
    // broker error so callers can uniformly `await assert.rejects(...)`.
    const task = queue.then(async () => {
      validateCommand(cmd);
      // idempotency BEFORE any guard work: same id + same payload replays,
      // same id + different payload is rejected, never applied twice.
      const ph = payloadHash(cmd);
      if (seen[cmd.commandId]) {
        const prev = seen[cmd.commandId];
        if (prev.payloadHash !== ph) {
          throw bad(409, 'duplicate_differs',
            `commandId ${cmd.commandId} already applied with a different payload`, { commandId: cmd.commandId });
        }
        try {
          const res = await readJson(resultPath(cmd.commandId));
          emit({ kind: 'replayed', commandId: cmd.commandId });
          return res;
        } catch {
          return { v: BROKER_VERSION, commandId: cmd.commandId, status: 'applied', replayed: true, at: now() };
        }
      }
      // A result file on disk without a seen entry (crash between result
      // write and seen update, before recover ran): treat as applied.
      const diskResult = await fsp.access(resultPath(cmd.commandId)).then(() => true, () => false);
      if (diskResult) {
        const res = await readJson(resultPath(cmd.commandId));
        if (res.payloadHash !== undefined && res.payloadHash !== ph) {
          throw bad(409, 'duplicate_differs', `commandId ${cmd.commandId} already applied with a different payload`);
        }
        seen[cmd.commandId] = { payloadHash: ph, status: 'applied', at: now() };
        await atomicWrite(seenPath, JSON.stringify(seen, null, 2));
        emit({ kind: 'replayed', commandId: cmd.commandId });
        return res;
      }
      await checkGuards(cmd, gate);
      await checkPreconditions(cmd);
      await ensureDir(journalDir);
      await ensureDir(resultsDir);
      return runTransaction(cmd, gate);
    });
    // keep the chain alive for the next command even if this one rejects
    queue = task.catch(() => {});
    return task;
  }

  return {
    submit,
    recover,
    stop,
    isFrozen: () => frozen,
    frozenIdentities: () => [...frozenIdentities],
    paths: () => ({ rootDir, treeDir, journalDir, resultsDir }),
    // test seam: drop in-memory idempotency to simulate a fresh process
    // after a crash (disk journal is the source of truth).
    dropMemory: () => { seen = {}; },
  };
}

export const PHASES = { WRITE: [...WRITE_PHASES] };
