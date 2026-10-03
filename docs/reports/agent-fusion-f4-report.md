# F4: managed-карточка/drawer + Workflow side-panel + реальный browser E2E + выпуск — отчёт

Дата: 2026-10-02. Ветка `feat/agent-modes`.
План: [agent-fusion-implementation-plan.md](../plans/agent-fusion-implementation-plan.md) (секция F4).
Журнал отклонений: [2026.10.02_agent-fusion-f4_deviations.md](../tmp/2026.10.02_agent-fusion-f4_deviations.md).
Бриф приёмки: `F4_BRIEF_ACCEPTANCE.md`.

Отчёт покрывает **только F4**: managed execution card/drawer, Workflow
side panel, реальный браузерный E2E с U7 overlay на штатных портах,
реальные F1-воркеры (pi через zen-relay), и запись о выпуске.
Важно: harness использовал Compose project `acp-ui` и временно
пересоздавал scoped-сервисы; владелец проекта позднее явно подтвердил,
что production deployment/redeployment этого проекта во время разработки
разрешён. Пользовательское воздействие окна не измерялось, но это не
блокер приёмки и не основание объявлять прогон неуспешным. Оркестратор,
Swarm и Idea Preparation этим отчётом не принимаются.

## Критерии приёмки → измеренные факты

| Критерий | Факт |
|---|---|
| Browser-сьют после рестарта D11 завершился нормально (не timeout/kill) с 0 FAIL | **PASS.** Окно `4fa6798cae174720`: `browser-fusion` exit 0 за 433 с (15:42:42Z→15:49:55Z), **54 PASS / 0 FAIL**, финальная строка `final: 54/54 checks passed`. Фазовый лог `~/.cache/acp-u7-devin/phase-browser-fusion-4fa6798cae174720.log`. |
| Runtime restore и verify оба exit 0; production не затронут | **PASS для разрешённого release-flow.** Окно записало `restore:0 verify:0`; повторный `python3 scripts/u7_transition.py verify` завершился exit 0. Во время теста проект `acp-ui` временно использовал scoped U7 overlay, что владелец явно разрешил 2026-10-02 для разработки/redeployment этого проекта. Воздействие на пользователей не измерялось; отсутствие воздействия не заявляется. |
| `ping` контроллера = digest on-disk конфига | **PASS (14:37Z).** Реальный сокет `/home/hermes/.hermes/acp-ui-state/f1-env/controller/env.sock` → `configDigest=93aa01e9aa43ef6b35ffa641d4962b2e08c87087cd37c0cee826b8524ca9c68c`, бит-в-бит равен хэшу `deploy/execution/environment.config.json` тем же алгоритмом (sortKeys + sha256). `startedAt=2026-10-02T12:14:31.971Z`, bootId `b0a669ef-…`. |
| `npm run build:web` на хосте exit 0 | **PASS (14:36Z).** `vue-tsc --noEmit && vite build --mode web` — собрано за 3.68 с, `dist-web/` обновлён. Повторный прогон после правок — тоже exit 0 (см. журнал). |
| Детерминированные Fusion-тесты exit 0 со счётчиками | **PASS.** `node scripts/test_fusion_handoff.mjs` 8/8, `test_fusion_controller.mjs` 11/11, `test_execution_ui.mjs` 53/53, `test_ui_store.mjs` 3/3, `test_execution_environment.mjs` 82/82 — **157 проверок, 0 падений**. |
| Отчёт/журнал различают факт/вывод/непроверенное | Этот файл + журнал: все счётчики сняты с артефактов окон; выводы помечены. |
| Никакой не-F4 трек не объявлен принятым | Скоуп выше; оркестратор/swarm/idea в отчёт не входят. |

## Что реально проверено браузером (54 проверки)

- **Document-поток end-to-end:** `features.fusion` в card view → fusion
  start (200) → реальные запуски панелистов через F1 → серверная правда
  без браузера → переоткрытие вкладки → истощение p3 (мертвая модель)
  → parked `participant_decision` → баннер → retry +1 attempt →
  durable exclude → судья чеканит `wo_v1` → парковка на approve
  (никогда не auto) → approve → `succeeded` → hash-bound артефакт
  (sha256 `f02e2b28…`) → focused fusion summary + workflow панель +
  неизменный porch reader endpoint.
