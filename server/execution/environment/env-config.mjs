// server/execution/environment/env-config.mjs — F1 deployment config model.
//
// ONE file (deploy/execution/environment.config.json) is the single source
// of truth for BOTH sides of the boundary:
//   * the trusted controller (deploy/execution/env-controller.mjs) validates
//     every worker/exec/materials request against it — only registered
//     resource roots, pinned images, fixed role profiles, declared exec
//     templates and declared egress entries are ever acted on;
//   * the runner-side environment modules (controller-client.mjs,
//     container-runtime.mjs, capability-store.mjs) resolve their paths and
//     policy from the same document.
//
// A client payload can therefore never introduce an absolute host path, an
// image, a mount, or an egress destination that the deployment did not
// register. Nothing in this module performs IO at import time.
//
// Path templating: "${VAR}" inside string values is expanded from an env
// map supplied by the caller (controller: process.env; tests: explicit).
// Unknown variables fail closed.

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { RuntimeError, SAFE_ID_RE, normPath } from '../common.mjs';

export const CONFIG_SCHEMA = 1;

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,200}$/;   // image refs incl. digest
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export const REL_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,300}$/; // relative resource path
const REL_RE = REL_PATH_RE;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const KINDS = new Set(['provider', 'search', 'registry', 'service']);
const ROLES = new Set(['panelist', 'judge', 'integrator', 'setup', 'probe']);
const PROJECT_MODES = new Set(['snapshot-ro', 'private-repo', 'none', 'workdir-rw']);

function fail(code, msg) { throw new RuntimeError(code, msg); }

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function reqObj(v, what) {
  if (!isObj(v)) fail('config_invalid', `${what} must be an object`);
  return v;
}

function reqStr(v, what, re = null) {
  if (typeof v !== 'string' || !v.length) fail('config_invalid', `${what} must be a non-empty string`);
  if (re && !re.test(v)) fail('config_invalid', `${what} malformed: ${v}`);
  return v;
}

function reqId(v, what) { return reqStr(v, what, SAFE_ID_RE); }

function reqInt(v, what, lo, hi) {
  if (!Number.isInteger(v) || v < lo || v > hi) {
    fail('config_invalid', `${what} must be an integer ${lo}..${hi}: ${v}`);
  }
  return v;
}

function absPath(v, what) {
  const s = reqStr(v, what);
  if (!s.startsWith('/')) fail('config_invalid', `${what} must be absolute: ${s}`);
  return normPath(s);
}

// ---- template expansion -----------------------------------------------------

const TEMPLATE_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;

