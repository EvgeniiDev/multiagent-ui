# Idea Preparation — независимый журнал приёмки тимлида

Дата проверки: 2026-10-02 UTC. Repo: `/home/hermes/projects/acp-ui-agent-modes`, branch `feat/agent-modes`. Этот журнал различает модульную приёмку этапов и полную приёмку фичи; вывод агента сам по себе не является доказательством.

## Этапы

| Этап | Статус | Независимое доказательство / оставшиеся условия |
|---|---|---|
| P0 feasibility + containment hardening | **принят** | `node --test scripts/test_preparation_binding.mjs` включён в combined suite: 18 тестов pass; `verify all` и `audit all` — 12/12 each; live Pi containment smoke `watchdog-accept-20261002-213236-symlink-escape-smoke`: status `pass`, четыре read/write/bash escape legs заблокированы, `fsIntact:true`, `newEscapes:[]`, `noNewLinks:true`. Smoke сообщает exit code 143 от завершения дочернего CLI при cleanup, но verdict/status pass и файловая проверка цела. |
| P1 state/session/transitions | **принят (модуль)** | `scripts/test_preparation_state.mjs` внутри combined suite: 11 pass; тесты работают через production state-service/internal-command seams. |
| P2 SkillBinding/compatibility | **принят (модуль)** | `scripts/test_preparation_skills.mjs` внутри combined suite: 23 pass; реестр проверен 12/12. |
| P3 lead/adaptive discussion | **принят (модуль); runtime gate перенесён в P5** | В текущем независимом combined run `scripts/test_preparation_lead.mjs` прошёл 23 теста. P3 report подтверждает, что реальный `pi --mode rpc` через `lead.mjs` и runner-side lead host не были доказаны. P5 обязан закрыть реальный Pi/profile flow и runner hosting; пока это не доказано, полный P3/runtime и вся фича не приняты. |
| P4 docs/approval/handoff | **принят (модуль)** | Независимо просмотрены `cmdHandoffPreparation`/`preparationView` и P4-S7; readiness проверяется до записи offer, offer сохраняет version/hash/context и не mint-ит run; staleness выводится из текущих inputs. Свежий combined run прошёл P4 9/9. Runtime/API/browser интеграция остаётся P5. |
| P5 UI/browser/release | **в работе — один исполнитель** | Active run `run_fair-oak-84a6`, Porch `devin`/`devin-cli`/`swe-2-max`, cwd `/home/hermes/projects/acp-ui-agent-modes`, started `2026-10-02T22:20:10Z`; status + active-list re-read confirm running at the exact cwd. First observable work read the P3/P4 reports. P5 brief: `BRIEF_IDEA_P5.md`. Recurring watchdog `976129e827b0` remains active, every 5 min, delivery origin. |

## Команды проверки этой итерации

- `node --test scripts/test_preparation_binding.mjs scripts/test_preparation_state.mjs scripts/test_preparation_skills.mjs scripts/test_preparation_lead.mjs` → **75/75 pass**, exit 0, 2.554 s.
- `node --test scripts/test_execution_ui.mjs scripts/test_fusion_controller.mjs scripts/test_fusion_handoff.mjs scripts/test_execution_environment.mjs scripts/test_sfc_loader.mjs scripts/test_ui_store.mjs scripts/test_workflow_porch.mjs scripts/test_ws_transport.mjs` → **129/129 pass**, exit 0, 10.835 s.
- `npm run build:web` → exit 0, Vite 6.4.1 built in 3.65 s; existing large chunk warning (722.03 kB) remains.
- `git diff --check` без настройки CRLF сообщает trailing whitespace по `src/lib/host/storage.ts` (строки 23–584) — unrelated baseline file; это не P0–P3 source. Не переписывал файл.

## Watchdog

Hermes cron `976129e827b0` / `acp-ui-teamlead-watch` прочитан через `hermes cron list`: `[active]`, cadence `every 5m`, delivery `origin`, workdir проекта, next run `2026-10-02T21:40:17Z` на момент проверки. Porch до dispatch показывал `active=[]`; P4 run после dispatch подтверждён как running с `model=swe-2-max`, точным cwd, audit ростом и инструментальными событиями.

## Общий статус

**Checkpoint 2026-10-02 22:18 UTC.** Независимый combined run `node --test scripts/test_preparation_binding.mjs scripts/test_preparation_state.mjs scripts/test_preparation_skills.mjs scripts/test_preparation_lead.mjs scripts/test_preparation_handoff.mjs scripts/test_execution_ui.mjs scripts/test_fusion_controller.mjs scripts/test_fusion_handoff.mjs scripts/test_execution_environment.mjs scripts/test_sfc_loader.mjs scripts/test_ui_store.mjs scripts/test_workflow_porch.mjs scripts/test_ws_transport.mjs` → 213/213 pass, 0 fail, 0 skipped, exit 0, 11.94 s. Host `npm run build:web` → exit 0, Vite 6.4.1, 3.59 s; existing large-chunk warning remains. P4 report source spot-check confirms readiness-gated handoff offers are data-only, not dispatch. Current P5 baseline: HEAD saved in `/tmp/idea-prep-p5-baseline.head`; `git status --short` saved in `/tmp/idea-prep-p5-baseline.status` (118 lines, SHA-256 `aa1005d53a1184ce4cb17815193ddfce4f8794ba065e998cb98fcf67c9ba0e77`).

