// server/execution/prompt.mjs — immutable run inputs -> launch artifacts.
//
// Everything an attempt launches with is built here from the run's recorded
// inputs: approved requirements/plan version ids + content hashes (blobs are
// re-verified by the scheduler before prompting), the preset/composition
// snapshot, and the workspace/base identity. Nothing is read from mutable
// global state at launch time — the porch config below is a full per-role
// snapshot rendered from the composition, so a later edit of the installed
// porch config cannot change what a recorded attempt resolves.

import { sha256 } from './execution-store.mjs';

// Managed preset members address CLIs by short name; porch profiles address
// backends. The mapping is fixed — a composition member is only valid when
// its cli is in the domain's compat table (same key set).
export const CLI_TO_PORCH_BACKEND = {
  devin: 'devin-cli',
  codex: 'codex-cli',
  pi: 'pi-cli',
};

export const ATTEMPT_ID_RE = /^att_[A-Za-z0-9._-]{1,100}$/;

export function profileIdFor(role) {
  return `acp-${role}`;
}

// Render the porch config snapshot for a composition. One profile per member
// role; the runtime pins PORCH_CONFIG to this file for the attempt.
// Deterministic: same composition -> same bytes -> same configSha256.
export function porchConfigSnapshot(composition) {
  const members = composition?.preset?.members;
  if (!members || typeof members !== 'object') {
    throw new Error('composition has no preset.members snapshot');
  }
  const agents = {};
  for (const role of ['implementer', 'reviewer', 'checker']) {
    const m = members[role];
    if (!m || typeof m !== 'object') continue;
    const backend = CLI_TO_PORCH_BACKEND[m.cli];
    if (!backend) {
      throw new Error(`member ${role} cli ${JSON.stringify(m.cli)} has no porch backend mapping`);
    }
    const agent = { enabled: true, backend, model: m.model };
    if (m.effort !== undefined) agent.effort = m.effort;
    if (m.params && typeof m.params === 'object'
      && Object.keys(m.params).length) {
      agent.params = { ...m.params };
    }
    agents[profileIdFor(role)] = agent;
  }
  return { agents };
}

// Deterministic JSON for hashing (sorted keys, no whitespace variance).
export function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}

export function configSha256(config) {
  return sha256(stableJson(config));
}

