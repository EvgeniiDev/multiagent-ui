// server/execution/state-service.mjs — the state server's request engine.
//
// Holds the whole request contract (legacy KV + porch read-only + execution
// API) behind a transport-agnostic `service.request({method, path, query,
// bodyText})` — acp-state-server.mjs only adapts sockets to it, so tests drive
// the real production handler without opening a listener.
//
// The write side is ONE serialized queue: every PUT/DELETE on /api/state/*
// and every execution command/preset write passes through the same promise
// chain, and each queued op re-reads the current doc before its CAS check —
// two concurrent PUTs carrying the same revision cannot both win, including
// the missing-document case (absent counts as rev 0 and a nonzero expected
// rev conflicts).
//
// Recovery: a repair pass runs at startup, before every queued write op, and
// before serving managed state (board.json / execution reads). It drains
// durable pendingWrites intents recorded on aggregates (claims purges,
// preset upserts — applied idempotently, never over a newer registry entry)
// and re-projects board.json from aggregate truth. A crash between the
// aggregate commit and its external effects is therefore healed before the
// next op rather than waiting for a restart.
//
// Managed-card protection lives inside the queue ops, not in clients:
// board.json PUTs must keep every managed card row and restore server-owned
// fields from the aggregate; claims.json PUTs must keep claim/attempt
// entries for managed cards byte-identical; DELETEs refuse while managed
// references remain.

import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  ensureStore,
  loadAggregate,
  saveAggregate,
  listManagedCardIds,
  listAggregates,
  writeBlob,
  readBlob,
  requireBlob,
  loadPresets,
  savePresets,
  loadCompatOverride,
  loadRun,
  saveRun,
  writeRunEvents,
  loadSchedulerLimits,
  loadEnvironments,
  saveEnvironments,
  emptyEnvironments,
  importStagedArtifact,
  runArtifactsDir,
  ARTIFACT_MAX_BYTES,
  paths,
  SHA256_RE,
} from './execution-store.mjs';
import {
  ensureInternalToken,
  extractPresentedToken,
  tokenMatches,
} from './internal-transport.mjs';
import {
  validateWorkspaceRoot,
  ensureWorkspaceRootAccess,
  workspaceRoot as configuredWorkspaceRoot,
} from './workspaces.mjs';
import {
  CommandError,
  ATTEMPT_NONTERMINAL,
  applyCardCommand,
  applyEnvCommand,
  mergeBoardWrite,
  guardClaimsWrite,
  guardBoardDelete,
  guardClaimsDelete,
  repairBoardProjections,
  mergedCompat,
  validatePreset,
  errorBody,
} from './execution-domain.mjs';
import {
  loadRegistry, verifyManifest, bindingConfigDigest,
} from './preparation/skills/registry.mjs';
import { ADAPTERS } from './preparation/skills/adapters.mjs';
import { defaultHostCapabilities } from './preparation/skills/capabilities.mjs';
import {
  preparationSummary, preparationView, evaluateReadiness,
} from './preparation/session.mjs';
import { SAFE_ID_RE, RuntimeError } from './common.mjs';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function numOrUndef(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
const NAME_RE = /^[a-z0-9._-]{1,64}$/;
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const AUDIT_TAIL_BYTES = 512 * 1024;
const CARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// ---------------------------------------------------------------------------
// porch read-only bridge (external runs, unchanged from the flat server —
// managed runs live under execution/state, this reader keeps its own root).
// ---------------------------------------------------------------------------

function makePorchReader(env = process.env) {
  function steerRoot() {
    const dir = env.PORCH_STEER_DIR;
    if (dir && dir.trim()) return resolve(dir.replace(/^~(?=$|\/)/, homedir()));
    const xdg = env.XDG_CACHE_HOME;
    const base = xdg && xdg.trim() ? xdg : join(homedir(), '.cache');
    return join(base, 'pragmatic-orchestration', 'steer');
  }
  function runsDir() {
    return join(steerRoot(), 'runs');
  }
  function runDir(runId) {
    if (!RUN_ID_RE.test(runId)) return null;
    const dir = resolve(runsDir(), runId);
    if (!dir.startsWith(resolve(runsDir()) + sep)) return null;
    return dir;
  }
  async function readJsonSafe(p) {
    try {
      return JSON.parse(await fs.readFile(p, 'utf-8'));
    } catch {
      return null;
    }
  }
  async function listRuns() {
    let entries = [];
    try {
      entries = await fs.readdir(runsDir(), { withFileTypes: true });
    } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      throw e;
    }
    const out = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const meta = await readJsonSafe(join(runsDir(), ent.name, 'meta.json'));
      if (!meta) continue;
      out.push({
        runId: meta.run_id || ent.name,
        agentId: meta.agent_id ?? null,
        backend: meta.backend ?? null,
        model: meta.model ?? null,
        cwd: meta.cwd ?? null,
        status: meta.status ?? null,
        pid: meta.pid ?? null,
        childPid: meta.child_pid ?? null,
        exitCode: meta.exit_code ?? null,
        startedAt: meta.started_at ?? null,
        finishedAt: meta.finished_at ?? null,
        updatedAt: meta.updated_at ?? null,
      });
    }
    out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return out;
  }
  async function readTail(p, maxBytes) {
    let fh;
    try {
      fh = await fs.open(p, 'r');
    } catch {
      return null;
    }
    try {
      const st = await fh.stat();
      const start = st.size > maxBytes ? st.size - maxBytes : 0;
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      let text = buf.toString('utf-8');
      if (start > 0) {
        const nl = text.indexOf('\n');
        if (nl >= 0) text = text.slice(nl + 1);
      }
      return { text, truncated: start > 0, size: st.size };
    } finally {
      await fh.close();
    }
  }
  async function readRun(runId) {
    const dir = runDir(runId);
    if (!dir) return { invalid: true };
    const meta = await readJsonSafe(join(dir, 'meta.json'));
    if (!meta) return { missing: true };
    const state = await readJsonSafe(join(dir, 'state.json'));
    const audit = await readTail(join(dir, 'audit.jsonl'), AUDIT_TAIL_BYTES);
    let final = null;
    try {
      final = await fs.readFile(join(dir, 'final.txt'), 'utf-8');
    } catch {
      /* not terminal yet */
    }
    return { meta, state, audit, final };
  }
  return { listRuns, readRun, runsDir };
}

// ---------------------------------------------------------------------------

