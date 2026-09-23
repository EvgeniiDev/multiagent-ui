# Hermes Kanban — как устроена встроенная доска (исследование для панели acp-ui)

**Дата:** 2026-09-23 · **Хост:** Linux 6.8.0-139-generic, пользователь `hermes`
**Версия Hermes:** `v0.21.0 (2026.8.31) · upstream c0d72947 · local 06a5b9c9 (+2 carried commits)`, install dir `/home/hermes/hermes-agent` → фактически `/home/hermes/.hermes/hermes-agent` (git)

**Легенда:** `[П]` = проверено запуском команды или чтением кода/файла на этом хосте. `[Д]` = взято из документации/help-текста, прямыми экспериментами не подтверждалось (помечено как вывод/документация).

---

## 0. Краткая модель

Hermes Kanban — это «доска задач поверх SQLite», общая для **всех** профилей Hermes на одной машине. Каждая задача — строка в `tasks`, каждая попытка исполнения — строка в `task_runs`, каждое изменение — строка в `task_events` (append-only). Доска имеет два «входа»:

1. **CLI `/ `hermes kanban …`** — для человека, cron и скриптов (это наш интеграционный шов).
2. **Набор модельных инструментов `kanban_*`** — для агента внутри сессии (диспетчер-спавненный воркер или профиль, у которого включён toolset `kanban`).

Обе поверхности ходят в один и тот же Python-слой `hermes_cli/kanban_db.py`, поэтому «не могут разъехаться» `[Д]` (и подтверждается тем, что и CLI, и инструменты импортируют `kanban_db`).

---

## 1. Модель данных

### 1.1 Доска (board)

`[Д]` Доска = отдельная очередь задач со **своей БД**, каталогом воркспейсов, каталогом логов и своим циклом диспетчера. Изоляция между досками абсолютная: задачи одной доски не видны воркерам другой (диспетчер прокидывает `HERMES_KANBAN_BOARD`).

`[П]` Порядок разрешения доски (`hermes_cli/kanban_db.py`, докстринг модуля): `board=` аргумент > `HERMES_KANBAN_BOARD` > `HERMES_KANBAN_DB` (пинит путь к файлу) > `<root>/kanban/current` > `default`.

`[П]` Файлы на этом хосте:

```
/home/hermes/.hermes/kanban.db             139264 B  ← доска default (back-compat путь)
/home/hermes/.hermes/kanban.db-wal / -shm            ← WAL
/home/hermes/.hermes/kanban.db.dispatch.lock          ← single-writer лок тика диспетчера
/home/hermes/.hermes/kanban.db.init.lock
/home/hermes/.hermes/kanban/.dispatcher.lock          ← singleton-лок встроенного диспетчера
```

`[Д]` Новая доска: `~/.hermes/kanban/boards/<slug>/kanban.db` + свои `workspaces/`, `logs/`, `attachments/<task_id>/`. Плюс `HERMES_KANBAN_ATTACHMENTS_ROOT` переопределяет каталог вложений.

`[П]` `hermes kanban boards list` на хосте:

```
    SLUG                      NAME                          COUNTS
●   default                   Default                       (empty)

