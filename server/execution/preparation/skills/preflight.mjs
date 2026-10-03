// server/execution/preparation/skills/preflight.mjs — P2 capability
// preflight (plan KTD3): the check list a binding must clear before any
// spawn or write.
//
// preflightBinding() runs the whole gate — route availability, adapter
// presence/compatibility, capability satisfaction, pinned-resource
// integrity (full manifest re-verify, no parsing of content), gate-contract
// well-formedness — and returns a resolved descriptor or throws one
// structured refusal. Nothing here spawns or writes: preflight exists so
// that every failure mode surfaces BEFORE the runtime commits.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RuntimeError } from '../../common.mjs';
import {
  assertRouteAvailable,
  resolveRoots,
  verifyManifest,
  bindingConfigDigest,
  GATE_TYPES,
} from './registry.mjs';
import { adapterFor } from './adapters.mjs';
import {
  requiredCapabilities,
  missingCapabilities,
  normalizeCapabilities,
} from './capabilities.mjs';

function fail(code, msg, extra = {}) {
  throw new RuntimeError(code, msg, extra);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Gate-contract check — KTD7 made explicit on the binding
// ---------------------------------------------------------------------------
// P1 derived contracts from stage via GATE_CONTRACT_OVERRIDES; P2 declares
// them on the binding (`gateContract` — an array of gate specs; [] is a
// valid declaration meaning "this route carries no user gate"). A declared
// contract is returned verbatim (the registry already validated its shape);
// an absent contract (legacy/P1-era binding data) resolves to null so the
// caller can apply the stage-derived P1 default — identical semantics,
// never a silent contract invention.

export function resolveGateContract(binding) {
  const c = binding.gateContract;
  if (c === undefined || c === null) return null;
  if (!Array.isArray(c)) {
    fail('gate_contract_invalid',
      `binding ${binding.bindingId}: gateContract must be an array of gate specs`,
      { bindingId: binding.bindingId });
  }
  for (const [i, spec] of c.entries()) {
    if (!isObj(spec) || !GATE_TYPES.has(spec.type) || typeof spec.stage !== 'string' || !spec.stage) {
      fail('gate_contract_invalid',
        `binding ${binding.bindingId}: gateContract[${i}] must declare a known type ` +
        `(${[...GATE_TYPES].join('|')}) and a stage`,
        { bindingId: binding.bindingId });
    }
  }
  return c.map((s) => ({ type: s.type, stage: s.stage }));
}

// ---------------------------------------------------------------------------
// Preflight — pure contract part, then the filesystem part
// ---------------------------------------------------------------------------
//
// Order matters: route truth (unsupported/candidate) first, then the
// adapter (missing → adapter_unavailable, incompatible →
// adapter_version_unsupported/adapter_unsafe), then capabilities
// (capability_missing), then the pinned manifest's presence, then the
// declared gate contract (gate_contract_invalid). Every refusal is a
// RuntimeError with a stable code and machine-readable details.
//
// `preflightContract` is the fs-pure subset — it never touches the disk:
// the session module calls it at binding-assignment time, where the
// pinned digest is recorded and the filesystem re-verify is layered on at
// the implementation start gate (ctx.preparationVerify). `preflightBinding`
// is the full check — contract part PLUS verifyManifest re-hash and
// declared-root existence — used by the probe/evidence tooling before a
// real spawn.

export function preflightContract(binding, {
  hostCapabilities,
  adapters,
} = {}) {
  assertRouteAvailable(binding);

  const adapter = adapterFor(binding, adapters); // adapter_unavailable
  if (typeof adapter.assertCompatible !== 'function') {
    fail('adapter_unavailable',
      `adapter ${adapter.adapterId ?? binding.adapterId} for binding ${binding.bindingId} ` +
      'does not implement assertCompatible — the adapter contract is incomplete',
      { bindingId: binding.bindingId, adapterId: binding.adapterId });
  }
  adapter.assertCompatible(binding);             // adapter_version_unsupported / adapter_unsafe

  const caps = normalizeCapabilities(hostCapabilities);
  const required = requiredCapabilities(binding, adapter);
  const missing = missingCapabilities(required, caps);
  if (missing.length) {
    fail('capability_missing',
      `binding ${binding.bindingId} requires capabilities this host does not provide: ` +
      `${missing.join(', ')}`,
      { bindingId: binding.bindingId, missing, required });
  }

  if (!binding.resourceManifest) {
    fail('resources_unpinned',
      `binding ${binding.bindingId} has no pinned resource manifest`,
      { bindingId: binding.bindingId });
  }
  const gateContract = resolveGateContract(binding);   // gate_contract_invalid

  return {
    bindingId: binding.bindingId,
    stage: binding.stage,
    adapterId: adapter.adapterId,
    adapterVersion: adapter.adapterVersion,
    questionChannel: binding.questionChannel,
    gateContract,
    result: binding.result ?? { mode: 'conversation', importAs: 'none', handoffs: [] },
    capabilities: { required, satisfied: true },
    digest: binding.resourceManifest.digest,
    configDigest: bindingConfigDigest(binding),
  };
}

export async function preflightBinding(binding, {
  hostCapabilities,
  adapters,
  workspace,
  scratch = true,
  fsCheck = true,
} = {}) {
  const contract = preflightContract(binding, { hostCapabilities, adapters });

  await verifyManifest(binding); // resource drift — full pinned-set re-hash

  const roots = workspace ? resolveRoots(binding, workspace, { scratch }) : null;
  const env = {
    PI_CODING_AGENT_DIR: true,
    PI_OFFLINE: '1',
    writeRoots: roots ? roots.writeRoots.length : undefined,
    readRoots: roots ? roots.readRoots.length : undefined,
  };
  if (fsCheck && workspace) {
    for (const root of [...roots.writeRoots, ...roots.readRoots]) {
      try {
        await fs.access(root);
      } catch {
        fail('root_missing',
          `binding ${binding.bindingId}: declared root missing: ${root}`,
          { bindingId: binding.bindingId, root });
      }
    }
  }
  return { ...contract, roots, env };
}
