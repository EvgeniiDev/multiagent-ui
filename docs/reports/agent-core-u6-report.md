# U6: managed execution UI — документы, одобрения, состав, запуск, наблюдение — отчёт

Дата: 2026-10-01. Ветка `feat/agent-modes`.
План: [agent-core-implementation-plan.md](../plans/agent-core-implementation-plan.md).
Журнал отклонений: [2026.10.01_agent-core-u6_deviations.md](../tmp/2026.10.01_agent-core-u6_deviations.md).

Отчёт покрывает **U6**: фронтенд managed-исполнения — execution API
client + Pinia-store, секция документов/одобрений/состава/run-контроля в
карточке, managed-aware персистентность доски, managed-история и детали в
Workflow-панели. U7 (реальные CLI, Compose, браузерные пути/навигация)
не реализован и не заявлен готовым. Модуль ждёт родительского
независимого прогона и приёмки.

## Реализовано

| Файл | Содержание |
|---|---|
| `src/lib/execution/api.ts` | Типизированный `ExecClient`: `getCard`/`getRun`/`getRunEvents`/`getDocument`/`getArtifact`, команды `sendCommand`, реестр пресетов `listPresets`/`createPreset`/`updatePreset`/`deletePreset`, `refreshIndex`. Типы приведены к реальным полям домена: `checkReport.exitCode`/`logOutArtifactId`/`logErrArtifactId`, `validation.reports.findings.doc`/`verdicts.doc`, `fixContext`, `rounds`, `artifacts`, `result`, `diagnostic`. `ExecApiError` с `status`/`code`/`details`; 409 → `revision_conflict`/`workspace_drift`/`command_conflict`. |
| `src/lib/execution/ui-model.ts` | UI-гейты над реальными wire-фикстурами: `canStart`/`canStop`/`canContinue`/`canAccept`, `continuePayload`, сборка документов (`buildDocSource`), строки checks (`CheckRow`), `presetPayload`, лейблы стадий/фаз/статусов. |
| `src/stores/execution.ts` | Per-card состояние с generations/single-flight: `watchCard`/`unwatchCard`, `refreshCard` (coalesce, reqSeq-guard, 404 → unmanaged + `clearManagedProjection`), `refreshRun` (per-selection in-flight токен — A→B→A безопасен; event-history drain по страницам с `eventsCursor`/`eventsPending`/`eventsCorrupt`), `selectRun` (pin исторического run, auto-follow current), `sendCommand` (свежий read → `expectedControlRevision`; net-stamp до POST — поздняя ошибка команды не гасит более новое здоровое состояние), `openManagedRun`/`clearFocus` (focus владеет ровно одним watch'ем), `managedIndex`, `loadPresets`. Отказ refresh = отказ команды без POST. Все poll-таймеры освобождаются `unwatch`/`clearFocus`/`stopPolling`. |
| `src/features/board/useCardDraft.ts` | Автосейв-машина drawer'а: per-field dirty-tracking относительно baseline загрузки (а не текущего полла), flush старой карточки при смене `cardId`/dispose (не протекает в новую), отказы managed-мутаций. Watcher на тот же `cardId`: серверные managed-поля (stage/status/project/blocked/blockedReason/cancelled/session) обновляются из авторитетного projection при сохранении локальных пользовательских правок — поллинг НЕ помечает dirty и НЕ вызывает записей. |
| `src/features/board/CardDrawer.vue` | Секция managed-исполнения через `ExecutionPanel`; managed-owned контролы (статус/стадия/проект/флаги/сессия) отключены с правдивой причиной; flush обращается к явному cardId. |
| `src/features/board/ExecutionPanel.vue` | Документы (attach text/import-path, viewer, approve requirements/plan с выводом реальных checks: run/cwd/timeoutSec/setup), пресет-состав (save/bind, reload реестра после сохранения), run-контроль (start/stop/continue/accept_result по hash), disabled-реasons, `commandError` 409 → подсказка обновить. Отчётность по реальным полям домена: checks-отчёты (exitCode, отдельные stdout/stderr-артефакты, сопоставление по `report.index`), findings (severity/status/текст), verdicts-doc (blocking/nonblocking/disputed/unvetted семантика), rounds, result/diagnostic. Ownership/generation-гварды: чтение артефактов и открытие документов привязаны к card+run+seq; редактор документов заморожен на время in-flight attach; состояние run-control/preset сбрасывается при смене карточки. |
| `src/features/board/ManagedRunEvents.vue` | Общий компонент полной managed-истории событий — все страницы, drained стором (без tail-cutoff); каждое событие раскрывается в записанный payload (`<details>` + verbatim JSON). Используется и в ExecutionPanel, и в WorkflowPanel — одна реализация. |
| `src/stores/board.ts` | Per-field delta persistence: `updateCard` помечает только реально изменённые поля; `persistManagedBoard` сериализован (`managedSaveChain`), каждая попытка мержит из ЖИВЫХ `cards` + CAS-rev по `mutateRemoteDocChecked`; clear только отгруженных поколений (редактирование во время PUT сохраняется и доставляется следующим циклом). `adoptRemoteBoard`: remote — база, локальные только явно-новые/unsaved строки, удалённые remote-карты не воскрешаются, managed-поля всегда из авторитетной строки. `syncManagedRows` — read-only оверлей серверных managed-полей, seq-ordered, boolean = успех чтения (не «changed»). `applyManagedProjection`/`clearManagedProjection` — projection-синк без пользовательских записей, backstop против отката controlRevision. Lifecycle-мутации (move/status/flag/remove/drag) отказывают managed-картам с правдивыми причинами через `MutationResult`. Новые `fetchRemoteDoc`/`mutateRemoteDocChecked` — scoped, bounded whole-request JSON (тело читается под тем же дедлайном). |
| `src/components/WorkflowPanel.vue` | Managed-секция рядом с porch (porch reader не изменён, `porchRunId` ≠ ACP session): список managed-карт (`managedIndex`), focus-деталь — селектор исторических run'ов карточки, статус/фаза/current-run принадлежность, `ManagedRunEvents` (полная drained-история с payload'ами), явные состояния: `runError` + retry-кнопка вместо вечного «loading…», loading только пока `runInflight`. Managed-индекс опрашивается пока панель смонтирована. |
| `src/lib/host/storage.ts` | `fetchRemoteDoc`/`mutateRemoteDocChecked` для managed-персистентности; `KVStore.dispose` + `__resetWebKvForTests` — тестовый teardown poll-таймера RemoteKVStore и кэша probe (production интервал намеренно живёт всю сессию). |

