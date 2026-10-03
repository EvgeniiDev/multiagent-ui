# U4: наблюдение, остановка и восстановление выполнения — отчёт

Дата: 2026-10-01. Ветка `feat/agent-modes`.
План: [agent-core-implementation-plan.md](../plans/agent-core-implementation-plan.md).
Журнал отклонений: [2026.10.01_agent-core-u4_deviations.md](../tmp/2026.10.01_agent-core-u4_deviations.md).

Отчёт покрывает **только U4** (управляемое наблюдение/остановка/
восстановление одного implementer-выполнения). U5–U7 (acceptance/checker
петли, review/fix запуски, Fusion, оркестратор, swarm, live-деплой)
не реализованы и не объявлены готовыми. U1–U3 приняты родителем ранее.
U4-модуль ждёт родительского независимого прогона и приёмки.

## Реализовано

| Файл | Содержание |
|---|---|
| `server/execution/managed-scheduler.mjs` | Тик-цикл наблюдения/остановки; **общий оригинально-окруженческий proof смерти процесса** (`classifyRecordedProcess`/`recordedChildDeath`/`recordedProcessDeath`) используется терминальным и vanished-путями идентично; lazy-probe — `runtime.processIdentity` вызывается только ПОСЛЕ проверки записанного pid+ns (thunk); cancelled-under-user-stop сохраняет `cancelled`, системный cancel без stop-интента → `interrupted`; lease-истечение во время outage отменяет только собственные ручки, унаследованные до adoption не трогаются; per-instance fail-closed журнал + dead-letter; курсор событий атомарен; стейджинг артефакта и durable-коммит при replay. |
| `server/execution/execution-domain.mjs` | `childNone` в whitelist супервизора (явная неизменная no-child аттестация); owner-гейты; `retire_environment` — единственный путь списания, точные slot+envInstance+generation+evidence. |
| `server/execution/porch-runtime.mjs` | `launch.pi = {sessionId:'acp-<attemptId>', sessionDir}` персистится в launch.json при старте — sessionDir считается ОДИН раз из эффективного launchEnv (base+params.env); `sessionLog(attemptId)` читает только записанный dir (после рестарта тоже); `PORCH_PI_SESSION_ID`→`--session-id` через установленный адаптер; errno-aware `processIdentity`; `/proc` probes. |
| `server/execution/fake-runtime.mjs` | `sessionLog(attemptId)` по собственной записанной cwd рана (сигнатура унифицирована с реальным runtime); явная `childSpawned/false` аттестация; `_force`, `_vanish`, `_procs`, `_calls` seams. |
| `server/execution/state-service.mjs` | `POST /api/internal/environments/retire` — ops-канал (`x-acp-ops-token`/`Bearer`), `ops_unavailable` без ключа, отличие от runner-токена; envelope `{commandId, type:'retire_environment', payload}`; события `?limit/&cursor`. |
| `server/execution/execution-store.mjs` | `environments.json` канонический валидированный лоадер (малформ = throw, fail-closed); retirements/commands дедупликация; run-проекции. |
| `scripts/retire-environment.mjs` | Хост-оператор хелпер: читает канонический ledger (`loadEnvironments`), bind-ит точные `envInstance`+`generation`; Docker-lifecycle proof через `docker inspect`/`ps -a --no-trunc` + host `/proc/<State.Pid>/stat` field22 (тот же jiffies-clock, что у runner envInstance.initStarttime); `--record` кладёт preflight receipt (slot+generation+envInstance+full64hex dockerId+bootId, атомарная запись 0600, антисивmlink по всем предкам) только для проверенно ЖИВОГО уникального контейнера; custom hostname без receipt отказывается всегда; `stopped`/`removed` из реального Docker состояния; running/live-unverifiable/ambiguous/unknown-status/malformed/daemon-error отказываются закрыто; `--dry-run` печатает команду и ничего не пишет; `--command-id` + already-retired short-circuit = безопасный повтор; `redirect:'error'` — токен никогда не следует редиректу. |
| `compose.yaml` (подготовлено, НЕ развёрнуто) | `state`: `ACP_OPS_TOKEN_FILE=/run/acp-ops/ops-token`, volumes заменяют anchor полным списком + `- /home/hermes/.acp-ops:/run/acp-ops:ro` — приватный каталог ВНЕ всех runner-mounts (projects/.local/.pi/.hermes/.codex). У runner mounts нет `.acp-ops` вообще — ключ недостижим даже при общем uid1001. |