**Полный Idea Preparation P0–P5 НЕ принят.** P0–P2 accepted earlier as modules; P3/P4 accepted only at module/test level. Actual Pi lead-driver + runner hosting, all P5 UI/browser/reload/binding flows, final regressions, and runtime/read-back remain gates. One P5 executor may work at a time; current monitor remains active. No claim of whole-feature acceptance.

---

## Checkpoint 2026-10-02 23:26 UTC — P5 исполнительская сдача

**STATUS: DONE** (executor statement; independent re-run remains the manager gate).

| Этап | Модуль | Runtime/integration |
|---|---|---|
| P0–P2 | принят | без изменений, регрессии нет (в combined 243/243) |
| P3 lead | принят (модуль) | **runtime закрыт**: реальный `pi --mode rpc` через production supervisor на runner-контейнере (E2E A/F) и in-process production-path smoke 6/6 доступных биндингов; supervisor restart persistence измерен на каждом биндинге |
| P4 docs/approval/handoff | принят (модуль) | **runtime закрыт**: exact-version approvals, gate subject binding, invalidation, plan↔requirements binding, checks contract, handoff offer без run — всё в E2E C1–C25 |
| P5 UI/browser/release | — | browser E2E **56/56 PASS**: durable discussion (A), racing/stale (B), gates/docs/handoff (C), unsupported+offline fail-closed (D), legacy adoption (E), `compose restart runner` persistence (F) |

**Измерено** (все команды на dirty tree, exit 0):
- `node --test` 15 файлов → 243/243, 15.9 s (213 baseline + новые 16 UI + 14 runner).
- `npm run build:web` → Vite 6.4.1, 4.12 s, pre-existing chunk warning.
- `preparation_binding_probe.mjs verify all` / `audit all` → 12/12 each.
- `preparation_skill_smoke.mjs all` → **12/12** (6 real pi turns + restart-persist; 6 `route_unsupported`), evidence `/home/hermes/.cache/acp-p5-smoke/run-2026-10-02T23-16-41-652Z/`.
- `scripts/e2e_preparation.py` → **56/56**, run id по логу `/tmp/p5-e2e-run10.log`, screenshots `/home/hermes/.cache/acp-u7-devin/e2e-prep-*.png`; session ids `prep_bd8c0698-19a6-46fd-a32b-a1b187de47e6` (small), `prep_b347cd67-90d6-4e25-83ac-222ad703030b` (complex).
- `u7_transition.py preparation` → isolated `acp-ui` stack; `restore` + `verify` → «all scoped+cron specs match the captured actual spec».
- Feature-off: restored spec отдаёт card view без `features`; `/preparation` и `/preparation/bindings` → 404.

**Dirty-tree delta:** baseline 118 → 125 entries; удалено 0; добавлено 7 (`compose.u7-preparation.yaml`, 3 скрипта tests/smoke/e2e, `PreparationPanel.vue`, `BRIEF_IDEA_P5.md` — brief заказчика). Остальные изменения внутри уже-грязных путей. HEAD `fb0a298c…` не двигался.

**Вывод:** все P5-гейты закрыты измеренными артефактами; заявлений о непроверенном нет.

**Не измерено:** содержание длинных интервью модели сверх контракта/durability; `orchestrator`/`swarm` handoff-режимы (`implemented:false` by design); user-impact рестарта scoped-сервисов в момент transition (стек изолированный, живой state не тронут; на live-стеке после restore — 0 managed cards).

**Следующий gate:** независимый прогон менеджером acceptance-команд на этом dirty tree; при совпадении — снятие «НЕ принят» по P5/фиче.

---

## Финальная независимая приёмка P0–P5 — 2026-10-02 23:53 UTC

**STATUS: ACCEPTED — Idea Preparation P0–P5 по Definition of Done плана.** Статусы этапов не смешиваются с более широкими Fusion/Orchestrator/Swarm проектами; их реализации здесь не заявляются.