Current board: default
```

(надпись «(empty)» — про счётчики задач доски, при этом 5 задач в `tasks`; команда показывает только агрегат.)

### 1.2 Задача (task / карточка)

`[Д]` «Task — a row with title, optional body, one assignee (a profile name), status (`triage | todo | ready | running | blocked | review | done | archived`), optional tenant namespace, optional idempotency key».

`[П]` Реальная схема `tasks` (выведена из `sqlite_master` живого `~/.hermes/kanban.db`, колонки — `PRAGMA table_info`):

```
id, title, body, assignee, status, priority, created_by, created_at, started_at,
completed_at, workspace_kind, workspace_path, branch_name, project_id,
claim_lock, claim_expires, tenant, result, idempotency_key,
consecutive_failures, worker_pid, last_failure_error, max_runtime_seconds,
last_heartbeat_at, current_run_id,
workflow_template_id, current_step_key,          ← зарезервировано под v2-роутинг, v1 игнорирует
skills, model_override, provider_override, reasoning_effort, max_retries,
goal_mode, goal_max_turns, session_id, block_kind, block_recurrences
```

Комментарии прямо в DDL `[П]`:

- `priority INTEGER DEFAULT 0` — тайбрейкер (в CLI `--priority`, сортировки `priority`, `priority-desc`).
- `consecutive_failures` — «Unified consecutive-failure counter. Incremented on spawn failure, timeout, or crash; reset only on successful completion» (circuit breaker диспетчера).
- `claim_lock` / `claim_expires` — CAS-лок атомарного клейма.
- `current_run_id` — «Pointer into task_runs for the currently-active run (NULL if no run is in-flight). Denormalised for cheap reads».
- `project_id` — связь с first-class Project (`hermes_cli/projects_db`), якорит worktree задачи в primary-репе проекта.

Отдельная сущность — **run** (попытка). `[П]` Схема `task_runs`:

```
id, task_id, profile, step_key,
status  -- running | done | blocked | crashed | timed_out | failed | released
claim_lock, claim_expires, worker_pid, max_runtime_seconds, last_heartbeat_at,
started_at, ended_at,
outcome -- completed | blocked | crashed | timed_out | spawn_failed | gave_up | reclaimed | (null)
summary, metadata, error
```

`[П]` Остальные таблицы: `task_links(parent_id, child_id)` — рёбра зависимостей (PK по паре), `task_comments(id, task_id, author, body, created_at)`, `task_events(id, task_id, run_id, kind, payload, created_at)`, `task_attachments(id, task_id, filename, stored_path, content_type, size, uploaded_by, created_at)`, `kanban_notify_subs(task_id, platform, chat_id, thread_id, …)`.

`[П]` Живые данные на хосте (read-only дамп через `python3 sqlite3`):

```
tasks columns: [id, title, body, assignee, status, priority, created_by, created_at, …]
{'id': 't_e2b17de1', 'title': 'Разработка мобильного приложения (Гермес-консоль)', 'assignee': None, 'status': 'ready', 'priority': 0, 'workspace_kind': 'scratch', 'created_by': 'user', 'tenant': None, 'current_run_id': None}
{'id': 't_d442502f', … 'status': 'todo' …}
… всего 5 задач, distinct status = ['ready','todo']
links: [('t_e2b17de1','t_d442502f'), ('t_e2b17de1','t_bbab41e1'), ('t_e2b17de1','t_ed65b022'), ('t_e2b17de1','t_54d58b45')]  ← это --parent на момент create
events kinds: created 5, commented 4, model_override_set 1, reasoning_effort_set 1
comments: 4 строки, author='default', тело начинается с "SPEC (обязательно к исполнению глупой моделью …)"
```

**Поля, которых НЕТ** (важно для нашей панели): нет этапов/стадийных колонок, нет роли-как-сущности, нет промпт-шаблона у роли, нет отдельного поля «спека» — спека живёт в `body` + `task_comments`. `assignee` — ровно одна строка (имя профиля Hermes), несколько исполнителей на карточке не выражаются (только через children/links).

### 1.3 Легенда CLI-соответствий (всё проверено `--help`)

| Что | Команда | Опция |
|---|---|---|
| создать | `hermes kanban create "<title>"` | `--body`, `--assignee`, `--parent` (repeatable), `--workspace scratch\|worktree\|worktree:<path>\|dir:<path>`, `--branch`, `--project`, `--tenant`, `--priority`, `--triage`, `--idempotency-key`, `--max-runtime`, `--created-by`, `--skill` (repeatable), `--max-retries`, `--model`, `--provider`, `--goal`, `--goal-max-turns`, `--initial-status {blocked,running}`, `--json` |
| связи | `hermes kanban link <parent_id> <child_id>` / `unlink` | — |
| исполнитель | `assign <id> <profile\|none>`, `reassign <id> <profile> [--reclaim]` | — |
| модель | `set-model <id> [model] [--provider]` | «takes effect on the next dispatch» |
| коммент | `comment <id> <text…>` | `--author`, `--max-len` |
| вложения | `attach`, `attachments`, `attach-rm` | — |
| парсинг | `list`, `ls`, `show`, `runs`, `log`, `tail`, `watch`, `stats`, `context`, `diagnostics/diag`, `assignees` | `--json` почти везде |

---

## 2. Жизненный цикл

### 2.1 Значения статуса `[П]`

Из `hermes kanban list --help` (полный список выбора):

```
--status {archived,blocked,done,ready,review,running,scheduled,todo,triage}
```

`[П]` `hermes kanban stats` печатает колонки: `triage, todo, scheduled, ready, running, blocked, done` (+archived). Т.е. фактических статусов **9**: `triage | todo | scheduled | ready | running | blocked | review | done | archived`. Докс-строка в `[Д]` перечисляет 8 и не упоминает `scheduled` — это расхождение документации с кодом, верен CLI.

### 2.2 Переходы, доступные из CLI `[П]` (формулировки из `--help`)

- `claim <id> [--ttl]` — «Atomically claim a ready task (prints resolved workspace path)».
- `complete <ids…> [--result] [--summary] [--metadata]` — «Mark one or more tasks done».
- `block <id> "<reason>" [--ids …] [--kind {capability,dependency,needs_input,transient}]` — `dependency` уходит в `todo` (ждёт родителей, авто-промоут), `needs_input`/`capability` — в `blocked` для человека, `transient` — «maybe-flaky failure»; повторные same-kind ре-блоки уводят в `triage` (breaker незакрытых циклов).
- `schedule <ids…> "<reason>"` — «Park one or more tasks in Scheduled (waiting on time, not human input)».
- `unblock <ids…> [--reason]` — «Return blocked/scheduled tasks to ready, or todo while parents remain open»; никогда не возвращает напрямую в `triage`.
- `request-review <id> [--summary] [--reviewer] [--metadata] [--force]` — «Move a task to 'review' … — NOT a block».
- `request-changes <id> "<reason>"` — «Reviewer verdict: return the active review run to its implementer».
- `reopen-review <ids…> [--reason]` — «(review -> ready/todo)».
- `promote <id> [--force] [--dry-run] [--json]` — «Manually move one or more todo/blocked tasks to ready (recovery path)».
- `archive <ids…>` / `archive --rm <ids…>` (перманентное удаление уже архивных).
- `reclaim <id> [--reason]` — «Release an active worker claim on a running task».
- `edit --result … <id>` — правка полей уже завершённой задачи (recovery).
- `specify` — triage → todo (дополняет спеку aux-LLM), `decompose` — triage → граф детей.

«Кто может выполнять» `[П]`: CLI не имеет RBAC/аутентификации — это локальный процесс с uid пользователя; любые переходы делает любой вызов CLI/`/kanban`/REST-dashboard. Ограничения, которые реально есть в коде:

- **Воркер, поднятый диспетчером, заперт на свою задачу** — `tools/kanban_tools.py:164 _enforce_worker_task_ownership`: «worker is scoped to task {env}; refusing to mutate {tid}».
- **Оркестраторские инструменты (`kanban_list`, `kanban_unblock`) скрыты от воркера задачи** — `tools/kanban_tools.py:79 _check_kanban_orchestrator_mode` (`to_env_worker=False`).
- **`delegate_task`-дети вообще не могут менять доску** — `hermes_cli/kanban_db.py:121 _assert_not_delegated_child_mutation` → `PermissionError("delegate_task child contexts cannot mutate Kanban tasks or boards")`; в CLI — fast-fail список `_DELEGATED_CHILD_DENIED_ACTIONS` (`hermes_cli/kanban.py:213`), в инструментах — `_visible()` возвращает `False` для delegated child.

### 2.3 Как задача завершается

`[Д]` Контракт «every claim must end in exactly one of»:

1. `kanban_complete(summary, metadata[, result])` → `done`;
2. `kanban_request_review(summary, metadata, reviewer)` → `review` (диспетчер по умолчанию поднимает встроенный skill `sdlc-review`, пока `kanban.review_dispatch: true`);
3. `kanban_block(reason)` → `blocked`;
4. процесс вышел без терминального tool-call → `crashed` / `gave_up` / `timed_out` (аварийный путь).

`[Д]` Плюс «agent-side prevention»: перед выходом воркеру подкидывают до 2 синтетических «nudge», напоминающих вызвать `kanban_complete`/`kanban_block`; если и это не помогло — `protocol_violation` (бюджет по умолчанию 3 подряд), дальше авто-блок.

`[П]` На этом хосте `kanban.review_dispatch: true` задан явно в `~/.hermes/config.yaml:209-210`.

`[Д]` `complete` без клейма тоже работает: ядро синтезирует zero-duration run, чтобы handoff не потерялся. Bulk-close с `--summary` запрещён (`complete a b c --summary X` refused), без `--summary` — разрешён.

---

## 3. Диспетчер (dispatch)

### 3.1 Что запускает и с какой частотой

`[Д]` Диспетчер — «long-lived loop that, every N seconds (default 60): reclaims stale claims, reclaims crashed workers, promotes ready tasks, atomically claims, spawns assigned profiles. Runs **inside the gateway** by default (`kanban.dispatch_in_gateway: true`). One dispatcher sweeps all boards per tick».

`[П]` Код: `gateway/kanban_watchers.py:207` — `if not kanban_cfg.get("dispatch_in_gateway", True): logger.info("kanban dispatcher: disabled via config …")`; настройки читаются из `kanban.*` один раз при старте (`gateway/kanban_watchers_dispatcher.py:_DispatcherSettings`: `interval`, `max_spawn`, `max_in_progress`, `failure_limit`, `stale_timeout_seconds`, `reconcile_orphans`, `default_assignee`, `max_in_progress_per_profile`). Рантайм-оверрайд — env `HERMES_KANBAN_DISPATCH_IN_GATEWAY` `[Д]`.

`[П]` Диспетчер **живой на этом хосте прямо сейчас**: gateway работает как systemd-user unit `hermes-gateway.service` (active 4 дня, PID 2280901), а `~/.hermes/logs/gateway.log` содержит строки:

```
2026-09-18 19:24:16,954 ERROR gateway.run: kanban dispatcher: tick failed on board default
2026-09-19 18:05:39,589 INFO gateway.run: kanban dispatcher: reaped 1 zombie worker(s), pids=[3527457]
2026-09-22 18:03:50,218 INFO gateway.run: kanban dispatcher: reaped 1 zombie worker(s), pids=[3902450]
```

`[П]` Ручной «тик» из CLI: `hermes kanban dispatch [--dry-run] [--max N] [--failure-limit N] [--json]` — «One dispatcher pass: reclaim stale, promote ready, spawn workers». Отдельный `hermes kanban daemon` помечен **DEPRECATED** («dispatcher now runs in the gateway. Use `hermes gateway start`»).

`[П]` Конкурентность тика: `dispatch_once()` берёт non-blocking single-writer лок по пути к БД (`_dispatch_tick_lock`); проигравший возвращает пустой результат с `skipped_locked=True` и ничего не пишет. Ключ — resolved путь БД, поэтому разные доски тикают параллельно.

### 3.2 Как выбираются задачи `[П]`

`dispatch_once` → «promote todo → ready, then atomically claim each spawnable ready/review row and spawn». Клейм — CAS в одной транзакции: `hermes_cli/kanban_db.py:2137 claim_task()` — «Atomically transition `ready -> running`», под `write_txn` (WAL + `BEGIN IMMEDIATE`), с проверкой `_parents_satisfied` (если родитель не готов — задача демотируется в `todo` и пишется `claim_rejected: parents_not_done`). Docстринг модуля: «SQLite serializes writers so one claimer wins, losers see zero rows (no retries, no distributed locks)».

`[П]` «Spawnable» определяется наличием профиля: `kanban_db_dispatch.py:1229 _has_spawnable()` → `SELECT DISTINCT assignee FROM tasks WHERE status=? AND assignee IS NOT NULL AND claim_lock IS NULL` и затем проверка `profile_exists(assignee)`. Неизвестный assignee → в результат попадает `skipped_nonspawnable` (событие `skipped_nonspawnable`, задача остаётся на `ready`) `[Д]`.

`[П]` Порядок предпочтения: если есть spawnable review-работа и есть бюджет — приоритет отдаётся review (`_any_spawnable_review`, код около строки 1787).

### 3.3 Как спавнится воркер — точная команда и env `[П]`

`kanban_db_dispatch.py:2086 _worker_argv()`:

```
<hermes> -p <assignee> --cli --accept-hooks
         [--skills <name>]…            # из task.skills, по одному флагу на навык
         [-m <model_override> [--provider <provider_override>]]
         [--reasoning <reasoning_effort>]
         [--toolsets <a,b,c>]          # если удалось разрешить
         chat -q "work kanban task <task_id>"
         [-Q]                          # только для goal-mode
