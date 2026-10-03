# U2: долговременное состояние управляемых карточек — отчёт

Дата: 2026-09-30. Ветка `feat/agent-modes`, база `fb0a298`.
План: [agent-core-implementation-plan.md](../plans/agent-core-implementation-plan.md).
Журнал отклонений: [2026.09.30_agent-core-u2_deviations.md](../tmp/2026.09.30_agent-core-u2_deviations.md).

Отчёт покрывает **только U2**. U3–U7, Fusion, оркестратор, swarm и
подготовка идей не реализованы и не объявлены готовыми. U1 подтверждён
родителем отдельно (19/19).

## Реализовано

| Файл | Содержание |
|---|---|
| `server/execution/execution-store.mjs` | Долговременное хранилище под `STATE_DIR/execution/state/`: агрегаты `cards/<id>.json`, контент-адресуемые blob `blobs/<sha256>.md`, `presets.json`, `runs/`; атомарная запись tmp+rename; fail-closed при повреждении (`corrupt_store`); проверка blob по SHA-256 при повторном использовании и чтении. |
| `server/execution/execution-domain.mjs` | Чистая доменная логика: валидация команд, применение к агрегату, авторитетная проекция, защита legacy-записей, таблица совместимости CLI/моделей, классификация legacy-claim. |
| `server/execution/state-service.mjs` | Единая сериализованная очередь записей: все KV-записи и execution-команды внутри; CAS перепроверяется в очереди (включая rev 0 несуществующего документа); `repairState` перед каждой операцией; seam внедрения сбоев `faults`; `internalCommand` — доверенный канал вне HTTP. |
| `server/acp-state-server.mjs` | Тонкий HTTP-адаптер над сервисом; `resolveConfig(env)` (STATE_DIR/PORT) — import-safe; `createRequestHandler(service)` экспортируется; `listen` под main-guard; POST в CORS; origin `*` сохранён; 413/400 диагностика. |
| `server/acp-runner.mjs` | Dispatcher пропускает карточки с `card.execution.managed === true`. |
| `scripts/porch-dispatch` | Отказ диспетча управляемых карточек по маркеру `execution.managed` до проверки blocked/cancelled/claim. |
| `scripts/u2_state_selftest.mjs` | 34 детерминированных теста `node --test`, без HTTP-listener'ов. |

## Граница хранилища и очереди

- Одна promise-цепочка сериализует **каждую** запись: KV PUT/DELETE,
  execution-команды, preset-записи. Каждая операция перечитывает
  состояние внутри очереди перед CAS.
- Агрегат: `cardId, schemaVersion, controlRevision, internalRevision,
  projectId, projectPath (realpath), session, documents, approvals,
  commands, runs, projection, cardSnapshot, composition, pendingWrites`.
- `pendingWrites` (семантические намерения: `board_projection`,
  `claims_purge`, `preset_upsert`) сохраняются вместе с агрегатом до
  внешних эффектов; `repairState` идемпотентно их дожимает перед
  каждой операцией очереди и перед управляемыми чтениями.
- Порядок команды: dedup → `expectedControlRevision` → валидация →
  apply → сохранить (blob → агрегат → проекция). Internal-канал
  (`heartbeat`) двигает только `internalRevision`.
- Дедуп в агрегате без горизонта вытеснения; lookup до проверки
  ревизии.

## Матрица требований и сценариев