export function expandTemplates(value, env) {
  if (typeof value === 'string') {
    return value.replace(TEMPLATE_RE, (m, name) => {
      const rep = env?.[name];
      if (typeof rep !== 'string' || !rep.length) {
        fail('config_template_unset', `template variable ${name} is not set`);
      }
      return rep;
    });
  }
  if (Array.isArray(value)) return value.map((v) => expandTemplates(v, env));
  if (isObj(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandTemplates(v, env);
    return out;
  }
  return value;
}

// ---- section validators -----------------------------------------------------

function validRoot(name, spec) {
  const o = reqObj(spec, `roots.${name}`);
  const access = reqStr(o.access, `roots.${name}.access`);
  if (access !== 'ro' && access !== 'rw') {
    fail('config_invalid', `roots.${name}.access must be ro|rw`);
  }
  return {
    name,
    hostPath: absPath(o.hostPath, `roots.${name}.hostPath`),
    mountPath: absPath(o.mountPath, `roots.${name}.mountPath`),
    access,
    purpose: typeof o.purpose === 'string' ? o.purpose : '',
  };
}

function validImage(name, spec) {
  const o = reqObj(spec, `images.${name}`);
  const ref = reqStr(o.ref, `images.${name}.ref`, REF_RE);
  if (ref.includes('..') || ref.includes('//')) {
    fail('config_invalid', `images.${name}.ref contains suspicious segments: ${ref}`);
  }
  const digest = o.digest === undefined ? null : reqStr(o.digest, `images.${name}.digest`, /^sha256:[0-9a-f]{64}$/);
  return { name, ref, digest };
}

function validRole(name, spec) {
  const o = reqObj(spec, `roles.${name}`);
  const projectMode = reqStr(o.projectMode, `roles.${name}.projectMode`);
  if (!PROJECT_MODES.has(projectMode)) {
    fail('config_invalid', `roles.${name}.projectMode must be one of ${[...PROJECT_MODES]}`);
  }
  return {
    name,
    projectMode,
    // Extra read-only input slots beyond the default (panelist: task only).
    inputs: Array.isArray(o.inputs) ? o.inputs.map((s) => reqId(s, `roles.${name}.inputs[]`)) : [],
    // 'deps' ro mount of a materialized dep set allowed for this role.
    deps: o.deps === true,
    // integrator only: binds a canonical worktree for result import.
    canonical: o.canonical === true,
    // setup role: may run a declared setup spec (deps.prepare).
    setup: o.setup === true,
  };
}

function validEgressEntry(i, spec) {
  const o = reqObj(spec, `egress.allowlist[${i}]`);
  const host = reqStr(o.host, `egress.allowlist[${i}].host`);
  const isIp = IPV4_RE.test(host) || host.includes(':');
  if (!isIp && !HOST_RE.test(host)) {
    fail('config_invalid', `egress.allowlist[${i}].host malformed: ${host}`);
  }
  const ports = Array.isArray(o.ports) && o.ports.length ? o.ports : [443];
  for (const p of ports) reqInt(p, `egress.allowlist[${i}].ports[]`, 1, 65535);
  const kind = reqStr(o.kind || 'provider', `egress.allowlist[${i}].kind`);
  if (!KINDS.has(kind)) fail('config_invalid', `egress.allowlist[${i}].kind must be one of ${[...KINDS]}`);
  return {
    host: host.toLowerCase(),
    hostIsIp: isIp,
    ports: new Set(ports),
    kind,
    // Explicit flag: this provider upstream legitimately resolves to a
    // private/LAN address (e.g. a local model relay). Everything else that
    // resolves private stays blocked — this entry names the exception.
    privateUpstream: o.privateUpstream === true,
  };
}

function validExecTemplate(i, spec) {
  const o = reqObj(spec, `execPolicy.templates[${i}]`);
  const name = reqId(o.name, `execPolicy.templates[${i}].name`);
  const head = o.head;
  if (!Array.isArray(head) || !head.length) {
    fail('config_invalid', `execPolicy.templates[${i}].head must be a non-empty argv prefix`);
  }
  if (typeof head[0] !== 'string' || !head[0].startsWith('/')) {
    fail('config_invalid', `execPolicy.templates[${i}].head[0] must be an absolute path`);
  }
  for (const a of head) {
    if (typeof a !== 'string' || !a.length) {
      fail('config_invalid', `execPolicy.templates[${i}].head entries must be non-empty strings`);
    }
  }
  // args validation: each client-supplied argv tail element must match this.
  const argReSrc = typeof o.argPattern === 'string' ? o.argPattern : '^[A-Za-z0-9._/+@=:,~\\-]{1,500}$';
  let argRe;
  try { argRe = new RegExp(argReSrc); } catch (e) {
    fail('config_invalid', `execPolicy.templates[${i}].argPattern bad regex: ${e.message}`);
  }
  // Every absolute path inside a tail argument must stay under one of these
  // container path prefixes (validated literally — exec never runs a shell,
  // so lexical containment is exact).
  const pathRoots = Array.isArray(o.pathRoots) ? o.pathRoots : [];
  for (const r of pathRoots) absPath(r, `execPolicy.templates[${i}].pathRoots[]`);
  return {
    name,
    head,
    argRe,
    pathRoots,
    maxArgs: reqInt(o.maxArgs ?? 64, `execPolicy.templates[${i}].maxArgs`, 0, 256),
    requiresFlag: typeof o.requiresFlag === 'string' ? o.requiresFlag : null,
  };
}

function validSetup(name, spec) {
  const o = reqObj(spec, `setups.${name}`);
  const argv = o.argv;
  if (!Array.isArray(argv) || !argv.length) {
    fail('config_invalid', `setups.${name}.argv must be a non-empty array`);
  }
  for (const a of argv) {
    if (typeof a !== 'string' || !a.length) fail('config_invalid', `setups.${name}.argv entries must be strings`);
  }
  const lockfiles = o.lockfiles;
  if (!Array.isArray(lockfiles) || !lockfiles.length) {
    fail('config_invalid', `setups.${name}.lockfiles must be a non-empty array`);
  }
  for (const l of lockfiles) {
    if (!REL_RE.test(l) || l.includes('..')) {
      fail('config_invalid', `setups.${name}.lockfiles[] bad relative path: ${l}`);
    }
  }
  const depPath = reqStr(o.depPath, `setups.${name}.depPath`, REL_RE);
  if (depPath.includes('..')) fail('config_invalid', `setups.${name}.depPath must not contain '..'`);
  return {
    name,
    argv,
    lockfiles,
    // Container-relative project path that receives the materialized dep
    // output during setup and the ro mount during checks (e.g. node_modules).
    depPath,
    checkArgv: Array.isArray(o.checkArgv) ? o.checkArgv.map(String) : null,
    timeoutMs: reqInt(o.timeoutMs ?? 600_000, `setups.${name}.timeoutMs`, 1000, 3600_000),
    checkTimeoutMs: reqInt(o.checkTimeoutMs ?? 120_000, `setups.${name}.checkTimeoutMs`, 1000, 600_000),
  };
}

// ---- public loader ----------------------------------------------------------

// Parse + validate. `env` supplies ${VAR} expansion (controller: process.env).
// `view` selects which path column the convenience fields resolve:
//   'controller' — in-container mountPath view (what the daemon uses);
//   'client'     — hostPath view (what runner-side modules use).
export function validateEnvironmentConfig(raw, { env = {}, view = 'controller' } = {}) {
  const doc = expandTemplates(raw, env);
  if (doc.schemaVersion !== CONFIG_SCHEMA) {
    fail('config_invalid', `schemaVersion must be ${CONFIG_SCHEMA}`);
  }
  const e = reqObj(doc.environment, 'environment');
  // socket/token/registry live UNDER the env root — declared relative so the
  // controller view (/env/…) and the client view (hostPath/…) each resolve
  // correctly in their own mount namespace.
  const relInEnv = (v, what) => {
    const s = reqStr(v, what, REL_RE);
    if (s.includes('..')) fail('config_invalid', `${what} must not contain '..'`);
    return s;
  };
  const envSec = {
    socketRel: relInEnv(e.socketPath ?? 'controller/env.sock', 'environment.socketPath'),
    tokenRel: relInEnv(e.tokenFile ?? 'controller/channel-token', 'environment.tokenFile'),
    registryRel: relInEnv(e.registryFile ?? 'controller/registry.json', 'environment.registryFile'),
    workerNamePrefix: reqStr(e.workerNamePrefix, 'environment.workerNamePrefix', /^[a-z0-9][a-z0-9-]{0,40}-$/),
    networkNamePrefix: reqStr(e.networkNamePrefix, 'environment.networkNamePrefix', /^[a-z0-9][a-z0-9-]{0,40}-$/),
    labelPrefix: reqStr(e.labelPrefix, 'environment.labelPrefix', /^[a-z][a-z0-9.]{2,60}$/),
    workerUid: reqInt(e.workerUid, 'environment.workerUid', 1, 65535),
    workerGid: reqInt(e.workerGid, 'environment.workerGid', 1, 65535),
    maxExecMs: reqInt(e.maxExecMs, 'environment.maxExecMs', 1000, 3600_000),
    maxOutputBytes: reqInt(e.maxOutputBytes, 'environment.maxOutputBytes', 1024, 64 * 1024 * 1024),
    maxInputBytes: reqInt(e.maxInputBytes ?? 256 * 1024, 'environment.maxInputBytes', 1024, 16 * 1024 * 1024),
    maxPromptBytes: reqInt(e.maxPromptBytes ?? 512 * 1024, 'environment.maxPromptBytes', 1024, 8 * 1024 * 1024),
    allowDebugExec: e.allowDebugExec === true,
  };
  const gw = reqObj(e.egressGateway, 'environment.egressGateway');
  envSec.egressGateway = {
    alias: reqStr(gw.alias, 'egressGateway.alias', HOST_RE),
    proxyPort: reqInt(gw.proxyPort, 'egressGateway.proxyPort', 1, 65535),
    proxyUrl: reqStr(gw.proxyUrl, 'egressGateway.proxyUrl', /^http:\/\/[a-z0-9.-]+:\d{1,5}$/),
    labelSelector: reqStr(gw.labelSelector, 'egressGateway.labelSelector'),
  };

  const roots = {};
  for (const [name, spec] of Object.entries(reqObj(doc.roots, 'roots'))) {
    roots[name] = validRoot(reqId(name, 'roots key'), spec);
  }
  if (!roots.env || roots.env.access !== 'rw') {
    fail('config_invalid', 'roots.env must exist with access rw');
  }
  if (!roots.projects || roots.projects.access !== 'ro') {
    fail('config_invalid', 'roots.projects must exist with access ro');
  }
  for (const needed of ['piCreds', 'piExt', 'piSkills', 'porchSkill']) {
    if (!roots[needed]) fail('config_invalid', `roots.${needed} is required`);
  }

  const images = {};
  for (const [name, spec] of Object.entries(reqObj(doc.images, 'images'))) {
    images[name] = validImage(reqId(name, 'images key'), spec);
  }
  if (!images.worker) fail('config_invalid', 'images.worker is required');

  const roles = {};
  for (const [name, spec] of Object.entries(reqObj(doc.roles, 'roles'))) {
    const role = validRole(reqId(name, 'roles key'), spec);
    if (!ROLES.has(name)) fail('config_invalid', `unknown role ${name}`);
    if (name === 'integrator' && !role.canonical) {
      fail('config_invalid', 'roles.integrator must declare canonical:true');
    }
    if (name === 'setup' && !role.setup) {
      fail('config_invalid', 'roles.setup must declare setup:true');
    }
    roles[name] = role;
  }
  for (const needed of ROLES) {
    if (!roles[needed]) fail('config_invalid', `roles.${needed} is required`);
  }

  const egress = reqObj(doc.egress, 'egress');
  const allowlist = Array.isArray(egress.allowlist) ? egress.allowlist : [];
  if (!allowlist.length) fail('config_invalid', 'egress.allowlist must be non-empty');
  const seen = new Set();
  const entries = allowlist.map((s, i) => validEgressEntry(i, s));
  for (const en of entries) {
    for (const p of en.ports) {
      const k = `${en.host}:${p}`;
      if (seen.has(k)) fail('config_invalid', `duplicate egress entry ${k}`);
      seen.add(k);
    }
  }
  if (!entries.some((en) => en.kind === 'provider')) {
    fail('config_invalid', 'egress.allowlist needs at least one provider entry');
  }

  const execPolicy = reqObj(doc.execPolicy, 'execPolicy');
  const templates = (Array.isArray(execPolicy.templates) ? execPolicy.templates : [])
    .map((s, i) => validExecTemplate(i, s));
  if (!templates.some((t) => t.name === 'porch')) {
    fail('config_invalid', 'execPolicy.templates needs a "porch" template');
  }
  if (!templates.some((t) => t.name === 'proc-probe')) {
    fail('config_invalid', 'execPolicy.templates needs a "proc-probe" template');
  }
  const envKeys = Array.isArray(execPolicy.envKeys) ? execPolicy.envKeys : [];
  for (const k of envKeys) {
    if (!ENV_KEY_RE.test(k)) fail('config_invalid', `execPolicy.envKeys bad key ${k}`);
  }
  const cwdKeys = isObj(execPolicy.cwdKeys) ? execPolicy.cwdKeys : {};
  const cwdMap = {};
  for (const [k, v] of Object.entries(cwdMap0(cwdKeys))) cwdMap[k] = v;

  const setups = {};
  for (const [name, spec] of Object.entries(reqObj(doc.setups ?? {}, 'setups'))) {
    setups[reqId(name, 'setups key')] = validSetup(name, spec);
  }

  const cfg = {
    schemaVersion: CONFIG_SCHEMA,
    environment: envSec,
    roots, images, roles,
    egress: { allowlist: entries },
    execPolicy: { templates, envKeys: new Set(envKeys), cwdKeys: cwdMap },
    setups,
    view,
  };
  // Convenience path resolvers honour the selected view.
  cfg.pathFor = (rootName, ...rest) => {
    const r = roots[rootName];
    if (!r) fail('unregistered_root', `resource root not registered: ${rootName}`);
    const base = view === 'controller' ? r.mountPath : (r.clientPath || r.hostPath);
    return path.join(base, ...rest);
  };
  // Resolved env-root-relative facilities in this view.
  envSec.socketPath = cfg.pathFor('env', envSec.socketRel);
  envSec.tokenFile = cfg.pathFor('env', envSec.tokenRel);
  envSec.registryFile = cfg.pathFor('env', envSec.registryRel);
  return cfg;
}

function cwdMap0(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    out[reqId(k, 'execPolicy.cwdKeys key')] = absPath(v, `execPolicy.cwdKeys.${k}`);
  }
  return out;
}