```

Env, который ставит `_default_spawn()` (`kanban_db_dispatch.py:2163`): `HERMES_HOME` (профильный!), `HERMES_TENANT`, `HERMES_KANBAN_TASK`, `HERMES_KANBAN_WORKSPACE`, `HERMES_SESSION_SOURCE=kanban`, `TERMINAL_CWD=<workspace>` (если абсолютный существующий каталог), `HERMES_KANBAN_BRANCH`, `HERMES_KANBAN_RUN_ID`, `HERMES_KANBAN_CLAIM_LOCK`, `HERMES_KANBAN_GOAL_MODE`/`_GOAL_MAX_TURNS`, `HERMES_KANBAN_DB`, `HERMES_KANBAN_WORKSPACES_ROOT`, `HERMES_KANBAN_BOARD`, `HERMES_PROFILE`; плюс снимаются `TERMINAL_TIMEOUT`-оверрайды от `max_runtime_seconds` и убирается `HERMES_TUI`. Спавн — `subprocess.Popen(..., start_new_session=True)`, stdout/stderr → `<board-root>/logs/<task_id>.log`, **PID возвращается** диспетчеру для детекта краша. `[П]` В списке из `worker-lanes.md` упомянут ещё `HERMES_KANBAN_WORKSPACE(S_ROOT)`/`claim_lock` — совпадает с кодом.

Документация `[Д]` («worker lanes»): «Wiring a non-Hermes CLI tool (Codex CLI, Claude Code CLI, OpenCode CLI …) as a kanban worker lane is *not yet a paved path*. The dispatcher's spawn function is pluggable (`spawn_fn` is a parameter on `dispatch_once`), and a plugin could register its own `spawn_fn` for a non-Hermes assignee, but the surrounding integration work … is still per-integration design work.»

`[П]` Подтверждение в коде: `dispatch_once(conn, *, spawn_fn=None, …)`; если `spawn_fn is None` — используется `_default_spawn`. CLI-путь (`hermes kanban dispatch`) `spawn_fn` не передаёт → из CLI подменить спавнер нельзя.

### 3.4 Набор инструментов у воркера `[П]`

- `--toolsets` воркера вычисляется как набор CLI-платформы **профиля assignee**: `_resolve_worker_cli_toolsets()` → `_get_platform_tools(cfg, "cli")` в контексте профильного `HERMES_HOME` (комментарий: пин нужен, «so worker startup cannot fall back to a stale root/active-profile config»).
- Сверх этого `model_tools.py:313 _select_tool_names()` **принудительно добавляет toolset `kanban`**, если `HERMES_KANBAN_TASK` установлен, контекст не delegated-child и это dispatcher-owned worker.
- Toolset `kanban` (`toolsets.py:144`) = все `kanban_*` из `_HERMES_CORE_TOOLS`: `kanban_show, kanban_list, kanban_complete, kanban_block, kanban_request_review, kanban_request_changes, kanban_heartbeat, kanban_comment, kanban_create, kanban_link, kanban_unblock, kanban_attach, kanban_attach_url, kanban_attachments`.
- Плюс `check_fn`-гейт `tools/kanban_tools.py:64 _visible()`: delegated child → нет инструментов; dispatcher-owned env-worker → только lifecycle-набор (`to_env_worker=True`); иначе — решает toolset профиля. `kanban_list`/`kanban_unblock` — orchestrator-only.
- Стековая дисциплина: воркер видит **только свою** задачу и не может мутировать чужую.

### 3.5 Изоляция / конкурентность

`[Д]` `kanban.max_in_progress` (по умолчанию не задан → берётся memory-derived дефолт `[П]`, см. `_resolve_dispatcher_settings`), `kanban.max_in_progress_per_profile`. Воркспейсы: `scratch` (удаляется после complete, артефакты копируются в attachments), `dir:<abs path>` (сохраняется), `worktree[:<path>]` (git worktree под `.worktrees/<id>/`, сохраняется). Клейм-лок с TTL и heartbeat-механикой: `DEFAULT_CLAIM_TTL_SECONDS` 15 мин, живой PID → продление, мёртвый → reclaim; `stale` при `kanban.dispatch_stale_timeout_seconds` (4 ч) без heartbeat в последний час.

### 3.6 Аварийная остановка `[П]`

```
$ hermes pause --help
usage: hermes pause [-h] [--reason REASON]
Engage the global emergency stop. Halts NEW work only — cron dispatch, kanban
dispatch, and new gateway turns — until `hermes resume`. In-flight work is
never killed.

