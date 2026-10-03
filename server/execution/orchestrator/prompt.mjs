// server/execution/orchestrator/prompt.mjs — prompts + materials for the
// O-unit roles. Every prompt is a pure function of the durable run record —
// promptSha256 binds exactly what the worker saw.

import { createHash } from 'node:crypto';
import { canonicalJson } from '../environment/agent-profile.mjs';

export const sha256Hex = (s) =>
  createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s), 'utf8').digest('hex');

// ---- decomposer --------------------------------------------------------------

export function buildDecomposerPrompt({ cardTitle = null, baseCommit, workers, limits, rejections = [] }) {
  const pool = Object.entries(workers || {})
    .map(([name, w]) => `- ${name}: ${w.provider}/${w.model}`)
    .join('\n');
  return [
    'Ты — оркестратор-декомпозиция (read-only). Разбей принятый план на',
    'подзадачи для параллельных воркеров и верни ОДИН JSON-документ.',
    'Код не пишешь, файлы не правишь — выход только контракт декомпозиции.',
    ...(cardTitle ? ['', `Карточка: ${String(cardTitle).slice(0, 200)}`] : []),
    '',
    `# Зафиксированные входы`,
    '',
    `- baseCommit: ${baseCommit}`,
    `- пул воркеров (только эти profileId допустимы):`,
    pool || '(пусто)',
    `- maxSubtasks: ${limits?.maxSubtasks ?? 32}`,
    '',
    'Документы requirements/plan/design лежат в /work/inputs/.',
    '',
    ...(rejections.length ? [
      '# Previous server validation rejection — repair the new decomposition',
      'These are recorded diagnostics, not new requirements. Correct every reported contract error.',
      canonicalJson(rejections.slice(-3).map((r) => ({
        attemptId: r.attemptId, sha256: r.sha256, code: r.code, message: r.message,
      })), '  '),
      '',
    ] : []),
    '# Контракт выхода — ОДИН JSON',
    '',
    '```json',
    '{',
    '  "decomposition": {',
    '    "subtasks": [',
    '      {',
    '        "id": "st-1",',
    '        "title": "короткое имя",',
    '        "outcome": "какой результат должна дать подзадача",',
    '        "acceptanceCriteria": ["проверяемое утверждение"],',
    '        "dependsOn": [],',
    '        "boundary": { "paths": ["src/only/these/**"] },',
    '        "worker": { "profileId": "<имя воркера из пула>" },',
    '        "limits": { "maxAttempts": 2, "maxFixCycles": 3 }',
    '      }',
    '    ]',
    '  }',
    '}',
    '```',
    '',
    'Если без изменения входов честно не разбить план, добавь в тот же JSON',
    'необязательное proposedInputChanges с reason и реальными versionId/sha256',
    'для изменяемых requirements/plan/design либо новым baseCommit. Иначе поле опусти.',
    '',
    '- id: ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$; уникален.',
    '- acceptanceCriteria: непустой список; dependsOn — только реальные',
    '  prerequisite-ы, без циклов. Границы независимых подзадач не',
    '  пересекаются.',
    '- EVERY subtask requires boundary.paths as a NON-EMPTY array of canonical relative paths/globs.',
    '  This includes verification-only tasks: declare the paths they inspect and dependencies',
    '  on tasks with overlapping boundaries, or fold verification into those tasks acceptanceCriteria.',
    '  Never emit boundary.paths: []. A read-only task does not waive this contract.',
    '- Никаких секретов и ключей в документе.',
    '',
    'Последняя строка ответа — `STATUS: DONE | BLOCKED`.',
  ].join('\n');
}

export function decomposerMaterials({ projectRoot, snapshotSha, requirementsText, planText, designText, workersText }) {
  const inputs = [
    { name: 'requirements', content: requirementsText },
    { name: 'plan', content: planText },
  ];
  if (designText) inputs.push({ name: 'design', content: designText });
  inputs.push({ name: 'workers', content: workersText });
  return { projectRoot, snapshotSha, inputs };
}

// ---- worker (work / fix) -------------------------------------------------------