export async function createStateService({ stateDir, env = process.env, faults, features, preparation } = {}) {
  if (!stateDir) throw new Error('createStateService: stateDir is required');
  await fs.mkdir(stateDir, { recursive: true });
  await ensureStore(stateDir);
  const porch = makePorchReader(env);

  // P1 idea preparation: the binding registry path. Defaults to the pinned
  // P0 registry; tests/ops may point elsewhere — the file is DATA, loaded
  // fresh inside each command that needs it (never cached across requests,
  // so a repin is observed on the next evaluation).
  const prepRegistryPath = preparation?.registryPath
    ?? env.ACP_PREP_REGISTRY
    ?? fileURLToPath(new URL('./preparation/skills/bindings.json', import.meta.url));
  // Deps bag for the session module's read surfaces — the same ctx seams the
  // domain handlers use.
  const PREP_VIEW_DEPS = { CommandError };

  // Feature gate: managed `start` is OFF by default and stays off until U4
  // stop/reconcile and U5 gates exist. ACP_EXEC_START=1 (or an injected
  // features.start in tests) enables the gated path. Even with the gate on,
  // `start` only persists a queued run — nothing here consumes it.
  const featureFlags = {
    start: features?.start === true || env.ACP_EXEC_START === '1',
    // U5 acceptance surface (accept_result + the validation pipeline):
    // default off; enabled via features.validation in tests or
    // ACP_EXEC_VALIDATION=1 once the whole gate is proven.
    validation: features?.validation === true || env.ACP_EXEC_VALIDATION === '1',
    // F2 fusion panel (panel snapshot, panelist launches, participant
    // decisions): default off; features.fusion in tests or
    // ACP_EXEC_FUSION=1.
    fusion: features?.fusion === true || env.ACP_EXEC_FUSION === '1',
    // P1 idea preparation (session commands + the prep_result internal
    // seam): default off; features.preparation in tests or
    // ACP_EXEC_PREPARATION=1.
    preparation: features?.preparation === true || env.ACP_EXEC_PREPARATION === '1',
    // O1 orchestrator (decomposition, parallel workers, integration):
    // default off; features.orchestrator in tests or ACP_EXEC_ORCHESTRATOR=1.
    orchestrator: features?.orchestrator === true || env.ACP_EXEC_ORCHESTRATOR === '1',
    // S1-S4 swarm (participants, brokered edits, decisions):
    // default off; features.swarm in tests or ACP_EXEC_SWARM=1.
    swarm: features?.swarm === true || env.ACP_EXEC_SWARM === '1',
  };

  // Authenticated internal transport: a 0600 token file chown'd to the
  // configured runner uid (ACP_EXEC_TOKEN_UID/GID). When provisioning fails
  // the internal HTTP route stays disabled — fail closed, diagnostic only.
  // `tokenAuth.token` is held in this closure only; it is never serialized
  // into routes, status surfaces, run records, or events.
  const tokenAuth = await ensureInternalToken(stateDir, {
    readerUid: numOrUndef(env.ACP_EXEC_TOKEN_UID),
    readerGid: numOrUndef(env.ACP_EXEC_TOKEN_GID),
  }).catch((e) => ({ ok: false, code: 'token_provision_error', message: String(e?.message || e) }));

  // Ops credential (U4): the ONLY thing that may write a retirement record.
  // It is deliberately NOT provisioned under the shared state mount — both
  // state and runner containers run uid 1001 and share it, so a 0600 file
  // there cannot separate them. Instead the operator hosts a private key
  // file and bind-mounts it read-only into the STATE container alone, at a
  // path named by ACP_OPS_TOKEN_FILE; the runner never mounts it. Missing or
  // unreadable => the retire route stays closed with a diagnosis; nothing
  // else is affected and boot never fails on it.
  let opsAuth = { ok: false, code: 'ops_unconfigured' };
  if (env.ACP_OPS_TOKEN_FILE && env.ACP_OPS_TOKEN_FILE.trim()) {
    const opsFile = env.ACP_OPS_TOKEN_FILE.trim();
    try {
      const raw = (await fs.readFile(opsFile, 'utf8')).trim();
      if (/^[0-9a-f]{48}$/.test(raw)) {
        opsAuth = { ok: true, token: raw };
      } else {
        opsAuth = { ok: false, code: 'ops_token_malformed' };
      }
    } catch (e) {
      opsAuth = { ok: false, code: 'ops_token_unreadable', message: e?.code || 'unreadable' };
    }
  }
  // The two credentials must be DISTINCT: an operator who accidentally
  // provisions the same value as the runner's internal token would hand the
  // runner retirement authority. Fail closed with a diagnosis instead of
  // letting the identical key unlock the ops route.
  if (opsAuth.ok && tokenAuth.ok && typeof tokenAuth.token === 'string'
    && tokenMatches(opsAuth.token, tokenAuth.token)) {
    opsAuth = { ok: false, code: 'ops_token_not_distinct',
      message: 'ops token equals the runner internal token — refused' };
  }
  function opsTokenPresented(headers) {
    const h = (k) => (headers || {})[k] ?? (headers || {})[k.toLowerCase()];
    const direct = h('x-acp-ops-token');
    if (typeof direct === 'string' && direct.length) return direct;
    const auth = h('authorization');
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
    return null;
  }

  // Designated workspace root (validated on first use per op): the managed
  // worktrees live under ACP_WORKSPACE_DIR or ROOT_DIR/.acp-workspaces —
  // never inside the state store. The same configured uid that reads the
  // internal token owns workspace allocation — the runner uid.
  let wsRootResolved = null;
  async function workspaceRoot() {
    if (!wsRootResolved) {
      const cfg = configuredWorkspaceRoot(env);
      await ensureWorkspaceRootAccess(cfg, {
        ownerUid: numOrUndef(env.ACP_EXEC_TOKEN_UID),
        ownerGid: numOrUndef(env.ACP_EXEC_TOKEN_GID),
      });
      wsRootResolved = await validateWorkspaceRoot(cfg);
    }
    return wsRootResolved;
  }

  // Deterministic fault injection for crash-consistency tests — NOT reachable
  // over any route; a `faults` object marks which persistence calls fail.
  const faultSet = {
    // A caller-supplied Set is kept by reference — same contract as
    // runs/runEvents below — so a test can arm/disarm a crash window around
    // a single doc flush (e.g. board.json fails right after the aggregate
    // commit).
    docNames: faults?.docNames instanceof Set ? faults.docNames : new Set(faults?.docNames || []),
    presets: faults?.presets === true,
    aggregates: faults?.aggregates instanceof Set ? faults.aggregates : new Set(faults?.aggregates || []),
    // Real persistence-boundary seams for the run projection and the
    // canonical events projection — NOT hand-seeded intents: the aggregate
    // commit succeeds, the projection write fails, repair/replay must heal.
    // A caller-supplied Set is kept by reference so a test can arm/disarm a
    // crash window around a single flush.
    runs: faults?.runs instanceof Set ? faults.runs : new Set(faults?.runs || []),
    runEvents: faults?.runEvents instanceof Set
      ? faults.runEvents : new Set(faults?.runEvents || []),
  };
  function injectFault(kind, key) {
    const hit =
      (kind === 'doc' && faultSet.docNames.has(key)) ||
      (kind === 'presets' && faultSet.presets) ||
      (kind === 'aggregate' && faultSet.aggregates.has(key)) ||
      (kind === 'run' && faultSet.runs.has(key)) ||
      (kind === 'runEvents' && faultSet.runEvents.has(key));
    if (hit) {
      const e = new Error(`injected persistence fault on ${kind}:${key}`);
      e.code = 'EINJECT';
      throw e;
    }
  }

  // ---- the one write queue --------------------------------------------------
  // Every mutation — KV PUT/DELETE, execution commands, preset writes — is
  // appended to this chain. repairState() runs before each op so a pending
  // intent left by an earlier partial flush lands before any new write, and
  // each op still re-reads the doc before its CAS check.
  let writeQueue = Promise.resolve();
  function enqueueWrite(op) {
    const run = writeQueue.then(async () => {
      await repairState();
      return op();
    });
    writeQueue = run.catch(() => {});
    return run;
  }

  // ---- KV doc primitives (queue-internal) -------------------------------------

  function docPath(name) {
    const p = resolve(stateDir, `${name}.json`);
    if (!p.startsWith(resolve(stateDir) + sep)) return null;
    return p;
  }

  async function readDocFile(name) {
    const p = docPath(name);
    if (!p) return { invalid: true };
    try {
      const raw = await fs.readFile(p, 'utf-8');
      return { doc: JSON.parse(raw) };
    } catch (e) {
      if (e && e.code === 'ENOENT') return { missing: true };
      throw e;
    }
  }

  async function writeDocFile(name, doc) {
    injectFault('doc', name);
    const dest = docPath(name);
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(doc), 'utf-8');
      await fs.rename(tmp, dest);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  }

  async function listDocs() {
    let files = [];
    try {
      files = await fs.readdir(stateDir);
    } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      throw e;
    }
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const name = f.slice(0, -'.json'.length);
      if (!NAME_RE.test(name)) continue;
      try {
        const st = await fs.stat(join(stateDir, f));
        const raw = await fs.readFile(join(stateDir, f), 'utf-8');
        let rev = 0;
        let updatedAt = 0;
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed.rev === 'number') rev = parsed.rev;
          if (typeof parsed.updatedAt === 'number') updatedAt = parsed.updatedAt;
        } catch {
          // Corrupt file: still list it by size so /health stays honest.
        }
        out.push({ name, rev, updatedAt, bytes: st.size });
      } catch {
        // Raced with a delete — skip.
      }
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  // ---- cli-compat state --------------------------------------------------------
  // Operator-extensible via cli-compat.json. A malformed override is a hard
  // diagnostic, never a silent fallback: compat-dependent validation throws
  // compat_invalid until the file is fixed or removed.

  let compatState = { ok: true, table: mergedCompat(null), error: null };
  async function refreshCompat() {
    try {
      compatState = { ok: true, table: mergedCompat(await loadCompatOverride(stateDir)), error: null };
    } catch (e) {
      compatState = { ok: false, table: null, error: e instanceof RuntimeError ? e.message : String(e) };
    }
  }
  function compatTable() {
    if (!compatState.ok) {
      throw new CommandError(500, 'compat_invalid',
        `cli compatibility configuration is invalid — ${compatState.error}`);
    }
    return compatState.table;
  }

  // ---- execution ctx (domain dep surface) --------------------------------------
  //
  // getDoc reads the CURRENT persisted doc or this op's staged write; putDoc
  // stages a doc write plus an optional durable intent; saveAggregate writes
  // immediately (the aggregate must hit disk before its external effects);
  // flushStaged applies staged writes (doc revs still bump — internal writes
  // are writes); pendingIntents() is what the aggregate durably journals.

  function makeCtx() {
    const staged = new Map(); // doc name -> {data, intent}
    let presetsWrite = null; // {doc, intent}
    const stagedRuns = new Map(); // runId -> {run, intent}
    const stagedEventRuns = new Map(); // runId -> full authoritative events array
    const ctx = {
      stateDir,
      features: featureFlags,
      workspaceRoot,
      loadSchedulerLimits: () => loadSchedulerLimits(stateDir),
      listAggregates: () => listAggregates(stateDir),
      async getDoc(name) {
        if (staged.has(name)) return structuredClone(staged.get(name).data);
        const { doc } = await readDocFile(name);
        return doc && typeof doc.data !== 'undefined' ? structuredClone(doc.data) : null;
      },
      peekDoc(name) {
        return staged.has(name) ? staged.get(name).data : undefined;
      },
      putDoc(name, data, intent = null) {
        staged.set(name, { data: structuredClone(data), intent });
      },
      putRun(run, intent = null) {
        stagedRuns.set(run.id, { run: structuredClone(run), intent });
      },
      // `events` is the run's FULL authoritative list — the jsonl is a
      // canonical projection rewritten atomically on flush/repair.
      appendRunEvent(runId, events) {
        stagedEventRuns.set(runId, structuredClone(events));
      },
      loadAggregate: (cardId) => loadAggregate(stateDir, cardId),
      loadEnvironments: () => loadEnvironments(stateDir),
      // P1: the binding registry is loaded FRESH inside the queue op that
      // needs it — a repinned bindings.json is observed on the next command,
      // and a missing/corrupt registry surfaces as a structured refusal.
      preparationRegistry: () => loadRegistry(prepRegistryPath),
      // P1: the full resource re-verify (P0 verifyManifest — sha256 of every
      // pinned file plus added/missing detection under the skill roots).
      preparationVerify: (binding) => verifyManifest(binding),
      // P2: the host capability descriptor and adapter map consulted by
      // binding-assignment preflight. Defaults are the declared host
      // surface; tests may inject a reduced descriptor/fake adapters via the
      // `preparation` service option — a descriptor can only ever shrink
      // what a binding may claim, never widen it.
      preparationCapabilities: () => preparation?.capabilities ?? defaultHostCapabilities(),
      preparationAdapters: () => preparation?.adapters ?? ADAPTERS,
      // Artifact import — runs inside the serialized queue: the runner only
      // ever writes the staging area; this is the store boundary.
      importArtifact: (args) => importStagedArtifact(stateDir, args).catch((e) => {
        if (e instanceof RuntimeError) {
          throw new CommandError(422, e.code, e.message);
        }
        throw new CommandError(422, 'artifact_import_failed', String(e?.message || e));
      }),
      // Service-side read of an imported artifact — U5 reports parse THESE
      // verified bytes, never a caller-supplied doc. Returns
      // { text, bytes, sha256 } or throws CommandError when absent.
      readArtifactText: async (runId, file) => {
        const dir = runArtifactsDir(stateDir, runId);
        const name = String(file ?? '');
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
          throw new CommandError(422, 'invalid_argument', `artifact file name invalid: ${JSON.stringify(name)}`);
        }
        const path = join(dir, name);
        if (resolve(path) !== join(dir, name)) {
          throw new CommandError(422, 'invalid_argument', 'artifact path escapes the run dir');
        }
        const buf = await fs.readFile(path).catch((e) => {
          if (e && e.code === 'ENOENT') {
            throw new CommandError(404, 'artifact_missing', `artifact ${name} is not stored for run ${runId}`);
          }
          throw e;
        });
        if (buf.length > ARTIFACT_MAX_BYTES) {
          throw new CommandError(422, 'artifact_corrupt', `artifact ${name} exceeds the accepted bound`);
        }
        return { text: buf.toString('utf8'), bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
      },
      // Bounded workspace-file hash — U5 check logs prove durable content.
      // `abs` must live under the recorded validation logs dir; the domain
      // passes the canonical dir so a caller cannot hash arbitrary paths.
      fileSha256: async (abs) => {
        const buf = await fs.readFile(abs).catch((e) => {
          throw new CommandError(422, 'artifact_unreadable',
            `cannot hash ${abs}: ${e.code || e.message}`);
        });
        return createHash('sha256').update(buf).digest('hex');
      },
      saveAggregate: (agg) => {
        injectFault('aggregate', agg.cardId);
        return saveAggregate(stateDir, agg);
      },
      writeBlob: (text) => writeBlob(stateDir, text),
      readBlob: (hash) => readBlob(stateDir, hash),
      requireBlob: (hash, what) => requireBlob(stateDir, hash, what),
      loadPresets: () => loadPresets(stateDir),
      putPresets(doc, intent = null) {
        presetsWrite = { doc: structuredClone(doc), intent };
      },
      compat: () => compatTable(),
      pendingIntents() {
        const intents = [];
        let boardIntent = false;
        for (const [, entry] of staged) {
          if (!entry.intent) continue;
          if (entry.intent.type === 'board_projection') {
            if (!boardIntent) {
              intents.push({ type: 'board_projection' });
              boardIntent = true;
            }
          } else {
            intents.push(structuredClone(entry.intent));
          }
        }
        if (presetsWrite?.intent) intents.push(structuredClone(presetsWrite.intent));
        for (const [, entry] of stagedRuns) {
          if (entry.intent) intents.push(structuredClone(entry.intent));
        }
        for (const [runId] of stagedEventRuns) {
          intents.push({ type: 'run_events', runId });
        }
        return intents;
      },
      async flushStaged() {
        for (const [name, entry] of staged) {
          const { doc: cur } = await readDocFile(name);
          const curRev = cur && typeof cur.rev === 'number' ? cur.rev : 0;
          await writeDocFile(name, {
            name,
            rev: curRev + 1,
            updatedAt: Date.now(),
            data: entry.data,
          });
        }
        if (presetsWrite) {
          injectFault('presets', 'registry');
          await savePresets(stateDir, presetsWrite.doc);
        }
        for (const [, entry] of stagedRuns) {
          injectFault('run', entry.run.id);
          await saveRun(stateDir, entry.run);
        }
        for (const [runId, events] of stagedEventRuns) {
          injectFault('runEvents', runId);
          await writeRunEvents(stateDir, runId, events);
        }
      },
    };
    return ctx;
  }

  // ---- repair: drain durable intents + re-project --------------------------------
  //
  // Runs before every queued write op and before managed-state reads. Each
  // intent type is applied SEMANTICALLY (never a raw-data replay), so nothing
  // newer can be overwritten:
  //   claims_purge  — drop claims[cardId]/attempts[cardId] if still present
  //   preset_upsert — apply only when the registry lacks the preset or holds
  //                   an older updatedAt; a newer registry entry always wins
  //   board_projection — covered by repairBoardProjections (recomputed, not
  //                   replayed)
  async function repairState() {
    const managedIds = await listManagedCardIds(stateDir);
    for (const cardId of managedIds) {
      // A corrupt aggregate propagates (fails closed) — repair must not
      // silently skip the one card that needs its intents drained.
      const agg = await loadAggregate(stateDir, cardId);
      if (!agg || !Array.isArray(agg.pendingWrites) || !agg.pendingWrites.length) continue;
      const ctx = makeCtx();
      for (const intent of agg.pendingWrites) {
        if (!intent || typeof intent !== 'object') continue;
        if (intent.type === 'claims_purge') {
          const claims = await ctx.getDoc('claims.json');
          const cid = intent.cardId || cardId;
          if (
            claims &&
            ((claims.claims || {})[cid] !== undefined || (claims.attempts || {})[cid] !== undefined)
          ) {
            const next = structuredClone(claims);
            if (next.claims) delete next.claims[cid];
            if (next.attempts) delete next.attempts[cid];
            ctx.putDoc('claims.json', next);
          }
        } else if (intent.type === 'preset_upsert' && intent.preset && intent.preset.id) {
          const doc = await loadPresets(stateDir);
          const idx = doc.presets.findIndex((p) => p && p.id === intent.preset.id);
          const newer =
            idx >= 0 && Number(doc.presets[idx].updatedAt || 0) >= Number(intent.preset.updatedAt || 0);
          if (!newer) {
            if (idx >= 0) doc.presets[idx] = structuredClone(intent.preset);
            else doc.presets.push(structuredClone(intent.preset));
            doc.rev = (Number(doc.rev) || 0) + 1;
            doc.updatedAt = Date.now();
            ctx.putPresets(doc);
          }
        } else if (intent.type === 'run_projection' && intent.runId) {
          // Recompute the run record from aggregate truth — never replay a
          // stored snapshot (the aggregate may have advanced past it).
          const run = (agg.runs || []).find(
            (r) => r && typeof r === 'object' && r.id === intent.runId);
          if (run) ctx.putRun({ ...structuredClone(run), cardId: agg.cardId });
        } else if (intent.type === 'run_events' && intent.runId) {
          // Canonical rewrite from aggregate events (seq-dedup merge inside).
          const run = (agg.runs || []).find(
            (r) => r && typeof r === 'object' && r.id === intent.runId);
          if (run && Array.isArray(run.events)) {
            ctx.appendRunEvent(run.id, run.events);
          }
        }
        // 'board_projection' — handled by repairBoardProjections below.
      }
      await ctx.flushStaged();
      agg.pendingWrites = null;
      await saveAggregate(stateDir, agg);
    }
    const ctx = makeCtx();
    await repairBoardProjections(ctx);
    await ctx.flushStaged();
  }

  // ---- route handlers ----------------------------------------------------------

  function ok(status, json) {
    return { status, json };
  }
  function fail(err) {
    if (err instanceof CommandError) return ok(err.status, errorBody(err));
    if (err instanceof RuntimeError) {
      return ok(500, { error: err.message, code: err.code });
    }
    // Unexpected faults (incl. injected ones) still become a response — the
    // queue stays alive and the caller gets a diagnostic, not a dropped conn.
    return ok(500, { error: String(err?.message || err), code: err?.code || 'internal' });
  }

  function parseJsonBody(bodyText) {
    if (bodyText === undefined || bodyText === null || bodyText === '') return {};
    try {
      return JSON.parse(bodyText);
    } catch {
      throw new CommandError(400, 'bad_json', 'invalid JSON body');
    }
  }

  async function handlePutDoc(name, bodyText) {
    const body = parseJsonBody(bodyText);
    if (!body || typeof body !== 'object' || !('data' in body)) {
      throw new CommandError(400, 'bad_body', 'body must be { data, rev? }');
    }
    if (Buffer.byteLength(JSON.stringify(body.data), 'utf-8') > MAX_BODY_BYTES) {
      throw new CommandError(413, 'too_large', 'document exceeds 5 MiB');
    }
    const wantRev = body.rev === undefined || body.rev === null ? null : Number(body.rev);
    if (wantRev !== null && (!Number.isInteger(wantRev) || wantRev < 0)) {
      throw new CommandError(400, 'bad_body', 'rev must be an integer >= 0');
    }
    return enqueueWrite(async () => {
      const { doc: cur, missing } = await readDocFile(name);
      const curRev = cur && typeof cur.rev === 'number' ? cur.rev : 0;
      // CAS inside the queue — a missing doc counts as rev 0, so an explicit
      // nonzero rev on an absent document conflicts instead of silently
      // winning (the pre-U2 `cur &&` loophole is closed). A repair bump in
      // this same op legitimately conflicts a stale client rev.
      if (wantRev !== null && wantRev !== curRev) {
        return ok(409, {
          error: 'rev conflict',
          code: 'rev_conflict',
          rev: curRev,
          updatedAt: cur?.updatedAt ?? null,
          missing: missing === true,
        });
      }
      let data = body.data;
      const ctx = makeCtx();
      if (name === 'board.json') {
        data = await mergeBoardWrite(ctx, data);
      } else if (name === 'claims.json') {
        data = await guardClaimsWrite(ctx, data, cur?.data ?? null);
      }
      await ctx.flushStaged(); // snapshot-refresh aggregate writes already ran
      const next = { name, rev: curRev + 1, updatedAt: Date.now(), data };
      await writeDocFile(name, next);
      return ok(200, { name, rev: next.rev, updatedAt: next.updatedAt });
    });
  }

  async function handleDeleteDoc(name) {
    return enqueueWrite(async () => {
      const { doc: cur, missing } = await readDocFile(name);
      if (missing || !cur) {
        return ok(404, { error: 'not found', code: 'not_found' });
      }
      const ctx = makeCtx();
      if (name === 'board.json') await guardBoardDelete(ctx, cur.data);
      if (name === 'claims.json') await guardClaimsDelete(ctx, cur.data);
      await ctx.flushStaged();
      const p = docPath(name);
      try {
        await fs.unlink(p);
      } catch (e) {
        if (e && e.code === 'ENOENT') return ok(404, { error: 'not found', code: 'not_found' });
        throw e;
      }
      return ok(200, { name, deleted: true });
    });
  }

  function cardView(aggregate) {
    return {
      cardId: aggregate.cardId,
      managed: true,
      schemaVersion: aggregate.schemaVersion,
      enabledAt: aggregate.enabledAt,
      controlRevision: aggregate.controlRevision,
      internalRevision: aggregate.internalRevision,
      project: {
        id: aggregate.projectId,
        label: aggregate.projectLabel,
        path: aggregate.projectPath,
      },
      session: aggregate.session ?? null,
      currentRunId: aggregate.currentRunId ?? null,
      workspaceId: aggregate.workspaceId ?? null,
      composition: aggregate.composition ?? null,
      pendingWrites: aggregate.pendingWrites ?? null,
      documents: aggregate.documents,
      approvals: aggregate.approvals,
      runs: (aggregate.runs || []).map((r) =>
        typeof r === 'string' ? { id: r } : {
          id: r.id, status: r.status ?? null,
          // F4: run summaries carry mode + the durable fusion pending-action
          // count so lists/history can badge a run waiting on the user
          // without fetching the whole run record.
          mode: r.mode ?? 'solo',
          pending: Array.isArray(r.fusion?.pendingActions)
            ? r.fusion.pendingActions.length : 0,
          // A terminal run can still hold a live reservation (spawned
          // attempt / active-or-unproven validation) — status alone never
          // proves its process groups dead. The scheduler dispatches these
          // for supervision/drain only; no new work issues on them.
          reserved: !!(r.validation
              && (r.validation.status === 'active' || r.validation.status === 'unproven'))
            || (r.attempts || []).some(
              (a) => a && ATTEMPT_NONTERMINAL.has(a.status)),
        },
      ),
      // Workspace reservations incl. owner identity — the scheduler reads
      // this to decide adopt-vs-create; operational metadata, not secrets.
      workspaces: Object.fromEntries(
        Object.entries(aggregate.workspaces || {}).map(([k, w]) => [k, {
          id: w.id, status: w.status, runId: w.runId ?? null,
          path: w.path, branch: w.branch,
          owner: w.owner ? {
            runnerId: w.owner.runnerId,
            instanceId: w.owner.instanceId ?? null,
            pid: w.owner.pid ?? null,
            pidStarttime: w.owner.pidStarttime ?? null,
            envKey: w.owner.envKey ?? null,
            envInstance: w.owner.envInstance ?? null,
            envSlot: w.owner.envSlot ?? null,
            envGeneration: w.owner.envGeneration ?? null,
          } : null,
        }])),
      commandsProcessed: Object.keys(aggregate.commands || {}).length,
      projection: aggregate.projection
        ? { stage: aggregate.projection.stage, status: aggregate.projection.status }
        : null,
      // P1: compact session summary for card/drawer surfaces — derived from
      // the aggregate (phase, gates, open questions, blocker count), never
      // client-writable.
      preparation: preparationSummary(aggregate),
      // F4: publish the service feature gates — the UI keys the fusion
      // editor surface off `features.fusion`; commands stay server-gated
      // regardless of what the view advertises.
      features: { ...featureFlags },
    };
  }

  async function handleCardCommand(cardId, bodyText) {
    const body = parseJsonBody(bodyText);
    return enqueueWrite(async () => {
      const ctx = makeCtx();
      // HTTP transport is always the user channel — the internal channel is
      // only reachable through service.internalCommand (not routed).
      return applyCardCommand(ctx, cardId, body, { channel: 'user' });
    }).then((out) => ok(out.status, out.body));
  }

  async function handleGetCard(cardId) {
    await enqueueWrite(async () => {}); // repair ran inside the queue
    const aggregate = await loadAggregate(stateDir, cardId);
    if (!aggregate) return ok(404, { error: 'card is not managed', code: 'card_not_found' });
    return ok(200, cardView(aggregate));
  }

  // P1: the full session view — presented artifacts, SkillGates, checkpoint,
  // and the derived readiness/blocker list. Registry truth (binding still
  // exists, digest still pinned) is evaluated inside the queue; the blob
  // re-verify runs only at the implementation start gate.
  async function handleGetPreparation(cardId) {
    if (featureFlags.preparation !== true) {
      return ok(501, {
        error: 'idea preparation is gated off (ACP_EXEC_PREPARATION)',
        code: 'unavailable',
      });
    }
    return enqueueWrite(async () => {
      const aggregate = await loadAggregate(stateDir, cardId);
      if (!aggregate) {
        return ok(404, { error: 'card is not managed', code: 'card_not_found' });
      }
      const view = await preparationView(PREP_VIEW_DEPS, {
        preparationRegistry: () => loadRegistry(prepRegistryPath),
        preparationVerify: (binding) => verifyManifest(binding),
        preparationCapabilities: () => preparation?.capabilities ?? defaultHostCapabilities(),
        preparationAdapters: () => preparation?.adapters ?? ADAPTERS,
      }, aggregate);
      return ok(200, {
        cardId,
        controlRevision: aggregate.controlRevision,
        preparation: view,
      });
    });
  }

  async function handleGetDocument(cardId, versionId) {
    const aggregate = await loadAggregate(stateDir, cardId);
    if (!aggregate) return ok(404, { error: 'card is not managed', code: 'card_not_found' });
    for (const kind of Object.keys(aggregate.documents || {})) {
      const version = (aggregate.documents[kind].versions || []).find(
        (v) => v && v.versionId === versionId,
      );
      if (!version) continue;
      // The blob is evidence: absent or hash-mismatched content fails loudly.
      const content = await requireBlob(stateDir, version.sha256, `${kind} document`);
      return ok(200, { ...version, content });
    }
    return ok(404, { error: `no document version ${versionId} on this card`, code: 'version_not_found' });
  }

  async function handleListPresets() {
    await enqueueWrite(async () => {}); // drain pending upserts before reading
    await refreshCompat();
    const doc = await loadPresets(stateDir);
    return ok(200, {
      presets: doc.presets,
      rev: doc.rev,
      compatibility: compatState.table,
      compatError: compatState.error,
    });
  }

  async function handleCreatePreset(bodyText) {
    const body = parseJsonBody(bodyText);
    const preset = body?.preset;
    return enqueueWrite(async () => {
      await refreshCompat();
      const doc = await loadPresets(stateDir);
      const clean = validatePreset(preset, compatTable());
      if (doc.presets.some((p) => p && p.id === clean.id)) {
        throw new CommandError(409, 'preset_exists', `preset ${clean.id} already exists`);
      }
      const now = Date.now();
      clean.createdAt = now;
      clean.updatedAt = now;
      clean.revision = 1;
      doc.presets.push(clean);
      doc.rev = (Number(doc.rev) || 0) + 1;
      doc.updatedAt = now;
      await savePresets(stateDir, doc);
      return ok(200, { ok: true, preset: clean, rev: doc.rev });
    });
  }

  async function handleUpdatePreset(presetId, bodyText) {
    const body = parseJsonBody(bodyText);
    return enqueueWrite(async () => {
      await refreshCompat();
      const doc = await loadPresets(stateDir);
      const idx = doc.presets.findIndex((p) => p && p.id === presetId);
      if (idx === -1) return ok(404, { error: `unknown preset ${presetId}`, code: 'preset_not_found' });
      const wantRev = body?.rev === undefined || body?.rev === null ? null : Number(body.rev);
      if (wantRev !== null && !Number.isInteger(wantRev)) {
        throw new CommandError(400, 'bad_body', 'rev must be an integer');
      }
      if (wantRev !== null && wantRev !== doc.rev) {
        throw new CommandError(409, 'rev_conflict', `rev ${wantRev} does not match current ${doc.rev}`, {
          rev: doc.rev,
        });
      }
      const clean = validatePreset(body?.preset, compatTable(), presetId);
      const now = Date.now();
      clean.createdAt = doc.presets[idx].createdAt;
      clean.revision = (Number(doc.presets[idx].revision) || 0) + 1;
      clean.updatedAt = now;
      doc.presets[idx] = clean;
      doc.rev = (Number(doc.rev) || 0) + 1;
      doc.updatedAt = now;
      await savePresets(stateDir, doc);
      return ok(200, { ok: true, preset: clean, rev: doc.rev });
    });
  }

  async function handleDeletePreset(presetId) {
    return enqueueWrite(async () => {
      const doc = await loadPresets(stateDir);
      const idx = doc.presets.findIndex((p) => p && p.id === presetId);
      if (idx === -1) return ok(404, { error: `unknown preset ${presetId}`, code: 'preset_not_found' });
      doc.presets.splice(idx, 1);
      doc.rev = (Number(doc.rev) || 0) + 1;
      doc.updatedAt = Date.now();
      await savePresets(stateDir, doc);
      return ok(200, { ok: true, deleted: presetId, rev: doc.rev });
    });
  }

  async function handleGetRun(runId) {
    // Inside the write queue: repairState() drains any projection intents
    // left by a mid-commit crash BEFORE this read — no stale/missing run.
    return enqueueWrite(async () => {
      const run = await loadRun(stateDir, runId);
      if (!run) return ok(404, { error: `unknown run ${runId}`, code: 'run_not_found' });
      return ok(200, run);
    });
  }

  async function handleGetRunEvents(runId, query) {
    return enqueueWrite(async () => {
      const run = await loadRun(stateDir, runId);
      if (!run) return ok(404, { error: `unknown run ${runId}`, code: 'run_not_found' });
      const cursor = Math.max(0, Number(query.get('cursor') || 0) || 0);
      // Bounded pages: U4 extends live observation on this seam; the public
      // storage read must never return an unbounded payload.
      const limit = Math.min(500,
        Math.max(1, Number(query.get('limit') || 100) || 100));
      const eventsFile = join(paths(stateDir).runsDir, `${runId}.events.jsonl`);
      let lines = [];
      try {
        const raw = await fs.readFile(eventsFile, 'utf-8');
        lines = raw.split('\n').filter((l) => l.trim());
      } catch (e) {
        if (!e || e.code !== 'ENOENT') throw e;
      }
      // Canonical seq view: malformed lines and duplicate seqs never advance
      // the cursor — the aggregate is authoritative and repair rewrites this
      // file, but a reader must still not double-count or lose position.
      const bySeq = new Map();
      let corrupt = 0;
      for (const l of lines) {
        try {
          const ev = JSON.parse(l);
          if (Number.isInteger(ev?.seq) && ev.seq >= 0 && !bySeq.has(ev.seq)) {
            bySeq.set(ev.seq, ev);
          } else if (!Number.isInteger(ev?.seq)) {
            corrupt += 1;
          }
        } catch {
          corrupt += 1;
        }
      }
      const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      const past = all.filter((e) => e.seq >= cursor);
      const events = past.slice(0, limit);
      const nextCursor = events.length ? events[events.length - 1].seq + 1 : cursor;
      return ok(200, {
        runId, events, nextCursor, limit,
        remaining: Math.max(0, past.length - events.length),
        total: all.length,
        corrupt,
      });
    });
  }

  async function handleGetArtifact(runId, artifactId) {
    // Managed read — inside the queue so a pending repair lands first.
    return enqueueWrite(async () => {
      const run = await loadRun(stateDir, runId);
      if (!run) return ok(404, { error: `unknown run ${runId}`, code: 'run_not_found' });
      const rec = (run.artifacts || {})[artifactId];
      const storedName = rec?.stored ?? rec?.file;
      if (!rec || typeof storedName !== 'string') {
        return ok(404, { error: `unknown artifact ${artifactId}`, code: 'artifact_not_found' });
      }
      // Server-mediated only: the artifact resolves inside the run's own dir —
      // a client path is never accepted. `stored` is the physical name bound
      // to the artifact id at commit; `file` is only the logical name.
      const dir = join(paths(stateDir).root, 'artifacts', runId);
      const file = resolve(dir, storedName);
      const real = await fs.realpath(file).catch(() => null);
      const realDir = await fs.realpath(dir).catch(() => null);
      if (!real || !realDir || (real !== realDir && !real.startsWith(realDir + sep))) {
        return ok(404, { error: `artifact ${artifactId} not stored`, code: 'artifact_not_found' });
      }
      // Verify the RAW stored bytes against the recorded hash — artifacts
      // (check stdout/stderr) may carry arbitrary non-UTF-8 bytes; a utf8
      // read would inject replacement characters and a hash over them
      // would falsely convict honest evidence. A record WITHOUT a recorded
      // sha256/byte count is unverifiable evidence — fail closed, never
      // serve bytes that cannot be bound to their commit-time hash.
      if (typeof rec.sha256 !== 'string' || !SHA256_RE.test(rec.sha256)
        || !Number.isInteger(rec.bytes) || rec.bytes < 0) {
        return ok(422, {
          error: `artifact ${artifactId} lacks its recorded sha256/bytes — evidence unverifiable`,
          code: 'artifact_evidence_unbound',
        });
      }
      const raw = await fs.readFile(real);
      if (createHash('sha256').update(raw).digest('hex') !== rec.sha256
        || raw.length !== rec.bytes) {
        throw new RuntimeError('corrupt_store', `artifact ${artifactId} fails its recorded hash/byte length`);
      }
      return ok(200, {
        artifactId, runId, kind: rec.kind ?? null,
        bytes: raw.length, sha256: rec.sha256 ?? null,
        contentBase64: raw.toString('base64'),
        content: raw.toString('utf8'), // backwards-compatible text view
      });
    });
  }

  // ---- the router -----------------------------------------------------------------

  async function request({ method, path, query, bodyText, headers }) {
    try {
      // -- authenticated internal channel --------------------------------------
      // Runner-side lifecycle commands. The token authorizes the CHANNEL;
      // per-resource ownership is still enforced inside the domain queue.
      const mInternal = /^\/api\/internal\/cards\/([^/]+)\/commands$/.exec(path);
      if (mInternal) {
        if (method !== 'POST') return ok(405, { error: 'method not allowed', code: 'method_not_allowed' });
        const cardId = decodeURIComponent(mInternal[1]);
        if (!CARD_ID_RE.test(cardId)) {
          return ok(400, { error: 'invalid card id', code: 'bad_request' });
        }
        if (!tokenAuth.ok || typeof tokenAuth.token !== 'string') {
          return ok(503, {
            error: 'internal transport unprovisioned',
            code: 'internal_unprovisioned',
            detail: tokenAuth.code ?? 'unknown',
          });
        }
        const presented = extractPresentedToken(headers || {});
        if (!presented) {
          return ok(401, { error: 'internal token required', code: 'unauthorized' });
        }
        if (!tokenMatches(presented, tokenAuth.token)) {
          return ok(403, { error: 'invalid internal token', code: 'forbidden' });
        }
        const body = parseJsonBody(bodyText);
        const out = await enqueueWrite(async () => {
          const ctx = makeCtx();
          return applyCardCommand(ctx, cardId, body, { channel: 'internal' });
        });
        return ok(out.status, out.body);
      }

      // -- environment ledger (internal runner channel) -------------------------
      // register_environment records slot/envInstance identity; it can never
      // retire a predecessor — two live containers may register one slot.
      const mEnvRegister = /^\/api\/internal\/environments\/register$/.exec(path);
      if (mEnvRegister) {
        if (method !== 'POST') return ok(405, { error: 'method not allowed', code: 'method_not_allowed' });
        if (!tokenAuth.ok || typeof tokenAuth.token !== 'string') {
          return ok(503, {
            error: 'internal transport unprovisioned',
            code: 'internal_unprovisioned',
            detail: tokenAuth.code ?? 'unknown',
          });
        }
        const presented = extractPresentedToken(headers || {});
        if (!presented) return ok(401, { error: 'internal token required', code: 'unauthorized' });
        if (!tokenMatches(presented, tokenAuth.token)) {
          return ok(403, { error: 'invalid internal token', code: 'forbidden' });
        }
        const body = parseJsonBody(bodyText);
        body.type = 'register_environment';
        const out = await enqueueWrite(async () => {
          const doc = await loadEnvironments(stateDir);
          const { doc: next, response } = applyEnvCommand(doc, body, Date.now());
          await saveEnvironments(stateDir, next);
          return response;
        });
        return ok(200, out);
      }

      // -- environment ledger read (internal runner channel) ----------------
      // The scheduler needs the recorded ledger to build retirement proofs —
      // read-only; retirement still requires the ops credential.
      if (path === '/api/internal/environments' && method === 'GET') {
        if (!tokenAuth.ok || typeof tokenAuth.token !== 'string') {
          return ok(503, {
            error: 'internal transport unprovisioned',
            code: 'internal_unprovisioned',
            detail: tokenAuth.code ?? 'unknown',
          });
        }
        const presented = extractPresentedToken(headers || {});
        if (!presented) return ok(401, { error: 'internal token required', code: 'unauthorized' });
        if (!tokenMatches(presented, tokenAuth.token)) {
          return ok(403, { error: 'invalid internal token', code: 'forbidden' });
        }
        const doc = await enqueueWrite(() => loadEnvironments(stateDir));
        return ok(200, doc);
      }

      // -- environment retirement (ops channel, NOT the runner channel) ---------
      // A retirement record is the ONLY positive evidence a replaced
      // container may present — and only the ops credential can mint it. The
      // runner's internal token is refused here unconditionally; a missing
      // ops key leaves the route closed with a diagnosis.
      const mEnvRetire = /^\/api\/internal\/environments\/retire$/.exec(path);
      if (mEnvRetire) {
        if (method !== 'POST') return ok(405, { error: 'method not allowed', code: 'method_not_allowed' });
        if (!opsAuth.ok || typeof opsAuth.token !== 'string') {
          return ok(503, {
            error: 'ops credential unprovisioned — retirement requires the host-side key '
              + '(ACP_OPS_TOKEN_FILE mounted into the state container only)',
            code: 'ops_unavailable',
            detail: opsAuth.code,
          });
        }
        const presented = opsTokenPresented(headers || {});
        if (!presented) return ok(401, { error: 'ops token required', code: 'unauthorized' });
        if (!tokenMatches(presented, opsAuth.token)) {
          return ok(403, { error: 'invalid ops token', code: 'forbidden' });
        }
        const body = parseJsonBody(bodyText);
        body.type = 'retire_environment';
        const out = await enqueueWrite(async () => {
          const doc = await loadEnvironments(stateDir);
          const { doc: next, response } = applyEnvCommand(doc, body, Date.now());
          await saveEnvironments(stateDir, next);
          return response;
        });
        return ok(200, out);
      }

      // -- execution API ------------------------------------------------------
      if (path === '/api/execution/cards' && method === 'GET') {
        await enqueueWrite(async () => {});
        const ids = await listManagedCardIds(stateDir);
        const cards = [];
        for (const id of ids) {
          const agg = await loadAggregate(stateDir, id);
          const cur = (agg.runs || []).find(
            (r) => r && typeof r === 'object' && r.id === agg.currentRunId) || null;
          cards.push({
            cardId: id,
            controlRevision: agg.controlRevision,
            currentRunId: agg.currentRunId ?? null,
            // F4: the index surfaces the current run's mode + pending-action
            // count so the Workflow list can badge "fusion run waiting on a
            // user decision" without loading every card view.
            currentRun: cur ? {
              id: cur.id,
              status: cur.status ?? null,
              mode: cur.mode ?? 'solo',
              pending: Array.isArray(cur.fusion?.pendingActions)
                ? cur.fusion.pendingActions.length : 0,
            } : null,
            managed: true,
            // P5: the preparation summary rides the index — a list row is
            // the ONLY surface the runner-side lead supervisor polls, and
            // the only place two dashboards could diverge on "is there an
            // active discussion". Same derived counts as the card view.
            preparation: featureFlags.preparation === true
              ? preparationSummary(agg) : null,
          });
        }
        return ok(200, { cards });
      }

      // P5: the binding registry listing for the card drawer's skill picker —
      // identity, stage, availability and the recorded refusal reason for
      // unsupported/candidate routes. Host filesystem details (skillDirs,
      // extraResources) stay server-side; the UI needs choices + reasons,
      // not paths. Registry unreadable = honest 503, never an empty list
      // masquerading as "no bindings exist".
      if (path === '/api/execution/preparation/bindings' && method === 'GET') {
        if (featureFlags.preparation !== true) {
          return ok(501, {
            error: 'idea preparation is gated off (ACP_EXEC_PREPARATION)',
            code: 'unavailable',
          });
        }
        try {
          const registry = await loadRegistry(prepRegistryPath);
          return ok(200, {
            pi: registry.pi ?? null,
            bindings: (registry.bindings ?? []).map((b) => ({
              bindingId: b.bindingId,
              stage: b.stage,
              status: b.status,
              title: b.title ?? null,
              provider: b.provider ?? null,
              adapterId: b.adapterId ?? null,
              adapterVersion: b.adapterVersion ?? null,
              questionChannel: b.questionChannel ?? null,
              tools: Array.isArray(b.tools) ? [...b.tools] : [],
              digest: b.resourceManifest?.digest ?? null,
              configDigest: bindingConfigDigest(b),
              unsupported: b.unsupported ?? null,
            })),
          });
        } catch (e) {
          return ok(503, {
            error: `binding registry unavailable: ${e?.message ?? e}`,
            code: 'registry_unavailable',
          });
        }
      }

      const mCardPrep = /^\/api\/execution\/cards\/([^/]+)\/preparation$/.exec(path);
      if (mCardPrep && method === 'GET') {
        const cardId = decodeURIComponent(mCardPrep[1]);
        if (!CARD_ID_RE.test(cardId)) {
          return ok(400, { error: 'invalid card id', code: 'bad_request' });
        }
        return await handleGetPreparation(cardId);
      }

      const mCardDoc = /^\/api\/execution\/cards\/([^/]+)\/documents\/([^/]+)$/.exec(path);
      if (mCardDoc && method === 'GET') {
        const cardId = decodeURIComponent(mCardDoc[1]);
        const versionId = decodeURIComponent(mCardDoc[2]);
        if (!CARD_ID_RE.test(cardId) || !VERSION_ID_RE.test(versionId)) {
          return ok(400, { error: 'invalid id', code: 'bad_request' });
        }
        return await handleGetDocument(cardId, versionId);
      }

      const mCardCmd = /^\/api\/execution\/cards\/([^/]+)\/commands$/.exec(path);
      if (mCardCmd && method === 'POST') {
        const cardId = decodeURIComponent(mCardCmd[1]);
        if (!CARD_ID_RE.test(cardId)) {
          return ok(400, { error: 'invalid card id', code: 'bad_request' });
        }
        return await handleCardCommand(cardId, bodyText);
      }

      const mCard = /^\/api\/execution\/cards\/([^/]+)$/.exec(path);
      if (mCard && method === 'GET') {
        const cardId = decodeURIComponent(mCard[1]);
        if (!CARD_ID_RE.test(cardId)) {
          return ok(400, { error: 'invalid card id', code: 'bad_request' });
        }
        return await handleGetCard(cardId);
      }

      if (path === '/api/execution/presets' && method === 'GET') {
        return await handleListPresets();
      }
      if (path === '/api/execution/presets' && method === 'POST') {
        return await handleCreatePreset(bodyText);
      }
      const mPreset = /^\/api\/execution\/presets\/([^/]+)$/.exec(path);
      if (mPreset) {
        const presetId = decodeURIComponent(mPreset[1]);
        if (!SAFE_ID_RE.test(presetId)) {
          return ok(400, { error: 'invalid preset id', code: 'bad_request' });
        }
        if (method === 'PUT') return await handleUpdatePreset(presetId, bodyText);
        if (method === 'DELETE') return await handleDeletePreset(presetId);
      }

      const mRunEvents = /^\/api\/execution\/runs\/([^/]+)\/events$/.exec(path);
      if (mRunEvents && method === 'GET') {
        const runId = decodeURIComponent(mRunEvents[1]);
        if (!SAFE_ID_RE.test(runId)) return ok(400, { error: 'invalid run id', code: 'bad_request' });
        return await handleGetRunEvents(runId, query);
      }
      const mRunArtifact = /^\/api\/execution\/runs\/([^/]+)\/artifacts\/([^/]+)$/.exec(path);
      if (mRunArtifact && method === 'GET') {
        const runId = decodeURIComponent(mRunArtifact[1]);
        const artifactId = decodeURIComponent(mRunArtifact[2]);
        if (!SAFE_ID_RE.test(runId) || !ARTIFACT_ID_RE.test(artifactId)) {
          return ok(400, { error: 'invalid id', code: 'bad_request' });
        }
        return await handleGetArtifact(runId, artifactId);
      }
      const mRun = /^\/api\/execution\/runs\/([^/]+)$/.exec(path);
      if (mRun && method === 'GET') {
        const runId = decodeURIComponent(mRun[1]);
        if (!SAFE_ID_RE.test(runId)) return ok(400, { error: 'invalid run id', code: 'bad_request' });
        return await handleGetRun(runId);
      }

      // -- porch read-only (unchanged contract) --------------------------------
      if (method === 'GET' && path === '/api/porch/runs') {
        return ok(200, { runs: await porch.listRuns() });
      }
      const pr = /^\/api\/porch\/runs\/([^/]+)$/.exec(path);
      if (pr && method === 'GET') {
        const runId = decodeURIComponent(pr[1]);
        const { meta, state, audit, final, missing, invalid } = await porch.readRun(runId);
        if (invalid) return ok(400, { error: 'invalid run id' });
        if (missing || !meta) return ok(404, { error: 'not found' });
        return ok(200, { meta, state, audit, final });
      }

      // -- legacy KV ------------------------------------------------------------
      if (method === 'GET' && path === '/health') {
        const docs = await listDocs();
        return ok(200, { ok: true, dir: stateDir, docs: docs.length });
      }
      if (method === 'GET' && path === '/api/state') {
        return ok(200, { docs: await listDocs() });
      }
      const m = /^\/api\/state\/([^/]+)$/.exec(path);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (!NAME_RE.test(name)) {
          return ok(400, { error: 'invalid name (^[a-z0-9._-]{1,64}$)', code: 'bad_name' });
        }
        if (method === 'GET') {
          if (name === 'board.json') await enqueueWrite(async () => {});
          const { doc, missing } = await readDocFile(name);
          if (missing || !doc) return ok(404, { error: 'not found', code: 'not_found' });
          return ok(200, { name, rev: doc.rev, updatedAt: doc.updatedAt, data: doc.data });
        }
        if (method === 'PUT') {
          return await handlePutDoc(name, bodyText);
        }
        if (method === 'DELETE') {
          return await handleDeleteDoc(name);
        }
      }

      return ok(404, { error: 'not found', code: 'not_found' });
    } catch (e) {
      return fail(e);
    }
  }

  // ---- init ------------------------------------------------------------------
  await repairState();

  const service = {
    stateDir,
    request,
    // Server-side command channel — deliberately NOT routed over HTTP. Only
    // trusted in-process callers (runner-side code/tests) may pass channel:
    // 'internal'; bodies claiming it via request() are rejected by domain.
    internalCommand(cardId, body) {
      return enqueueWrite(async () => {
        const ctx = makeCtx();
        return applyCardCommand(ctx, cardId, body, { channel: 'internal' });
      }).then(
        (out) => out,
        (e) => (e instanceof CommandError ? { status: e.status, body: errorBody(e) }
          : e instanceof RuntimeError ? { status: 500, body: { error: e.message, code: e.code } }
          : Promise.reject(e)),
      );
    },
    // Environment commands — same not-routed-to-sockets seam as
    // internalCommand; models an already-authenticated caller (register →
    // runner; retire → ops). Domain semantics (binding/generation/evidence)
    // still apply fully.
    internalGlobal(body) {
      return enqueueWrite(async () => {
        const doc = await loadEnvironments(stateDir);
        const { doc: next, response } = applyEnvCommand(doc, body, Date.now());
        await saveEnvironments(stateDir, next);
        return response;
      }).then(
        (out) => out,
        (e) => (e instanceof CommandError ? { status: e.status, body: errorBody(e) }
          : e instanceof RuntimeError ? { status: 500, body: { error: e.message, code: e.code } }
          : Promise.reject(e)),
      );
    },
    loadEnvironments: () => loadEnvironments(stateDir),
    compatState: () => compatState,
    refreshCompat,
    enqueueWrite,
    readDocFile,
    writeDocFile,
    repairNow: () => enqueueWrite(async () => {}),
  };
  return service;
}
