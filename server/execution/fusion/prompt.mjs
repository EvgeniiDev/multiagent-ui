// server/execution/fusion/prompt.mjs — the panelist prompt + materials.
//
// R1: every panelist receives the IDENTICAL task and project snapshot —
// this builder deliberately takes NO participant identity, so the prompt
// text is byte-identical across the panel. Participant identity lives in
// the attempt record and the worker binding, never in the task.
//
// The prompt is also a pure function of the run's recorded fusion snapshot
// — nothing caller-supplied enters it, so promptSha256 binds exactly what
// every panelist saw.

import { createHash } from 'node:crypto';
import { answerContractText } from './answer.mjs';

export function buildPanelPrompt({ cardTitle = null, taskText, snapshotSha, projectRoot, resultKind, searchEnabled = false }) {
  const lines = [
    'You are an independent panelist in a managed fusion panel. Produce',
    'your own answer to the task below — alone, from the evidence in the',
    'project snapshot. Do not modify any files; the snapshot is read-only.',
    '',
    `# Task`,
    '',
    taskText,
    '',
    `# Project snapshot`,
    '',
    `- root: ${projectRoot}`,
    `- snapshot: ${snapshotSha}`,
    `- result kind: ${resultKind}`,
  ];
  if (cardTitle) lines.splice(3, 0, '', `Card: ${String(cardTitle).slice(0, 200)}`);
  if (searchEnabled) {
    lines.push('', 'Web search is enabled for this profile; cite sources under "## Rationale" when used.');
  }
  lines.push('', '# Answer contract', '', answerContractText(), '');
  return lines.join('\n');
}

// Runtime materials — identical for every participant of the run. The
// task text rides as a named input so the runtime binds the same bytes
// into every worker.
export function panelMaterials({ projectRoot, snapshotSha, taskText }) {
  return {
    projectRoot,
    snapshotSha,
    inputs: [{ name: 'task', content: taskText }],
  };
}

export const sha256Hex = (s) =>
  createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s), 'utf8').digest('hex');