export function buildWorkerPrompt({ cardTitle = null, kind = 'work', task, inputCommit, snapshotOf, findings }) {
  const lines = [
    kind === 'fix'
      ? 'Ты — воркер оркестратора, раунд ИСПРАВЛЕНИЯ. В репозитории уже'
      : 'Ты — воркер оркестратора. Выполни ровно одну подзадачу в своём',
    kind === 'fix'
      ? 'лежит результат предыдущего раунда — исправь его по вердикту.'
      : 'изолированном репозитории. Ничего за пределами границы не трогай.',
    ...(cardTitle ? ['', `Карточка: ${String(cardTitle).slice(0, 200)}`] : []),
    '',
    `# Подзадача ${task.id}`,
    '',
    `title: ${task.title}`,
    `outcome: ${task.outcome}`,
    '',
    '## Граница (только эти пути можно менять)',
    '',
    ...(task.boundary?.paths || []).map((p) => `- ${p}`),
    '',
    '## Критерии приёмки',
    '',
    ...(task.acceptanceCriteria || []).map((c) => `- ${c}`),
    '',
    `# База`,
    '',
    `- inputCommit: ${inputCommit}`,
    `- включает принятые результаты предшественников: ${(snapshotOf || []).join(', ') || '(нет)'}`,
  ];
  if (kind === 'fix' && findings?.length) {
    lines.push('', '## Замечания верификатора — исправь каждое', '');
    for (const f of findings.slice(0, 32)) {
      lines.push(`- [${f.severity ?? '?'}] ${f.text ?? f.id}${f.where ? ` (${f.where})` : ''}`);
    }
  }
  lines.push('',
    'Результат: рабочее дерево репозитория в конечном состоянии.',
    'Requirements и plan находятся в /work/inputs/requirements и /work/inputs/plan,',
    'включая acp-checks. Это входные документы, а не файлы внутри границы проекта.',
    'Финальный ответ — отчёт по каждому критерию. Для реально выполненных проверок',
    'укажи точную команду, exit code и фактический stdout/stderr (полный вывод, если',
    'это требует критерий). Не выдумывай вывод; явно укажи невыполненные проверки.',
    'Этот ответ передаётся верификатору вместе с отчётом фиксации дерева.',
    'Коммитить можно, но не обязательно — зафиксированное состояние дерева',
    'и есть результат. Последняя строка ответа — `STATUS: DONE | BLOCKED`.');
  return lines.join('\n');
}

export function workerMaterials({ projectRoot, snapshotSha, snapshotId, canonicalId, fromCanonical, taskText, briefText, boundaryText, criteriaText, depsText, requirementsText, planText, contextText }) {
  return {
    projectRoot, snapshotSha, canonicalId,
    ...(snapshotId ? { snapshotId } : {}),
    ...(fromCanonical ? { fromCanonical: true } : {}),
    inputs: [
      { name: 'task', content: taskText },
      { name: 'brief', content: briefText },
      { name: 'boundary', content: boundaryText },
      { name: 'criteria', content: criteriaText },
      ...(depsText ? [{ name: 'deps', content: depsText }] : []),
      { name: 'requirements', content: requirementsText },
      { name: 'plan', content: planText },
      ...(contextText ? [{ name: 'context', content: contextText }] : []),
    ],
  };
}

// ---- verifier ------------------------------------------------------------------

export function buildVerifierPrompt({ cardTitle = null, task }) {
  return [
    'Ты — верификатор оркестратора (read-only). Проверь кандидат-результат',
    'подзадачи по её критериям приёмки и верни ОДИН JSON-вердикт.',
    ...(cardTitle ? ['', `Карточка: ${String(cardTitle).slice(0, 200)}`] : []),
    '',
    `# Подзадача ${task.id}`,
    '',
    `outcome: ${task.outcome}`,
    '',
    '## Критерии приёмки — проверь КАЖДЫЙ',
    '',
    ...(task.acceptanceCriteria || []).map((c) => `- ${c}`),
    '',
    '## Граница — изменения вне неё это нарушение',
    '',
    ...(task.boundary?.paths || []).map((p) => `- ${p}`),
    '',
    'В /work/project уже лежит неизменяемый КАНДИДАТ результата.',
    'input `diff` описывает изменения, его не нужно повторно применять.',
    'input `report` содержит отчёт фиксации и workerResponse — сохранённый',
    'финальный отчёт воркера, если он доступен. Это его утверждения, не доказанный',
    'результат проверок: самостоятельно проверь каждый критерий на кандидате.',
    '',
    '# Вердикт — ОДИН JSON',
    '',
    '```json',
    '{',
    '  "decision": "accept | return",',
    '  "summary": "кратко",',
    '  "findings": [',
    '    { "id": "f1", "severity": "blocker|major|minor",',
    '      "text": "что не так", "where": "path:line" }',
    '  ]',
    '}',
    '```',
    '',
    '- accept — только если КАЖДЫЙ критерий выполнен и граница не нарушена.',
    '- return — с непустыми findings: что именно исправить.',
    '',
    'Последняя строка ответа — `STATUS: DONE | BLOCKED`.',
  ].join('\n');
}

