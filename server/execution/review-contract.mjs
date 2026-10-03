// server/execution/review-contract.mjs — the U5 managed review/checker gate.
//
// This is the EXACT semantic contract scripts/boardctl implements for the
// legacy path, mirrored for the managed pipeline so both flows agree on
// what blocks a result:
//
//   severities: critical|major|minor|nit   (reviewtest-role `review`
//   vocabulary — snapshotted at run start, not read per evaluation)
//   blocking:   critical|major             (open + unresolved → gate)
//   backlog:    minor|nit                  (reported, never gate)
//   verdicts:   confirmed|rejected|disputed, latest-per-finding wins
//   maxRounds:  preset.limits.maxReviewRounds (default 3 — same default
//   boardctl's DEFAULT_REVIEW_RULES carries)
//
// Gate rules (identical to _open_counts/_blocking_text/_gate_agent_tested):
//   * an OPEN blocking-severity finding gates unless the LATEST verdict for
//     that finding is exactly 'rejected' — rejected findings stay in
//     history but stop gating;
//   * 'confirmed' and 'disputed' keep gating; a finding with NO verdict is
//     unvetted and gates;
//   * minor/nit stay visible in the report but never gate;
//   * a finding with status != 'open' (closed) never gates.
//
// Differences from the file path, deliberately: managed findings/verdicts
// are domain records bound to {round, attemptId, artifact sha256,
// resultSha256} — an external participant can never write them, and a
// stale verdict file can never clear a gate. The gate fails CLOSED when
// evidence is missing: parse errors, absent docs, wrong rounds and stale
// result hashes are all hard rejections upstream of evaluation — nothing
// degenerates to an empty evidence set that passes.

export const REVIEW_SEVERITIES = ['critical', 'major', 'minor', 'nit'];
export const REVIEW_BLOCKING = ['critical', 'major'];
export const REVIEW_BACKLOG = ['minor', 'nit'];
export const REVIEW_VERDICTS = ['confirmed', 'rejected', 'disputed'];
export const REVIEW_REASON_PREFIX = 'review:';
export const DEFAULT_MAX_ROUNDS = 3;

export class ReviewDocError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ReviewDocError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// Snapshot the review rules for a run — mirrors boardctl _review_meta:
// the reviewtest stage-role's `review` data overrides the default
// severities/blocking/backlog; maxRounds comes from the managed preset's
// own limit (default 3 = boardctl's DEFAULT_REVIEW_RULES). Bound once at
// run start so mid-run role edits can never re-scope a live gate.
export function snapshotReviewRules(rolesDoc, presetLimits) {
  const raw = (() => {
    const rid = rolesDoc?.stageRoles?.reviewtest;
    const role = (rolesDoc?.roles || []).find((r) => r && r.id === rid);
    return (role && typeof role === 'object' ? role.review : null) || {};
  })();
  const list = (v, def) => (Array.isArray(v) && v.length ? v.map(String) : def);
  const lim = presetLimits && typeof presetLimits === 'object' ? presetLimits : {};
  const maxRounds = Number.isInteger(lim.maxReviewRounds) && lim.maxReviewRounds >= 1
    ? lim.maxReviewRounds
    : (Number.isInteger(raw.maxRounds) && raw.maxRounds >= 1
      ? raw.maxRounds : DEFAULT_MAX_ROUNDS);
  return {
    severities: list(raw.severities, [...REVIEW_SEVERITIES]),
    blocking: list(raw.blocking, [...REVIEW_BLOCKING]),
    backlog: list(raw.backlog, [...REVIEW_BACKLOG]),
    maxRounds,
  };
}