// The implementer prompt is generated ONLY from approved, hash-verified
// inputs plus run/workspace identity. It never references mutable paths
// (no "see board.json", no "latest plan") — the documents are embedded.
export function buildImplementerPrompt({
  cardId, cardTitle, runId, attemptId, workspace, baseCommit,
  requirementsText, planText, checks, continuation = null,
}) {
  const lines = [];
  lines.push(`# Managed implementation run`);
  lines.push(``);
  lines.push(`You are the implementer of a managed card run. Work ONLY inside`);
  lines.push(`this workspace; do not touch any other checkout, branch or file.`);
  lines.push(``);
  lines.push(`## Identity`);
  lines.push(`- card: ${cardId}${cardTitle ? ` — ${cardTitle}` : ''}`);
  lines.push(`- run: ${runId}`);
  lines.push(`- attempt: ${attemptId}`);
  lines.push(`- workspace: ${workspace.path}`);
  lines.push(`- branch: ${workspace.branch} (base commit ${baseCommit})`);
  lines.push(``);
  if (continuation && typeof continuation === 'object') {
    // Continuation over a retained workspace: the agent inherits the prior
    // run's commits and dirty edits verbatim — never re-implement them.
    lines.push(`## Continuation context`);
    lines.push(``);
    lines.push(`This run continues prior run \`${continuation.fromRun}\` over the`);
    lines.push(`SAME workspace. Its files, commits, history and uncommitted`);
    lines.push(`changes are preserved exactly — do not reset, stash, or re-do`);
    lines.push(`committed work. Requirements/plan below are the NEW approved`);
    lines.push(`documents for this run.`);
    lines.push(``);
    const findings = Array.isArray(continuation.findings) ? continuation.findings : [];
    if (findings.length) {
      lines.push(`### Findings from the prior run`);
      lines.push(``);
      for (const f of findings.slice(0, 50)) {
        const sev = f && f.severity ? `[${f.severity}] ` : '';
        const txt = f && f.text ? String(f.text) : '';
        if (txt) lines.push(`- ${sev}${txt}`);
      }
      lines.push(``);
    }
    const open = Array.isArray(continuation.openFindings) ? continuation.openFindings : [];
    if (open.length) {
      lines.push(`### Open findings still to address`);
      lines.push(``);
      for (const f of open.slice(0, 50)) {
        const sev = f && f.severity ? `[${f.severity}] ` : '';
        const txt = f && f.text ? String(f.text) : '';
        if (txt) lines.push(`- ${sev}${txt}`);
      }
      lines.push(``);
    }
    const arts = Array.isArray(continuation.artifacts) ? continuation.artifacts : [];
    if (arts.length) {
      lines.push(`### Prior run artifacts`);
      lines.push(``);
      for (const a of arts.slice(0, 50)) {
        const n = a && a.file ? a.file : a;
        lines.push(`- ${n}`);
      }
      lines.push(``);
    }
    if (continuation.priorResultText) {
      // Complete, hash-verified artifact bytes — never an excerpt.
      lines.push(`### Prior run final output (verbatim, complete)`);
      lines.push(``);
      lines.push(String(continuation.priorResultText));
      lines.push(``);
    } else if (continuation.priorResultSummary) {
      lines.push(`### Prior run result summary (bounded durable summary,`);
      lines.push(`### the full output artifact is unavailable)`);
      lines.push(``);
      lines.push(String(continuation.priorResultSummary));
      lines.push(``);
    }
    if (continuation.priorResultUnavailable) {
      lines.push(`### Prior run final output UNAVAILABLE`);
      lines.push(``);
      lines.push(`${continuation.priorResultUnavailable.detail}`);
      lines.push(``);
    }
    if (continuation.note) {
      lines.push(`### Operator note`);
      lines.push(``);
      lines.push(String(continuation.note).slice(0, 4000));
      lines.push(``);
    }
  }
  lines.push(`## Approved requirements (verbatim)`);
  lines.push(``);
  lines.push(requirementsText.trimEnd());
  lines.push(``);
  lines.push(`## Approved plan (verbatim)`);
  lines.push(``);
  lines.push(planText.trimEnd());
  lines.push(``);
  if (Array.isArray(checks) && checks.length) {
    lines.push(`## Approved acceptance checks`);
    lines.push(``);
    lines.push(`The run is only acceptable if every check passes:`);
    for (const c of checks) {
      const t = c.timeoutSec ? ` (timeout ${c.timeoutSec}s)` : '';
      const cwd = c.cwd ? ` [cwd: ${c.cwd}]` : '';
      lines.push(`- \`${c.run}\`${cwd}${t}`);
    }
    lines.push(``);
  }
  lines.push(`## Rules`);
  lines.push(`- Commit your work on the branch above; do not amend or rewrite`);
  lines.push(`  the base commit or any unrelated branch.`);
  lines.push(`- Do not merge, push, or open PRs — merging is a separate user action.`);
  lines.push(`- Keep the working tree clean of unrelated edits.`);
  lines.push(`- When finished, report what changed and the check results.`);
  lines.push(``);
  return lines.join('\n');
}

// --- U5 reviewer/checker/fix prompts ------------------------------------------
// The review contract a managed reviewer/checker writes into `.acp-out/`
// inside ITS OWN pristine copy — same doc shape as the legacy boardctl
// review files so both paths produce identical evidence.

export const FINDINGS_FILE = 'review_findings.json';
export const VERDICTS_FILE = 'review_verdict.json';