export function verifierMaterials({ projectRoot, snapshotSha, snapshotId, taskText, diffText, criteriaText, boundaryText, contextText, reportText }) {
  return {
    projectRoot, snapshotSha, snapshotId,
    inputs: [
      { name: 'task', content: taskText },
      { name: 'diff', content: diffText },
      { name: 'criteria', content: criteriaText },
      { name: 'boundary', content: boundaryText },
      ...(contextText ? [{ name: 'context', content: contextText }] : []),
      { name: 'report', content: reportText },
    ],
  };
}

// ---- assembler (orch-integrator) -------------------------------------------------

export function buildAssemblerPrompt({ cardTitle = null, taskCount }) {
  return [
    'Ты — интегратор оркестратора. Собери принятые результаты подзадач в',
    'ОДНО согласованное дерево в своём репозитории: примени диффы каждого',
    'предшественника в заданном порядке (input `results`), разреши конфликты',
    'по смыслу, проверь, что НИ ОДИН путь из `changed[]` предков не потерян.',
    ...(cardTitle ? ['', `Карточка: ${String(cardTitle).slice(0, 200)}`] : []),
    '',
    `- принятых подзадач: ${taskCount}`,
    '',
    'Правила:',
    '',
    '- Применяй патчи в порядке `order`; конфликт решаешь САМ, не откатывая',
    '  чужие изменения без причины.',
    '- Ничего не меняй вне принятых границ и разрешённых пересечений.',
    '- Финальное дерево должно содержать ВСЕ пути `changed[]` всех родителей.',
    '',
    'Before STATUS, emit exactly one standalone ```acp-orchestrator-integration JSON block:',
    '{"additionalPaths":[],"resolvedPaths":[]}',
    'additionalPaths explicitly declares every assembler-only changed path outside parent diffs.',
    'resolvedPaths explicitly declares parent-owned paths whose final content/mode/deletion differs',
    'from parent proofs because of intentional conflict resolution. Use canonical relative paths.',
    'Empty arrays are required when no such edits were made. Undeclared edits fail closed.',
    'Отчёт — короткое описание сборки. Последняя строка — `STATUS: DONE | BLOCKED`.',
  ].join('\n');
}

export function assemblerMaterials({ projectRoot, snapshotSha, canonicalId, fromCanonical, taskText, workOrderText, requirementsText, planText, designText, resultsText }) {
  return {
    projectRoot, snapshotSha, canonicalId,
    ...(fromCanonical ? { fromCanonical: true } : {}),
    inputs: [
      { name: 'task', content: taskText },
      { name: 'work-order', content: workOrderText },
      { name: 'requirements', content: requirementsText },
      { name: 'plan', content: planText },
      ...(designText ? [{ name: 'design', content: designText }] : []),
      { name: 'results', content: resultsText },
    ],
  };
}

// ---- shared serializations -----------------------------------------------------

export function taskBriefText(task) {
  return canonicalJson({
    id: task.id, title: task.title, outcome: task.outcome,
    acceptanceCriteria: task.acceptanceCriteria,
    dependsOn: task.dependsOn, boundary: task.boundary,
    limits: task.limits,
  }, '  ');
}

export function boundaryTextOf(task) {
  return (task.boundary?.paths || []).join('\n');
}

export function criteriaTextOf(task) {
  return (task.acceptanceCriteria || []).map((c, i) => `${i + 1}. ${c}`).join('\n');
}

// The bundle of accepted parent diffs the assembler merges — deterministic
// order = graph topo order; conflicts are the assembler's job.
export function resultsBundleText(entries) {
  const out = ['# Accepted predecessor diffs — apply in `order`', ''];
  for (const e of entries) {
    out.push(`## ${e.taskId} (resultCommit ${e.resultCommit ?? 'n/a'})`, '');
    out.push('```diff', e.formatPatch ?? '(empty diff)', '```', '');
  }
  return out.join('\n');
}

// Committed declarations are also accepted as bare JSON during recovery.
export function parseIntegrationDeclarations(text) {
  if (typeof text !== 'string') throw new Error('integration declaration is missing');
  const matches = [...text.matchAll(/^```acp-orchestrator-integration[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (matches.length > 1) throw new Error('multiple integration declarations');
  const raw = matches.length === 1 ? matches[0][1] : text.trim();
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'additionalPaths,resolvedPaths') {
    throw new Error('integration declaration requires exactly additionalPaths and resolvedPaths');
  }
  for (const key of ['additionalPaths', 'resolvedPaths']) {
    if (!Array.isArray(value[key]) || value[key].some((p) => typeof p !== 'string'
      || !p || p.startsWith('/') || /[\\\x00-\x1f]/.test(p)
      || p.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git'))
      || new Set(value[key]).size !== value[key].length) throw new Error(`invalid ${key}`);
  }
  if (value.additionalPaths.some((p) => value.resolvedPaths.includes(p))) throw new Error('declaration categories overlap');
  return value;
}
