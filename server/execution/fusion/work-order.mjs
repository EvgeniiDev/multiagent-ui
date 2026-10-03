// server/execution/fusion/work-order.mjs — F3 judge + integrator contracts.
//
// The judge's final text is a STRUCTURED work order, not a comparison. A
// response that only compares/summarizes panel answers is REJECTED: the
// contract requires the analysis sections (matches, contradictions, gaps,
// unique ideas, blind spots) AND the order sections (goal, boundaries,
// steps, affected parts, criteria with verification methods, verdict).
//
// Section headers are markdown level-2 headings carrying the canonical
// names (case-insensitive):
//   ## Matches          ## Goal
//   ## Contradictions   ## Boundaries
//   ## Gaps             ## Steps
//   ## Unique ideas     ## Affected parts
//   ## Blind spots      ## Criteria
//                       ## Verdict
//
// The verdict binds the routing decision: 'in_plan' (within the approved
// requirements+plan — auto-routes to the integrator), 'scope_change'
// (outside them — explicit user approval required), 'uncertain' (cannot
// tell — wait for the user, never guess).

export const REQUIRED_WO_SECTIONS = [
  'matches', 'contradictions', 'gaps', 'uniqueIdeas', 'blindSpots',
  'goal', 'boundaries', 'steps', 'affectedParts', 'criteria', 'verdict',
];

export const WO_SECTION_TITLES = {
  matches: 'Matches',
  contradictions: 'Contradictions',
  gaps: 'Gaps',
  uniqueIdeas: 'Unique ideas',
  blindSpots: 'Blind spots',
  goal: 'Goal',
  boundaries: 'Boundaries',
  steps: 'Steps',
  affectedParts: 'Affected parts',
  criteria: 'Criteria',
  verdict: 'Verdict',
};

export const WO_MAX_BYTES = 256 * 1024;
const SECTION_MAX_CHARS = 8000;
const SECTION_MIN_CHARS = 2;

export const WO_VERDICTS = new Set(['in_plan', 'scope_change', 'uncertain']);

const HEADING_KEYS = new Map([
  ['matches', 'matches'],
  ['contradictions', 'contradictions'],
  ['gaps', 'gaps'],
  ['uniqueideas', 'uniqueIdeas'],
  ['blindspots', 'blindSpots'],
  ['goal', 'goal'],
  ['boundaries', 'boundaries'],
  ['steps', 'steps'],
  ['affectedparts', 'affectedParts'],
  ['criteria', 'criteria'],
  ['verdict', 'verdict'],
]);
const SECTION_RE = /^##\s+(.+?)\s*$/;
const normHeading = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
const listItems = (body) =>
  body.split('\n').map((l) => l.trim()).filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, '').trim()).filter(Boolean);

function splitSections(text) {
  const sections = {};
  const found = [];
  const duplicate = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const h = SECTION_RE.exec(line.trim());
    if (h) {
      const key = HEADING_KEYS.get(normHeading(h[1]));
      if (key !== undefined) {
        if (sections[key] !== undefined) duplicate.push(key);
        cur = key;
        sections[key] ??= '';
        if (!found.includes(key)) found.push(key);
      } else {
        cur = null;
      }
      continue;
    }
    if (cur !== null) sections[cur] += line + '\n';
  }
  return { sections, found, duplicate };
}

// Parse a judge's final text into the work-order record.
//   { ok: true, sections, verdict, steps, affectedParts, criteria }
//   { ok: false, reason, missing, empty, duplicate, problems }
export function parseWorkOrder(text) {
  if (typeof text !== 'string' || !text.length) {
    return { ok: false, reason: 'work_order_empty', missing: [...REQUIRED_WO_SECTIONS] };
  }
  if (Buffer.byteLength(text, 'utf8') > WO_MAX_BYTES) {
    return { ok: false, reason: 'work_order_too_large', missing: [...REQUIRED_WO_SECTIONS] };
  }
  const { sections, found, duplicate } = splitSections(text);
  const missing = [];
  const empty = [];
  const out = {};
  for (const key of REQUIRED_WO_SECTIONS) {
    if (sections[key] === undefined) { missing.push(key); continue; }
    const body = sections[key].trim();
    if (body.length < SECTION_MIN_CHARS) { empty.push(key); continue; }
    out[key] = body.slice(0, SECTION_MAX_CHARS);
  }
  const problems = [];
  let verdict = null;
  if (out.verdict) {
    verdict = out.verdict.trim().toLowerCase();
    if (!WO_VERDICTS.has(verdict)) {
      problems.push(`verdict must be exactly one of ${[...WO_VERDICTS].join('|')} — got ${JSON.stringify(out.verdict.trim().slice(0, 80))}`);
      verdict = null;
    }
  }
  let steps = null;
  if (out.steps) {
    steps = listItems(out.steps);
    if (!steps.length) problems.push('steps must contain at least one list item (- ...)');
  }
  let affectedParts = null;
  if (out.affectedParts) {
    affectedParts = listItems(out.affectedParts);
    if (!affectedParts.length) problems.push('affectedParts must contain at least one list item (- ...)');
  }
  let criteria = null;
  if (out.criteria) {
    criteria = listItems(out.criteria);
    if (!criteria.length) {
      problems.push('criteria must contain at least one list item (- ...)');
    } else {
      const noVerify = criteria.filter((c) => !/verify/i.test(c));
      if (noVerify.length) {
        problems.push(`every criteria item must name its verification method ('verify') — ${noVerify.length} item(s) do not`);
      }
    }
  }
  if (missing.length || empty.length || duplicate.length || problems.length) {
    return {
      ok: false, reason: 'work_order_incomplete',
      missing, empty, duplicate, found, problems,
    };
  }
  return { ok: true, sections: out, verdict, steps, affectedParts, criteria };
}