export function buildReviewerPrompt({
  cardId, cardTitle, runId, attemptId, copyDir, round, resultSha256,
  requirementsText, planText,
}) {
  const lines = [];
  lines.push('# Managed review pass');
  lines.push('');
  lines.push('You are the reviewer of a managed card run. You are looking at');
  lines.push('an ISOLATED COPY of the result — your edits here never reach the');
  lines.push('canonical workspace. Review, do not implement.');
  lines.push('');
  lines.push('## Identity');
  lines.push(`- card: ${cardId}${cardTitle ? ` — ${cardTitle}` : ''}`);
  lines.push(`- run: ${runId}`);
  lines.push(`- attempt: ${attemptId}`);
  lines.push(`- review copy: ${copyDir}`);
  lines.push(`- round: ${round}`);
  lines.push(`- result: ${resultSha256}`);
  lines.push('');
  lines.push('## Approved requirements (verbatim)');
  lines.push('');
  lines.push(requirementsText.trimEnd());
  lines.push('');
  lines.push('## Approved plan (verbatim)');
  lines.push('');
  lines.push(planText.trimEnd());
  lines.push('');
  lines.push('## Your output contract');
  lines.push('');
  lines.push(`Write \`.acp-out/${FINDINGS_FILE}\` in this copy — JSON:`);
  lines.push('```');
  lines.push(JSON.stringify({
    version: 1, round, resultSha256,
    findings: [{ id: 'f1', round, severity: 'critical|major|minor|nit', text: '…', where: 'path:line', status: 'open' }],
  }, null, 2));
  lines.push('```');
  lines.push('- severities: critical|major block; minor|nit are kept as notes.');
  lines.push('- An empty findings list is a valid "no findings" verdict.');
  lines.push('- Do not modify the reviewed sources — only write the doc.');
  lines.push('');
  lines.push('## Managed evidence channel');
  lines.push('');
  lines.push(`This is a MANAGED run: \`boardctl review --close/--round/--sync\``);
  lines.push('and `boardctl review-check` are REFUSED on managed cards, and');
  lines.push('`.acp/cards/` review files are legacy-only evidence that this');
  lines.push('pipeline never reads. Your ONLY output is the `.acp-out/` doc');
  lines.push('above — the scheduler imports it from this copy, binds it to');
  lines.push('your attempt, and records it as verified evidence.');
  lines.push('');
  return lines.join('\n');
}

export function buildCheckerPrompt({
  cardId, cardTitle, runId, attemptId, copyDir, round, resultSha256,
  findingsDoc,
}) {
  const lines = [];
  lines.push('# Managed checker pass');
  lines.push('');
  lines.push('You are the checker of a managed card run. You see a SEPARATE');
  lines.push('pristine copy of the result plus the reviewer\'s findings — vet');
  lines.push('each finding against the actual code.');
  lines.push('');
  lines.push('## Identity');
  lines.push(`- card: ${cardId}${cardTitle ? ` — ${cardTitle}` : ''}`);
  lines.push(`- run: ${runId}`);
  lines.push(`- attempt: ${attemptId}`);
  lines.push(`- check copy: ${copyDir}`);
  lines.push(`- round: ${round}`);
  lines.push(`- result: ${resultSha256}`);
  lines.push('');
  lines.push('## Reviewer findings under review (verbatim, verified import)');
  lines.push('');
  lines.push(JSON.stringify(findingsDoc, null, 2));
  lines.push('');
  lines.push('## Your output contract');
  lines.push('');
  lines.push(`Write \`.acp-out/${VERDICTS_FILE}\` in this copy — JSON:`);
  lines.push('```');
  lines.push(JSON.stringify({
    version: 1, round, resultSha256,
    verdicts: [{ findingId: 'f1', verdict: 'confirmed|rejected|disputed', reason: '…' }],
  }, null, 2));
  lines.push('```');
  lines.push('- vet EVERY finding id — a finding you skip stays unvetted and');
  lines.push('  still gates the result.');
  lines.push('- rejected = the finding is wrong; confirmed/disputed = stands.');
  lines.push('');
  lines.push('## Managed evidence channel');
  lines.push('');
  lines.push('This is a MANAGED run: `boardctl review-check` is REFUSED on');
  lines.push('managed cards and `.acp/cards/` verdict files are legacy-only —');
  lines.push('this pipeline never reads them. Your ONLY output is the');
  lines.push('`.acp-out/` verdicts doc above; the scheduler imports, verifies,');
  lines.push('and records it bound to your attempt.');
  lines.push('');
  return lines.join('\n');
}