$ hermes resume --help
usage: hermes resume [-h]
Remove the ESTOP sentinel; dispatch resumes on the next tick.
```

`[П]` Механика: `agent/estop.py` (`SENTINEL_NAME = "ESTOP"`, `sentinel_path() = <hermes_home>/ESTOP`, `engage/disengage/is_engaged/get_state/check_paused`). Диспетчер kanban уважает его через `gateway/kanban_watchers_common.py:104-110` → `check_paused("kanban", logger)`. Файловый fail-safe: можно просто `touch ~/.hermes/ESTOP` `[П]` (докстринг модуля). `/pause` и `/pause off` в gateway делают то же `[П]` (`gateway/run_busy.py:779-791`).

---

## 4. Доставка спеки воркеру

`[П]` Единственная функция сборки контекста — `hermes_cli/kanban_db.py:3718 build_worker_context()`. Порядок секций (из вызовов `_ctx_*`):

```
# Kanban task <id>: <title>
Assignee / Status / Tenant / Workspace / Max runtime / Terminal timeout / Branch
## Body                    ← task.body (капнуто, _CTX_MAX_BODY_BYTES)
## Attachments             ← имя + АБСОЛЮТНЫЙ путь каждого файла
## Prior attempts          ← outcome/summary/error прошлых runs этой же карточки
## Parent task results     ← summary + `_metadata_: {...}` завершённых родителей, verbatim
## (role history)          ← недавняя работа того же профиля
## Comment thread          ← все комментарии, newest-capped
```

Всё tail-capped/char-capped (`_CTX_MAX_*`), чтобы промпт не раздувался на «патологических» досках `[П]`.

`[П]` Живой пример конца этого контекста (для `t_d442502f`, вырезано):

```
# Kanban task t_d442502f: Перевести приложение полностью на английский

