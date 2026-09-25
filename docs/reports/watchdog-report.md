# W15 — Крон-диспетчер: такт проверки живых прогонов (idle watchdog): отчёт

STATUS: DONE

## Чего не хватало (по брифу)

`server/acp-runner.mjs` умел heartbeat, sweep протухших lease, maxRetries и
краны, но зависший прогон (ребёнок жив, минутами молчит — крутится на
промпте) был невидим до истечения всего lease. Нужен «ленивый техдир раз в
N минут»: такт внутри существующего цикла `pollIntervalSec`, который
свежих не трогает, молчунов прибивает и всё пишет в леджер.

## Что изменено

- `server/acp-runner.mjs` — изменения строго под вотчдог (остальное не
  тронуто, как у соседней карточки planqueue: «the only change allowed»):
  - **claim** теперь несёт `lastOutputAt`: ставится при взятии карточки,
    перезаписывается временем спавна каждой попытки (mutate публикации pid)
    и актуальным штампом на каждом heartbeat-тике (`renewLease` пишет его
    же, рядом с `hbAt` — лишних записей в claims.json нет);
  - **свежесть**: stdout и stderr ребёнка штампуют `run.lastOutputAt` —
    байт любого вида считается жизнью;
  - **такт вотчдога** — тот же `setInterval` heartbeat'а (второго цикла
    нет): renew lease → `idleTick()`. Решение по порядку: ребёнок жив и
    свеж → ничего; жив и молчит дольше `idleTimeoutMin` → та же SIGTERM →
    SIGKILL-через-10-сек эскалация, что и у lease-таймаута (`terminate`
    теперь общая); запись в леджер `idle Nm — terminated <card>, attempt
    X/Y` с `role` + `sessionId`; мёртвый ребёнок с незакрытым claim —
    покрыт существующим `finally { releaseClaim }` (проверено в e2e,
    дубликата нет);
  - **gate rule**: claim остаётся нашим до выхода — килл вотчдога идёт по
    обычному пути non-zero exit → `attempts` растёт, retry/блок по
    `maxRetries`. Exit-запись помечается `idle-terminated` (раньше там
    были `timeout`/`finished`);
  - `idleTimeoutFor(role)`: `idleTimeoutMin` <= 0 выключает вотчдог,
    отсутствие/мусор → 15 мин; дробные значения честны (e2e использует
    0.05 мин);
- `src/stores/roles.ts` — поле `idleTimeoutMin` в `Role` (sanitize default
  15 через `intAtLeast` — старые роли без поля получают 15; validate
  `>= 0`), по образцу `maxRetries`;
- `src/features/roles/RolesSection.vue` — инпут `role-idle` (min 0) в
  форме, подхват в `formToRole`/`startEdit`/`resetForm`, строка лимитов
  показывает `idle Nm` / `idle off`;
- `src/stores/claims.ts` — `lastOutputAt?: number` в `CardClaim` (зеркало
  документа, как `hbAt`);
- `src/features/board/AgentsTab.vue` — `idle …m — terminated` добавлено в
  словарь ошибок `isFailureEntry` — килл вотчдога красится как сбой;
- `scripts/e2e_watchdog.py` — новый сьют: свой state server на **25962**,
  веб для UI-ноги на **25963**, `tmp-watchdog-test/`, stub `node
  stub-cli.mjs` (печатает `SESSION:` один раз, пишет `child.pid`, умеет
  молчать `STUB_SLEEP_SEC`, болтать `STUB_CHATTER_SEC`, уходить с
  `STUB_EXIT`). Зарегистрирован в `scripts/e2e_all.py` строкой
  `("watchdog", …)`.

## Проверка

```
$ node --check server/acp-runner.mjs          -> OK
$ npm run build:web                           -> vue-tsc + vite OK (2.93s)
$ ~/.hermes/tools-venv/bin/python scripts/e2e_watchdog.py
```

Хвост полного прогона (32 проверки):

