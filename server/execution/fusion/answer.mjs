// server/execution/fusion/answer.mjs — the panel answer contract (KTD5).
//
// A panelist's final text is a STRUCTURED answer, not a blob: every
// mandatory section must be present and non-empty. A supervisor exit code
// of 0 without a complete answer is NOT a result — the attempt resolves
// 'failed' and the participant consumes an attempt.
//
// Section headers are markdown headings carrying the canonical names
// (case-insensitive, #-depth free):
//   ## Proposal
//   ## Rationale
//   ## Affected files
//   ## Downsides
//   ## Excluded actions

export const REQUIRED_ANSWER_SECTIONS = [
  'proposal', 'rationale', 'affectedFiles', 'downsides', 'excludedActions',
];

export const ANSWER_SECTION_TITLES = {
  proposal: 'Proposal',
  rationale: 'Rationale',
  affectedFiles: 'Affected files',
  downsides: 'Downsides',
  excludedActions: 'Excluded actions',
};

export const ANSWER_MAX_BYTES = 256 * 1024;
const SECTION_MAX_CHARS = 8000;
const SECTION_MIN_CHARS = 2;

// Normalized heading text -> canonical key. Strict canonical names only —
// the contract is deliberately narrow so a "helpful" paraphrase can never
// count as a section.
const HEADING_KEYS = new Map([
  ['proposal', 'proposal'],
  ['rationale', 'rationale'],
  ['affectedfiles', 'affectedFiles'],
  ['downsides', 'downsides'],
  ['excludedactions', 'excludedActions'],
]);
// Contract sections are delimited by LEVEL-2 headings exactly — `###`+
// subheadings and `#` titles stay part of the surrounding body. A `##`
// heading that is not a contract name closes the current section (its
// body never joins the answer).
const SECTION_RE = /^##\s+(.+?)\s*$/;

const normHeading = (s) => s.toLowerCase().replace(/[^a-z]/g, '');

// Parse a panelist's final text into the section map.
//   { ok: true, sections } — every mandatory key present and non-empty
//   { ok: false, missing, empty, duplicate, found, reason }
export function parsePanelAnswer(text) {
  if (typeof text !== 'string' || !text.length) {
    return { ok: false, reason: 'answer_empty', missing: [...REQUIRED_ANSWER_SECTIONS] };
  }
  if (Buffer.byteLength(text, 'utf8') > ANSWER_MAX_BYTES) {
    return { ok: false, reason: 'answer_too_large', missing: [...REQUIRED_ANSWER_SECTIONS] };
  }
  const lines = text.split('\n');
  const sections = {};
  const found = [];
  const duplicate = [];
  let cur = null;
  for (const line of lines) {
    const h = SECTION_RE.exec(line.trim());
    if (h) {
      const key = HEADING_KEYS.get(normHeading(h[1]));
      if (key !== undefined) {
        if (sections[key] !== undefined) duplicate.push(key);
        cur = key;
        sections[key] ??= '';
        if (!found.includes(key)) found.push(key);
      } else {
        cur = null; // non-contract ## section — content is not answer text
      }
      continue;
    }
    if (cur !== null) sections[cur] += line + '\n';
  }
  const missing = [];
  const empty = [];
  const out = {};
  for (const key of REQUIRED_ANSWER_SECTIONS) {
    if (sections[key] === undefined) { missing.push(key); continue; }
    const body = sections[key].trim();
    if (body.length < SECTION_MIN_CHARS) { empty.push(key); continue; }
    out[key] = body.slice(0, SECTION_MAX_CHARS);
  }
  if (missing.length || empty.length || duplicate.length) {
    return {
      ok: false,
      reason: 'answer_incomplete',
      missing, empty, duplicate, found,
    };
  }
  return { ok: true, sections: out };
}

// Domain-side check of the answer descriptor handed to resolve_attempt —
// the controller's parse result is never trusted; the domain re-validates
// the recorded shape AND binds it to a committed, hash-verified artifact.
// Returns {ok:true} or {ok:false, code, problems}.
export function validateRecordedAnswer(answer) {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    return { ok: false, code: 'answer_invalid', problems: ['answer must be an object'] };
  }
  const problems = [];
  if (typeof answer.artifactId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(answer.artifactId)) {
    problems.push('answer.artifactId must be a safe id');
  }
  if (typeof answer.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(answer.sha256)) {
    problems.push('answer.sha256 must be a sha256 hex');
  }
  if (!Number.isInteger(answer.bytes) || answer.bytes < 0) {
    problems.push('answer.bytes must be an integer >= 0');
  }
  const sections = answer.sections;
  if (sections === null || typeof sections !== 'object' || Array.isArray(sections)) {
    problems.push('answer.sections must be an object');
  } else {
    for (const key of REQUIRED_ANSWER_SECTIONS) {
      const v = sections[key];
      if (typeof v !== 'string' || v.trim().length < SECTION_MIN_CHARS) {
        problems.push(`answer.sections.${key} missing or empty`);
      } else if (v.length > SECTION_MAX_CHARS) {
        problems.push(`answer.sections.${key} exceeds ${SECTION_MAX_CHARS} chars`);
      }
    }
  }
  return problems.length
    ? { ok: false, code: 'answer_invalid', problems }
    : { ok: true };
}

// The contract text embedded in every panelist prompt — the SAME text for
// every participant (prompts are byte-identical across the panel).
export function answerContractText() {
  return [
    'Your reply IS the result. Write exactly one Markdown answer containing',
    'ALL of the following sections, in this order, each as a level-2 heading',
    'with a non-empty body:',
    '',
    ...REQUIRED_ANSWER_SECTIONS.map((k) => `## ${ANSWER_SECTION_TITLES[k]}`),
    '',
    'A response missing any of these sections — even a completed run with',
    'exit code 0 — is NOT accepted as an answer and counts as a failed',
    'attempt. Do not ask questions: decide on the evidence given and record',
    'assumptions under "## Downsides" or "## Excluded actions".',
  ].join('\n');
}
