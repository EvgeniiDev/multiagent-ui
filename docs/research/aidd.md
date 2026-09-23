# CodeAlive-AI/`ai-driven-development` — что реально переиспользуемо для канбан-панели, которая гоняет кодинг-агентов

Источник: https://github.com/CodeAlive-AI/ai-driven-development
Изученный коммит: `af4035b657a54c9a6ff7deb85af070f494892d82` (Tue Sep 22 02:28:16 2026 +0500, «Sync FPF skill with upstream spec»), версия плагина `.claude-plugin/plugin.json` = `10.0.0`. Клон читался локально в `/tmp/aidd` (read-only исследование).

## 0. Главный вывод (чего в репо нет)

Это **не канбан и не оркестратор**, а коллекция Agent Skills (стандарт agentskills.io) + один Claude-Code-хук:

- **Нет модели доски**: ни колонок, ни статусов карточек, ни WIP-лимитов. Слово `kanban` встречается в репо ровно один раз и как **антипаттерн** (см. §3).
- **Нет диспетчера, который «забирает карточку»**: в `README.md` прямо сказано, что multi-agent orchestration **вынесена** — «the `agents-consilium` skill now lives in its own repository — [CodeAlive-AI/pragmatic-orchestration](https://github.com/CodeAlive-AI/pragmatic-orchestration) (CLI renamed to `porch`)». Это отдельный источник (другой агент).
- **Нет ролей вида «executor + model + prompt на стадии»** в виде схемы. Вместо этого — онтология FPF (роль-вид / назначение / метод / план / работа) и реестр «методов-семейств с диспетчером» (G.5).
- **Нет общего состояния laptop↔phone**. Есть инвариант «один источник правды» для инструкций агентов и grep-first файл-словарь (`docs/THESAURUS.md`).

Переиспользовать стоит не артефакты доски, а **дисциплины и словари**: план-гейт, классификацию неопределённостей, acceptance targets, онтологию Work/PlanItem, selector-outcome для назначения исполнителя.

## 1. Инвентарь скиллов (фактически 22 каталога в `skills/`)

`ls -1d skills/*/ | wc -l` → **22**. При этом `README.md` пишет «23 skills + 1 hook», бейдж — «24 Skills»: расхождение заявленного и фактического — фактическое число 22.

| Скилл (путь `skills/<name>/`) | Одна строка | Локально |
|---|---|---|
| `agentic-readiness` | Аудит/улучшение репо под агентов: `AGENTS.md`/`CLAUDE.md`, discovery, routing, контекст-бюджеты, MCP/skills/subagents; скрипт `scripts/audit_repo.py` + rubric 0–4 | нет |
| `bug-fix-protocol` | 8-шаговый протокол: баг = 2 ошибки (дефект кода + тестовая система), шаг 8 — аудит слоя, который должен был поймать | нет |
| `clipboard` | Копирование текста в клипборд macOS (rich text) | нет |
| `code-that-fits-in-your-head` | Эвристики Mark Seemann (2021) + agent-native правки: декомпозиция, outside-in TDD, STRIDE, Strangler; `workflows/` ×5 | **ДА** |
| `fetch-url-as-markdown` | URL → чистый Markdown через trafilatura, Exa MCP как fallback | нет |
| `fpf-problem-solving` | First Principles Framework (FPF) А. Левенчука: 15 разделов / 395 файлов, skill-роутер по «thinking verbs» → `_index.md` → самый узкий подраздел | нет (16 МБ) |
| `hooks-management` | Хуки/автоматизация для Claude Code, Codex, OpenCode, Devin | нет |
| `installing-cli-tools` | Установка/обновление/аутентификация CLI с удержанием токенов вне чата и логов | нет |
| `investigating-repository-history` | Реконструкция замысла по `git blame/log` + GitHub PR, со confidence-скором и cited-выходом | нет |
| `maintaining-macos-health` | Дисковый клининг/оптимизация/алертинг macOS (LaunchAgent) | нет |
| `maintaining-windows-health` | То же для Windows 11 (Storage Sense → discuss-first, Task Scheduler) | нет |
| `mcp-management` | Поиск/установка/удаление MCP-серверов по 10+ агентам | нет |
| `plan-mode` | **План-гейт**: investigate → классификация вопросов → план → явное approval → реализация → валидация. `SKILL.md` + `PROTOCOL.md` | нет |
| `plugins-management` | Плагины/маркетплейсы для Claude Code, OpenCode, Devin | нет |
| `prompt-engineering` | 14 reference-доков: семейства Claude/GPT/Gemini, техники, eval, red-teaming, типовые сбои | **ДА** |
| `refactoring-csharp` | One-shot Roslyn-контракт переименования C#-символов (dry-run + коды ошибок) | нет |
| `repo-activity-summary` | Сводка «чем жил репо» по `git log`: технологии, churn-хотспоты, velocity, health | нет |
| `semantic-scholar-deep` | Глубокий research по Semantic Scholar Graph API, multi-hop BFS по цитатам | нет |
| `settings-management` | Настройки агентов (Claude JSON, Codex TOML, OpenCode JSONC, Devin JSON) | нет |
| `skills-management` | Полный жизненный цикл скиллов + SkillOpt-цикл обучения: `scripts/review_skill.py`, `audit_skill_duplicates.py`, `optimize_skill.py`, `blind_comparator.py`, `prompts/grader.md`, `references/optimization-grading-checklist.md` | нет |
| `ubiquitous-language` | DDD-тезаурус проекта: `docs/THESAURUS.md`, grep-first формат 2.0, аудит нейминга, майнинг git-истории | **ДА** |
| `windows-qa-engineer` | QA-копайлот по Windows-приложениям (UFO/UIA + MCP) | нет |

**Итого локально стоит 3 из 22** (`~/.pi/agent/skills/`): `code-that-fits-in-your-head`, `prompt-engineering`, `ubiquitous-language`. Проверено `diff -rq --strip-trailing-cr` — **побайтово совпадают** с HEAD этого репо (различались только CRLF-переводы строк). В `~/.hermes/skills/` ни одного скилла из этой коллекции нет (поиск по `plan-mode`, `bug-fix-protocol`, `fpf-problem-solving`, `skills-management`, `agentic-readiness` — 0 совпадений; всего там 134 `SKILL.md`).

Локально установленные `architecture-design`, `pragmatic-orchestration`, `russian-technical-editing` в этом репо **отсутствуют** (их нет в листинге `skills/`) — это второй источник.

Дополнительно в репо: `hooks/balanced-safety-hooks/` (Go-хук `bash-guard`, `PreToolUse:Bash`) и `.claude-plugin/{plugin.json,marketplace.json}` (single-plugin marketplace, `source: "./"`).

## 2. Их процесс: idea → spec → plan → реализация → review → done

### 2.1 План-гейт (`skills/plan-mode/SKILL.md`, `PROTOCOL.md`)

Порядок: investigate (read-only) → анализ задачи → классификация открытых вопросов → точечные вопросы → план → **явное approval** → реализация → валидация. Гейт запрещает менять проект в режиме планирования (файлы, патчи, установки, lockfile, миграции, деплой, «попробовать реализацию, чтобы понять код»).

- **Владелец шагов.** Агент: исследование, классификация, план, реализация, валидация. Человек: ответы на вопросы и **approval**. Что считается approval — перечислено явно («proceed/implement/apply/approve» или правленый план с указанием продолжать); что **не** считается — ответ на один вопрос, комментарий к плану, просьба деталей/альтернатив/оценки.
- **Артефакты.** План-сообщение по фиксированному шаблону (`PROTOCOL.md`, раздел «Planning output»): `# Feature Plan:` → `## Understanding` → `## Context findings` → `## Ambiguities, contradictions, and blockers` (таблица `Type | Item | Evidence | Impact | Resolution`) → `## Proposed implementation plan` (шаг → Files/areas, Reason, Notes) → `## Test and validation plan` → `## Rollout, migration, and compatibility` → `## Approval gate`. Финальный отчёт — шаблон `## Changed` / `## Validation` / `## Notes`, где по каждой команде пишется `passed` или `failed: [reason and impact]`.
- **Как судится «done».** Валидация + честный отчёт «что проверяли, что нет»; при противоречии новых свидетельств плану — пауза и возврат в планирование, а не тихое отклонение.
- **Файловых артефактов нет.** План живёт как сообщение; файл создаётся только если пользователь явно попросил планировочный артефакт (формулировка `PROTOCOL.md`: «unless the user has explicitly asked only for a planning artifact that itself requires creating a file»).

### 2.2 Реализация и приёмка

- `skills/bug-fix-protocol/SKILL.md`: red-тест → поиск корневой причины → минимальная правка → зелёный локально → полный прогон + линт + типы → документирование → **шаг 8 (аудит тестовой системы)**, без него фикс считается неполным.
- `skills/code-that-fits-in-your-head/workflows/add-feature-outside-in.md`: 10 шагов (Step 0 — выбрать гранулярность цикла: «Я открываю спецификацию или исполняю известную?»; Step 1 — граница; Step 2 — тест границы первым; далее домен, декомпозиция, cross-cutting, threat-model, коммиты мелкими обратимыми шагами) + `## Exit Criteria`. Для крупных фич: «define the target architecture, dependency direction, acceptance and non-regression criteria, verification strategy, and recovery path before implementation» и прямое «Do not reduce scope merely to satisfy a line or file limit».
- `skills/code-that-fits-in-your-head/workflows/review-code.md`: 8 шагов (понять change set → читать тесты первыми → декомпозиция → инкапсуляция → API → cross-cutting/security → гигиена коммитов → фидбек) + `## Exit Criteria`. Блокирующие вопросы: «For each new/changed behaviour, is there a test?», «Did the change weaken, skip, or rewrite an existing oracle merely to get green?», «is any acceptance evidence independent of the implementation?», «If no tests for a behaviour change: block and ask why».
- `skills/agentic-readiness/references/rubric.md`: шкала 0–4 по 5 осям (discovery/ownership, commands and verification, architecture and routing, conciseness, safety); ось «Commands and verification»: 3 = «Focused checks and definition of done are documented and accurate», 4 = «Critical requirements are also enforced by CI, hooks, or policy». Отдельная норма: «Do not hide a P0 behind a high aggregate score».
- `skills/agentic-readiness/SKILL.md`, раздел «Verify required commands and hooks actually work»: «A configuration entry, hook file, or successful commit alone is not proof»; для блокирующего хука — allowed fixture должен пройти, violating — быть отклонён; непроверенное помечать «not verified», не смешивать с подтверждённым падением.

## 3. Моделирование задач/доски

**Канбан-доски нет.** Единственное вхождение `kanban`: `skills/fpf-problem-solving/sections/07-cluster-a-v---constitutional-principles-of-the-kernel/16-a-15-2---u-workplan.md` — в списке антипаттернов: «**Plan-as-actual.** Do not treat a Gantt bar, Kanban ticket, shift rota, or calendar booking as performed work» и в §A.15.2:2: «**Plan and occurrence blur.** Gantt bars or Kanban tickets are reported as if the work already happened; audits and costing degrade». Это важное правило для нашей панели: **карточка — это намерение, а не факт работы**; факт — отдельная сущность.

Что есть вместо модели доски — онтология работы FPF A.15 (`skills/fpf-problem-solving/sections/07-cluster-a-v---constitutional-principles-of-the-kernel/`):

- **`16-a-15-2---u-workplan.md`** — `U.WorkPlan`: эпистема «одного плана» для координации возможной будущей работы по существующему субъекту на заданном горизонте. §A.15.2:4.2 «`PlanItem` content» даёт **открытую палитру полей карточки** (не схему!). Прямо пригодные нам пункты:
  - 1 — целевой `U.Method` и, при необходимости, эпистема-описание метода;
  - 2 — планируемое окно/условие входа (earliest start, latest finish, timebox, recurrence, blackout);
  - 3 — предполагаемый исполнитель `U.System` + локальный вид системной роли + условия допуска + (только если уже есть) назначение `U.SystemRoleAssignment`;
  - 4 — требование по capability (порог A.2.2 или `CapabilityFitCondition`);
  - 5 — бюджеты и резервы ресурсов;
  - 6 — **«Dependencies and commitments»**: «state the source item or commitment, the affected target item, and the condition that blocks, orders, overlaps, or excludes the planned work» — это ровно модель зависимостей карточек (блокирует/упорядочивает/пересекается/исключает);
  - 7 — **«Acceptance targets»**: «name the criterion and target value or window that a later evaluation will test. The target is not the evaluation or acceptance verdict»;
  - 8 — место/затронутый субъект/asset-ограничения; 9 — планируемые заполнения (см. A.15.3); 10 — ожидаемый эффект/результат/поставка.
  §A.15.2:5 «What a good `WorkPlan` states (review checklist)» — 7 пунктов чек-листа для ревью плана («plan review checklist»), включая «Acceptance targets with their direct criteria and intended qualification windows».
- **Статусы карточек не моделируются.** Есть близкие по смыслу, но не про колонки:
  - `19-a-15-5---work-entry-readiness-and-full-kit-preparation.md` (`A.15.5`) — критерий и **вердикт готовности к входу в работу** с окном доверия и условием «stop or recheck»; это естественный «Ready»-гейт.
  - `45-a-21---gate-decisions-from-independent-check-results.md` (`A.21`, `GateDecisionResult`) — «a named gate must decide whether one bounded action or transition may proceed under an applicable profile rule. Identify every check that the rule requires, including the subject and criterion of each check» — это естественный «Done / Accepted»-гейт.
  - `21-a-15-7---situation-responsive-work-steering-and-next-action.md` (`A.15.7`) — выбор следующего действия во время работы, с тремя видимыми частями ответа: «Decision now / Performer / Stop and feedback», и требованием «If another System made the choice, name the chooser separately» — ровно то, что должен возвращать диспетчер.
- **Эпики/подзадачи.** Явных полей epic/subtask нет. Есть §A.15.2:4.4 «Plan mereology (composition of plans ≠ composition of methods or work occurrences)» и `46-a-22---structure-and-structural-views.md` (A.22 Structure) — можно строить иерархию планов, но это онтологическая рамка, не готовая модель.
- **Роли.** `12-a-13---the-agential-role-agency-spectrum.md` (A.13): «which System qualifies for a local goal-directed system-role kind, and which assignment actually holds for the action in question» — разделяются *локальный вид системной роли* (kind + критерий) и *наличие назначения* (assignment). `14-a-15---system-role-method-work-alignment.md` (A.15) — «Start here when. The team is mixing system classification or assignment with recipe, schedule, capability, or performed Work, often under an ambiguous source word such as *role*, *process*, *workflow*, or *activity*». Для нашей панели это прямая защита от смешения «роль = модель = промпт».
- **Работа как факт.** `15-a-15-1---u-work.md` (A.15.1): `U.Work` — датированное мировое событие; «A WorkPlan, MethodDescription, log, dashboard, assertion, or record is a different object and does not make the Work occur».

## 4. Назначение агента, бриф, приёмка

- В этом репо **нет** механизма выбора агента под карточку (он вынесен в `pragmatic-orchestration`, см. §0).
- Ближайшая переиспользуемая конструкция — **`13-part-g---discipline-sota-patterns-kit/07-g-5---multi-method-dispatcher-and-methodfamily-registry.md`** (`G.5`, «Multi-Method Dispatcher and MethodFamily Registry»): реестр строк `MethodFamilyId` + `MethodFamilyRowRef := <MethodFamilyId, rowEdition>`, селектор и **закрытый набор исходов** `SelectorOutcomeKind`/`SetResultFamily` — `Shortlist`, `RankedShortlist`, `JointUseSet`, `SpecialistHandoff` / narrowed handoff, abstain, escalation; результат обязан явно нести outcome kind, участников, ordering, named use, inclusion conditions и **basis pins**. Явная норма: «without pretending that there is always one scalar winner or that all set results are alternatives» и «do not rebuild a registry on every run» (переиспользовать уже обоснованные строки). Это и есть корректная форма «диспетчер выбрал исполнителя, вот на каком основании».
- **Бриф исполнителю** — `23-a-15-9---request-and-use-a-bounded-result-from-another-pract.md` (A.15.9): «Use the outside-practice result this decision can rely on; obtain a new contribution when it is worth the work»; что должно быть названо — **нужный результат и как его можно использовать**, а не «department, title, document, meeting, approval, provider, or tool». Дополнение — A.15.5 (full-kit readiness: план, заполнения, ресурсы, назначения, обязательства, права, источники, гейты).
- **Приёмка** — acceptance targets из A.15.2:4.2 п.7 (критерий + целевое значение/окно) + A.21 (гейт-решение из независимых проверок).
- **Проверка вместо доверия к артефакту** — §2.2 выше (`agentic-readiness`): конфиг/хук/коммит ≠ доказательство.

## 5. Что конкретно копировать под наши нужды

### (a) Колонки + статусы доски
Готовой модели нет — берём три вещи:
1. `skills/plan-mode/PROTOCOL.md` — раздел «Planning output» (шаблон плана как тело карточки-спеки) и «Final response after implementation» (`## Changed` / `## Validation` / `## Notes`) как обязательный «отчёт исполнителя».
2. `skills/fpf-problem-solving/sections/07-cluster-a-v---constitutional-principles-of-the-kernel/16-a-15-2---u-workplan.md` §A.15.2:4.2 — поля 1–10 как поля карточки (особенно 6 «Dependencies and commitments» и 7 «Acceptance targets») и §A.15.2:5 — чек-лист ревью плана.
3. `.../19-a-15-5---work-entry-readiness-and-full-kit-preparation.md` + `.../45-a-21---gate-decisions-from-independent-check-results.md` — два честных гейта: «Ready» и «Accepted/Done» (вердикт + окно + условие перепроверки вместо расплывчатого «в работе»).
Плюс правило-предохранитель из `16-a-15-2`: карточка ≠ выполненная работа.

### (b) Роли (executor + model + prompt) на стадии
- `.../12-a-13---the-agential-role-agency-spectrum.md` и `.../14-a-15---system-role-method-work-alignment.md` — разделяйте: вид роли + критерий, фактическое назначение, метод, план, факт работы. Поле «роль» в карточке не должно смешивать «какая модель» и «какой доступ».
- `skills/prompt-engineering/` (установлен локально) — источник промптов по стациям; конкретно `skills/prompt-engineering/references/gpt56-sol-prompting.md:101`: «For PTC, define the bounded stage, eligible tools, compact output schema, retry limit, stop condition, and handoff back to direct model judgment» — это почти готовый контракт «стадия → промпт → инструменты → схема вывода → лимит попыток → условие остановки».
- `skills/prompt-engineering/references/claude-fable5-prompting.md:11`: «Use it as a job handoff: give it the goal, context, definition of done, boundaries, and verification method without over-prescribing the route» — формула брифа для исполнителя; там же :109 «Keep memory scoped, reviewable, and correctable».

### (c) Диспетчер, который забирает карточку и запускает агента
- `skills/fpf-problem-solving/sections/13-part-g---discipline-sota-patterns-kit/07-g-5---multi-method-dispatcher-and-methodfamily-registry.md` — форма выбора и **явный набор исходов** (Shortlist / RankedShortlist / JointUseSet / SpecialistHandoff / abstain / escalation) с basis pins. Копировать как контракт ответа диспетчера и как правило «не пересобирать реестр на каждом прогоне».
- `.../07-cluster-a-v---constitutional-principles-of-the-kernel/21-a-15-7---situation-responsive-work-steering-and-next-action.md` — формат «next action» на трёх частях (решение / исполнитель / стоп-и-обратная связь) для идущей работы.
- `hooks/balanced-safety-hooks/DESIGN.md` (и `README.md` хука) — модель безопасности запуска команд агентом: внутренние решения `allow|ask`, **не `deny`** («agents trivially bypass `deny` by rephrasing»), безопасные исключения для `/tmp`, AST-парсинг Bash через `mvdan.cc/sh`, Codex-адаптер мапит `ask`→`deny`, т.к. в Codex `PreToolUse` не поддерживает ask-промпты. Для диспетчера это готовое «что переспрашивать перед `rm`/миграцией/`git push -f`».

### (d) PM-роль, которая ревьюит граф карточек
- `skills/plan-mode/PROTOCOL.md` — раздел «Classifying ambiguities, contradictions, and blockers»: определения **Ambiguity / Contradiction / Blocker / Risk / Assumption** и обязательные поля каждого пункта (что это, свидетельство, почему важно, блокирует ли, предлагаемый дефолт/резолюция), таблица `Type | Item | Evidence | Impact | Resolution`, правило «Do not bury blockers inside a long plan. Surface them before the plan» и перечень причин отклонить собственный план («Relies on invented project structure», «Hides a blocker as an assumption»). Это готовый чек-лист «противоречия/пересечения/блокеры» для PM.
- `skills/agentic-readiness/references/rubric.md` — рубрика 0–4 по осям с действиями на каждом уровне + запрет прятать P0 за агрегатом.
- `skills/skills-management/references/optimization-grading-checklist.md` и `skills/skills-management/prompts/grader.md` + `scripts/blind_comparator.py` / `aggregate_runs.py` — механика независимой оценки (слепое сравнение, агрегация прогонов, JSON-выход для программного использования) — пригодится, когда PM сравнивает варианты исполнения карточки.
- `skills/ubiquitous-language/references/naming-audit.md` — аудит расхождений терминов по слоям (docs → API → домен → схема БД → тесты → коммиты) и «Unresolved»-список: инструмент против «пересечений и расхождений» в графе задач.

### (e) Общее состояние laptop ↔ phone
Специального артефакта в репо **нет**: grep по `laptop|phone|mobile` в `skills/agentic-readiness`, `skills/skills-management`, `skills/plan-mode`, `skills/prompt-engineering` — 0 совпадений; `sync`/`handoff` встречаются только в смысле передачи задачи (напр. `skills/skills-management/references/skill-deduplication.md:64` «A maintained tracked source with a documented sync/update process beats an anonymous …»). Реально переиспользуемое:

1. `skills/agentic-readiness/references/instruction-files.md`, раздел «Recommended topology» — **«Use one shared source of truth»**: канонический `AGENTS.md` в корне + обычный `CLAUDE.md` со строкой `@AGENTS.md` (не симлинк: «A regular import shim is portable to Windows and can carry a small Claude-specific section»), вложенные `AGENTS.md` только для «only billing-specific additions or overrides», «Do not maintain full copies in both files». Там же — таблица различий discovery (Codex: цепочка строится один раз за сессию, лимит `project_doc_max_bytes` 32 KiB; Claude: `@imports` до 5 хопов, целевой размер <200 строк; OpenCode: не разворачивает `@file` автоматически; Devin импортирует `.cursor/rules/*` и «imported rules can silently double with project files»). Для синхронизации ноутбук↔телефон это переносимое правило: **один канонический файл в репо + тонкие шимы, а не копии**.
2. `skills/ubiquitous-language/SKILL.md` + `references/generating-thesaurus.md` — единый словарь `docs/THESAURUS.md` (grep-first формат 2.0; селекторы `kind:`, `ctx:`, `avoid:`, `Legacy`→канон, есть раздел `## Unresolved`), дефолтный путь `docs/THESAURUS.md`. Это ровно тот общий артефакт, которого не хватает нашей доске: одинаковые названия колонок/статусов/ролей и на ноутбуке, и на телефоне, и у агентов.
3. `skills/skills-management/SKILL.md` — инвариант «Maintain one active implementation of a frontmatter `name` per consumer topology» + `scripts/agents.py` (карта путей установки по агентам: `~/.claude/skills`, `~/.agents/skills`, `.agents/skills`, `~/.cursor/skills`, `~/.config/devin/skills`, …) + `scripts/audit_skill_duplicates.py` с preflight-режимом `--candidate <path> --fail-on-conflict`. Это переносимый механизм «что где лежит и не разъехалось ли».
4. Осторожная, но полезная норма FPF (`19-a-15-5-…-work-entry-readiness…`): «Persist the local result as a C.2.1 episteme only when another use must rely on it» — что вообще заслуживает быть записанным в общее состояние, а что нет.
5. `skills/plan-mode/PROTOCOL.md` — «Re-check the working tree and the relevant files» в начале реализации: дешёвый протокол сверки состояния перед работой (актуально для двух устройств).
6. `skills/fpf-problem-solving/README-RU.md` — единственный русскоязычный README в репо; сам FPF-скилл описан как русскоязычно-ориентированный (объяснения «thinking verbs» даны по-русски). Полезно, если доска делается «русской в первую очередь».

## 6. Оговорки и чего я не смог получить

- `README.md` заявляет «(+ ru/zh/pt-BR translations)», но в корне репо по факту только `README.md` — файлов переводов нет (файлы переводов я не нашёл; в структуре — только `README-RU.md` внутри FPF-скилла). Считаю заявление README устаревшим.
- FPF-скилл — ~16 МБ нормативной прозы (15 директорий, 395 файлов); это **онтологический словарь, а не готовая схема данных**. Копировать надо формулировки правил, а не структуру целиком.
- Канбан-модель, диспетчер карточек и роль PM в этом репо отсутствуют — соответствующие части ожидаются в `CodeAlive-AI/pragmatic-orchestration` (там же `agents-consilium`/`porch`) и `CodeAlive-AI/vibe-stack`; их я не исследовал (другой источник).
- `windows-qa-engineer` и хук `bash-guard` подробно не разбирал, кроме `DESIGN.md` (нужен был только принцип `allow|ask`).

## 7. Evidence (что именно открывалось)

| Источник (URL / путь) | Что показал |
|---|---|
| https://github.com/CodeAlive-AI/ai-driven-development | Листинг корня: `.claude-plugin/`, `hooks/balanced-safety-hooks`, `skills`, `AGENTS.md`, `CLAUDE.md`, `LICENSE`, `README.md` (файлов переводов нет) |
| https://raw.githubusercontent.com/CodeAlive-AI/ai-driven-development/main/README.md | Бейджи «24 Skills / 1 Hook / 12+ Agents», текст «23 skills + 1 hook», таблицы скиллов по разделам, «Working principles» (4 принципа), структура репо, Heritage, перенос `agents-consilium` в `pragmatic-orchestration` |
| https://github.com/CodeAlive-AI/ai-driven-development/tree/main/skills | Листинг каталогов скиллов (22 шт.) |
| https://raw.githubusercontent.com/CodeAlive-AI/ai-driven-development/main/AGENTS.md | Правила разработки репо: коммит/пуш в `main` по умолчанию, теги только при изменении скиллов/хуков/плагина, семвер, релиз-процесс, запрет коммитить `.skill_snapshots/`, `.skill_edit_log.jsonl` |
| `git clone --depth 1 https://github.com/CodeAlive-AI/ai-driven-development.git /tmp/aidd` → HEAD `af4035b657a54c9a6ff7deb85af070f494892d82` (2026-09-22) | Локальная копия для точного grep/diff; `skills/*/` = 22 каталога; `.claude-plugin/plugin.json` version `10.0.0` |
| `skills/plan-mode/SKILL.md` | Гейт: 8 шагов «Understand → plan → get approval → implement → validate»; запрет мутаций; «Counts as approval» / «Does not count»; правила вопросов |
| `skills/plan-mode/PROTOCOL.md` | Полный протокол: allowed/not allowed, investigation workflow, task analysis, классификация Ambiguity/Contradiction/Blocker/Risk/Assumption, шаблон вопроса с «Recommended default», шаблон плана, quality bar, gotchas, шаблон финального отчёта |
| `skills/bug-fix-protocol/SKILL.md` | 8 шагов, «two failures in one», шаг 8 обязателен, что возвращать в отчёте |
| `skills/code-that-fits-in-your-head/SKILL.md` | Философия, индексы `references/*`, 5 `workflows/`, раздел про «agent-native» правки |
| `skills/code-that-fits-in-your-head/workflows/add-feature-outside-in.md` | 10 шагов, Step 0 «выбираю гранулярность цикла», требование acceptance/non-regression/verification/recovery для больших фич, Exit Criteria |
| `skills/code-that-fits-in-your-head/workflows/review-code.md` | 8 шагов ревью, «Read the Tests First», блок при отсутствии теста на изменение поведения, Exit Criteria |
| `skills/agentic-readiness/SKILL.md` | Audit-only по умолчанию, `scripts/audit_repo.py --root .`, «Verify required commands and hooks actually work» (allowed/violating fixture, «not verified») |
| `skills/agentic-readiness/references/rubric.md` | Шкалы 0–4 по 5 осям, «definition of done» на уровне 3, CI/хуки как уровень 4, запрет прятать P0 |
| `skills/agentic-readiness/references/instruction-files.md` | «Use one shared source of truth», `AGENTS.md` + `CLAUDE.md` c `@AGENTS.md`, таблица discovery по Codex/Claude/OpenCode/Devin (лимиты, 32 KiB, <200 строк, пять хопов импорта) |
| `skills/ubiquitous-language/SKILL.md` | Четыре режима, дефолт `docs/THESAURUS.md` (стр. 74), grep-рецепты (`kind:`, `ctx:`, `avoid:`, `\`Basket\` →`), связь с DDD/FPF |
| `skills/ubiquitous-language/references/generating-thesaurus.md`, `references/naming-audit.md` | Дефолтный путь и формат словаря; аудит нейминга по слоям, раздел `## Index` и `## Unresolved` |
| `skills/skills-management/SKILL.md` | Полная таблица команд (`review_skill.py`, `audit_skill_duplicates.py --fail-on-conflict`, `optimize_skill.py`, `blind_comparator.py`, `eval_viewer.py`, …), инвариант одного активного скилла на имя, проверки ревью (token footprint 300–2000, procedurality, patch-friendliness, slow-update маркеры >500 строк) |
| `skills/skills-management/scripts/agents.py` (grep) | Карта путей установки скиллов по агентам (`~/.claude/skills`, `~/.agents/skills`, `.agents/skills`, `~/.cursor/skills`, `~/.config/devin/skills` и др.) |
| `skills/agentic-readiness/references/` — grep `laptop|phone|mobile` по 4 скиллам | Совпадений нет; `sync`/`handoff` — только про передачу задачи (`skill-deduplication.md:64`, `06-patterns-and-troubleshooting.md:61`) |
| `skills/fpf-problem-solving/SKILL.md`, `README-RU.md`, `sections/02-table-of-contents/_index.md` (459 строк) | FPF как agentic-RAG router по «thinking verbs» → `_index.md` → узкий подраздел; русскоязычный README; индекс паттернов A.1–A.22, B, C, D, E, F, G |
| `.../07-cluster-a-v---…/16-a-15-2---u-workplan.md` | `U.WorkPlan`: §A.15.2:4.2 «`PlanItem` content» (10 пунктов, в т.ч. dependencies/acceptance targets), §A.15.2:4.3 таблица «schedule/workflow/process/plan», §A.15.2:5 review checklist, §A.15.2:7b «Plan-as-actual … Kanban ticket» |
| `.../07-cluster-a-v---…/15-a-15-1---u-work.md`, `19-a-15-5-…`, `20-a-15-6-…`, `21-a-15-7-…`, `23-a-15-9-…` | `U.Work` (план ≠ работа ≠ лог ≠ дашборд); A.15.5 readiness-вердикт; A.15.6 восстановление смысла «проект/процесс/кейс»; A.15.7 next-action (Decision now / Performer / Stop and feedback); A.15.9 заказ ограниченного результата у другой практики |
| `.../07-cluster-a-v---…/12-a-13---the-agential-role-agency-spectrum.md`, `14-a-15---system-role-method-work-alignment.md` | Разделение вида системной роли/назначения/метода/плана/работы; предупреждение о смешении под словами «role/process/workflow/activity» |
| `.../07-cluster-a-v---…/45-a-21---gate-decisions-from-independent-check-results.md` | A.21 `GateDecisionResult`: перечислить каждую проверку, требуемую правилом гейта (субъект + критерий) |
| `.../13-part-g---…/07-g-5---multi-method-dispatcher-and-methodfamily-registry.md` | Реестр `MethodFamilyRowRef = <MethodFamilyId, rowEdition>`, закрытые `SelectorOutcomeKind`/`SetResultFamily` (Shortlist / RankedShortlist / JointUseSet / SpecialistHandoff / abstain / escalation), basis pins, «не пересобирать реестр на каждом прогоне», «не делать вид, что всегда есть один скалярный победитель» |
| `hooks/balanced-safety-hooks/DESIGN.md` | v3/v3.2/v3.3: AST-парсинг Bash через `mvdan.cc/sh`, внутренние решения `allow|ask` (не `deny` — «agents trivially bypass deny by rephrasing»), `/tmp` в allowlist, latency 0–10 ms warm, Codex-адаптер маппит `ask`→`deny` |
| `~/.pi/agent/skills/` + `diff -rq --strip-trailing-cr` против `/tmp/aidd/skills/` | `prompt-engineering`, `ubiquitous-language`, `code-that-fits-in-your-head` — идентичны HEAD; установлены только эти 3 из 22 |
| `~/.hermes/skills/` (134 `SKILL.md`) | Ни одного скилла из этой коллекции (поиск по именам — 0) |
