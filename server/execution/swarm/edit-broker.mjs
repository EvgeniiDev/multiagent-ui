// S2 durable edit broker. Linux descriptor-relative filesystem operations.
// Parent supplies trusted gate.currentLease / gate.ownershipFor and physical reader barriers.
// intent + binary beforeimages + started marker precede ALL tree mutations.
// result.json is the commit point: recovery rolls back uncommitted transactions,
// completes indexes/outbox for committed ones, and keeps readers frozen on errors.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp, constants as fsconst, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
export const BROKER_VERSION = 3;
const OP_KINDS = new Set(['write', 'create', 'delete', 'rename', 'chmod']);
const FILE_MODES = new Set([0o100644, 0o100755]);
const WRITE_PHASES = new Set(['implement', 'catch_up']);
export class BrokerError extends Error {
    constructor(status, code, message, extra = {}) { super(message); this.name = 'BrokerError'; this.status = status; this.code = code; this.extra = extra; }
}
const bad = (status, code, message, extra) => new BrokerError(status, code, message, extra);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function canonicalJson(v) {
    if (Array.isArray(v))
        return `[${v.map(canonicalJson).join(',')}]`;
    if (isObj(v))
        return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}
export const sha256Hex = text => createHash('sha256').update(text, 'utf8').digest('hex');
export const sha256Bytes = buf => createHash('sha256').update(buf).digest('hex');
const failAt = (fsFail, point) => fsFail?.at instanceof Set && fsFail.at.has(point);
function splitPath(raw) {
    if (typeof raw !== 'string' || !raw.length || raw.length > 1024)
        throw bad(422, 'bad_path', 'invalid path');
    if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/.test(raw))
        throw bad(422, 'absolute_path', 'absolute path rejected');
    const parts = raw.split('/');
    if (parts.some(s => !s || s === '.' || s === '..'))
        throw bad(422, 'path_traversal', 'path must be canonical and relative');
    if (parts.includes('.git'))
        throw bad(422, 'git_path', '.git path rejected');
    if (parts.some(s => s.length > 255 || s.includes('\0') || s.startsWith('.swarm-')))
        throw bad(422, 'bad_path', 'invalid segment');
    return parts;
}
async function syncDir(path) {
    const fd = await fsp.open(path, fsconst.O_RDONLY | fsconst.O_DIRECTORY | fsconst.O_NOFOLLOW);
    try {
        await fd.sync();
    }
    finally {
        await fd.close();
    }
}
async function ensureDir(path) {
    const first = await fsp.mkdir(path, { recursive: true, mode: 0o700 });
    const stop = first ? dirname(first) : dirname(path);
    for (let current = path;; current = dirname(current)) {
        await syncDir(current);
        if (current === stop)
            break;
    }
}
async function atomicWrite(path, data) {
    const tmp = `${path}.tmp-${randomUUID()}`;
    const fd = await fsp.open(tmp, fsconst.O_WRONLY | fsconst.O_CREAT | fsconst.O_EXCL | fsconst.O_NOFOLLOW, 0o600);
    try {
        await fd.writeFile(data);
        await fd.sync();
    }
    finally {
        await fd.close();
    }
    await fsp.rename(tmp, path);
    await syncDir(join(path, '..'));
}
const readJson = async (path) => JSON.parse(await fsp.readFile(path, 'utf8'));
async function optionalJson(path) { try {
    return await readJson(path);
}
catch (e) {
    if (e.code === 'ENOENT')
        return null;
    throw e;
} }
// Every directory component is opened from the previous held descriptor.
// No tree read/mutation resolves an attacker-controlled absolute parent path.
async function anchorTree(treeDir, paths) {
    if (process.platform !== 'linux')
        throw bad(503, 'descriptor_paths_unavailable', 'Linux /proc/self/fd is required');
    const handles = [];
    const anchors = new Map();
    try {
        const root = await fsp.open(treeDir, fsconst.O_RDONLY | fsconst.O_DIRECTORY | fsconst.O_NOFOLLOW);
        handles.push(root);
        const rootStat = await root.stat({ bigint:true });
        const identities = { root: `${rootStat.dev}:${rootStat.ino}`, parents: {} };
        for (const path of new Set(paths)) {
            const parts = splitPath(path);
            let parent = root;
            for (const part of parts.slice(0, -1)) {
                try {
                    parent = await fsp.open(`/proc/self/fd/${parent.fd}/${part}`, fsconst.O_RDONLY | fsconst.O_DIRECTORY | fsconst.O_NOFOLLOW);
                    handles.push(parent);
                }
                catch (e) {
                    if (e.code === 'ELOOP' || e.code === 'ENOTDIR')
                        throw bad(422, 'symlink_component', 'unsafe ancestor');
                    if (e.code === 'ENOENT')
                        throw bad(409, 'missing_parent', 'missing parent');
                    throw e;
                }
            }
            anchors.set(path, { parent, leaf: parts.at(-1), path: `/proc/self/fd/${parent.fd}/${parts.at(-1)}` });
            const stat = await parent.stat({ bigint:true });
            identities.parents[path] = `${stat.dev}:${stat.ino}`;
        }
        return { identities, get: path => anchors.get(path), close: async () => { for (const h of handles.reverse())
                await h.close(); } };
    }
    catch (e) {
        for (const h of handles.reverse())
            await h.close().catch(() => { });
        throw e;
    }
}
// Held descriptors prevent redirection, but may refer to detached directories.
// Rewalk the live root without following links and require the persisted inode
// bindings before claiming or restoring any edit on the visible canonical tree.
async function assertTreeIdentity(treeDir, anchors, expected) {
    if (!isObj(expected) || typeof expected.root !== 'string' || !isObj(expected.parents)
        || !Object.keys(expected.parents).length || Object.values(expected.parents).some(v => typeof v !== 'string'))
        throw bad(500, 'anchor_identity_changed', 'missing original tree identity');
    let fresh;
    try {
        fresh = await anchorTree(treeDir, Object.keys(expected.parents));
        for (const identity of [anchors.identities, fresh.identities]) {
            if (identity.root !== expected.root || Object.keys(identity.parents).length !== Object.keys(expected.parents).length
                || Object.entries(expected.parents).some(([path, value]) => identity.parents[path] !== value))
                throw bad(409, 'anchor_identity_changed', 'canonical root or parent directory was replaced');
        }
    } catch (e) {
        if (e.code === 'anchor_identity_changed') throw e;
        throw bad(409, 'anchor_identity_changed', 'canonical root or parent directory is no longer reachable safely', { cause: String(e) });
    } finally { await fresh?.close(); }
}
async function readLeaf(anchor) {
    let fd;
    try {
        fd = await fsp.open(anchor.path, fsconst.O_RDONLY | fsconst.O_NOFOLLOW | fsconst.O_NONBLOCK);
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return null;
        if (e.code === 'ELOOP')
            throw bad(422, 'symlink_target', 'symlink leaf rejected');
        throw e;
    }
    try {
        const stat = await fd.stat();
        if (!stat.isFile())
            throw bad(422, 'not_a_file', 'only regular files may change');
        if (stat.nlink !== 1)
            throw bad(422, 'hardlink_target', 'shared inode rejected');
        return { bytes: await fd.readFile(), mode: stat.mode & 0o777 };
    }
    finally {
        await fd.close();
    }
}
async function replaceLeaf(anchor, bytes, mode, verify = async () => {}) {
    // Atomic replacement avoids truncate-after-open and external hardlink writes.
    await verify();
    const tmp = `/proc/self/fd/${anchor.parent.fd}/.swarm-${randomUUID()}`;
    const fd = await fsp.open(tmp, fsconst.O_WRONLY | fsconst.O_CREAT | fsconst.O_EXCL | fsconst.O_NOFOLLOW, mode);
    try {
        await fd.writeFile(bytes);
        await fd.chmod(mode);
        await fd.sync();
    }
    finally {
        await fd.close();
    }
    await verify();
    await fsp.rename(tmp, anchor.path);
    await verify();
    await anchor.parent.sync();
}
async function unlinkLeaf(anchor, verify = async () => {}) {
    await verify();
    try {
        await fsp.unlink(anchor.path);
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    await verify();
    await anchor.parent.sync();
}
// .swarm- is reserved by the broker. A process can die after creating its
// replacement file but before rename; recovery removes those anchored entries.
async function cleanupTemps(anchors, paths, verify = async () => {}) {
    const parents = new Map();
    for (const path of paths) {
        const parent = anchors.get(path).parent;
        const stat = await parent.stat();
        parents.set(`${stat.dev}:${stat.ino}`, parent);
    }
    for (const parent of parents.values()) {
        const path = `/proc/self/fd/${parent.fd}`;
        for (const leaf of await fsp.readdir(path)) {
            if (/^\.swarm-[0-9a-f-]{36}$/.test(leaf)) {
                await verify();
                await fsp.unlink(`${path}/${leaf}`);
                await verify();
            }
        }
        await parent.sync();
    }
}

function validateCommand(cmd) {
    if (!isObj(cmd))
        throw bad(422, 'bad_command', 'command must be an object');
    if (typeof cmd.commandId !== 'string' || cmd.commandId.length === 0 || cmd.commandId.length > 128) {
        throw bad(422, 'bad_command_id', 'commandId must be a non-empty string <= 128');
    }
    const lease = cmd.lease;
    if (!isObj(lease))
        throw bad(401, 'missing_lease', 'lease is required');
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
            if (typeof op.to !== 'string')
                throw bad(422, 'bad_op', 'rename needs "to"');
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
    if (!isObj(cmd.ownership))
        throw bad(422, 'bad_ownership', 'ownership proof map is required');
}
export function createEditBroker(opts) {
    if (!isObj(opts) || typeof opts.rootDir !== 'string' || typeof opts.treeDir !== 'string')
        throw Error('createEditBroker requires {rootDir,treeDir}');
    const rootDir = resolve(opts.rootDir), treeDir = resolve(opts.treeDir), hooks = opts.hooks ?? {}, fsFail = opts.fsFail ?? {}, now = opts.clock ?? Date.now;
    const journalDir = join(rootDir, 'journal'), resultsDir = join(rootDir, 'results'), seenPath = join(rootDir, 'seen.json'), barrierPath = join(rootDir, 'barrier.json');
    let seen = {}, queue = Promise.resolve(), frozen = existsSync(barrierPath), frozenIdentities = [];
    if (frozen) {
        try {
            frozenIdentities = JSON.parse(readFileSync(barrierPath, 'utf8')).identities;
        }
        catch { }
    }
    const emit = async (e) => { await hooks.onEvent?.({ at: now(), ...e }); };
    const hash = cmd => sha256Hex(canonicalJson(cmd));
    const resultPath = id => join(resultsDir, `${sha256Hex(id)}.json`);
    const touched = ops => ops.flatMap(op => [op.path, op.kind === 'rename' ? op.to : null].filter(Boolean));
    const inject = point => { if (failAt(fsFail, point))
        throw Error(['write', 'delete', 'rename', 'rollback'].includes(point) ? `injected ${point} failure` : `injected crash ${point}`); };
    async function freezeReaders() {
        if (typeof hooks.readerIdentities !== 'function' || typeof hooks.onFreeze !== 'function' || typeof hooks.onThaw !== 'function')
            throw bad(503, 'reader_barrier_unavailable', 'physical reader freeze/thaw hooks are required');
        const existing = await optionalJson(barrierPath);
        const ids = existing?.identities ?? await hooks.readerIdentities();
        if (!Array.isArray(ids))
            throw bad(503, 'reader_barrier_unavailable', 'reader identities must be an array');
        try {
            await atomicWrite(barrierPath, JSON.stringify({ identities: ids, at: now() }));
        } catch (error) {
            if (existsSync(barrierPath)) {
                frozen = true;
                frozenIdentities = ids;
            }
            throw error;
        }
        frozen = true;
        frozenIdentities = ids;
        await hooks.onFreeze(ids);
    }
    async function thawReaders() {
        if (!frozen)
            return;
        await hooks.onThaw(frozenIdentities);
        await fsp.unlink(barrierPath);
        await syncDir(rootDir);
        frozen = false;
        frozenIdentities = [];
    }
    async function checkGuards(cmd, gate) {
        if (typeof gate?.currentLease !== 'function' || typeof gate?.ownershipFor !== 'function')
            throw bad(503, 'authority_unavailable', 'trusted lease and ownership lookups are required');
        const cur = await gate.currentLease(cmd.lease.participantId, cmd.lease.attemptId);
        if (!cur)
            throw bad(409, 'stale_lease', 'no current lease');
        for (const key of ['runId', 'participantId', 'attemptId', 'turnId', 'generation'])
            if (cur[key] !== cmd.lease[key])
                throw bad(409, 'stale_lease', `current lease differs on ${key}`);
        if (cur.terminal === true)
            throw bad(409, 'lease_terminal', 'lease is terminal');
        if (cur.terminal !== false)
            throw bad(503, 'authority_unavailable', 'lease terminal state must be explicit');
        if (!WRITE_PHASES.has(cmd.phase) || cur.phase !== cmd.phase)
            throw bad(409, 'bad_phase', 'edits require current implement/catch_up phase');
        if (gate.decisionsAgreed !== true)
            throw bad(409, 'decisions_pending', 'required decisions are not agreed');
        for (const op of cmd.ops)
            for (const path of [op.path, ...(op.kind === 'rename' ? [op.to] : [])]) {
                const proof = cmd.ownership[path], authority = await gate.ownershipFor(path);
                if (!isObj(proof) || !isObj(authority))
                    throw bad(403, 'no_ownership_proof', 'authoritative ownership is missing', { path });
                if (!Number.isInteger(authority.version) || proof.version !== authority.version)
                    throw bad(409, 'stale_ownership', 'ownership version differs', { path });
                if ((proof.owner ?? null) !== (authority.owner ?? null) || (proof.reservedBy ?? null) !== (authority.reservedBy ?? null))
                    throw bad(403, 'not_owner', 'ownership proof differs from authority', { path });
                const reserved = path === op.to || op.kind === 'create';
                if (authority.owner !== cmd.lease.participantId && !(reserved && authority.owner == null && authority.reservedBy === cmd.lease.participantId))
                    throw bad(403, 'not_owner', 'participant does not own or reserve path', { path });
            }
    }
    async function preconditions(cmd, anchors) {
        for (const op of cmd.ops) {
            const leaf = await readLeaf(anchors.get(op.path)), exp = op.expected ?? {};
            if (exp.type !== undefined && exp.type !== 'file')
                throw bad(422, 'bad_type', 'only regular files supported');
            if (exp.absent === true && leaf)
                throw bad(409, 'exists', 'expected absent');
            if (op.kind === 'create' && leaf)
                throw bad(409, 'exists', 'create target exists');
            if (op.kind !== 'create' && !leaf)
                throw bad(409, 'missing', 'target missing');
            if (exp.hash !== undefined && (!leaf || sha256Bytes(leaf.bytes) !== exp.hash))
                throw bad(409, 'stale_hash', 'content hash mismatch');
            if (exp.mode !== undefined) {
                if (!FILE_MODES.has(exp.mode))
                    throw bad(422, 'bad_mode', 'unsupported expected mode');
                if (!leaf || (0o100000 | leaf.mode) !== exp.mode)
                    throw bad(409, 'stale_mode', 'mode mismatch');
            }
            if (op.kind === 'rename' && await readLeaf(anchors.get(op.to)) && !cmd.allowOverwrite)
                throw bad(409, 'rename_collision', 'destination exists');
        }
    }
    async function restore(txnDir, intent, anchors = null) {
        inject('rollback');
        const ownAnchors = anchors ?? await anchorTree(treeDir, intent.before.map(r => r.path));
        const verify = () => assertTreeIdentity(treeDir, ownAnchors, intent.identities);
        try {
            await assertTreeIdentity(treeDir, ownAnchors, intent.identities);
            // Beforeimages cover BOTH rename endpoints and every touched path.
            for (const image of [...intent.before].reverse()) {
                await assertTreeIdentity(treeDir, ownAnchors, intent.identities);
                const anchor = ownAnchors.get(image.path);
                if (image.absent) {
                    await unlinkLeaf(anchor, verify);
                    await assertTreeIdentity(treeDir, ownAnchors, intent.identities);
                    continue;
                }
                const bytes = await fsp.readFile(join(txnDir, image.file));
                if (sha256Bytes(bytes) !== image.sha256)
                    throw Error('beforeimage hash mismatch');
                await replaceLeaf(anchor, bytes, image.mode, verify);
                await assertTreeIdentity(treeDir, ownAnchors, intent.identities);
            }
            await assertTreeIdentity(treeDir, ownAnchors, intent.identities);
            await cleanupTemps(ownAnchors, intent.before.map(image => image.path), () => assertTreeIdentity(treeDir, ownAnchors, intent.identities));
            await assertTreeIdentity(treeDir, ownAnchors, intent.identities);
            await atomicWrite(join(txnDir, 'rolledback.json'), JSON.stringify({ at: now(), ops: intent.ops.length }));
            await fsp.unlink(join(txnDir, 'blocked.json')).catch(e => { if (e.code !== 'ENOENT')
                throw e; });
            await syncDir(txnDir);
        }
        finally {
            if (!anchors)
                await ownAnchors.close();
        }
    }
    async function finalize(txnDir, intent, result) {
        await atomicWrite(resultPath(intent.commandId), JSON.stringify(result));
        seen[intent.commandId] = { payloadHash: intent.payloadHash, status: 'applied', at: result.at };
        await atomicWrite(seenPath, JSON.stringify(seen));
        if (!await optionalJson(join(txnDir, 'event-delivered.json'))) {
            await emit({ kind: 'applied', eventId: result.eventId, commandId: intent.commandId, txnId: intent.txnId, ops: result.ops });
            await atomicWrite(join(txnDir, 'event-delivered.json'), JSON.stringify({ eventId: result.eventId, at: now() }));
        }
    }
    async function recoverInternal() {
        await ensureDir(journalDir);
        await ensureDir(resultsDir);
        seen = await optionalJson(seenPath) ?? {};
        const barrier = await optionalJson(barrierPath);
        if (barrier) {
            frozen = true;
            frozenIdentities = barrier.identities;
        }
        const recovered = [], blocked = [];
        for (const name of (await fsp.readdir(journalDir)).sort()) {
            const txnDir = join(journalDir, name);
            if (!(await fsp.lstat(txnDir)).isDirectory())
                continue;
            let intent;
            try {
                intent = await optionalJson(join(txnDir, 'intent.json'));
            }
            catch (e) {
                blocked.push({ txnId: name, reason: 'invalid_intent', error: String(e) });
                continue;
            }
            if (!intent)
                continue;
            try {
                if (intent.v !== BROKER_VERSION)
                    throw Error('unsupported journal version');
                const result = await optionalJson(join(txnDir, 'result.json'));
                if (result) {
                    await syncDir(txnDir);
                    await freezeReaders();
                    const anchors = await anchorTree(treeDir, intent.before.map(image => image.path));
                    try { await assertTreeIdentity(treeDir, anchors, intent.identities); }
                    finally { await anchors.close(); }
                    await finalize(txnDir, intent, result);
                    recovered.push({ txnId: name, commandId: intent.commandId, outcome: 'already_applied' });
                    continue;
                }
                if (await optionalJson(join(txnDir, 'rolledback.json'))) {
                    recovered.push({ txnId: name, commandId: intent.commandId, outcome: 'already_rolled_back' });
                    continue;
                }
                const started = await optionalJson(join(txnDir, 'started.json'));
                if (started || await optionalJson(join(txnDir, 'blocked.json'))) {
                    await freezeReaders();
                    await restore(txnDir, intent);
                    recovered.push({ txnId: name, commandId: intent.commandId, outcome: 'rolled_back' });
                }
                else {
                    // A crash under the barrier can precede started.json and
                    // blocked.json. Admission must still prove the original tree.
                    await freezeReaders();
                    const anchors = await anchorTree(treeDir, intent.before.map(image => image.path));
                    try { await assertTreeIdentity(treeDir, anchors, intent.identities); }
                    finally { await anchors.close(); }
                    await atomicWrite(join(txnDir, 'rolledback.json'), JSON.stringify({ at: now(), ops: 0 }));
                    recovered.push({ txnId: name, commandId: intent.commandId, outcome: 'rolled_back_noop' });
                }
            }
            catch (e) {
                await atomicWrite(join(txnDir, 'blocked.json'), JSON.stringify({ at: now(), error: String(e) }));
                blocked.push({ txnId: name, commandId: intent.commandId, reason: 'recovery_failed', error: String(e) });
            }
        }
        if (blocked.length) {
            if (!frozen)
                await freezeReaders();
            return { recovered, blocked };
        }
        await thawReaders();
        return { recovered, blocked };
    }
    async function transaction(cmd, gate) {
        if (new Set(touched(cmd.ops)).size !== touched(cmd.ops).length)
            throw bad(422, 'overlapping_ops', 'each batch path may be touched only once');
        await checkGuards(cmd, gate);
        const anchors = await anchorTree(treeDir, touched(cmd.ops));
        let txnDir, intent, started = false, committed = false;
        try {
            await preconditions(cmd, anchors);
            const txnId = `txn-${now()}-${randomUUID()}`;
            txnDir = join(journalDir, txnId);
            await ensureDir(join(txnDir, 'before'));
            const before = [];
            for (const [i, path] of [...new Set(touched(cmd.ops))].entries()) {
                const leaf = await readLeaf(anchors.get(path));
                if (!leaf) {
                    before.push({ path, absent: true });
                    continue;
                }
                const file = `before/${i}.bytes`;
                await atomicWrite(join(txnDir, file), leaf.bytes);
                before.push({ path, file, mode: leaf.mode, sha256: sha256Bytes(leaf.bytes) });
            }
            intent = { v: BROKER_VERSION, txnId, commandId: cmd.commandId, payloadHash: hash(cmd), ops: cmd.ops, before, identities: anchors.identities, at: now() };
            await atomicWrite(join(txnDir, 'intent.json'), JSON.stringify(intent));
            inject('after_intent');
            await atomicWrite(join(txnDir, 'staged.json'), JSON.stringify(cmd.ops));
            inject('after_stage');
            await freezeReaders();
            inject('after_freeze');
            // Freeze callbacks may change leases/claims or the tree: revalidate under barrier.
            await checkGuards(cmd, gate);
            await assertTreeIdentity(treeDir, anchors, intent.identities);
            await preconditions(cmd, anchors);
            for (const image of before) {
                const leaf = await readLeaf(anchors.get(image.path));
                if (image.absent ? leaf !== null : !leaf || sha256Bytes(leaf.bytes) !== image.sha256 || leaf.mode !== image.mode) {
                    throw bad(409, 'stale_hash', 'tree changed before the reader barrier');
                }
            }
            await atomicWrite(join(txnDir, 'started.json'), JSON.stringify({ at: now() }));
            started = true;
            const results = [];
            const verify = () => assertTreeIdentity(treeDir, anchors, intent.identities);
            for (const [i, op] of cmd.ops.entries()) {
                await assertTreeIdentity(treeDir, anchors, intent.identities);
                const a = anchors.get(op.path);
                const previous = await readLeaf(a);
                switch (op.kind) {
                    case 'write':
                        inject('write');
                        await replaceLeaf(a, Buffer.from(op.bytes, 'utf8'), op.mode === undefined ? previous.mode : op.mode & 0o777, verify);
                        break;
                    case 'create':
                        inject('write');
                        await replaceLeaf(a, Buffer.from(op.bytes, 'utf8'), (op.mode ?? 0o100644) & 0o777, verify);
                        break;
                    case 'delete':
                        inject('delete');
                        await unlinkLeaf(a, verify);
                        break;
                    case 'rename': {
                        inject('rename');
                        const dst = anchors.get(op.to);
                        await verify();
                        await fsp.rename(a.path, dst.path);
                        await verify();
                        await a.parent.sync();
                        await dst.parent.sync();
                        break;
                    }
                    case 'chmod': {
                        const fd = await fsp.open(a.path, fsconst.O_RDONLY | fsconst.O_NOFOLLOW);
                        try {
                            const st = await fd.stat();
                            if (!st.isFile() || st.nlink !== 1)
                                throw bad(422, 'not_a_file', 'unsafe chmod target');
                            await verify();
                            await fd.chmod(op.mode & 0o777);
                            await verify();
                            await fd.sync();
                        }
                        finally {
                            await fd.close();
                        }
                        await a.parent.sync();
                        break;
                    }
                }
                inject(`after_mutation_${i}`);
                await assertTreeIdentity(treeDir, anchors, intent.identities);
                await atomicWrite(join(txnDir, `applied-${i}.json`), JSON.stringify({ i, at: now() }));
                inject(`after_op_${i}`);
                const after = op.kind === 'delete' ? null : await readLeaf(anchors.get(op.kind === 'rename' ? op.to : op.path));
                results.push({ kind: op.kind, path: op.path, ...(op.to ? { to: op.to } : {}), afterHash: after ? sha256Bytes(after.bytes) : null });
            }
            inject('before_result');
            await assertTreeIdentity(treeDir, anchors, intent.identities);
            const result = { v: BROKER_VERSION, commandId: cmd.commandId, txnId, status: 'applied', ops: results, payloadHash: intent.payloadHash, eventId: `swarm-edit-${sha256Hex(cmd.commandId)}`, at: now() };
            await atomicWrite(join(txnDir, 'result.json'), JSON.stringify(result));
            committed = true;
            inject('after_result');
            await finalize(txnDir, intent, result);
            await thawReaders();
            return result;
        }
        catch (e) {
            // Publication can rename result.json before directory fsync fails. Its
            // presence fences rollback too; recovery retries durable publication.
            if (txnDir && await optionalJson(join(txnDir, 'result.json')))
                committed = true;
            if (committed || /^injected crash/.test(e.message))
                throw e;
            if (e.code === 'anchor_identity_changed' && frozen) {
                await atomicWrite(join(txnDir, 'blocked.json'), JSON.stringify({ at: now(), code:e.code, error:String(e), identities:intent.identities }));
                throw e;
            }
            if (started) {
                try {
                    await restore(txnDir, intent, anchors);
                }
                catch (rb) {
                    await atomicWrite(join(txnDir, 'blocked.json'), JSON.stringify({ error: String(rb) }));
                    throw bad(500, 'recovery_blocked', 'rollback failed', { txnId: intent.txnId });
                }
            }
            if (frozen)
                await thawReaders();
            throw e;
        }
        finally {
            await anchors.close();
        }
    }
    function enqueue(fn) { const task = queue.then(fn); queue = task.catch(() => { }); return task; }
    function recover() { return enqueue(recoverInternal); }
    function submit(cmd, gate) {
        return enqueue(async () => {
            validateCommand(cmd);
            const recovery = await recoverInternal();
            if (recovery.blocked.length)
                throw bad(500, 'recovery_blocked', 'pending recovery blocks edits', recovery);
            const ph = hash(cmd), prev = seen[cmd.commandId];
            if (prev) {
                if (prev.payloadHash !== ph)
                    throw bad(409, 'duplicate_differs', 'idempotency payload differs');
                return readJson(resultPath(cmd.commandId));
            }
            return transaction(cmd, gate);
        });
    }
    function stop() { return enqueue(async () => { const recovery = await recoverInternal(); if (recovery.blocked.length)
        throw bad(500, 'recovery_blocked', 'pending recovery blocks stop', recovery); await emit({ kind: 'stopped' }); return { stopped: true }; }); }
    return { submit, recover, stop, isFrozen: () => frozen, frozenIdentities: () => [...frozenIdentities], paths: () => ({ rootDir, treeDir, journalDir, resultsDir }), dropMemory: () => { seen = {}; } };
}
export const PHASES = { WRITE: [...WRITE_PHASES] };