## Плановые требования → доказательства

| Требование | Доказательство |
|---|---|
| enable только из карточки с авторитетных входов | `enable` через `sendCommand`: свежий read → `phase==='unmanaged'` → POST без CAS; уже managed → `already_managed` до POST (execution-store тесты + real-handler suite) |
| документы версионируются и одобряются раздельно | attach/approve requirements+plan через production-стор против реального handler; `approve_plan` bound к requirements (`requirementsSha256`, `checksSource: document_block`); набор checks показывается с run/cwd/timeoutSec/setup |
| состав валидируется по server-compatibility | `save_preset` + `loadPresets` → `compatibility` из реального реестра; `canStart(view)` над стор-adopted view |
| ревизии/409 без потери данных | deferred-command тест: ошибка не опускает свежее online-состояние; stale `expectedControlRevision` → реальный `409 revision_conflict` (классификация `ExecApiError`), повтор по live-rev через `sendCommand` успешен и store принимает свежий view |
| observability/остановка/продолжение/приёмка | `selectRun` pin + auto-follow current; `refreshRun` drain'ит ВСЕ страницы событий (`eventsCursor`/`eventsPending`, out-of-order не откатывает курсор); terminal-переход триггерит добор деталей; acceptance bound к `resultSha256` (approve-gate `canAccept`) |
| смена карточки без утечек/перетираний | focus владеет одним watch'ем; `unwatch` во время in-flight GET отменяет эффект ответа; A→B→A: старый A не гасит новый flight-токен; все таймеры/годы освобождаются — сьюта завершается сама |
| managed persistence не затирает соседние правки | per-field дельта merge на remote-базе; delayed-PUT + правка во время полёта — обе сохраняются; remote-удаление не воскрешается; managed lifecycle-мутации отказывают |
| run-детали правдивые | рендер только по полям реального run-рекорда: check-отчёты по `report.index` с exitCode/stdout/stderr-артефактами, findings/verdicts docs с семантикой гейта, artifacts читаются с run-генерационным гвардом |
| события доступны целиком | `ManagedRunEvents` выводит ВСЕ drained-события с раскрытием payload — SSR-тест доказывает seq 1 и seq 30 с разными payload'ами одновременно в DOM (старый `slice(-12)` seq 1 скрыл бы) |
| Workflow: исторический выбор + ошибка/повтор | селектор run'ов карточки (`st.view.runs`), `runError`+retry, loading только пока реальный flight; SSR-кейс: обе секции (managed+porch) рендерятся вместе |