## Контракты доказательства смерти (общие для terminal + vanished)

- Пропавший/чужой namespace → `foreign_ns`, **ноль** обращений к
  `runtime.processIdentity` (probe — thunk после проверки ns).
- Смерть супервизора = записанный PID + неизменный starttime + pidNs.
- Смерть ребёнка = записанный целый childPid + его starttime+ns; либо явная
  неизменная launch-аттестация `childNone===true`/`childSpawned:false`.
- `child_pid:null` в статусе НИКОГДА не доказательство отсутствия ребёнка
  (установленный control.py сериализует поле всегда).
- Неизвестное child-состояние → attempt сохраняется (reserved); живой или
  недоказуемый ребёнок → сохраняется; исчезновение под cancel → сохраняет
  user-stop семантику.

## Outage / replay контракты

- При API-outage: новых запусков нет; локальное наблюдение продолжается;
  истёкший lease отменяет только собственные ручки (journaled);
  nonterminal-запрос сохраняет attempt+reservation до терминального proof.
- Replay: синтетическая карточка `refreshCard` перед первым send
  (expectedInternalRevision); `bad_command`/`invalid_argument` на известном
  kind → удержание записи + durable `journal_apply_rejected`, dead-letter
  только для неисправимо битых байтов/неизвестных kind; replay resolve
  маппит статус рана как online (`cancelled`-без-stop → `interrupted`,
  stopping → сохранить prior/cancelled, `failed`→failed, `completed`→
  `awaiting_validation`); артефакт коммитится ДО resolve; журнал дренится;
  терминализованный ран не перезапускается автоматически.
- `heartbeat` берёт `leaseUntil` из ответа сервера (кламп домена ≥5000ms);
  локальный sched никогда не выдумывает lease.

## Ops-ключ (подготовлено, ключ НЕ создан и НЕ задеплоен)

```bash
# на хосте, один раз; существующий ключ не перезаписывать
install -d -m 0700 -o 1001 -g 1001 /home/hermes/.acp-ops
test -f /home/hermes/.acp-ops/ops-token || \
  openssl rand -hex 24 \
  | install -m 0600 -o 1001 -g 1001 /dev/stdin /home/hermes/.acp-ops/ops-token
```

48 lowercase hex. Без файла/при malformed/при равенстве runner-токену retire
закрыт `ops_unavailable`/`ops_token_*` диагностикой — бут не падает.
Хелпер: `node scripts/retire-environment.mjs --slot <s> --container-id <v>
--init-starttime <j> --generation <n> [--record|--dry-run|--command-id]`.

## Тесты (host, без сервисов и без docker)

`node --test scripts/u4_core_selftest.mjs` — **57/57 pass** (~13.3s).
Полный U1–U4: U1=19, U2=34, U3=43, U4=57 → **153/153** (см. финальный
прогон; родитель повторяет независимо). `u3_crossuid_proof.mjs` требует
root/`--child` — не входит в считанный набор (окружение, не регрессия).

Покрытие, сверх принятых 36: dead/unknown/vanished процесс-доказательства
с ZERO-probe для foreign/missing ns; null-child без аттестации retained;
lease-expiry cancel + полный replay-дрен; cursor paging/fault dedup;
implementer role-timeout (reviewer launch отказан — U5); helper:
identity/docker-error/parse/lifecycle/receipt/record/main seams + реальный
state-service маршрут (403/apply/dedup/409/503); Pi sessionLog через
реальный `start()`+`launchRecord`+recreate-runtime, custom HOME /
PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR(flat) / colon-cwd /
unrecorded/missing/ambiguous/unreadable.

## Не сделано (явные отсрочки)

- Reviewer/checker/fix запуски и стоп-флоу — **U5/U7**, не реализованы;
  `LAUNCHABLE_ROLES={implementer}` намеренно; fix = фаза implementer-а,
  отдельной роли вне EXEC_ROLES нет.
- Real Pi запуск/процесс/log-growth proof — **U7** (синтетические файлы не
  доказывают живой pi); helper не выполнен против живого Docker.
- U5 acceptance/checker петли, Fusion, оркестратор, swarm, idea prep —
  вне U4.
- Нет автоматического merge/push результата; `awaiting_validation` паркинг
  до U5; public start OFF через U5 (501).
