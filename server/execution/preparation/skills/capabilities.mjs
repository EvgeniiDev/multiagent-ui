// server/execution/preparation/skills/capabilities.mjs — P2 capability
// vocabulary and the host capability descriptor (plan KTD3/R9).
//
// A binding's required capabilities are the union of
//   * its declared `requires` (registry schema: CAPABILITY_RE),
//   * the capabilities DERIVED from its contract fields — the question
//     channel it needs (`question.<channel>`) and every tool in its
//     allowlist (`tool.<name>`),
//   * the adapter's own host requirements (e.g. pi-skill needs
//     `runtime.pi` — a registered pi runtime).
//
// `missingCapabilities` resolves that set against a host descriptor.
// The descriptor is DATA supplied through the ctx seam
// (ctx.preparationCapabilities) — the session module stays fs/exec-pure;
// tests inject reduced descriptors to exercise `capability_missing`.

import { RuntimeError } from '../../common.mjs';

function fail(code, msg, extra = {}) {
  throw new RuntimeError(code, msg, extra);
}

// The static declaration of what THIS preparation host surface provides.
// The pi-skill adapter + preparation-bridge extension serve both question
// channels (chat prompts and blocking extension_ui dialogs via ask_user),
// the pi builtin tool surface behind --tools allowlists plus the bridge's
// ask_user, the private git document workspace with document import, the
// ce-* skills' own /tmp scratch convention, and read-only project mounts.
// `runtime.pi` is a DECLARED runtime requirement: the registry pins
// pi.version and the real binary/version is exercised by the bounded probe
// (`preparation_binding_probe.mjs preflight`), not re-exec'd per command.
// `native` is empty on purpose — no native CLI surface (intra-skill
// dispatch, MCP peers, browser helpers) is claimed; a binding requiring
// one refuses with capability_missing.
export function defaultHostCapabilities() {
  return {
    question: ['chat', 'extension_ui'],
    tools: ['read', 'write', 'edit', 'bash', 'ask_user'],
    workspace: ['git', 'documents', 'project_ro'],
    scratch: ['ce'],
    runtime: ['pi'],
    native: [],
  };
}

// Defensive normalization of an injected/host descriptor: unknown sections
// are dropped, every entry must be a safe token, absent sections are empty.
// A malformed descriptor cannot widen the capability surface.
export function normalizeCapabilities(host) {
  const src = host && typeof host === 'object' ? host : {};
  const norm = {};
  for (const section of ['question', 'tools', 'workspace', 'scratch', 'runtime', 'native']) {
    const list = Array.isArray(src[section]) ? src[section] : [];
    norm[section] = [...new Set(list.filter((v) => typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,60}$/.test(v)))];
  }
  return norm;
}

// Every capability the binding needs to run its declared route, given the
// adapter that will serve it.
export function requiredCapabilities(binding, adapter) {
  const set = new Set(binding.requires ?? []);
  if (binding.questionChannel) set.add(`question.${binding.questionChannel}`);
  for (const t of binding.tools ?? []) set.add(`tool.${t}`);
  for (const r of adapter?.hostRequirements ?? []) set.add(r);
  return [...set].sort();
}

// The capability vocabulary uses `tool.<name>` while the host descriptor
// groups tools under `tools`; every other prefix matches its section.
const CAP_SECTION = {
  question: 'question', tool: 'tools', workspace: 'workspace',
  scratch: 'scratch', runtime: 'runtime', native: 'native',
};

export function hasCapability(host, cap) {
  const i = cap.indexOf('.');
  const section = CAP_SECTION[i < 0 ? cap : cap.slice(0, i)];
  const name = i < 0 ? '' : cap.slice(i + 1);
  const list = section ? host[section] : undefined;
  return Array.isArray(list) && list.includes(name);
}

// Resolve required capabilities against the host. Missing entries are
// returned (structured), never silently substituted — the caller refuses.
export function missingCapabilities(required, host) {
  const caps = normalizeCapabilities(host);
  return required.filter((cap) => !hasCapability(caps, cap));
}

export function assertCapabilities(binding, adapter, host) {
  const required = requiredCapabilities(binding, adapter);
  const missing = missingCapabilities(required, host);
  if (missing.length) {
    fail('capability_missing',
      `binding ${binding.bindingId} requires capabilities this host does not provide: ` +
      `${missing.join(', ')}`,
      { bindingId: binding.bindingId, missing, required });
  }
  return required;
}