const SEV_SET_DEFAULT = new Set(REVIEW_SEVERITIES);
const VERDICT_SET = new Set(REVIEW_VERDICTS);

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Strict parse of the reviewer findings document — managed contract is the
// legacy file shape {version:1, round, findings:[...]}, and `round`/`result`
// binding is REQUIRED at this seam: the caller always supplies the current
// round and the accepted resultSha256; a doc missing/stale on either fails.
// Findings carry bounded text in the run record — the artifact stores the
// full doc verbatim; `truncated` flags mark every clamped field so a cut is
// never silent.
export function parseFindingsDoc(doc, { round, resultSha256 } = {}) {
  if (!Number.isInteger(round) || round < 1) {
    throw new ReviewDocError('findings_unbound',
      'findings parse requires the current round — unbound docs are never accepted');
  }
  if (!isObj(doc) || doc.version !== 1 || !Array.isArray(doc.findings)) {
    throw new ReviewDocError('findings_invalid',
      'findings doc must be {version:1, round, findings:[…]}');
  }
  if (doc.round !== round) {
    throw new ReviewDocError('findings_stale',
      `findings doc round ${JSON.stringify(doc.round)} does not match round ${round}`);
  }
  if (doc.resultSha256 !== undefined && resultSha256 !== undefined
    && doc.resultSha256 !== resultSha256) {
    throw new ReviewDocError('findings_stale',
      `findings doc resultSha256 ${JSON.stringify(doc.resultSha256)} != ${resultSha256}`);
  }
  const seen = new Set();
  const findings = doc.findings.map((f, i) => {
    const at = `findings[${i}]`;
    if (!isObj(f) || typeof f.id !== 'string' || !f.id) {
      throw new ReviewDocError('findings_invalid', `${at}: missing string id`);
    }
    if (seen.has(f.id)) {
      throw new ReviewDocError('findings_invalid', `${at}: duplicate id ${f.id}`);
    }
    seen.add(f.id);
    const sev = String(f.severity ?? '');
    if (!SEV_SET_DEFAULT.has(sev)) {
      throw new ReviewDocError('findings_invalid',
        `${at}: severity ${JSON.stringify(f.severity)} outside ${REVIEW_SEVERITIES.join('|')}`);
    }
    const status = f.status === undefined ? 'open' : String(f.status);
    if (status !== 'open' && status !== 'closed') {
      throw new ReviewDocError('findings_invalid',
        `${at}: status must be open|closed, got ${JSON.stringify(f.status)}`);
    }
    const fround = f.round === undefined || f.round === null ? doc.round : f.round;
    if (fround !== round) {
      throw new ReviewDocError('findings_stale',
        `${at}: finding round ${fround} does not match round ${round}`);
    }
    const text = typeof f.text === 'string' ? f.text : '';
    const where = typeof f.where === 'string' ? f.where : '';
    return {
      id: f.id,
      round,
      severity: sev,
      text: text.slice(0, 8000),
      where: where.slice(0, 2000),
      ...(text.length > 8000 || where.length > 2000 ? { truncated: true } : {}),
      status,
      ...(status === 'closed' && f.closedInRound !== undefined
        ? { closedInRound: f.closedInRound } : {}),
    };
  });
  return { version: 1, round, findings };
}

// Strict parse of the checker verdict document {version:1, round?,
// verdicts:[…]}. A top-level doc.round that disagrees with the current
// round is stale — rejected. Each verdict must reference a finding id
// present in THIS round's findings; every verdict's own round (absent →
// doc.round → current) must equal the current round. Doc resultSha256, when
// carried, must match the accepted snapshot hash.
export function parseVerdictDoc(doc, { round, resultSha256, findingIds } = {}) {
  if (!Number.isInteger(round) || round < 1) {
    throw new ReviewDocError('verdicts_unbound',
      'verdict parse requires the current round — unbound docs are never accepted');
  }
  if (!isObj(doc) || doc.version !== 1 || !Array.isArray(doc.verdicts)) {
    throw new ReviewDocError('verdicts_invalid',
      'verdicts doc must be {version:1, verdicts:[…]}');
  }
  if (doc.round !== undefined && doc.round !== round) {
    throw new ReviewDocError('verdicts_stale',
      `verdicts doc round ${JSON.stringify(doc.round)} does not match round ${round}`);
  }
  if (doc.resultSha256 !== undefined && resultSha256 !== undefined
    && doc.resultSha256 !== resultSha256) {
    throw new ReviewDocError('verdicts_stale',
      `verdicts doc resultSha256 ${JSON.stringify(doc.resultSha256)} != ${resultSha256}`);
  }
  const ids = findingIds instanceof Set ? findingIds : null;
  const verdicts = doc.verdicts.map((v, i) => {
    const at = `verdicts[${i}]`;
    if (!isObj(v) || typeof v.findingId !== 'string' || !v.findingId) {
      throw new ReviewDocError('verdicts_invalid', `${at}: missing string findingId`);
    }
    if (ids && !ids.has(v.findingId)) {
      throw new ReviewDocError('verdicts_invalid',
        `${at}: verdict for unknown finding ${JSON.stringify(v.findingId)}`);
    }
    const verdict = String(v.verdict ?? '');
    if (!VERDICT_SET.has(verdict)) {
      throw new ReviewDocError('verdicts_invalid',
        `${at}: verdict ${JSON.stringify(v.verdict)} outside ${REVIEW_VERDICTS.join('|')}`);
    }
    const vround = v.round === undefined || v.round === null
      ? (doc.round ?? round) : v.round;
    if (vround !== round) {
      throw new ReviewDocError('verdicts_stale',
        `${at}: verdict round ${vround} does not match round ${round}`);
    }
    const reason = typeof v.reason === 'string' ? v.reason
      : (typeof v.rationale === 'string' ? v.rationale : '');
    return {
      findingId: v.findingId,
      round,
      verdict,
      reason: reason.slice(0, 4000),
      ...(reason.length > 4000 ? { truncated: true } : {}),
    };
  });
  return { version: 1, round, verdicts };
}