// The fix prompt is the implementer prompt PLUS the complete verified gate
// evidence — findings/verdict documents verbatim, check diagnostics, prior
// attempts and immutable artifact provenance. Nothing the domain recorded
// is dropped or silently truncated.
export function buildFixPrompt(args) {
  const base = buildImplementerPrompt({
    ...args,
    continuation: {
      ...(args.continuation || {}),
      findings: args.fixContext?.openFindings || [],
      priorAttempts: args.fixContext?.priorAttempts || args.continuation?.priorAttempts || [],
    },
  });
  const fx = args.fixContext || {};
  const lines = [base, '', '## Fix context — verified gate evidence', ''];
  lines.push(`- prior round: ${fx.round ?? '?'} — verified result hash ${fx.resultSha256 ?? '?'}`);
  lines.push(`- checks verdict: ${fx.checksVerdict ?? '?'}`);
  if (fx.priorResult) {
    lines.push(`- prior implementer result (attempt ${fx.priorResult.attemptId ?? '?'}):`);
    if (fx.priorResult.summary) lines.push(`  summary: ${fx.priorResult.summary}`);
    if (fx.priorResult.finalArtifactId) {
      lines.push(`  final artifact: ${fx.priorResult.finalArtifactId}`);
    }
    if (fx.priorResult.outcome) lines.push(`  outcome: ${fx.priorResult.outcome}`);
  }
  if (fx.reason) lines.push(`- gate decision reason: ${fx.reason}`);
  if (fx.findingsArtifactId) {
    lines.push(`- findings evidence: artifact ${fx.findingsArtifactId} (reviewer attempt ${fx.findingsAttemptId ?? '?'})`);
  }
  if (fx.verdictsArtifactId) {
    lines.push(`- verdicts evidence: artifact ${fx.verdictsArtifactId} (checker attempt ${fx.verdictsAttemptId ?? '?'})`);
  }
  const open = Array.isArray(fx.openFindings) ? fx.openFindings : [];
  if (open.length) {
    lines.push('- open findings to fix:');
    for (const f of open) {
      lines.push(`  * [${f.severity ?? '?'}] ${f.id}: ${f.text ?? ''}${f.where ? ` (${f.where})` : ''}`);
    }
    lines.push('');
    lines.push('Fix ONLY the listed findings; do not rework reviewed code.');
  } else {
    lines.push('- no open reviewer findings — the gate fired on the CHECK results.');
    lines.push('  Fix what the check diagnostics below report; do not rework reviewed code.');
  }
  const reps = Array.isArray(fx.checkReports) ? fx.checkReports : [];
  if (reps.length) {
    lines.push('');
    lines.push('## Approved check diagnostics');
    lines.push('');
    for (const r of reps) {
      lines.push(`- check[${r.index}] → ${r.status} (exit ${r.exitCode ?? '?'})`);
      if (r.stderrTail) lines.push(`  stderr tail: ${JSON.stringify(r.stderrTail)}`);
      if (r.stdoutTail) lines.push(`  stdout tail: ${JSON.stringify(r.stdoutTail)}`);
    }
    // Full verified log bytes — hydrated from the immutable artifact store
    // (id + sha256 verified), never the mutable workspace copy.
    const logged = reps.filter((r) => r.logOut?.content || r.logErr?.content);
    if (logged.length) {
      for (const r of logged) {
        if (r.logOut?.content) {
          lines.push('');
          lines.push(`### check[${r.index}] stdout — verified artifact ${r.logOut.artifactId}`);
          lines.push('```');
          lines.push(r.logOut.content);
          lines.push('```');
        }
        if (r.logErr?.content) {
          lines.push('');
          lines.push(`### check[${r.index}] stderr — verified artifact ${r.logErr.artifactId}`);
          lines.push('```');
          lines.push(r.logErr.content);
          lines.push('```');
        }
      }
    } else if (reps.some((r) => r.logOutArtifactId || r.logErrArtifactId)) {
      for (const r of reps) {
        if (r.logOutArtifactId || r.logErrArtifactId) {
          lines.push(`  check[${r.index}] full logs: out=${r.logOutArtifactId ?? '—'}`
            + ` err=${r.logErrArtifactId ?? '—'}`
            + ` (sha256 ${r.logSha256Out?.slice(0, 16) ?? '—'}…/${r.logSha256Err?.slice(0, 16) ?? '—'}…)`);
        }
      }
    }
  }
  if (fx.priorFinal?.content !== undefined && fx.priorFinal?.content !== null) {
    lines.push('');
    lines.push(`## Prior implementer final report — verified artifact ${fx.priorFinal.artifactId}`);
    lines.push('```');
    lines.push(fx.priorFinal.content);
    lines.push('```');
  } else if (fx.priorFinal?.unavailable === 'not_declared') {
    lines.push('');
    lines.push('## Prior implementer final report');
    lines.push('');
    lines.push('- the prior attempt declared NO final artifact — only the recorded');
    lines.push('  summary and result hash above are authoritative.');
  }
  if (fx.findingsDoc) {
    lines.push('');
    lines.push('## Verified findings document (verbatim)');
    lines.push('');
    lines.push(JSON.stringify(fx.findingsDoc, null, 2));
  }
  if (fx.verdictsDoc) {
    lines.push('');
    lines.push('## Verified verdicts document (verbatim)');
    lines.push('');
    lines.push(JSON.stringify(fx.verdictsDoc, null, 2));
  }
  lines.push('');
  return lines.join('\n');
}