Assignee: (unassigned)
Status:   todo
Workspace: scratch @ (unresolved)

## Body
Сейчас в Гермес-консоли смесь английского и испанского …

## Comment thread
comment from worker `default` at 2026-09-11 07:14, 12d ago:
SPEC (обязательно к исполнению глупой моделью — не додумывать, только этот текст + указанные файлы).
… [truncated, 445 chars omitted]
```

Каналы доставки:

- **Инструменты**: `kanban_show()` без аргументов (берёт `HERMES_KANBAN_TASK`), `kanban_comment`, `kanban_attach(_url)` `[П]`.
- **CLI для человека/скриптов**: `hermes kanban context <id>` — «Print the full context a worker sees for a task (title + body + parent results + comments)»; `hermes kanban show <id>` — задача + комментарии + события `[П]`.
- **Системный промпт**: блок `KANBAN_GUIDANCE` (`agent/prompt_builder.py:233`) инжектится воркеру автоматически — «nothing to install or configure» `[Д]`.
- **Дополнительно**: вложения (`attachments/<task_id>/`), `--skill`-пины, `metadata` родителей.

Что говорят доки про «worker-proof» спеки `[Д]`:

- Для goal-mode: «The judge is only as good as your goal text, so write the body as **explicit acceptance criteria**».
- «**Decide before you fan out.** … Workers cannot see sibling cards, so every child card body must carry every decision it depends on» — оркестратор обязан выдать общие решения (формат файла, схема, имена) в тело каждой дочки.
- Handoff: `summary` = человеческая выжимка, `metadata` = машиночитаемый JSON; рекомендованная форма — `changed_files`, `verification`, `dependencies`, `blocked_reason`, `retry_notes`, `residual_risk`. «Keep secrets, raw logs, tokens, OAuth material … out of metadata».
- Донорство контекста вниз — только через `--parent <done-card-id>` (секция `## Parent task results`); завершённые карточки иммутабельны, для доработки создаётся **новая** дочерняя карточка.
- Читать спеку воркеру «на входе» больше нечем — `body` + тред комментариев + родительские summary/metadata.

---

## 5. Пригодность для нашей панели

Наши пять требований — разбор по одному.

### 5.1 Стадийные колонки с per-card статусом → **as-is, если стадии = встроенные статусы; иначе тонкий адаптер**

`[П]` Колонки dashboard-плагина = статусы: `triage, todo, ready, running, blocked, done` (+`archived`), плюс per-profile «лейны» внутри Running. `review` — отдельный статус в CLI/БД. Кастомизации колонок нет; `workflow_template_id`/`current_step_key` есть в схеме, но `[П]` «In v1 the kernel writes these when the task is opted into a template but otherwise ignores them; the dispatcher doesn't consult them for routing yet».

Вывод: если наши стадии ложатся на 9 встроенных (Backlog=todo, In Progress=running, Review=review, Done=done и т.п.) — берём как есть, per-card статус родной. Именованные/произвольные стадии (например «Анализ», «Сборка», «Приёмка QA» сверх стандартных) встроенной доской не выражаются: нужен либо panel-side слой (маппинг наших колонок ↔ 9 статусов), либо наш собственный model + доска Hermes как «движок исполнения».

### 5.2 Роли (executor + model + prompt), привязанные к стадии → **тонкий адаптер, роли — panel-side**

Что есть в Hermes `[П]`:

- `assignee` = **имя профиля Hermes** (одна на карточку).
- `--model`/`--provider` и `set-model` — пер-задачный пин модели, «takes effect on the next dispatch».
- `--skill` (repeatable) — форс-загрузка навыков воркера; `--reasoning`, `--goal`, `--max-runtime`, `--max-retries`.
- Промпт роли: не существует как сущность; есть тело карточки + авто-инжект `KANBAN_GUIDANCE` + (для оркестратора) авто-инжект orchestrator-гайденса. Описания профилей (`hermes profile describe`) влияют только на LLM-роутинг декомпозера.
- «Роль → стадия» привязки нет: `[П]` assignee ставится на карточке в момент create/assign, а не при переходе стадии.

Вывод: таблица «стадия → (executor, model, prompt)» должна жить в нашей панели; при переходе стадии наш диспетчер пишет в карточку `assignee`/`set-model`/`--skill`, а промпт передаёт как `--body`/комментарий либо как отдельный блок в наш собственный prompt (Hermes его не знает). Если executor — не профиль Hermes (OpenCode/Devin/Pi), встроенная привязка не работает вообще (см. 5.3).

### 5.3 Диспетчер, который клеймит карточку и запускает **наш** бридж (Hermes/OpenCode/Devin/Pi по ACP) → **отдельная panel-side логика клейма поверх Hermes-доски**

Факты:

- `[П]` Встроенный `_default_spawn` умеет только `hermes -p <profile> chat -q`. Никаких ACP-клиентов он не запускает.
- `[Д]` CLI-лейн для внешних агентов — «not yet a paved path»; `spawn_fn` плагируемый, но только in-process (`dispatch_once(spawn_fn=…)`), CLI-команда его не отдаёт `[П]`.
- `[П]` Хуки `on_kanban_worker_spawned`, `kanban_task_claimed`, `on_kanban_dispatch_tick` — **observer-only, return ignored** → перехватить/подменить спавн хуком нельзя (в `hooks.md:470-477` это указано явно; `_fire_dispatch_tick_hook` тоже «Observer-only and fully best-effort»).
- `[П]` Но `claim` — публичный CLI-верб с CAS: `hermes kanban claim <id> [--ttl 900]` и он **печатает resolved workspace path**; в ядре `claim_task(conn, task_id, claimer=…)` принимает внешнего клеймера.
- `[П]` Завершение тоже публичное: `hermes kanban complete <id> --summary … --metadata '{…}'` / `block --kind …` / `request-review`.