// Latest verdict per finding — the last entry wins (boardctl _verdict_map).
export function verdictMap(verdicts) {
  const map = new Map();
  for (const v of verdicts || []) {
    if (v && typeof v.findingId === 'string') map.set(v.findingId, v);
  }
  return map;
}

// The strict managed gate. ALL inputs are already-verified records — never
// raw files: `checksVerdict` must be exactly 'pass' or 'fail'; when checks
// pass, `findings` and `verdicts` must be present parsed docs (an EMPTY
// findings list is valid — it is a verified "no findings" report; a MISSING
// doc is a hard error, never an implied empty set). `rules` is the
// run-snapshotted rule set.
export function evaluateReviewGate({ round: roundNo, checksVerdict,
  findings, verdicts, rules }) {
  if (!Number.isInteger(roundNo) || roundNo < 1) {
    throw new ReviewDocError('gate_unbound', 'gate requires the current round number');
  }
  const r = rules && typeof rules === 'object' ? rules : snapshotReviewRules(null, null);
  const blockingSev = Array.isArray(r.blocking) && r.blocking.length ? r.blocking : REVIEW_BLOCKING;
  const backlogSev = Array.isArray(r.backlog) && r.backlog.length ? r.backlog : REVIEW_BACKLOG;
  const maxRounds = Number.isInteger(r.maxRounds) && r.maxRounds >= 1 ? r.maxRounds : DEFAULT_MAX_ROUNDS;

  if (checksVerdict !== 'pass' && checksVerdict !== 'fail') {
    throw new ReviewDocError('gate_evidence_missing',
      `checksVerdict must be exactly 'pass'|'fail' — got ${JSON.stringify(checksVerdict)}`);
  }
  if (checksVerdict === 'fail') {
    return {
      decision: roundNo >= maxRounds ? 'blocked' : 'fix',
      blocking: [], nonBlocking: [], unvetted: [],
      reason: 'approved checks failed',
      checksVerdict, maxRounds,
    };
  }
  if (!isObj(findings) || !Array.isArray(findings.findings)) {
    throw new ReviewDocError('gate_evidence_missing',
      'verified findings doc required for a passed-checks round — missing evidence never gates open');
  }
  if (!isObj(verdicts) || !Array.isArray(verdicts.verdicts)) {
    throw new ReviewDocError('gate_evidence_missing',
      'verified verdicts doc required for a passed-checks round — missing evidence never gates open');
  }

  const vm = verdictMap(verdicts.verdicts);
  const open = findings.findings.filter((f) => (f.status ?? 'open') === 'open');
  const blocking = [];
  const nonBlocking = [];
  for (const f of open) {
    const rejected = vm.get(f.id)?.verdict === 'rejected';
    if (blockingSev.includes(f.severity)) {
      if (!rejected) blocking.push(f.id);
    } else if (backlogSev.includes(f.severity)) {
      nonBlocking.push({ id: f.id, severity: f.severity, rejected });
    }
  }
  const unvetted = blocking.filter((id) => !vm.has(id));
  let decision;
  let reason = null;
  if (!blocking.length) {
    decision = 'awaiting_acceptance';
  } else if (roundNo >= maxRounds) {
    decision = 'blocked';
    reason = `${REVIEW_REASON_PREFIX} round limit ${maxRounds} reached with open findings`;
  } else {
    decision = 'fix';
    reason = `open findings: ${blocking.join(', ')}`;
  }
  return { decision, blocking, nonBlocking, unvetted, reason, checksVerdict, maxRounds };
}