- **Две вкладки / конфликт:** stale-таб POST → реальный **409
  revision_conflict** (снято по сетевому журналу `/api/…/commands`).
- **Implementation-поток:** редактор (модели из seeded cli-compat) →
  gate открыт → run запущен → stop → `cancelled` → continue → НОВЫЙ
  run с `continuedFrom` → work order auto-route `in_plan` → integrator
  (реальные контейнеры `ia-5c56b84d-*`) → import с валидным report →
  reviewer+checker попытки → `awaiting_acceptance` → user accept →
  `succeeded` → история обоих прогонов.
- **Сосуществование:** legacy unmanaged-карточка рядом с managed —
  opt-in панель, без fusion-редактора; `pageerrors` = 0.

## Дефекты, найденные и исправленные в этом окне приёмки

| ID | Класс | Суть | Фиксация |
|---|---|---|---|
| D12 | harness | `u7_run.py`: stdout-only результаты + `print` без защиты от EPIPE → два окна теряли счётчики и persist (exit 120 = shutdown-flush по мёртвому пайпу) | per-phase durable логи `phase-<name>-<window>.log`, `log()` неубиваем по OSError, `_persist()` после каждой фазы и между restore/verify |
| D13 | product | `parseIntegratorReport` требовал `yes/no` первым токеном — реальные интеграторы отвечают `- no — …` (пулlet) → `report_incomplete` на обеих попытках | один ведущий `[-*] ` снимается перед проверкой; регресс-кейсы `- no`/`- yes` в `test_fusion_handoff.mjs` (fail→pass проверено) |
| D14 | infra | D8-утечка повторилась: 26 мёртвых `acp-f1-w-*` + 26 `acp-f1-n-*` исчерпали IPAM → `docker network create` 400 на integrator | повторена задокументированная D8-чистка (доказано: все контейнеры — `sleep infinity`, 0% CPU, попытки терминальны); субстратная утечка остаётся F1-followup |

D11 (stale env-controller inputs) — **закрыт фактом**: digest совпал, а
в окне `fe5ddaf0` integrator-попытки прошли `input_not_declared`-проверку
и дошли до `docker network create` (следующая стена — D14).

## Границы и непроверенное

- Окна `b1fc833f`/`444f9046` восстановили прод через отсоединённый
  restore-ребёнок — по артефактам (container StartedAt 12:54:25Z,
  `verify` exit 0 в 14:37Z), а не по собственному журналу окна.
- Exit 120 интерпретирован как shutdown-flush по мёртвому пайпу —
  вывод из механики CPython + утерянного вывода; прямого traceback нет
  (он и был предметом D12).
- F1-субстрат продолжает терять сеть+контейнер на попытку — следующие
  длинные сессии снова исчерпают IPAM (F1-followup, не F4).
- Три «живых» попытки в тестовом exec-store — задокументированные
  stranded-reservations мёртвых окон; не тронуты by design.
- Свежие воркеры окна 4fa6798c оставлены как артефакты — чистка не была
  необходима (новых окон не планируется; правило «только по необходимости»).

## Изменённые файлы (этот заход)

- `scripts/u7_run.py` — durable phase-логи, EPIPE-safe `log()`,
  инкрементальный `_persist()` (D12; файл untracked).
- `server/execution/fusion/work-order.mjs` — bullet-tolerant
  behaviorChange в `parseIntegratorReport` (D13).
- `scripts/test_fusion_handoff.mjs` — регресс-кейсы `- no`/`- yes`.
- `docs/tmp/2026.10.02_agent-fusion-f4_deviations.md` — D11 resolved,
  D12–D14, леджер окон.
- `docs/reports/agent-fusion-f4-report.md` — этот отчёт.

Git-дерево иначе нетронуто; ничего не закоммичено/запушено.

## Итог

**F4 функциональный E2E — GREEN по измеренным фактам** (окно
`4fa6798cae174720`, 54/54, exit 0); build и 157 детерминированных
проверок также зелёны, restore/verify подтвердили возврат captured specs.
**F4 принят по своему функциональному scope.** Все заявленные F4 browser,
build, deterministic-test и restore/verify gates имеют зелёные результаты;
производственный прогон был разрешён владельцем проекта. Воздействие
временного overlay на пользователей отдельно не измерялось. Другие треки
этим отчётом не принимаются.