| Требование | Реализация | Тест (selftest) |
|---|---|---|
| Долговременный агрегат карточки | `execution-store` + `state-service` | все execution-тесты |
| Неизменяемые документы/версии, привязка к hash | blob CAS + `documents{kind→{current,versions[]}}` | `document immutability: imported source file edit cannot rewrite history` |
| Явное одобрение: versionId+sha256, обязательные | `approve_requirements`, `approve_plan` | `approvals require explicit versionId+sha256; stale versions rejected` |
| Plan привязан к версии requirements | `requirementsVersionId` в версии плана | `plan is bound to the requirements version it was prepared for` |
| Структурные checks при одобрении; fenced-блок — только импорт | `payload.checks` + опциональный ` ```acp-checks ` | `plan checks: structured payload, document block, or nothing -> diagnostics` |
| Preset CRUD + совместимость CLI/модель | `presets.json` + `mergedCompat` | `presets CRUD + per-CLI compatibility` |
| Полный snapshot композиции на карточке | `aggregate.composition` при `save_preset` | `save_preset binds a composition snapshot immune to registry edits` |
| Сериализованная CAS для всех писателей | одна очередь, CAS внутри | `kv: concurrent PUTs ...`, `kv: missing-document CAS`, `kv: stale PUT` |
| Идемпотентность commandId до ревизии; конфликт payload | `aggregate.commands` | `dedup: replay ...`, `dedup: no eviction horizon — >256` |
| Раздельные control/internal ревизии | `controlRevision`/`internalRevision` + `internalCommand` seam | `revisions: heartbeat moves only internalRevision via trusted seam` |
| Internal-канал недоступен по HTTP | channel=user на адаптере + reject `channel:'internal'` | тот же тест + `real request handler` |
| Защита managed-полей при любой legacy-записи | `mergeBoardWrite`, `guardClaimsWrite`, DELETE guard | `board PUT: managed fields restored...`, `claims PUT/DELETE: managed card entries are frozen` |
| Запрет удаления/дубли managed-карточек | 409 `card_managed`/`duplicate_card_id` | `board PUT` test |
| Enable: проект, git-репозиторий, claims, binding | `cmdEnable` + `git rev-parse --show-toplevel` | `enable: binds project...`, `enable: fake .git marker and linked worktree` |
| Enable: живой claim / неоднозначный claim | `classifyLegacyClaim` (active/ambiguous/stale) | `enable: live claim and evidence-bearing expired claims refuse` |
| Восстановление после частичной записи | `pendingWrites` + `repairState` | 4× `crash: ...` (см. ниже) |
| Повреждённое хранилище fail-closed | `corrupt_store` на чтении | `corrupt aggregate ...`, `corrupt presets registry ...` |
| Целостность blob при approve/serve | `requireBlob` | `blob evidence: reuse verifies hash...` |
| Совместимость env HTTP (STATE_DIR/PORT) | `resolveConfig` | `config seam: STATE_DIR/PORT legacy env names and defaults` |
| CORS `*` + POST, OPTIONS | адаптер | `http: OPTIONS, CORS '*' + POST, bad URL 400, unknown route 404` |
| Тело >5MiB → 413; битый URL → 400 | `readBody` + pre-check + drain | `http: over-5MiB bodies -> 413 (declared length and streamed)` |
| Реальный handler без listener'а | `createRequestHandler` + fake req/res | `real request handler over fake req/res (no listener)` |
| Legacy-runner пропускает managed | `acp-runner.mjs`, `porch-dispatch` | `node --check` + code review (unit-уровень) |
| 501 на U3-команды | `command_unavailable` + dedup | `unsupported commands return 501 and are dedup-recorded` |
| Orphan blob безвреден | blob без ссылки не ломает | `orphan blob (crash between blob and aggregate write) is benign` |

## Команды и результаты (unit/self-test — хост, node v26)

- `node --test scripts/u2_state_selftest.mjs` — **34/34 pass**, exit 0.
- `node --check server/execution/execution-store.mjs` — OK.
- `node --check server/execution/execution-domain.mjs` — OK.
- `node --check server/execution/state-service.mjs` — OK.
- `node --check server/acp-state-server.mjs` — OK.
- `node --check server/acp-runner.mjs` — OK.
- `python3 -c 'import ast; ast.parse(open("scripts/porch-dispatch").read())'` — OK.

### Покрытие crash-восстановления (внедрённые сбои)

Сервисный seam `faults` (`docNames`, `presets`, `aggregates`) выбрасывает
ошибку **внутри** функций персистентности — после коммита агрегата:

| Сценарий | Утверждение |
|---|---|
| enable: claims-пурж упал | restart → `repairState` дожимает `claims_purge`, claim удалён; replay команды → исходный outcome |
| save_preset: запись реестра упала | restart → `preset_upsert` дожат; **более новая** запись реестра не перезаписывается |
| attach: board-проекция упала | restart → `board_projection` пересчитан и записан |
| aggregate-запись упала | команда не записана; повтор чист (нет полурезультата) |

### Compose-доказательства

**Не выполнялись.** Живой стек принадлежит основному checkout'у; по
инструкции второй Compose-стек и рестарты без координации с родителем не
запускались. Интеграционная проверка API через Compose — отдельный шаг
после ревью. Все приведённые выше результаты — unit/self-test на хосте.

## Известные ограничения / границы

- U3-команды возвращают `501 command_unavailable` — намеренно, до U3–U5.
- `git` требуется в PATH state-контейнера. Уточнение U3: live-образ state
  git НЕ содержит (`exit127`, проверено Compose-exec); `Dockerfile.node`
  его ставит и пересобранный образ это подтвердил, но rebuild/deploy
  отложен к U7 — текущее суждение о доступности git в state было
  неправильным.
- GC blob'ов не реализован (неизменяемые свидетельства; намеренно).
- `AGENTS.md`-diff (строка 25907/codex в таблице портов) — родительский
  контекст, не изменение U2.
- PR не создан, ничего не закоммичено, не запушено; работа остаётся
  reviewable в рабочем дереве.
