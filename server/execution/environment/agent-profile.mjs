// server/execution/environment/agent-profile.mjs — AgentProfile model + digest.
//
// The AgentProfile is the COMPLETE effective description of what runs in a
// worker: pi version, worker image, provider/model/thinking, skills,
// extensions, the tools allowlist, web-search parameters and the launch
// config. validateAgentProfile() produces a normalized object; its canonical
// JSON (sorted keys) is hashed into the profileDigest — the key under which
// the web-search capability/probe ledger lives (capability-store.mjs).
//
// Because the digest covers tools+extensions, removing web_search at the
// same image/model yields a NEW digest with no probe on record — an
// unprobed combination, rejected when search is on.

import crypto from 'node:crypto';
import { RuntimeError, SAFE_ID_RE } from '../common.mjs';
import { REL_PATH_RE } from './env-config.mjs';

const PI_VER_RE = /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,200}$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const TOOL_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
const FLAG_ENUM = new Set([
  '--no-extensions', '--no-skills', '--no-context-files',
  '--no-prompt-templates', '--no-themes', '-na', '--no-approve',
]);

function fail(msg) { throw new RuntimeError('invalid_profile', msg); }

function reqStr(v, what, re) {
  if (typeof v !== 'string' || !re.test(v)) fail(`${what} malformed: ${JSON.stringify(v)}`);
  return v;
}

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// A resource ref: {resource: <registered root name>, rel: <relative path>}.
// The controller maps resource+rel onto the mounted container path — the
// profile never carries an absolute host path.
function validResourceRef(v, what) {
  if (!isObj(v)) fail(`${what} must be {resource, rel}`);
  reqStr(v.resource, `${what}.resource`, SAFE_ID_RE);
  reqStr(v.rel, `${what}.rel`, REL_PATH_RE);
  if (v.rel.includes('..')) fail(`${what}.rel must not contain '..': ${v.rel}`);
  return { resource: v.resource, rel: v.rel };
}

export function validateAgentProfile(raw) {
  if (!isObj(raw)) fail('profile must be an object');
  const p = {
    schemaVersion: 1,
    profileId: reqStr(raw.profileId, 'profileId', SAFE_ID_RE),
    pi: { version: reqStr(raw.pi?.version, 'pi.version', PI_VER_RE) },
    // Worker image key — resolved against config.images at prepare time.
    image: reqStr(raw.image, 'image', SAFE_ID_RE),
    provider: reqStr(raw.provider, 'provider', PROVIDER_RE),
    model: reqStr(raw.model, 'model', MODEL_RE),
    thinking: raw.thinking === undefined || raw.thinking === null ? null : raw.thinking,
    skills: (raw.skills ?? []).map((s, i) => validResourceRef(s, `skills[${i}]`)),
    extensions: (raw.extensions ?? []).map((s, i) => validResourceRef(s, `extensions[${i}]`)),
    tools: raw.tools === undefined ? null : raw.tools,
    search: validateSearch(raw.search),
    launch: validateLaunch(raw.launch),
    systemPromptFile: raw.systemPromptFile === undefined || raw.systemPromptFile === null
      ? null : validResourceRef(raw.systemPromptFile, 'systemPromptFile'),
  };
  if (p.thinking !== null && !THINKING.has(p.thinking)) {
    fail(`thinking must be one of ${[...THINKING].join('|')}`);
  }
  if (p.tools !== null) {
    if (!Array.isArray(p.tools)) fail('tools must be an array or null');
    for (const t of p.tools) reqStr(t, 'tools[]', TOOL_RE);
    if (!p.tools.length) fail('tools allowlist may not be empty (use explicit tools)');
    p.tools = [...new Set(p.tools)].sort();
  }
  if (p.search.enabled && !p.search.provider) {
    fail('search.enabled requires search.provider (explicit, never inferred)');
  }
  return p;
}

function validateSearch(raw) {
  if (raw === undefined || raw === null) return { enabled: false, provider: null, params: {} };
  if (!isObj(raw)) fail('search must be an object');
  const enabled = raw.enabled === true;
  const params = isObj(raw.params) ? raw.params : {};
  for (const key of ['provider', 'proxy']) {
    if (Object.hasOwn(params, key)) fail(`search.params.${key} is reserved`);
  }
  // Params become the worker's scoped web-search.json verbatim — keep them
  // JSON-pure and bounded so the digest meaningfully captures them.
  const json = JSON.stringify(params);
  if (json.length > 16 * 1024) fail('search.params exceeds 16KiB');
  return {
    enabled,
    provider: raw.provider === undefined || raw.provider === null ? null
      : reqStr(raw.provider, 'search.provider', PROVIDER_RE),
    params: JSON.parse(json),
  };
}