Схема интеграции (предлагаемая, панель держит свой dispatch-цикл):

1. Наши карточки держим в статусе `ready` с `assignee`, которого **нет** среди профилей Hermes → встроенный диспетчер их не спавнит (`_has_spawnable` вернёт False, событие `skipped_nonspawnable`, задача остаётся `ready`) `[П]/[Д]`. Альтернатива — целиком выключить встроенный диспетчер (`kanban.dispatch_in_gateway: false` или `HERMES_KANBAN_DISPATCH_IN_GATEWAY=0`) и владеть тиком самим.
2. Наш dispatcher вызывает `hermes kanban claim t_x --ttl N` → выигрывает CAS → получает workspace → запускает нужный бридж (Hermes/OpenCode/Devin/Pi по ACP) с `cwd=workspace`, передавая ему спеку из `hermes kanban context t_x`.
3. По завершении — `hermes kanban heartbeat t_x` во время долгих шагов (иначе reclaim по stale) и `complete`/`request-review`/`block` с `--summary`/`--metadata`.
4. Живая телеметрия — нам: `hermes kanban watch --kinds …` / `tail` / `runs --json` / `workers/active`; хуки — только как «наблюдатели» (`kanban_task_claimed` в процессе диспетчера, `completed/blocked` — в процессе воркера).

Важная оговорка по ACP: `[П]` ACP-сессия Hermes жёстко строится с toolset `hermes-acp` (`acp_adapter/session.py:390`, `server.py:423`), а `hermes-acp` = `_CODING_TOOLS` **без** всех `kanban_*` (`toolsets.py:66,183`). Значит «из коробки» Hermes-по-ACP доску через инструменты не двигает — либо ему нужен включённый toolset `kanban` в профиле/сессии, либо он работает через CLI-шелл (что ACP-агент умеет — у него есть `terminal`).

Второй подводный камень: `[П]` если наш бридж запускает Hermes-агента как `delegate_task`-ребёнка, у него `HERMES_DELEGATED_CHILD_CONTEXT=1` → kanban-инструменты скрыты, а любая мутация (включая CLI) отбивается `PermissionError`. На этом хосте именно так: `env | grep DELEGATED` → `HERMES_DELEGATED_CHILD_CONTEXT=1`, и `hermes kanban list/show/stats` падают с «could not initialize database: delegate_task child contexts cannot mutate Kanban tasks or boards» (см. §6).

### 5.4 Общий стейт для ноутбука и телефона → **as-is в пределах одного хоста; межхостовый шаринг — наш собственный**

`[П]` Физически состояние — один SQLite (+WAL) на хосте; доступ из двух клиентов на одной машине/сети обеспечен несколькими поверхностями:

- HTTP dashboard-плагин: `hermes dashboard` (по умолчанию `--port 9119 --host 127.0.0.1`), маршруты `/api/plugins/kanban/…` `[П]`, включая `POST /dispatch`, `GET /board`, `PATCH /tasks/:id`, `POST /tasks`, `POST /tasks/:id/comments`, `POST /links`, `GET /workers/active`, `POST /runs/{id}/terminate`, `WS /events?since=` `[П]`.
- `[Д]` Плагин-роуты dashboard **не требуют аутентификации** (middleware их пропускает), токен нужен только WebSocket'у; «If you run `hermes dashboard --host 0.0.0.0`, every plugin route — kanban included — becomes reachable from the network. **Don't do that on a shared host.**» Для телефона рекомендуемый путь — туннель/loopback.
- Телефон без dashboard: `/kanban …` из мессенджера (Telegram и др.) — тот же `run_slash`, и `/kanban` **обходит** gateway-guard «агент занят», т.е. читает/пишет доску даже посреди хода `[Д]`; плюс подписки `notify-subscribe --delivery-mode notify|notify+wake|wake`.
- Cross-host: `[Д]` «Kanban is deliberately single-host… Running a shared board across two hosts is not supported… If you need multi-host, run an independent board per host and use `delegate_task` / a message queue to bridge them.» Ручной перенос — `hermes kanban boards export` (упаковка задач/комментов/связей/истории/вложений, claims и PID-ы вычищаются) + `import`.

Вывод: если панель живёт на одном хосте (наш сервер = единственный writer), «ноутбук + телефон» решается бесплатно: читаем/пишем REST или БД. Если двум устройствам нужно видеть доску при разных хостах — нужен наш синхро-слой (репликация БД/CRDT/свой API); встроенного нет.

### 5.5 Конкретные швы интеграции (сводка)

| Шов | Что именно |
|---|---|
| CLI (главный) | `create/list/show/context/runs/log/tail/watch/stats/dispatch/claim/heartbeat/comment/complete/block/unblock/schedule/request-review/request-changes/reopen-review/promote/assign/reassign/set-model/link/unlink/archive/boards …`; `--json` почти везде |
| Файлы | `~/.hermes/kanban.db` (+`-wal`/`-shm`), `~/.hermes/kanban/boards/<slug>/kanban.db`, `<board-root>/logs/<task_id>.log`, `<board-root>/workspaces/<id>/`, `attachments/<task_id>/`, `~/.hermes/kanban/current`, `~/.hermes/ESTOP`, `*.lock` |
| HTTP | dashboard-плагин `/api/plugins/kanban/*` (§5.4), WS `/events`; OpenAI-совместимый API-сервер kanban-инструментов **не** имеет (`toolsets.py:191` — `_core_without(…, kanban=False)`) |
| Инструменты модели | `kanban_*` (список в §3.4); включаются либо env-воркером, либо toolset `kanban` в конфиге профиля (`platform_toolsets.cli`/`telegram` — на этом хосте включён `[П]`) |
| Хуки (только observer) | `kanban_task_claimed`, `kanban_task_completed`, `kanban_task_blocked`, `on_kanban_worker_spawned`, `on_kanban_worker_exited`, `on_kanban_worker_stale_claim`, `on_kanban_task_updated`, `on_kanban_dispatch_tick` |
| Уведомления | `notify-subscribe/list/unsubscribe`, `/kanban subscribe` в gateway; desktop-тосты |