export async function loadEnvironmentConfig(file, opts = {}) {
  const raw = await fs.readFile(file, 'utf8');
  let doc;
  try { doc = JSON.parse(raw); } catch (e2) {
    throw new RuntimeError('config_invalid', `config is not JSON: ${e2.message}`);
  }
  return validateEnvironmentConfig(doc, opts);
}

// Synchronous variant for the daemon's boot path (single small file).
export function loadEnvironmentConfigSync(file, opts = {}) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  return validateEnvironmentConfig(doc, opts);
}

// Egress decision shared by the gateway and the deterministic tests.
// Returns {ok:true, entry, addrs?} or {ok:false, code, message}.
// `resolveIps` is injectable: the gateway passes dns.lookup; tests pass a
// stub. DNS-rebind safety: the decision inspects RESOLVED addresses, and the
// gateway connects to the resolved IP (never the hostname) afterwards.
export function egressDecision(cfg, { host, port, resolvedIps = null }) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return { ok: false, code: 'bad_host', message: 'empty host' };
  const entry = cfg.egress.allowlist.find((en) =>
    en.host === h && en.ports.has(port));
  if (!entry) {
    return { ok: false, code: 'not_allowlisted',
      message: `${h}:${port} is not in the egress allowlist` };
  }
  if (entry.hostIsIp) {
    // IP literal: host equality already enforced; the private-upstream flag
    // decides whether a registered private endpoint is reachable. Generic
    // private IPs are never entries, so a non-flagged match on a literal is
    // still just the exact registered endpoint.
    if (isPrivateIp(h) && !entry.privateUpstream) {
      return { ok: false, code: 'private_blocked',
        message: `${h}:${port} is a private/local address` };
    }
    return { ok: true, entry, addrs: [h] };
  }
  if (!resolvedIps) return { ok: true, entry, addrs: null, needsResolve: true };
  if (!resolvedIps.length) {
    return { ok: false, code: 'dns_empty', message: `${h} resolved no addresses` };
  }
  for (const ip of resolvedIps) {
    if (isPrivateIp(ip) && !entry.privateUpstream) {
      return { ok: false, code: 'private_blocked',
        message: `${h} resolves to private/local ${ip}` };
    }
  }
  return { ok: true, entry, addrs: resolvedIps };
}

