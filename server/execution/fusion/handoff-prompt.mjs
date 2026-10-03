// server/execution/fusion/handoff-prompt.mjs — F3 judge + integrator prompts.
//
// Same rules as the panel prompt (prompt.mjs): the builders are pure
// functions of the durable run record — nothing caller-supplied enters
// them, so promptSha256 binds exactly what the judge/integrator saw.
//
// R6: the judge reads the project snapshot (read-only) plus the ACCEPTED
// panel answers and the exclusions record — never the workspace, never
// panel logs, never participant attempts that produced no accepted
// answer. Its output is a versioned work order (work-order.mjs).
//
// R8/R2: the integrator receives the work order plus the needed source
// documents — NEVER panel answers or logs. The isolation is also
// enforced in the domain (integrate_begin refuses panel-bound input
// hashes); the prompt simply never names them.

import { workOrderContractText, integratorReportContractText } from './work-order.mjs';

// The judge-facing serialization of the accepted panel answers — this
// text rides as the 'answers' input file. Accepted answers verbatim
// (from the committed artifacts); excluded participants are metadata
// only (they produced no accepted answer — nothing to show).
export function buildAnswersBundle({ participants, answers, exclusions }) {
  const lines = [
    '# Accepted panel answers',
    '',
    `Accepted answers: ${participants.length}`,
  ];
  for (const p of participants) {
    lines.push(
      '',
      `## Participant ${p.id} — model ${p.model}`,
      '',
      answers.get(p.id) ?? '(answer text unavailable)',
    );
  }
  lines.push('', '# Excluded participants', '');
  if (!exclusions.length) {
    lines.push('(none)');
  } else {
    for (const x of exclusions) {
      lines.push(
        `- ${x.participantId} model=${x.model ?? '?'} reason=${x.reason ?? 'excluded'}`
        + ` by=${x.by ?? '?'} at=${x.at ?? '?'}`);
    }
  }
  return lines.join('\n');
}

export function buildJudgePrompt({
  cardTitle = null, taskText, snapshotSha, projectRoot, resultKind,
  answeredCount, excludedCount,
}) {
  const lines = [
    'You are the judge of a managed fusion panel. The panelists answered',
    'independently; you now judge their ACCEPTED answers against the',
    'actual project and produce a work order.',
    '',
  ];
  if (cardTitle) lines.push(`Card: ${String(cardTitle).slice(0, 200)}`, '');
  lines.push(
    '# Materials',
    '',
    `- project snapshot: ${snapshotSha} mounted at ${projectRoot} (READ-ONLY — you never write to it)`,
    '- task: /work/inputs/task',
    '- accepted answers + excluded-participant record: /work/inputs/answers',
    '- work-order contract (rubric): /work/inputs/rubric',
    `- result kind: ${resultKind}`,
    `- accepted answers: ${answeredCount}; excluded participants: ${excludedCount}`,
    '',
    '# Task',
    '',
    taskText,
    '',
    '# Rules',
    '',
    '- Judge ONLY the accepted answers — the exclusions record explains a',
    '  reduced composition; excluded participants have no answer.',
    '- Inspect the project snapshot wherever the answers make claims about',
    '  the code — verify them; contradictions with the code go into the',
    '  analysis sections.',
    '- A mere comparison or summary of the answers is REJECTED. The output',
    '  is an executable work order with a verdict.',
    '- When the order stays inside the approved requirements and plan,',
    '  verdict in_plan; when it exceeds them, scope_change; when you',
    '  cannot tell, uncertain — the system then waits for the user.',
    '',
    '# Work-order contract',
    '',
    workOrderContractText(),
    '',
  );
  return lines.join('\n');
}

export function judgeMaterials({ projectRoot, snapshotSha, taskText, answersBundle }) {
  return {
    projectRoot,
    snapshotSha,
    inputs: [
      { name: 'task', content: taskText },
      { name: 'answers', content: answersBundle },
      { name: 'rubric', content: workOrderContractText() },
    ],
  };
}