| Этап | Итоговая отметка | Проверяемое основание |
|---|---|---|
| P0 feasibility + containment | **принят** | P0 report; 18/18 hardening tests; live escape smoke PASS с 4/4 заблокированными обходами, `fsIntact:true`; registry verify/audit 12/12. |
| P1 state/session/transitions | **принят (модуль)** | P1 report; regression suite включает сценарии durable state, concurrency, CAS, replay/crash recovery и feature-off. |
| P2 SkillBinding/compatibility | **принят (модуль)** | P2 report; registry 12 bindings, контракт/preflight/result containment, ресурсы pinned. |
| P3 lead/adaptive discussion | **принят (модуль + runtime gate закрыт через P5)** | P3 report + настоящий Pi RPC lead smoke для каждого из 6 available bindings, включая supervisor dispose/rebuild; 6 unsupported отказали. |
| P4 requirements/design/plan/handoff | **принят (модуль + browser/runtime gate закрыт через P5)** | P4 report; свежий browser E2E C1–C25 подтверждает exact-version approvals, gates, invalidation, ready и handoff offer без implementation run. |
| P5 UI/browser/release | **принят** | Независимый свежий browser E2E 56/56 PASS; host build и regression battery зелёные; настоящий профиль/route smoke покрывает все 12 bindings; baseline Compose restored и прочитан обратно. |

### Финальные измерения

- `node --test scripts/test_preparation_binding.mjs scripts/test_preparation_state.mjs scripts/test_preparation_skills.mjs scripts/test_preparation_lead.mjs scripts/test_preparation_handoff.mjs scripts/test_preparation_ui.mjs scripts/test_preparation_runner.mjs scripts/test_execution_ui.mjs scripts/test_fusion_controller.mjs scripts/test_fusion_handoff.mjs scripts/test_execution_environment.mjs scripts/test_sfc_loader.mjs scripts/test_ui_store.mjs scripts/test_workflow_porch.mjs scripts/test_ws_transport.mjs` → **243/243 pass, 0 fail, 0 skipped**, 14.33 s.
- `npm run build:web` → exit 0; Vite 6.4.1, 3.86 s; прежнее предупреждение о чанке 742.53 kB (>500 kB) остаётся.
- `node scripts/preparation_binding_probe.mjs verify all` и `audit all` → все **12/12** ресурсов/реестровых записей `ok:true` в каждом проходе.
- Реальные bindings: независимый первый прогон создал PASS verdict для 5 available (`grill-me-intent`, `grill-with-docs`, `ce-brainstorm`, `ce-plan`, `ce-doc-review`); целевой `superpowers-architectural` завершён отдельно PASS с 202 transcript lines. Итого **6/6 available PASS**. Все шесть unsupported (`ce-work`, `ce-pov`, `superpowers-execution-handoffs`, `ce-doc-review-cross-model`, `superpowers-visual-companion`, `ce-slack-researcher`) независимо вернули **422 `route_unsupported`, 6/6 PASS**. Первоначальный общий smoke был прерван после пяти completed available bindings, до verdict шестого; он не засчитан как успешный общий запуск — недостающий binding закрыт отдельным PASS.
- Browser E2E `scripts/e2e_preparation.py` → **56/56 PASS, 0 fail, 42 s**. Реальные ID: small session `prep_7d2e188f-61fe-49b6-867c-8b92d41ad361`, complex session `prep_c4a5161d-3e6e-46b8-a382-5b61bbcdf2bc`; handoff создал **0** implementation runs. Отдельно повторно пройдены reload, second tab, offline, legacy card и runner restart F1–F3.
- После проверки выполнен `python3 scripts/u7_transition.py restore`; `python3 scripts/u7_transition.py verify` → `verify: all scoped+cron specs match the captured actual spec`. `GET /health` → `{"ok":true,"dir":"/home/hermes/.hermes/acp-ui-state","docs":12}`; web root → HTTP 200; preparation bindings и prep view в baseline → HTTP 404.
- Возвращены сохранённые до теста данные `/home/hermes/.hermes/acp-ui-state-u7` (1428 файлов, 20,860,787 bytes). Созданные браузерным E2E данные не удалялись: сохранены отдельно в `/home/hermes/.hermes/acp-ui-state-u7-watchdog-test-20261003` (114 файлов, 1,114,526 bytes). Porch active list → `[]`.
- Git baseline `/tmp/idea-prep-p5-baseline.status`: 118 путей. Текущий status: 126; **0 baseline paths removed, 8 expected P5 paths added**, никаких изменений статуса у базовых путей. HEAD не менялся; reset/clean/stash/commit/push не выполнялись.

### Вывод и не измерено

Функциональные acceptance criteria P0–P5 выполнены, поэтому Idea Preparation принимается целиком в границах плана. Не измерялось непосредственное влияние краткого рестарта сервисов на пользователей во время тестового Compose transition; после отката health/read-back зелёные, но нулевое влияние не предполагается. Качество семантического содержания длинных интервью модели сверх контрактов/долговечности не оценивается. `orchestrator`/`swarm` consumers и их реализация остаются вне scope; preparation только выдаёт честный durable offer.

**Watchdog остановлен:** Hermes cron `976129e827b0` переведён `enabled=false, state=paused` после приёмки; сохранён для обратимого resume. Остальные cron jobs не менялись.
