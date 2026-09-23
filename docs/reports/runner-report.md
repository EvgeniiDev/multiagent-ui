# W5-B — Раннер: отчёт

STATUS: DONE

## Что сделано

- `server/acp-runner.mjs` (новый, Node stdlib, без зависимостей):
  `--once` / `--serve` / `--stop-all`; `STATE_URL` (дефолт
  `http://127.0.0.1:25900`), `ROOT_DIR` (дефолт `$HOME/projects`),
  `DRY_RUN=1`, `RUNNER_ID`. Проход: читает `board/projects/roles/claims`,
  берёт карточки со стадией из `stageRoles` без живого claim, без флагов
  `blocked`/`cancelled`, не из `done`/`backlog`, при свободном слоте
  `maxConcurrent`; claim rev-safe (bounded retry на 409) с
  `leaseUntil = now + timeoutMin`, `agentName = <runnerId>:<roleId>`,
  `pid` публикуется rev-safe после spawn; бриф `00_brief.md` (id, заголовок,
  acceptance, verification, путь артефактов, путь файла роли, требование
  `STATUS:` последней строкой — и ничего больше); spawn через
  `child_process.spawn` с `cwd = projectPath`, stdout/stderr в
  `run-<N>.log`; по завершении — событие `kind: 'card'` в `activity.json`
  (команда, exit-код, длительность, последняя строка `STATUS:` из `05_*`/
  `04_*`, имя лога), снятие claim; карточка НЕ двигается. Таймаут →
  `SIGTERM`, через 10 с `SIGKILL`; недоступный сервер состояния — stderr
  без падения (`--serve` продолжает цикл). `--stop-all` снимает свои claim'ы
  и шлёт `SIGTERM` своим процессам (по pid из памяти и из claims).
- `server/acp-state-server.mjs` восстановлен из истории этого репозитория
  (`control-center`, коммит `9ac0101`): e2e поднимает свой сервер на порту
  25907 с `STATE_DIR=<worktree>/tmp-runner-test`.
- `scripts/e2e_runner.py` (новый, python3 stdlib): свой state server на
  25907, проект с `path` внутри `tmp-runner-test`, карточка в `dev`, роль с
  `cli` = скрипт-заглушка (пишет `04_impl_log.md` со `STATUS: DONE` в каталог
  карточки, exit 0). Проверяет: claim поставлен и снят, `00_brief.md`,
  `run-*.log`, событие в `activity.json` с exit 0 и вердиктом, карточка
  осталась в `dev`; живой чужой claim блокирует взятие; `maxConcurrent: 1`
  при двух карточках — один прогон за проход; `blocked` не берётся;
  `DRY_RUN=1` ничего не запускает; `--stop-all` снимает свои claim'ы.

## Вывод команд

```
$ node --check server/acp-runner.mjs server/acp-state-server.mjs
OK (оба)

$ ~/.hermes/tools-venv/bin/python scripts/e2e_runner.py
PASS  once exits 0
PASS  once prints run summary  ({ "ok": true, "runs": [{ "card": "card-dev-1", "exitCode": 0, ... }] })
PASS  claim released after run  ({"version": 1, "claims": {}})
PASS  00_brief.md created
PASS  brief holds id+title+acceptance+STATUS rule
PASS  run-*.log created  (run-1.log)
PASS  run log captures stub stdout
PASS  stub wrote verdict into the card dir (04_impl_log.md)
PASS  stub got the brief path
PASS  activity.json gains a card event  (kind=card, agentName=e2e-runner:dev)
PASS  event cites exit 0
PASS  event cites verdict STATUS
PASS  card NOT moved (still dev)  (dev)
PASS  live foreign claim: once still exits 0
PASS  live foreign claim: no run started  (runs: [])
PASS  live foreign claim: no new log
PASS  maxConcurrent=1: exactly one card runs
PASS  maxConcurrent=1: the other card untouched
PASS  blocked card: no run started  (runs: [])
PASS  blocked card: no brief written
PASS  dry run exits 0
PASS  dry run prints the command  ([dry-run] ...)
PASS  dry run spawns nothing (no 04_impl_log.md)
PASS  dry run leaves no claim
PASS  stop-all exits 0
PASS  stop-all releases own claims

26/26 checks passed
```

## Что не проверено

- `--serve` (долгий цикл) — только `--once` и `--stop-all`; логика цикла та
  же (`passOnce`), интервал берётся из минимального `pollIntervalSec`.
- Реальный CLI-агент (devin/opencode/…) — только заглушка с exit 0.
- Таймаут-убийство (`SIGTERM`→`SIGKILL`) — `timeoutMin: 5` в тесте, прогон
  занимает доли секунды; ветка кода ревьюирована, живьём не гонялась.
- Гонки двух раннеров за одну карточку — rev-safe запись покрыта retry на
  409, параллельный прогон двух раннеров не запускался.
- `cancelled`-флаг отдельной проверкой не покрыт (код отсекает его вместе с
  `blocked`; e2e покрывает `blocked`).

## Заметки реализации

- `child.on('close')` подписывается синхронно при spawn: быстрый процесс
  может завершиться до первого `await`, поздняя подписка никогда не
  срабатывает (ловилось на заглушке — процесс зависал с живым pid в claim).
- Лог пишется накоплением чанков в памяти + один `writeFile`: `FileHandle`
  + `createWriteStream` в Node 26 не отпускает `fd.close()` при живых
  пайпах. Для CLI-агентов с большим выводом это держит вывод в памяти —
  приемлемо для тонкого слоя; при необходимости — потоковая запись с
  явным `end`/`close` стримов.
- `BRIEF.md` в рабочей копии уже изменён оркестратором (чужое изменение);
  в коммит идут только три файла ниже.