// The integrator prompt: the work order verbatim (its sha256 is recorded
// in the launch inputs) plus the fix context when this is a fix attempt.
// Source documents (requirements/plan/design) ride as named inputs.
export function buildIntegratorPrompt({
  cardTitle = null, taskText = null, workOrderText, resultKind,
  hasRequirements = false, hasPlan = false, hasDesign = false,
  fixContext = null, dependencies = null,
}) {
  const docs = [];
  if (hasRequirements) docs.push('- requirements: /work/inputs/requirements');
  if (hasPlan) docs.push('- plan: /work/inputs/plan');
  if (hasDesign) docs.push('- design: /work/inputs/design');
  const lines = [
    'You are the integrator of a managed fusion run. A judged work order',
    'has been accepted for this task; you implement it in your private',
    'working repository.',
    '',
  ];
  if (cardTitle) lines.push(`Card: ${String(cardTitle).slice(0, 200)}`, '');
  lines.push(
    '# Materials',
    '',
    '- the project (your private writable repository): /work/project',
    dependencies ? `- prepared read-only dependencies: registered setup ${dependencies.setupId}` : null,
    '- task: /work/inputs/task',
    '- work order (the authoritative scope): /work/inputs/work-order',
    ...docs,
    fixContext ? '- prior verification evidence: /work/inputs/results' : null,
    `- result kind: ${resultKind}`,
    '',
    '# Rules',
    '',
    '- Implement the work order exactly — it is the accepted scope.',
    dependencies ? '- Use the prepared dependencies; lockfile changes are prepared again before verification.' : null,
    '- Where the work order disagrees with the actual code, fix the',
    '  mismatch inside the already-accepted behavior and list EVERY such',
    '  mismatch under ## Mismatches in your report.',
    '- A change of behavior beyond the work order/approved plan requires',
    '  approval: declare it (## Behavior change: yes) — never smuggle it.',
    '- Commit your work or leave it in the worktree — the controller',
    '  imports the complete final state (new, modified AND deleted files).',
    '- You never saw and never will see the panel answers — the work',
    '  order is the only decision input.',
    '',
    '# Work order',
    '',
    workOrderText,
  );
  if (fixContext) {
    lines.push('', '# Prior verification (fix round)', '');
    if (fixContext.checkReports?.length) {
      lines.push('## Failed checks');
      for (const r of fixContext.checkReports) {
        if (r.status === 'pass') continue;
        lines.push(`- check ${r.index}: ${r.status} (exit ${r.exitCode ?? '?'})`);
        if (r.stderrTail) lines.push(`  stderr: ${String(r.stderrTail).slice(0, 600)}`);
      }
    }
    if (fixContext.openFindings?.length) {
      lines.push('', '## Open findings');
      for (const f of fixContext.openFindings) {
        lines.push(`- [${f.severity ?? '?'}] ${f.text ?? f.id}${f.where ? ` (${f.where})` : ''}`);
      }
    }
    if (fixContext.reason) lines.push('', `gate reason: ${fixContext.reason}`);
    lines.push('', 'Fix exactly these — the round re-verifies afterward.');
  }
  lines.push('', '# Report contract', '', integratorReportContractText(), '');
  return lines.filter((l) => l !== null).join('\n');
}

export function integratorMaterials({
  projectRoot, snapshotSha, canonicalId, taskText, workOrderText,
  requirementsText = null, planText = null, designText = null,
  resultsBundle = null, fromCanonical = false, dependencies = null,
}) {
  const inputs = [
    { name: 'task', content: taskText ?? '' },
    { name: 'work-order', content: workOrderText },
  ];
  if (requirementsText !== null) inputs.push({ name: 'requirements', content: requirementsText });
  if (planText !== null) inputs.push({ name: 'plan', content: planText });
  if (designText !== null) inputs.push({ name: 'design', content: designText });
  if (resultsBundle !== null) inputs.push({ name: 'results', content: resultsBundle });
  return {
    projectRoot,
    snapshotSha,
    canonicalId,
    ...(dependencies ? { setupId: dependencies.setupId, depSetId: dependencies.depSetId, lockHash: dependencies.lockHash } : {}),
    ...(fromCanonical ? { fromCanonical: true } : {}),
    inputs,
  };
}