### 5.6 Что придётся сделать самим (итог)

1. **Роли и промпты** (executor+model+prompt на стадию) — только panel-side; Hermes не знает про роли.
2. **Стадии сверх 9 статусов** — либо маппинг, либо свой model карточек.
3. **Свой dispatch-цикл для ACP-бриджей** — Hermes отдаёт атомарный `claim` + `complete/block`, но спавнит только свои профили; внешние лейны «not yet a paved path».
4. **Межхостовый шаринг** — вне scope встроенной доски.
5. **Осторожно с делегированием**: `delegate_task`-дети не могут даже читать доску через CLI — наши брокеры должны быть отдельными процессами/сессиями, не delegate-детьми.

---

## 6. Доказательства (реальные команды и вывод)

### 6.1 Версия и точка входа

```
$ which hermes
/home/hermes/.local/bin/hermes
$ hermes --version
Hermes Agent v0.21.0 (2026.8.31) · upstream c0d72947 · local 06a5b9c9 (+2 carried commits)
Install directory: /home/hermes/.hermes/hermes-agent
Install method: git
Python: 3.11.16
OpenAI SDK: 2.24.0
```

### 6.2 `hermes kanban --help` (дословно, начало)

```
usage: hermes kanban [-h] [--board <slug>]
                     {init,boards,create,swarm,list,ls,show,assign,set-model,reclaim,reassign,diagnostics,diag,link,unlink,claim,comment,attach,attachments,attach-rm,complete,edit,block,schedule,unblock,request-review,request-changes,reopen-review,promote,archive,tail,dispatch,daemon,watch,stats,notify-subscribe,notify-list,notify-unsubscribe,log,runs,heartbeat,assignees,context,specify,decompose,gc,repair}
                     ...

Durable SQLite-backed task board shared across Hermes profiles. Tasks are
claimed atomically, can depend on other tasks, and are executed by a named
profile in an isolated workspace. See https://hermes-
agent.nousresearch.com/docs/user-guide/features/kanban or docs/hermes-
kanban-v1-spec.pdf for the full design.
```

Полный список подкоманд и их назначений получен циклом `for c in …; do hermes kanban $c --help; done` (см. §1.3, §2, §3 — цитаты оттуда).

### 6.3 Read-only дамп живой БД (без CLI, чтобы не пройти через guard)

```python
con = sqlite3.connect("file:~/.hermes/kanban.db?mode=ro", uri=True)
# sqlite_master → таблицы: kanban_notify_subs, task_attachments, task_comments,
#                        task_links, task_runs, task_events, tasks
# tasks: 5 строк, task_links: 4, task_comments: 4, task_events: 11, task_runs: 0
```

Схемы `tasks`/`task_runs`/`task_links`/`task_comments`/`task_events`/`task_attachments` процитированы в §1.2.

### 6.4 Поведение под `delegate_task`-ребёнком (важный для нас факт)

```
$ hermes kanban list
kanban: could not initialize database: delegate_task child contexts cannot mutate Kanban tasks or boards
$ hermes kanban stats
kanban: could not initialize database: delegate_task child contexts cannot mutate Kanban tasks or boards
$ hermes kanban boards list
    SLUG                      NAME                          COUNTS
●   default                   Default                       (empty)

Current board: default
$ env | grep -i 'HERMES_KANBAN\|DELEGATED'
HERMES_DELEGATED_CHILD_CONTEXT=1
```

Причина в коде: `hermes_cli/kanban.py:213 _DELEGATED_CHILD_DENIED_ACTIONS` (+ `_DELEGATED_CHILD_DENIED_BOARD_ACTIONS`), а durable-граница — `hermes_cli/kanban_db.py:121-135 _assert_not_delegated_child_mutation()` → `PermissionError`. `boards list` проходит, потому что `boards` диспетчится **до** `init_db()` (`hermes_cli/kanban.py:156`), а `init_db` (и любой другой action) упирается в guard при открытии соединения.

Для получения read-only вывода в этом исследовании команды запускались с `env -u HERMES_DELEGATED_CHILD_CONTEXT`, **только чтение** (`stats`, `list`, `show`, `context`, `diagnostics`, `boards list`, все `--help`). Никаких мутаций доски не производилось.

### 6.5 Реальный read-only вывод CLI

```
$ env -u HERMES_DELEGATED_CHILD_CONTEXT hermes kanban stats
By status:
  triage    0
  todo      4
  scheduled  0
  ready     1
  running   0
  blocked   0
  done      0

Oldest ready task age: 1037703s

$ env -u HERMES_DELEGATED_CHILD_CONTEXT hermes kanban list
▶ t_e2b17de1  ready     (unassigned)          Разработка мобильного приложения (Гермес-консоль)
◻ t_d442502f  todo      (unassigned)          Перевести приложение полностью на английский
◻ t_bbab41e1  todo      (unassigned)          Прикрутить русское STT через GigaAM
◻ t_ed65b022  todo      (unassigned)          Разобраться с багом сессий: двойные теги и 500 при отправке
◻ t_54d58b45  todo      (unassigned)          Подробный вывод ошибок в UI под скрывашкой

$ env -u HERMES_DELEGATED_CHILD_CONTEXT hermes kanban diagnostics
No active diagnostics on this board.

$ env -u HERMES_DELEGATED_CHILD_CONTEXT hermes kanban show t_e2b17de1
Task t_e2b17de1: Разработка мобильного приложения (Гермес-консоль)
  status:    ready
  assignee:  -
  workspace: scratch
  model:     muse-spark-1.3-contributor-free (provider: custom:relay)
  max-retries: 2 (default)
  created:   2026-09-11 07:07 by user
  children:  t_54d58b45, t_bbab41e1, t_d442502f, t_ed65b022

Body:
Epic. База: Flutter/Dart приложение Гермес-консоль …

Events (3):
  [2026-09-11 07:07] created {'assignee': None, 'status': 'ready', 'parents': [], 'workspace_kind': 'scratch', …}
  [2026-09-11 07:45] model_override_set {'model': 'muse-spark-1.3-contributor-free', 'provider': 'custom:relay'}
  [2026-09-11 07:45] reasoning_effort_set {'reasoning_effort': 'xhigh'}
```

