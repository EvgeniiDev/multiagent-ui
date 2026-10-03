# U5: проверки, ревью, исправления, приёмка + production wiring — отчёт

Дата: 2026-10-01. Ветка `feat/agent-modes`.
План: [agent-core-implementation-plan.md](../plans/agent-core-implementation-plan.md).
Журнал отклонений: [2026.10.01_agent-core-u5_deviations.md](../tmp/2026.10.01_agent-core-u5_deviations.md).

Отчёт покрывает **U5** (validation-worktree, принятые checks, reviewer/
checker через managed-артефакты, ограниченные fix-циклы, приёмка по hash)
и **production-интеграцию** managed-ядра в `acp-runner`/`boardctl`
(default-off, serve-only, quiesce/drain при остановке). U6 и U7
(реальные CLI/Compose/браузер) не реализованы и не заявлены готовыми.
Модуль ждёт родительского независимого прогона и приёмки.

## Реализовано

| Файл | Содержание |
|---|---|
| `server/execution/managed-scheduler.mjs` | `runValidationTask`: реальные check-процессы с durable-логами, intent→recorded→settled/unproven записями, never_spawned-гейтами до/после intent, lease-heartbeat/cancel-poll; фазы review/check_review — роли в **своих** pristine-копиях, evidence импортируется из `.acp-out/` и биндится к attempt/round/resultSha256; fix-циклы через `fixContext` + гидратированные verified-артефакты; restart/spool reconcile с typed-доказательствами; **`quiesce()`/`drain()`** — runner-выключение: забор новых работ + drain собственных групп + удержание reservation для adoption; per-tick `scanPredecessors`; журнальный replay с typed-discharge. |
| `server/execution/execution-domain.mjs` | `end_validation` с procs_unproven-барьером и settled-gate (verdict→review-фаза); `record_report` по verified artifact-bytes; `accept_result` bound к run+resultSha256+controlRevision; immutable committed-артефакты с физическим именем `stored` = идентификатору записи; budget-отказы (`attempts_exhausted`); `command_receipt` read-only dedup seam. |
| `server/execution/result-snapshot.mjs` | `computeResultManifest` (git-bound снапшот: dirty/new/deleted/mode, symlink/gitlink/unmerged fail-closed); `materializeResultCopy` + `verifyResultCopy` (containment по realpath); `runCheckCommand` — настоящие process groups, durable stdout/stderr, kill/cancel, положительное group-death доказательство. |
| `server/execution/prompt.mjs` | Prompt'ы ролей с bound `.acp-out` схемой (round/resultSha256/attempt) и явным запретом legacy `boardctl review --close/--round/--sync/review-check` на managed-картах; `.acp/cards` — legacy-only, managed-пайплайн их не читает. |
| `server/execution/review-contract.mjs` | Валидация findings/verdict документов: blocking/disputed/unvetted/rejected/minor семантика гейта. |
| `server/acp-runner.mjs` | Production-драйвер: `createManagedPump` (цепочка таймеров — перекрытие невозможно конструктивно, sync-throw/settle не сталлят, bounded drain); `createManagedDriver` (гейт `ACP_EXEC_START`, fail-closed stateDir-деривация, client/runtime/scheduler, стартовая evidence-строка без секретов, **один общий дедлайн** quiesce→pump→task drain); `runOnce` — отказ managed до построения; `runServe` — quiesce по сигналу немедленно, legacy-pass может оставаться заблокированным; import-safe `main`. |
| `scripts/boardctl` | Managed: `review` (read-only из агрегата, `--json`), `accept` (user-channel lifecycle command, bound к run+resultSha256+controlRevision, retry по revision_conflict), `stop` (user-channel lifecycle command); отказы legacy-записей на managed-картах до любой мутации; unmanaged-карты — полное legacy-поведение. Internal-токен boardctl не использует — authenticated internal-канал только у scheduler'а/импорта роль-evidence. |

## Плановые сценарии → доказательства