## Реальный клиент/сервис-контракт (listener-free)

`real state-service handler — user flow contract`: временные state/git
каталоги, `createStateService`, посев `projects.json`/`board.json` через
реальные PUT-маршруты, `ExecClient` над `svc.request` (без HTTP-listener).
Весь flow идёт через **production Pinia-store**: `watchCard` + свежий
read доказывает `unmanaged`, далее `exec.sendCommand` для
enable → attach/approve requirements → attach/approve plan
(`acp-checks` fence) → `save_preset`. Проверки: `canStart(st.view)` ok,
server-projection `{stage:'plan',status:'done'}`, approved-bindings,
`loadPresets` compatibility, re-attach инвалидирует ОБА approval,
прямой stale-envelope → `ExecApiError 409 revision_conflict`,
production-ритрай через свежий rev → успех + store-adoption,
`st.commandError` чист.

## Результаты проверки

| Сьюта | Результат |
|---|---|
| `scripts/test_execution_ui.mjs` (node:test, strip-types) | **39/39 PASS**, exit 0, ~5s — request-engine, ui-model гейты, execution-store concurrency, board managed persistence, useCardDraft (вкл. same-card projection refresh), SSR setup/render CardDrawer+ExecutionPanel+WorkflowPanel, real-handler Pinia flow. Родительский независимый прогон: PASS 37/37 до Workflow-доработки, затем 39/39 после |
| `scripts/test_workflow_porch.mjs` — porch-регрессия | **51/51 PASS**, exit 0 — внешний porch reader неизменён |
| `npm run build:web` (хост) | `vue-tsc --noEmit` + `vite build --mode web` — чисто, ~4.5s |

## Чем доказано (честные слои)

- **Реально:** запросный движок `ExecClient` против реального
  `svc.request`; production `sendCommand`/`refreshCard`/`refreshRun`/
  `selectRun`/`openManagedRun`; реальные CAS/dedup/aggregate/approval/
  invalidation семантики домена; board remote merge против реальных
  GET/PUT с ревизиями; SFC setup+render скомпилированных компонентов.
- **Контролируемый транспорт:** гонки доказаны deferred-фикстурами
  (`FakeExec`/`wireFetch`) — порядок ответов управляем, без сети.
- **SSR setup/render — НЕ браузер.** `createSSRApp`+`renderToString`
  выполняет setup и шаблон (включая immediate-watchers — TDZ-класс
  регрессий), но `onMounted`/`onBeforeUnmount`, навигация и реальные
  жизненные циклы не исполняются. Это setup/render-доказательство,
  не mount/unmount.
- **НЕ доказано (U7):** браузерная навигация/жизненный цикл, живой
  HTTP-стек Compose, реальные Pi/Codex/Devin процессы, интеграция
  Tauri-хоста (Tauri-ветки не трогались).

## Границы U6 (намеренные)

- Нет автоматического merge/push — публикация и слияние остаются
  отдельными действиями; UI показывает только чтение/команды.
- Сервисы/рантаймы не запускались; порты не открывались; `docker
  compose` не трогался.
- Legacy porch-поведение сохранено — регрессия 51/51; `porchRunId`
  никогда не трактуется как ACP session id.
