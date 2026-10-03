// server/execution/preparation/supervisor.mjs — the RUNNER-side host of the
// P3 durable lead driver (P5).
//
// The lead (lead.mjs) is deliberately transport- and service-agnostic: tests
// drove it in-process through serviceFromService + a fake transport. In
// production it lives inside the runner process, talks to the state server
// through the authenticated internal client (serviceFromClient), and spawns
// real `pi --mode rpc` children (createPiRpcTransport). THIS module is that
// integration point — it owns:
//
//   * discovery: each sweep lists managed cards via the SAME
//     GET /api/execution/cards index the UI reads; a row whose preparation
//     summary shows a running attempt (or a still-live in-memory session
//     needing teardown) gets one serialized drive() call;
//   * dirs: every session's workspace/pi-session/agent/transcript roots are
//     derived with prepRunDirs() under <stateDir>/execution/preparation/ —
//     inside the existing execution store, never in the project;
//   * the agent dir: pi needs provider/model/auth config to call a model.
//     Each session gets a PRIVATE pi-agent dir seeded once from the host
//     profile (auth.json/models.json copied, settings.json rendered from
//     the configured ACP_PREP_* model selection). A profile that cannot be
//     seeded is reported honestly — the supervisor throws at construction
//     so a misconfigured runner surfaces instead of silently running the
//     lead with no model;
//   * lifecycle: start()/stop() bound the sweep pump; dispose() closes every
//     in-memory session transport inside the runner's existing drain budget
//     (durable state survives — a successor runner re-drives from the
//     checkpoint, the CLI process is always replaceable).
//
// Failure honesty: one card's drive error is recorded and the sweep
// continues — a broken binding on card A never starves card B. The sweep
// itself throws only when the card index is unreachable (the pump counts
// it as a tick error).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { RuntimeError } from '../common.mjs';
import {
  createPreparationLead, serviceFromClient, prepRunDirs,
} from './lead.mjs';
import { createPiRpcTransport } from './pi-rpc.mjs';
import { loadRegistry, verifyManifest } from './skills/registry.mjs';
import { ADAPTERS } from './skills/adapters.mjs';
import { defaultHostCapabilities } from './skills/capabilities.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const SUPERVISOR_DEFAULTS = {
  tickMs: 5_000,               // discovery cadence — same weight class as the managed pump
  disposeDrainMs: 10_000,      // transport teardown budget inside the runner's drain
};

// Which list rows owe the lead a drive() call right now. A `running` attempt
// is the durable signal the user minted work (kickoff/answer/continue/draft)
// — an active session parked on an unanswered question has nothing to do
// until the answer flips the attempt back to running, so it is NOT driven
// (a dead parked transport simply respawns on that drive, checkpoint-rebind
// covered). The in-memory driver state only earns a sweep visit when the
// durable session is no longer active — the teardown case.
function cardNeedsDrive(row, driverState) {
  const p = row?.preparation;
  if (p?.attempts?.running > 0) return true;
  if (driverState !== null && (!p || p.status !== 'active')) return true;
  return false;
}