| Сценарий плана U5 | Тест / место |
|---|---|
| exit=0 агента при failed checks не даёт готовность | `U5 fix cycle`, `U5 fix gate` — verdict fail → нет awaiting_acceptance, путь fix/blocked |
| проверки не изменяют workspace задачи | checks выполняются в `verify`-копии; `U5 fix producer` биндит результат IMPLEMENTER'а; `copy: separate pristine copies stay independent`; snapshot resultSha256 фиксирует задачу до копий |
| новый/удалённый/незакоммиченный файл входит в снимок | `manifest: dirty tracked + new untracked + deleted captured`, `manifest: binary bytes/mode change` |
| отсутствующий verdict блокирует готовность | `U5 fix gate` + `driveRolePhase report_missing → failed`; `record_report` требует verified bytes |
| disputed/unvetted блокируют | `u5_core`: `gate: boardctl parity — open critical/major gate; rejected clears; minor/nit never gate` — open/no-verdict/disputed gating |
| отклонённое замечание не блокирует | `U5 golden path` — verdict `rejected` на open major → awaiting_acceptance |
| открытое неблокирующее сохраняется в отчёте и не блокирует | `U5 golden path` — open `minor` finding f2 без verdict'а сохранён в записанном report и гейт не держит; `u5_core` parity-тест — minor/nit never gate |
| лимит цикла даёт blocked | `U5 fix budget` (maxAttemptsPerRole=1), `U5 fix gate` (maxReviewRounds) |
| исправления запускают новые проверки | `U5 fix cycle` — новый round, новая validation, immutable round-1 артефакты при логических коллизиях имён |
| изменение результата перед accept отклоняет приёмку | `U5 accept boundary` — реальная мутация canonical-workspace ПОСЛЕ awaiting_acceptance: `accept_result` с ОРИГИНАЛЬНЫМ одобренным resultSha256 → 409 `workspace_drift` (domain пересчитывает живой manifest), run остаётся parked; восстановление байтов → тот же hash принимается |
| остановка проверки завершает только её process group | `U5 stop during a running check drains the proven group`, `check: cancel kills own group; unrelated sentinel survives`, `U5 quiesce` (OS-проверка пустого pgid) |

## Production-интеграция (seq74)

- **Default-off:** без `ACP_EXEC_START` ни client/runtime/scheduler/pump/
  timer/listener не создаётся; import модуля свободен от side-эффектов.
- **Параллельность:** managed-тики идут независимо от многочасового
  заблокированного `passOnce()`; серийность без перекрытия по построению.
- **Изоляция отказов:** ошибки тика/API-down/legacy-pass не убивают
  соседний контур.
- **Остановка:** SIGTERM → quiesce немедленно (до возврата pass), bounded
  drain в одном дедлайне; reservation/proc-записи не терминализируются.
  Удержанный reservation остаётся с записанным владельцем — истечение
  lease само adoption НЕ разрешает: наследник обязан принести
  положительное доказательство смерти владельца или retirement
  оригинального окружения.
- **`--once`:** при включённом гейте — отказ с указанием `--serve`, до
  построения зависимостей; legacy-only `--once` без изменений.
- **`stop-all`/`release-all`/`cancel`:** только `claims.json`/`liveProcs`;
  managed-lifecycle не имперсонируется.
- **boardctl:** managed-карты — только execution API (user-channel
  lifecycle-команды без internal-токена; reads из агрегатных GET'ов);
  `BOARD_STATE_DIR`/offline-записи managed отсутствуют и запрещены.

## Чем доказано (честные слои)

- **Реально:** git/manifest/копии, check process groups + kill/death-proof,
  state-service request surface (in-process, CAS/dedup/aggregate —
  без сетевого listener'а), artifact-store байты/SHA, журнал/spool
  на диске, scheduler pump/quiesce через production `runServe`+driver.
- **Заглушки:** роль-CLI через `fake-runtime` (porch-runtime stub);
  boardctl-тесты — injected transport (без живого listener'а);
  `mkClient` — реальный authenticated internal client по request surface.
- **НЕ доказано (U7):** реальные Pi/Codex/Devin процессы, Compose-стек,
  браузерные пути, живой ops-retire против Docker.

## Результаты проверки

| Сьюта | Результат |
|---|---|
| Полный U1–U5 (u1-u5-20261001-0508.log, независимый прогон родителя) | **213/213 PASS**, 187.056s, exit 0 |
| Полный U1–U5 на текущем коде (локальный последовательный прогон) | все сьюты зелёные, exit 0 |
| `u5_domain_selftest.mjs` | 28/28 (вкл. 2 quiesce + accept-boundary drift + recovery/spool/journal матрицы) |
| `u5_runner_wiring_selftest.mjs` | 17/17 (вкл. driver.stop ordering/budget) |
| `u5_boardctl_managed_selftest.py` | 16/16 |
| `u4_core_selftest.mjs` | 59/59 |
| `u1_runtime` / `u2_state` / `u3_core` / `u5_core` | 19/19 · 34/34 · 43/43 · 31/31 |

Исторический инцидент `u1-u5-20261001-0501.log` закрыт как
**UNATTRIBUTABLE**: повторный прямой аудит исходного лога подтвердил, что
отличающий fingerprint не записывался, а per-test state удалялся. Окно
ограничено `[record_snapshot → proc-intent]`, точнее — до сохранения
leadered proc record; доказанный U7b CAS-starvation того же вида уже исправлен,
но не доказывает причину именно 0501. Продуктовый фикс по этому событию не
вносился. Это закрывает только ретроспективную диагностику, **не** U5/Core
acceptance: оставшиеся U7 live/Compose/managed HTTP и runtime-гейты обязательны.