// Domain-side check of the work-order descriptor handed to
// resolve_attempt — same contract as validateRecordedAnswer: the recorded
// shape is re-validated AND hard-bound to a committed artifact.
export function validateRecordedWorkOrder(wo) {
  if (wo === null || typeof wo !== 'object' || Array.isArray(wo)) {
    return { ok: false, code: 'work_order_invalid', problems: ['workOrder must be an object'] };
  }
  const problems = [];
  if (typeof wo.artifactId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(wo.artifactId)) {
    problems.push('workOrder.artifactId must be a safe id');
  }
  if (typeof wo.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(wo.sha256)) {
    problems.push('workOrder.sha256 must be a sha256 hex');
  }
  if (!Number.isInteger(wo.bytes) || wo.bytes < 0) {
    problems.push('workOrder.bytes must be an integer >= 0');
  }
  if (typeof wo.verdict !== 'string' || !WO_VERDICTS.has(wo.verdict)) {
    problems.push(`workOrder.verdict must be one of ${[...WO_VERDICTS].join('|')}`);
  }
  const sections = wo.sections;
  if (sections === null || typeof sections !== 'object' || Array.isArray(sections)) {
    problems.push('workOrder.sections must be an object');
  } else {
    for (const key of REQUIRED_WO_SECTIONS) {
      const v = sections[key];
      if (typeof v !== 'string' || v.trim().length < SECTION_MIN_CHARS) {
        problems.push(`workOrder.sections.${key} missing or empty`);
      } else if (v.length > SECTION_MAX_CHARS) {
        problems.push(`workOrder.sections.${key} exceeds ${SECTION_MAX_CHARS} chars`);
      }
    }
  }
  return problems.length
    ? { ok: false, code: 'work_order_invalid', problems }
    : { ok: true };
}

// The contract text embedded in every judge prompt (the 'rubric' input).
export function workOrderContractText() {
  return [
    'Your reply IS the work order. Write exactly one Markdown document',
    'containing ALL of the following sections, in this order, each as a',
    'level-2 heading with a non-empty body:',
    '',
    ...REQUIRED_WO_SECTIONS.map((k) => `## ${WO_SECTION_TITLES[k]}`),
    '',
    'The first five sections record your analysis of the accepted panel',
    'answers: where they agree (## Matches), where they conflict',
    '(## Contradictions), what none of them covers (## Gaps), ideas only',
    'one answer raised (## Unique ideas), and risks all answers missed',
    '(## Blind spots — include what your own inspection of the project',
    'revealed). A response that merely compares or summarizes the answers',
    'is REJECTED: the order sections below are mandatory.',
    '',
    '## Steps and ## Affected parts must each contain at least one',
    'Markdown list item (- ...). Every ## Criteria list item must name',
    'its verification method (the word "verify" must appear — e.g.',
    '"the build passes — verify: npm run build").',
    '',
    '## Verdict must be exactly one line: in_plan | scope_change |',
    'uncertain. Use in_plan only when the order stays inside the approved',
    'requirements and plan; scope_change when it exceeds them (an explicit',
    'user approval is then required); uncertain when you cannot tell — the',
    'system waits for the user instead of guessing.',
    '',
    'A response missing any section — even a completed run with exit',
    'code 0 — is NOT a work order and counts as a failed attempt. You',
    'read the project; you never write to it.',
  ].join('\n');
}