// Provision a per-session pi agent dir: the profile's auth + models files
// are copied once; settings.json is rendered for the configured model.
// Copying keeps session-local mutations off the host profile; skipping
// existing files keeps a respawn's accumulated session cache. A source that
// cannot yield auth fails closed BEFORE any pi child spawns.
async function seedPiAgentDir(agentDir, { sourceDir, model, fsImpl = fs } = {}) {
  await fsImpl.mkdir(agentDir, { recursive: true });
  const src = sourceDir ? path.resolve(sourceDir) : null;
  const copied = [];
  if (src) {
    for (const name of ['auth.json', 'models.json']) {
      const from = path.join(src, name);
      const to = path.join(agentDir, name);
      try { await fsImpl.access(from); } catch { continue; }
      try {
        await fsImpl.access(to);
      } catch {
        await fsImpl.copyFile(from, to);
        copied.push(name);
      }
    }
  }
  const settingsPath = path.join(agentDir, 'settings.json');
  const settings = { hideThinkingBlock: false };
  if (model?.provider) settings.defaultProvider = model.provider;
  if (model?.id) settings.defaultModel = model.id;
  if (model?.thinking) settings.defaultThinkingLevel = model.thinking;
  try {
    await fsImpl.access(settingsPath);
  } catch {
    await fsImpl.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`,
      { mode: 0o600 });
    copied.push('settings.json');
  }
  // Fail-closed check AFTER seeding: without auth the model call dies a few
  // seconds into the first turn — surfacing it here costs nothing.
  try {
    await fsImpl.access(path.join(agentDir, 'auth.json'));
  } catch {
    throw new RuntimeError('prep_agent_dir_unprovisioned',
      `pi agent dir ${agentDir} has no auth.json and source ` +
      `${src ?? '(none)'} did not provide one — the selected Pi profile ` +
      'is not provisioned for the preparation lead');
  }
  return { agentDir, seeded: copied };
}

export function createPreparationSupervisor({
  client,                 // createInternalClient-shaped
  stateDir,               // resolved managed state dir (execution root = <stateDir>/execution)
  env = process.env,
  // --- lead seams (defaults = production wiring) ---
  registry = null,        // registry | () => registry; null → default bindings.json
  registryPath = null,    // explicit bindings.json override (tests/e2e)
  verify = null,          // (binding) => manifest verify; default verifyManifest
  adapters = ADAPTERS,
  hostCapabilities = defaultHostCapabilities(),
  model = null,           // {provider,id,thinking}; null → env ACP_PREP_*
  piBinary = null,        // default env.ACP_PREP_PI_BIN || 'pi'
  extensionPath = null,   // default PREPARATION_BRIDGE_PATH via the lead
  readOnlyRoots = [],
  limits = {},
  transportFactory = null, // test seam — default: real pi-rpc + agent-dir seed
  agentDirSource = null,   // default env.ACP_PREP_PI_AGENT_DIR || <home>/.pi/agent
  spawnImpl = null,        // forwarded to the default transport factory
  now = () => Date.now(),
  log = (msg) => console.error(`prep-lead: ${msg}`),
} = {}) {
  const execRoot = path.join(path.resolve(stateDir), 'execution');
  const sessionsRoot = path.join(execRoot, 'preparation');
  const resolvedModel = model ?? {
    provider: env.ACP_PREP_PROVIDER || undefined,
    id: env.ACP_PREP_MODEL || undefined,
    thinking: env.ACP_PREP_THINKING || undefined,
  };
  const resolvedBinary = piBinary ?? env.ACP_PREP_PI_BIN ?? 'pi';
  const resolvedAgentSource = agentDirSource
    ?? env.ACP_PREP_PI_AGENT_DIR
    ?? path.join(os.homedir(), '.pi', 'agent');
  const regLoader = registry !== null
    ? (typeof registry === 'function' ? registry : () => registry)
    : () => loadRegistry(registryPath
        ?? fileURLToPath(new URL('./skills/bindings.json', import.meta.url)));
  const verifier = verify === null
    ? (b) => verifyManifest(b)
    : verify;

  const defaultTransportFactory = async (plan, ctx) => {
    const dirs = ctx?.dirs ?? {};
    await seedPiAgentDir(dirs.agentDir, {
      sourceDir: resolvedAgentSource, model: resolvedModel,
    });
    return createPiRpcTransport({
      argv: [plan.command, ...(plan.args ?? [])],
      cwd: plan.cwd,
      env: { ...process.env, ...(plan.env ?? {}) },
      transcriptPath: dirs.transcriptPath ?? null,
      ...(spawnImpl ? { spawnImpl } : {}),
    });
  };

  const lead = createPreparationLead({
    service: serviceFromClient(client),
    registry: regLoader,
    dirsFor: (view) => prepRunDirs(sessionsRoot, view.sessionId),
    transportFactory: transportFactory ?? defaultTransportFactory,
    verify: verifier,
    adapters,
    model: resolvedModel,
    piBinary: resolvedBinary,
    ...(extensionPath ? { extensionPath } : {}),
    hostCapabilities,
    readOnlyRoots,
    limits,
    now,
  });

  const inflight = new Set();   // cardIds with a drive in flight — serialization
                                // lives in the lead; this set only dedupes
                                // the sweep's discovery within one process.
  const stats = { sweeps: 0, drives: 0, errors: 0, lastError: null, lastSweepAt: null };
  let stopped = false;
  let sweeping = Promise.resolve();

  async function sweep() {
    if (stopped) return { driven: 0 };
    const res = await client.listCards();
    const cards = Array.isArray(res?.cards) ? res.cards : [];
    stats.sweeps += 1;
    stats.lastSweepAt = now();
    let driven = 0;
    for (const row of cards) {
      const cardId = row?.cardId;
      if (!cardId || inflight.has(cardId)) continue;
      if (!cardNeedsDrive(row, lead.driverState(cardId))) continue;
      inflight.add(cardId);
      // Serial per card, parallel across cards — the lead serializes per
      // card internally anyway; this Promise is unhandled-by-design: the
      // catch below is the only sink.
      const p = lead.drive(cardId)
        .then((r) => { stats.drives += 1; return r; })
        .catch((e) => {
          stats.errors += 1;
          stats.lastError = `${cardId}: ${e?.code ?? 'error'} ${e?.message ?? e}`;
          log(`drive ${cardId} failed: ${e?.code ?? ''} ${e?.message ?? e}`);
        })
        .finally(() => inflight.delete(cardId));
      driven += 1;
      void p;
    }
    return { driven };
  }

  return {
    lead,                    // exposed for tests/diagnostics
    sessionsRoot,

    // One bounded pass — driven by the runner's pump. The pump serializes
    // ticks, so overlapping sweeps cannot happen; the flag guards direct
    // callers regardless.
    async sweep() {
      const run = sweeping.then(() => sweep());
      sweeping = run.catch(() => {});
      return run;
    },

    // Stop the sweep loop only — in-memory sessions (and their parked CLI
    // transports) stay alive for dispose() to close inside the drain bound.
    stop() { stopped = true; },

    async dispose({ drainMs = SUPERVISOR_DEFAULTS.disposeDrainMs } = {}) {
      stopped = true;
      const deadline = now() + drainMs;
      // Wait for in-flight sweeps/drives first — a drive that outlives the
      // budget is abandoned (its durable state stands; the transport close
      // below still runs).
      while (inflight.size > 0 && now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const left = Math.max(0, deadline - now());
      await Promise.race([
        lead.dispose(),
        new Promise((r) => setTimeout(r, left)),
      ]);
      return { abandoned: inflight.size };
    },

    stats: () => ({ ...stats, inflight: inflight.size }),
  };
}