// Private/loopback/link-local/reserved classification — IPv4 + IPv6 +
// v4-mapped IPv6 (dotted AND hex forms, e.g. ::ffff:7f00:1). Anything
// non-public is "private" for our purposes.
export function isPrivateIp(ip) {
  let s = String(ip || '').toLowerCase();
  // v4-mapped IPv6 in hex form: ::ffff:HHHH:HHHH → expand to dotted v4.
  const hexMap = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hexMap) {
    const hi = parseInt(hexMap[1], 16), lo = parseInt(hexMap[2], 16);
    s = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  const v6mapped = /^::ffff:(\d{1,3}\.){3}\d{1,3}$/.test(s);
  const v4 = IPV4_RE.test(s) ? s : v6mapped ? s.slice(7) : null;
  if (v4) {
    const [a, b] = v4.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;              // this-net, RFC1918, loopback
    if (a === 100 && b >= 64 && b <= 127) return true;              // CGNAT
    if (a === 169 && b === 254) return true;                        // link-local (metadata!)
    if (a === 172 && b >= 16 && b <= 31) return true;               // RFC1918
    if (a === 192 && b === 168) return true;                        // RFC1918
    if (a === 192 && b === 0) return true;                          // IETF proto assign
    if (a === 198 && (b === 18 || b === 19)) return true;           // benchmark
    if (a === 198 && b === 51) return true;
    if (a === 203 && b === 0) return true;
    if (a >= 224) return true;                                      // multicast/reserved/broadcast
    return false;
  }
  if (s === '::' || s === '::1' || s === '0:0:0:0:0:0:0:1') return true;
  if (s.startsWith('fc') || s.startsWith('fd')) return true;        // ULA fc00::/7
  if (/^fe[89a-f]/.test(s)) return true;                            // link-local fe80::/10 + deprecated site-local
  if (s.startsWith('ff')) return true;                              // multicast
  if (s.includes('.')) return false;                                // exotic mapped — let resolve decide
  // Documentation ranges 2001:db8::/32 etc. are treated public-inert; the
  // connect attempt simply fails upstream. Non-parseable = blocked by caller.
  return !s.includes(':');
}
