# U1: исходное состояние среды runner

Дата: 2026-09-30. План: [первая поставка ядра](../plans/agent-core-implementation-plan.md).

Ниже сохранена исходная инвентаризация до изменений U1. Проверки реализации и итоговый контроль описаны в последующих разделах.

## Наблюдения

- `docker compose ps`: runner работает; штатные сервисы доступны. Перед действиями проверены слушающие порты через `ss -tlnp`.
- `docker compose exec -T runner sh -c …`: UID=0, bash и Pi доступны; git и Python отсутствуют. Devin и Codex доступны через `/home/hermes/.local/bin` в штатном PATH.
- В работающем контейнере отсутствуют `/home/hermes/.pi`, установленный каталог porch и `/home/hermes/.codex`. Наличие авторизации внутри CLI отдельно не проверялось; содержимое секретов не читалось.
- `docker inspect` показывает, что runner запущен с прежними mount: отдельные каталоги `.hermes`, `.local`, проекты и `/usr/bin/pi`. Текущий `compose.yaml` уже задаёт mount `.pi` и `.hermes` целиком. Файл конфигурации и фактический контейнер расходятся.
- `Dockerfile.node` явно устанавливает только libatomic1 и Node-пакеты Pi/ACP; git и Python в зависимостях не объявлены.

## Следующие действия U1

Добавить объявленные зависимости образа и настройки runner для porch, авторизации и постоянных артефактов; выбрать UID с корректными правами. Учитывать существующие незакоммиченные изменения `compose.yaml`, не заменять файл целиком. Пересоздание контейнера выполнять через Compose после проверки активных задач, поскольку оно завершает процессы текущего раннера.

Затем проверить запуск, события, полный результат, подтверждённую отмену и восстановление наблюдения для Devin, Codex и Pi. До этих проверок совместимость porch с рабочим runner не подтверждена.

## Реализация и проверка U1 (2026-09-30)

### Реализовано

- `server/execution/common.mjs` — `spawnBounded` (таймаут + killGrace + settle-дедлайн, обрезка stdout/stderr, `observationCut`, устойчивость к наследованным пайпам и EPIPE stdin), безопасные ID, `RuntimeError` с типизированным `code`.
- `server/execution/porch-runtime.mjs` — процессный адаптер поверх публичных команд porch: `start` (эксклюзивный attempt-каталог, снимок конфигурации в `attemptDir/porch-config.json`, `PORCH_RUN_DIR`/`PORCH_PI_SESSION_ID` на попытку, `launch_failed` vs `launch_uncertain`), `status`/`events`/`wait`/`cancel` через `delegate`, `reconcile` с AND-семантикой по `delegate list --all --limit 0`, `environment()` с uid/pidNs/starttime. Импорт без побочных эффектов.
- `server/execution/fake-runtime.mjs` — детерминированный backend с тем же API и инвариантами (эксклюзивные attempt, обязательный снимок конфигурации, терминальная иммутабельность, отмена, uncertain launch, курсоры событий).
- `server/execution/runtime-contract.md` — контракт адаптера.
- `Dockerfile.node` — добавлены `bash git python3 ca-certificates`.
- `compose.yaml` (только сервис runner): `user: "1001:1001"`, `ACP_EXEC_DIR`, явный список volumes с добавлением `~/.codex` (rw) и `~/.gitconfig` (ro). Живой контейнер НЕ пересоздавался.
- Проверки: `scripts/u1_runtime_selftest.mjs` (19 тестов, офлайн), `scripts/u1_live_smoke.mjs` (режимы run/cancel), `scripts/u1_restart_smoke.mjs` (launch/observe в разных процессах Node).

### Команды и результаты

- `node --test scripts/u1_runtime_selftest.mjs` — 19/19 (хост, node v26).
- `docker compose run --rm --no-deps --entrypoint node runner --test /repo/scripts/u1_runtime_selftest.mjs` — 19/19 в образе (node v26 из `.local/bin`; также 19/19 под `/usr/local/bin/node` v22).
- `docker compose run --rm --no-deps --entrypoint /bin/bash runner -c '...'` — uid=1001, git 2.39.5, python3 3.11.2, devin/codex/pi в PATH, porch исполняемый, `~/.pi`/`~/.codex`/`~/.local/share/devin`/`~/.hermes` смонтированы, `ACP_EXEC_DIR` доступен на запись.

### Живой смоук (compose run, изолированные root `/home/hermes/.hermes/acp-ui-state/u1-smoke` и `u1-restart`)

| CLI | Запуск | События | Результат | Отмена |
|---|---|---|---|---|
| pi | `run_keen-onyx-fd0b` (242мс) | 21 | completed, маркер найден, 13с | `run_scarlet-comet-a92e` → cancelled (exit 130, 8с) |
| codex | `run_early-fjord-d59e` (235мс) | 16 | completed, маркер найден, 5с | `run_lively-cedar-e1d3` → cancelled (exit 130, 12с) |
| devin | `run_brisk-prairie-8ad1` (232мс) | 18 | completed, маркер найден, 10с | `run_warm-lichen-89c9` → cancelled (exit 130, 9с) |

- Restart-доказательство (один контейнер, uid 1001, один pidNs): launcher `node` (pid 7) запустил `run_solar-delta-0165` и завершился; свежий observer `node` восстановил контекст из persistent root, нашёл ровно этот живой run через `reconcile`, `cancel` → terminal `cancelled` (exit 130).
- Итог реестров разработчика: 8 смоук-запусков, все терминальные (3 completed, 5 cancelled), живых не осталось.
- Артефакты попыток (control/final/final.txt/meta.json/normalized/raw/turns + launch.json) сохранены в `.../u1-smoke/exec/attempts/*` и `.../u1-restart/exec/attempts/*`.

### Журнал отклонений

`docs/tmp/2026.09.30_agent-core-u1_deviations.md` — 23 записи: дефекты bounded-наблюдения, семантики reconcile, идентичности среды, fake-инвариантов, смоук-драйвера и наблюдения о среде. Исправления подтверждены указанными проверками; особенности среды отмечены отдельно.

## Независимый контроль результата

- Контролёр повторно выполнил `docker compose run --rm --no-deps --entrypoint /usr/local/bin/node runner --test /repo/scripts/u1_runtime_selftest.mjs`: 19/19, exit 0 под Node 22.
- Сохранённые реестры и ответы трёх CLI проверены отдельно: нужные маркеры присутствуют в полном ответе; успешные запуски completed/0, отменённые cancelled/130.
- Обновлённый restart-драйвер повторно проверен контролёром в одном одноразовом контейнере: `run_crisp-cobalt-3fa6`, launcher PID 7 завершился, observer PID 1, одинаковые UID 1001 и pidNs; точный живой запуск найден, отмена подтверждена cancelled/130; exit 0. Артефакты: `/home/hermes/.hermes/acp-ui-state/development/u1-swe2max/parent-restart/`.
- Итог: восемь пробных запусков разработчика и один независимый контрольный запуск терминальные. Образ runner собран; работающий сервис остаётся на прежнем контейнере. Подключение runtime к карточкам и планировщику относится к U2–U4.
- Код U1 написал Devin через porch, профиль SWE-2 Max. Контролёр проверил код, направил исправления и выполнил независимые проверки; уточнения итогового отчёта сделаны по сохранённым результатам.