```
PASS  idle: card claimed
PASS  idle: claim carries lastOutputAt + startedAt  ({"startedAt": 1790335083884, "lastOutputAt": 1790335083899, "pid": 152738})
PASS  idle: --once exits 0
PASS  idle: claim released after the run
PASS  idle: two run logs (one per attempt)  (run-1.log,run-2.log)
PASS  idle: ledger carries «idle Nm — terminated» for both attempts  (["idle 0.1m — terminated card-idle, attempt 1/2 (idleTimeoutMin=0.05)", "idle 0.1m — terminated card-idle, attempt 2/2 (idleTimeoutMin=0.05)"])
PASS  idle: kill entries carry role + sessionId
PASS  idle: exit entries marked idle-terminated  (exit=127 dur=5s attempt=1/2 idle-terminated …)
PASS  idle: watchdog kill counts as a failed attempt  ({"card-idle": 2})
PASS  idle: maxRetries exhausted -> card flagged blocked  (maxRetries 2 ex…)
PASS  chatty: --once exits 0
PASS  chatty: run finished clean (exit 0)
PASS  chatty: no watchdog kill while output flows
PASS  fast: --once exits 0
PASS  fast: single run log  (run-1.log)
PASS  fast: exit=0 finished, no idle entries
PASS  fast: no attempts counter, card not blocked
PASS  off: card claimed
PASS  off: --once exits 0
PASS  off: hang left to the lease timeout, claim released
PASS  off: NO watchdog kill entries
PASS  off: exit marked 'timeout' (the lease path, not idle)  (exit=127 dur=9s attempt=1/1 timeout)
PASS  off: single run log (no retry past maxRetries=1)
PASS  off: the timeout failure still flags blocked
PASS  roles UI: legacy role sanitized to the 15m default  (… retries 1 · idle 15m)
PASS  roles UI: role with idleTimeoutMin=4 added
PASS  roles UI: limits line shows 'idle 4m'
PASS  roles UI: idleTimeoutMin persisted as 4  ({"id": "wd", …, "idleTimeoutMin": 4})
PASS  roles UI: limits line shows 'idle off' after edit
PASS  roles UI: idleTimeoutMin=0 persisted  ({"id": "wd", …, "idleTimeoutMin": 0})
PASS  roles UI: idleTimeoutMin < 0 rejected  (idleTimeoutMin must be >= 0)
PASS  zero pageerror events

32/32 checks passed
```

Регрессии:

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_runner.py   -> 26/26 checks passed
$ ~/.hermes/tools-venv/bin/python scripts/e2e_dispatch.py -> 46/46 checks passed
$ ~/.hermes/tools-venv/bin/python scripts/e2e_roles.py    -> 35/35 assertions passed
```

## Что НЕ проверено живьём

- Тик вотчдога гонялся только через heartbeat-интервал внутри `runCard`
  (`--once` в e2e); в `--serve` путь тот же — интервал живёт, пока идёт
  прогон, — но длительный serve-прогон часами не наблюдался.
- Реальный CLI-агент (devin/hermes/opencode) — только `node`-заглушка;
  «тишина» определена по байтам stdout/stderr, у живых CLI фоновый вывод
  может быть другим (например, долгое молчание при большом файловом
  чтении — для таких ролей и есть `idleTimeoutMin: 0`).
- `lastOutputAt` в claim виден панели/внешним читателям, но отдельного
  отображения «свежести» в UI не делалось — только тип в `CardClaim` и
  окраска килл-записи как ошибки в Agents tab.
- SIGKILL-эскалация после watchdog-SIGTERM не проверена отдельно (общий
  `terminate` с lease-таймаутом; SIGTERM-ветка в e2e исполнялась,
  10-секундный grace — по ревью кода).
- Гранулярность тика = `max(5s, pollIntervalSec)` — килл всегда на первом
  тике после порога; для порогов < 5 с срабатывание позже порога (в e2e
  0.05 мин → килл ~5 с). Это осознанное «раз в N минут», а не realtime.

## Заметки реализации

- `lastOutputAt` пишется в claims.json не на каждый байт (это был бы
  GET+PUT на data-событие), а на heartbeat-тике и при публикации pid —
  решение о килле принимает in-memory штамп, поле в claim — для аудита и
  внешних наблюдателей.
- Мёртвый ребёнок + живой claim: для своих прогонов покрыто `finally`
  в `runCard`; для чужих claim с живым lease диспетчер нарочно не
  вмешивается — lease определяет владельца, sweep работает только по
  истёкшим.
- `idleTick` ставит `killReason` синхронно до await леджера — повторный
  тик/гонка с lease-таймаутом не убьёт дважды; килл вотчдога и таймаута
  делят один `terminate` (SIGTERM → SIGKILL через KILL_GRACE_MS).
- Сид roles.json в UI-ноге e2e повторяет `e2e_roles.py` (`json.dumps`
  дважды в Python → одинарно-закодированный документ в localStorage);
  заодно читатель документа терпим к двойной кодировке.
