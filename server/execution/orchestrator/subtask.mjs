// server/execution/orchestrator/subtask.mjs — O1 Subtask contract + set
// validation (plan: docs/plans/agent-orchestrator-implementation-plan.md,
// O1/R2/KTD1).
//
// The decomposition role (prompts/execution/orchestrator/decompose.md) emits
// a JSON document; THIS module is the server-side gate it can never bypass.
// Fail closed: unknown fields, missing contract fields, duplicate ids,
// unknown/self dependencies, cycles, empty acceptance criteria and any
// secret-shaped key are all rejected before a graph record exists.
//
// Contract per subtask:
//   id                 SAFE_ID_RE, unique within the decomposition
//   title              non-empty string ≤300
//   outcome            non-empty string ≤2000 — the result this task owes
//   acceptanceCriteria non-empty array of non-empty strings ≤500 each
//   dependsOn          array of subtask ids (default []) — real prerequisites
//   boundary.paths     non-empty array of repo-relative paths/globs — the
//                      only paths the assigned worker may change
//   worker.profileId   non-empty string — the assigned worker profile
//   worker.label       optional display label
//   limits             {maxAttempts int 1..10 =2, maxFixCycles int 0..10 =3}
//
// No other keys are accepted anywhere in the document, and no key whose name
// looks credential-shaped (SECRET_KEY_RE) is ever stored — materials reach
// workers through the environment, never through the graph.

import { SAFE_ID_RE } from '../common.mjs';
import { invalid } from './errors.mjs';