// ---- integrator report -----------------------------------------------------

export const REQUIRED_REPORT_SECTIONS = ['changes', 'mismatches', 'behaviorChange'];

export const REPORT_SECTION_TITLES = {
  changes: 'Changes',
  mismatches: 'Mismatches',
  behaviorChange: 'Behavior change',
};

export const REPORT_MAX_BYTES = 256 * 1024;

const REPORT_HEADING_KEYS = new Map([
  ['changes', 'changes'],
  ['mismatches', 'mismatches'],
  ['behaviorchange', 'behaviorChange'],
]);

// Parse an integrator's final text.
//   { ok: true, sections, mismatches: [...], behaviorChange: bool }
export function parseIntegratorReport(text) {
  if (typeof text !== 'string' || !text.length) {
    return { ok: false, reason: 'report_empty', missing: [...REQUIRED_REPORT_SECTIONS] };
  }
  if (Buffer.byteLength(text, 'utf8') > REPORT_MAX_BYTES) {
    return { ok: false, reason: 'report_too_large', missing: [...REQUIRED_REPORT_SECTIONS] };
  }
  const sections = {};
  const found = [];
  const duplicate = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const h = SECTION_RE.exec(line.trim());
    if (h) {
      const key = REPORT_HEADING_KEYS.get(normHeading(h[1]));
      if (key !== undefined) {
        if (sections[key] !== undefined) duplicate.push(key);
        cur = key;
        sections[key] ??= '';
        if (!found.includes(key)) found.push(key);
      } else {
        cur = null;
      }
      continue;
    }
    if (cur !== null) sections[cur] += line + '\n';
  }
  const missing = [];
  const empty = [];
  const out = {};
  for (const key of REQUIRED_REPORT_SECTIONS) {
    if (sections[key] === undefined) { missing.push(key); continue; }
    const body = sections[key].trim();
    if (body.length < SECTION_MIN_CHARS) { empty.push(key); continue; }
    out[key] = body.slice(0, SECTION_MAX_CHARS);
  }
  const problems = [];
  let mismatches = null;
  if (out.mismatches) {
    const items = listItems(out.mismatches);
    const none = items.length === 0
      || (items.length === 1 && /^\(?none\)?\.?$/i.test(items[0]));
    mismatches = none ? [] : items;
  }
  let behaviorChange = null;
  if (out.behaviorChange) {
    const first = out.behaviorChange.trim()
      .replace(/^[-*]\s+/, '')
      .split(/\s+/)[0]?.toLowerCase();
    if (first === 'yes') behaviorChange = true;
    else if (first === 'no') behaviorChange = false;
    else problems.push('behaviorChange must start with yes or no');
  }
  if (missing.length || empty.length || duplicate.length || problems.length) {
    return {
      ok: false, reason: 'report_incomplete',
      missing, empty, duplicate, found, problems,
    };
  }
  return { ok: true, sections: out, mismatches, behaviorChange };
}

export function validateRecordedReport(rep) {
  if (rep === null || typeof rep !== 'object' || Array.isArray(rep)) {
    return { ok: false, code: 'report_invalid', problems: ['report must be an object'] };
  }
  const problems = [];
  if (typeof rep.artifactId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(rep.artifactId)) {
    problems.push('report.artifactId must be a safe id');
  }
  if (typeof rep.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(rep.sha256)) {
    problems.push('report.sha256 must be a sha256 hex');
  }
  if (!Number.isInteger(rep.bytes) || rep.bytes < 0) {
    problems.push('report.bytes must be an integer >= 0');
  }
  if (typeof rep.behaviorChange !== 'boolean') {
    problems.push('report.behaviorChange must be a boolean');
  }
  return problems.length
    ? { ok: false, code: 'report_invalid', problems }
    : { ok: true };
}

export function integratorReportContractText() {
  return [
    'Your reply IS the integrator report. Write exactly one Markdown',
    'document with ALL of the following sections, in this order, each a',
    'level-2 heading with a non-empty body:',
    '',
    '## Changes',
    'What you changed in the private repository to implement the work',
    'order.',
    '',
    '## Mismatches',
    'Every mismatch between the work order and the actual code you found',
    'and fixed within the already-accepted behavior — one list item each.',
    'Write "(none)" when there were none.',
    '',
    '## Behavior change',
    'The first word must be yes or no. "yes" means the result changes',
    'behavior beyond the work order / approved plan and requires user',
    'approval; explain it after the first word.',
    '',
    'A response missing any section — even a completed run with exit',
    'code 0 — is NOT a report and counts as a failed attempt.',
  ].join('\n');
}