function validateLaunch(raw) {
  const l = isObj(raw) ? raw : {};
  const out = {
    // porch progress mode for the delegate child.
    progress: l.progress ?? 'none',
    extraFlags: [],
  };
  if (!['none', 'compact', 'full'].includes(out.progress)) {
    fail(`launch.progress must be none|compact|full`);
  }
  // Fixed enum only — arbitrary argv injection into pi is not a payload
  // capability; skills/extensions/tools above cover the real surface.
  for (const f of l.extraFlags ?? []) {
    if (!FLAG_ENUM.has(f)) fail(`launch.extraFlags: unsupported flag ${f}`);
    out.extraFlags.push(f);
  }
  return out;
}

// Canonical JSON: recursively sorted keys, no whitespace. Any byte-level
// difference in the effective profile changes the digest.
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) {
    return `{${Object.keys(v).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function profileDigest(profile) {
  const p = validateAgentProfile(profile);
  return crypto.createHash('sha256').update(canonicalJson(p)).digest('hex');
}

// The porch agent config block the worker runs with — derived, never taken
// from the payload as-is. model is already provider-qualified.
export function porchAgentEntry(profile) {
  const p = validateAgentProfile(profile);
  return {
    enabled: true,
    backend: 'pi-cli',
    model: p.model,
    role: 'analyst',
    label: `f1:${p.profileId}`,
  };
}

export function usesDuckDuckGoTransport(profile) {
  const p = validateAgentProfile(profile);
  return p.search.enabled && p.search.provider === 'duckduckgo'
    && p.extensions.some(e => e.resource === 'piExt' && e.rel === 'pi-web-access');
}

// The deterministic pi argv fragment injected by the boundary shim
// (PI_PROFILE_FLAGS_FILE). Synthesized BY THE CONTROLLER from the validated
// profile — the runner payload carries the profile, never argv.
//   extRoot: container path where the 'piExt' resource root is mounted.
export function profileFlags(profile, { extRoot = '/work/node_modules', skillRoot = '/work/skills' } = {}) {
  const p = validateAgentProfile(profile);
  const duckDuckGoTransport = usesDuckDuckGoTransport(p);
  const flags = [];
  flags.push('--no-extensions');           // explicit -e only, no discovery
  for (const e of p.extensions) flags.push('-e',
    duckDuckGoTransport && e.resource === 'piExt' && e.rel === 'pi-web-access'
      ? '/work/conf/duckduckgo-extension.ts' : `${extRoot}/${e.rel}`);
  flags.push('--no-skills');
  for (const s of p.skills) flags.push('--skill', `${skillRoot}/${s.rel}`);
  flags.push('--no-context-files', '--no-prompt-templates', '--no-themes', '-na');
  if (p.tools) flags.push('--tools', p.tools.join(','));
  if (p.thinking) flags.push('--thinking', p.thinking);
  for (const f of p.launch.extraFlags) flags.push(f);
  return flags;
}

// Scoped pi agent dir content the controller materializes per worker:
// models.json limited to the profile's provider; settings pinned to it;
// web-search.json present only when search is enabled.
export function scopedAgentSpec(profile, sourceModels, { searchProxy = null } = {}) {
  const p = validateAgentProfile(profile);
  const providers = sourceModels?.providers;
  if (!isObj(providers) || !isObj(providers[p.provider])) {
    throw new RuntimeError('provider_not_registered',
      `provider ${p.provider} is absent from the credential source`);
  }
  const block = providers[p.provider];
  // Only declared provider fields are copied — models + baseUrl + api +
  // apiKey + compat. Anything else in the source entry stays out.
  const scoped = {};
  for (const k of ['baseUrl', 'api', 'apiKey', 'compat', 'models', 'headers', 'authHeader']) {
    if (block[k] !== undefined) scoped[k] = block[k];
  }
  const settings = {
    defaultProvider: p.provider,
    defaultModel: p.model.includes('/') ? p.model.split('/').slice(1).join('/') : p.model,
    ...(p.thinking ? { defaultThinkingLevel: p.thinking } : {}),
    packages: [],                       // nothing discovered from settings
    enableInstallTelemetry: false,
  };
  const files = {
    'models.json': { providers: { [p.provider]: scoped } },
    'settings.json': settings,
  };
  if (p.search.enabled) {
    // pi-web-access picks the provider only from web-search.json — 'provider'
    // is explicit (DDG is never auto-selected), and Node fetch ignores
    // HTTP(S)_PROXY so the egress gateway goes in 'proxy' verbatim.
    files['web-search.json'] = {
      provider: p.search.provider,
      ...(searchProxy ? { proxy: searchProxy } : {}),
      ...p.search.params,
    };
  }
  return files;
}