export const BOUNDARY_PATH_RE = /^[A-Za-z0-9*][A-Za-z0-9._/*-]{0,300}$/;
export const SECRET_KEY_RE =
  /secret|passwor?d|passwd|token|credential|api[_-]?key|private[_-]?key|access[_-]?key|session[_-]?key|auth[_-]?header|authorization|bearer/i;
export const DEFAULT_LIMITS = Object.freeze({ maxAttempts: 2, maxFixCycles: 3 });
export const MAX_SUBTASKS = 200;

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function reqStr(v, what, max) {
  if (typeof v !== 'string' || !v.trim()) {
    throw invalid('invalid_argument', `${what} must be a non-empty string`);
  }
  const s = v.trim();
  if (s.length > max) {
    throw invalid('invalid_argument', `${what} must be at most ${max} chars`);
  }
  return s;
}

export function assertOnlyKeys(obj, allowed, what) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw invalid('unexpected_field', `${what}: unexpected field "${k}"`, { field: k });
    }
  }
}

// Recursive key scan — runs BEFORE structural validation so a smuggled
// credential-shaped key is always reported as secrets_forbidden, never
// laundered into a generic shape error.
export function assertNoSecrets(v, path = 'payload') {
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertNoSecrets(x, `${path}[${i}]`));
    return;
  }
  if (!isObj(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (SECRET_KEY_RE.test(k)) {
      throw invalid('secrets_forbidden',
        `${path}.${k}: credential-shaped keys are never stored — secrets travel through the environment, not the graph`);
    }
    assertNoSecrets(x, `${path}.${k}`);
  }
}

// Bounded plain-JSON pass-through for blocks whose semantic validation is a
// downstream concern (e.g. composition/limits snapshots): plain data only,
// bounded depth/width — the graph stores nothing it cannot serialize
// deterministically.
export function boundedJson(v, path, depth = 0) {
  if (depth > 6) throw invalid('invalid_shape', `${path}: nesting deeper than 6`);
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v.length > 2000) throw invalid('invalid_shape', `${path}: string longer than 2000`);
    return v;
  }
  if (Array.isArray(v)) {
    if (v.length > 128) throw invalid('invalid_shape', `${path}: array longer than 128`);
    return v.map((x, i) => boundedJson(x, `${path}[${i}]`, depth + 1));
  }
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (keys.length > 64) throw invalid('invalid_shape', `${path}: more than 64 keys`);
    const out = {};
    for (const k of keys) {
      if (k.length > 80) throw invalid('invalid_shape', `${path}: oversized key`);
      out[k] = boundedJson(v[k], `${path}.${k}`, depth + 1);
    }
    return out;
  }
  throw invalid('invalid_shape', `${path}: only plain JSON values are accepted`);
}

const SUBTASK_KEYS = new Set([
  'id', 'title', 'outcome', 'acceptanceCriteria', 'dependsOn', 'boundary', 'worker', 'limits',
]);
const BOUNDARY_KEYS = new Set(['paths']);
const WORKER_KEYS = new Set(['profileId', 'label']);
const LIMIT_KEYS = new Set(['maxAttempts', 'maxFixCycles']);

function intIn(v, lo, hi, what) {
  if (!Number.isInteger(v) || v < lo || v > hi) {
    throw invalid('invalid_argument', `${what} must be an integer in [${lo},${hi}]`);
  }
  return v;
}

function validateBoundary(raw, what) {
  if (!isObj(raw)) {
    throw invalid('boundary_missing', `${what}.boundary {paths:[...]} is required`);
  }
  assertOnlyKeys(raw, BOUNDARY_KEYS, `${what}.boundary`);
  if (!Array.isArray(raw.paths) || !raw.paths.length) {
    throw invalid('boundary_missing', `${what}.boundary.paths must be a non-empty array`);
  }
  const paths = raw.paths.map((p, i) => {
    if (typeof p !== 'string' || !BOUNDARY_PATH_RE.test(p)
      || p.includes('..') || p.startsWith('/') || p.includes('//')) {
      throw invalid('boundary_invalid',
        `${what}.boundary.paths[${i}]: unsafe repository path ${JSON.stringify(p)}`);
    }
    return p;
  });
  return { paths: [...new Set(paths)] };
}

function validateWorker(raw, what) {
  if (!isObj(raw)) {
    throw invalid('worker_missing', `${what}.worker {profileId} is required`);
  }
  assertOnlyKeys(raw, WORKER_KEYS, `${what}.worker`);
  const out = { profileId: reqStr(raw.profileId, `${what}.worker.profileId`, 160) };
  if (raw.label !== undefined) out.label = reqStr(raw.label, `${what}.worker.label`, 160);
  return out;
}

function validateLimits(raw, what) {
  if (raw === undefined) return { ...DEFAULT_LIMITS };
  if (!isObj(raw)) throw invalid('invalid_argument', `${what}.limits must be an object`);
  assertOnlyKeys(raw, LIMIT_KEYS, `${what}.limits`);
  return {
    maxAttempts: raw.maxAttempts === undefined
      ? DEFAULT_LIMITS.maxAttempts
      : intIn(raw.maxAttempts, 1, 10, `${what}.limits.maxAttempts`),
    maxFixCycles: raw.maxFixCycles === undefined
      ? DEFAULT_LIMITS.maxFixCycles
      : intIn(raw.maxFixCycles, 0, 10, `${what}.limits.maxFixCycles`),
  };
}

export function validateSubtask(raw, index = 0) {
  const what = `subtasks[${index}]`;
  if (!isObj(raw)) throw invalid('subtask_invalid', `${what} must be an object`);
  assertOnlyKeys(raw, SUBTASK_KEYS, what);
  if (typeof raw.id !== 'string' || !SAFE_ID_RE.test(raw.id)) {
    throw invalid('subtask_invalid', `${what}.id must match ${SAFE_ID_RE}`);
  }
  const id = raw.id;
  const title = reqStr(raw.title, `${what}.title`, 300);
  const outcome = reqStr(raw.outcome, `${what}.outcome`, 2000);
  if (!Array.isArray(raw.acceptanceCriteria) || !raw.acceptanceCriteria.length) {
    throw invalid('criteria_missing', `${what}.acceptanceCriteria must be a non-empty array`);
  }
  const acceptanceCriteria = raw.acceptanceCriteria.map(
    (c, i) => reqStr(c, `${what}.acceptanceCriteria[${i}]`, 500));
  let dependsOn = [];
  if (raw.dependsOn !== undefined) {
    if (!Array.isArray(raw.dependsOn)) {
      throw invalid('subtask_invalid', `${what}.dependsOn must be an array`);
    }
    for (const d of raw.dependsOn) {
      if (typeof d !== 'string' || !SAFE_ID_RE.test(d)) {
        throw invalid('dependency_unknown', `${what}.dependsOn entries must be subtask ids`);
      }
    }
    dependsOn = [...new Set(raw.dependsOn)];
  }
  if (dependsOn.includes(id)) {
    throw invalid('dependency_self', `${what} depends on itself`, { taskId: id });
  }
  return {
    id, title, outcome, acceptanceCriteria, dependsOn,
    boundary: validateBoundary(raw.boundary, what),
    worker: validateWorker(raw.worker, what),
    limits: validateLimits(raw.limits, what),
  };
}

// Deterministic topological order: Kahn's algorithm, ties broken by
// declaration order — the same document always yields the same order.
export function topoOrder(tasks) {
  const indeg = new Map(tasks.map((t) => [t.id, t.dependsOn.length]));
  const dependents = new Map(tasks.map((t) => [t.id, []]));
  for (const t of tasks) {
    for (const d of t.dependsOn) dependents.get(d).push(t.id);
  }
  const queue = tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.id);
  const out = [];
  while (queue.length) {
    const id = queue.shift();
    out.push(id);
    for (const dep of dependents.get(id)) {
      indeg.set(dep, indeg.get(dep) - 1);
      if (indeg.get(dep) === 0) queue.push(dep);
    }
  }
  if (out.length !== tasks.length) {
    const cycle = tasks.filter((t) => indeg.get(t.id) > 0).map((t) => t.id).sort();
    throw invalid('graph_cycle', `dependency cycle among: ${cycle.join(', ')}`, { cycle });
  }
  return out;
}

export function validateSubtaskSet(raw) {
  if (!Array.isArray(raw)) {
    throw invalid('subtasks_invalid', 'decomposition.subtasks must be an array');
  }
  if (!raw.length) {
    throw invalid('subtasks_empty', 'decomposition.subtasks must not be empty');
  }
  if (raw.length > MAX_SUBTASKS) {
    throw invalid('subtasks_invalid', `decomposition.subtasks exceeds ${MAX_SUBTASKS}`);
  }
  const tasks = raw.map((t, i) => validateSubtask(t, i));
  const seen = new Set();
  for (const t of tasks) {
    if (seen.has(t.id)) {
      throw invalid('subtask_duplicate', `duplicate subtask id "${t.id}"`, { taskId: t.id });
    }
    seen.add(t.id);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!seen.has(d)) {
        throw invalid('dependency_unknown',
          `${t.id} depends on unknown subtask "${d}"`, { taskId: t.id, dependency: d });
      }
    }
  }
  return { tasks, order: topoOrder(tasks) };
}