### 6.6 Конфиг и живой диспетчер

```
$ grep -n 'kanban' -A 3 ~/.hermes/config.yaml
209:kanban:
210-  review_dispatch: true
…
247:    - kanban        (platform_toolsets.cli)
266:    - kanban        (platform_toolsets.telegram)

$ hermes gateway status
● hermes-gateway.service … Active: active (running) since Fri 2026-09-18 11:38:46 UTC; 4 days ago
   Main PID: 2280901 (hermes)

$ grep -i kanban ~/.hermes/logs/gateway.log | tail
2026-09-18 19:24:16,954 ERROR gateway.run: kanban dispatcher: tick failed on board default
2026-09-19 18:05:39,589 INFO gateway.run: kanban dispatcher: reaped 1 zombie worker(s), pids=[3527457]
…
2026-09-22 18:03:50,218 INFO gateway.run: kanban dispatcher: reaped 1 zombie worker(s), pids=[3902450]
```

### 6.7 Ключевые `file:line`, на которые опирается разбор

```
hermes_cli/kanban.py:137-195        kanban_command(): dispatch, --board scope, init_db, _HANDLERS
hermes_cli/kanban.py:213-239        _DELEGATED_CHILD_DENIED_ACTIONS / _is_delegated_child_cli_mutation
hermes_cli/kanban_db.py:1-10        module docstring: paths, board resolution, WAL+BEGIN IMMEDIATE CAS
hermes_cli/kanban_db.py:121-135     _assert_not_delegated_child_mutation (PermissionError)
hermes_cli/kanban_db.py:2137-2169   claim_task(): ready->running под write_txn, _parents_satisfied
hermes_cli/kanban_db.py:2172-2199   claim_review_task(): review->running
hermes_cli/kanban_db.py:3718-3735   build_worker_context(): header/body/attachments/prior/parents/comments
hermes_cli/kanban_db_dispatch.py:2028  _resolve_worker_cli_toolsets()
hermes_cli/kanban_db_dispatch.py:2086  _worker_argv()
hermes_cli/kanban_db_dispatch.py:2163  _default_spawn() — env + Popen + PID
hermes_cli/kanban_db_dispatch.py:1418  dispatch_once(..., spawn_fn=None, ...)
hermes_cli/kanban_db_dispatch.py:1477  _call_spawn_fn() — «pluggable» шов
hermes_cli/kanban_db_dispatch.py:1229  _has_spawnable() — spawnability = профиль существует
toolsets.py:144-153                 toolset "kanban" (все kanban_*), описание + гейт
toolsets.py:183-187                 "hermes-acp" = _CODING_TOOLS без clarify → без kanban
model_tools.py:313-334              авто-добавление toolset kanban при HERMES_KANBAN_TASK
tools/kanban_tools.py:64-81         _visible / lifecycle vs orchestrator гейты
tools/kanban_tools.py:164-186       _enforce_worker_task_ownership
acp_adapter/session.py:390          enabled_toolsets хардкод ["hermes-acp"] (+ MCP)
gateway/kanban_watchers.py:207      dispatch_in_gateway (default True)
gateway/kanban_watchers_common.py:104-110  estop → пауза диспетчера
agent/estop.py:24-41                SENTINEL_NAME="ESTOP", sentinel_path()
plugins/kanban/dashboard/plugin_api.py:266-1672  REST/WS поверхность (см. §5.4)
website/docs/user-guide/features/kanban.md:62,69,82,1167   статусы, диспетчер, пути, «single-host out of scope»
website/docs/user-guide/features/kanban-worker-lanes.md:31-100  контракт лейна, env, «not yet a paved path»
website/docs/user-guide/features/hooks.md:470-477  хуки kanban — observer-only
```

---

## 7. Итоговая рекомендация

**Строить панель на доске Hermes как на «движке задач», но с собственным слоем стадий/ролей/диспетчера.**

- Взять как есть (не переписывать): БД-модель `tasks/task_runs/task_events`, атомарный `claim`, статусы, комментарии, вложения, runs/handoff, circuit breaker, `hermes pause`.
- Тонким адаптером: маппинг наших стадий на 9 статусов; запись `assignee`/`set-model`/`--skill` при переходе стадии; спека в `body` + первый комментарий (как уже делает пользователь на этом хосте — формат «SPEC (глупая модель: не додумывать…)»).
- Своим кодом: реестр ролей (executor+model+prompt на стадию), dispatch-цикл для ACP-бриджей (claim → запуск нашего агента в `workspace` → heartbeat → complete/block), межхостовый стейт, HTTP для телефона (или доверять dashboard с `--host` только внутри доверенной сети).

Главный шов интеграции — **CLI**: `hermes kanban claim|heartbeat|complete|block|request-review|comment|context|show|list|runs --json`, плюс файлы `~/.hermes/kanban.db` и `~/.hermes/ESTOP`. Второй шов — REST dashboard `/api/plugins/kanban/*` (один хост). Хуки годятся только для наблюдения.
