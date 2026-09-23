# W8 — Диспетчер (C3): отчёт

STATUS: DONE

## Чего не хватало (по брифу)

В `server/acp-runner.mjs` уже были: поллинг доски, rev-safe claim с
`leaseUntil`, один spawn на роль, запись `kind:'card'` в `activity.json`,
`--once`/`--serve`/`--stop-all`. Отсутствовали:

1. heartbeat — lease замирал на `timeoutMin`, второй диспетчер мог счесть
   карточку свободной при живом прогоне;
2. sweep истёкших lease — мёртвый диспетчер оставлял claim навсегда;
3. `maxRetries` — поле роли отсутствовало в модели и в раннере;
4. stop-краны — `cancel <cardId>` отсутствовал, `stop-all` не проверял,
   что pid — наш ребёнок;
5. аудит — записи не несли `role`/`sessionId`.

## Что изменено

- `server/acp-runner.mjs` — переписан поверх старого костяка:
  - **claim** теперь несёт `runnerPid` (pid процесса-диспетчера) и `stage`
    (стадия, из которой взята карточка) — первое нужно для проверки
    «свой ребёнок», второе — для возврата карточки;
  - **heartbeat**: пока жив ребёнок, `leaseUntil` продлевается тиком
    `max(5s, pollIntervalSec)` rev-safe; каждое продление — только в
    `RUNNER_DEBUG` stderr, в леджер не пишется;
  - **sweep** в начале каждого прохода (`--once` и `--serve`): claim с
    истёкшим `leaseUntil` и мёртвым pid снимается, карточка возвращается в
    стадию из claim (со статусами по правилам `moveCard` — `statusByStage` /
    initial), помечается `blocked` + `blockedReason: 'claim expired (…)'`
    (штатный механизм флагов — новых полей карточки нет) и пишется в леджер;
  - **maxRetries** (поле роли, дефолт 1 = без повторов): неуспешный exit
    перезапускает команду до исчерпания попыток; счётчик `attempts` лежит в
    `claims.json` рядом с `claims` и переживает снятие claim; успешная
    попытка сбрасывает счётчик; исчерпание → карточка `blocked` с причиной;
    non-zero exit при уже снятом claim (cancel/stop-all) — «aborted», не
    считается попыткой;
  - **краны**: `stop-all` (SIGTERM своим детям + снятие своих claim),
    `release-all` (только снятие), `cancel <cardId>` (flag → release →
    SIGTERM одному ребёнку, карточка помечается `blocked`, чтобы её не
    перезабрали на следующем поллинге). Пид сигналится только если это
    ребёнок процесса-диспетчера: `ppid(pid) === claim.runnerPid`
    (`/proc` + fallback `ps`), либо spawn из этого процесса. Чужие claim
    (`runnerId` ≠ наш) не трогаются вообще;
  - **аудит**: каждый переход — claim / start (с `attempt=k/max` и пометкой
    retry) / exit (code + duration) / retry / lease expired / cancel /
    stop-all — пишет `kind:'card'` запись с полями `role` и `sessionId`;
    `sessionId` снимается из stdout ребёнка (`session_id:`/`sessionId=`/
    `SESSION:` конвенции) и rev-safe публикуется обратно в claim.
- `src/stores/roles.ts` — поле `maxRetries` в `Role` (sanitize default 1,
  validate `>= 1`) — иначе панель затирала бы поле при каждой записи;
- `src/features/roles/RolesSection.vue` — инпут `role-retries` в форме и
  `retries N` в строке лимитов (иначе редактирование роли молча сбрасывало
  бы значение на дефолт);
- `src/stores/activity.ts` — `role?: string` в `ActivityEntry`
  (`sessionId` уже был);
- `scripts/e2e_dispatch.py` — новый сьют (свой state server на **25908**,
  `tmp-dispatch-test/`, роль `cli: node stub-cli.mjs` — заглушка печатает
  `SESSION: sess-<id>`, пишет `child.pid`, умеет спать/фейлить N раз и
  двигать свою карточку через board API). Зарегистрирован в
  `scripts/e2e_all.py` строкой `("dispatch", …, None)`.

## Проверка

Команда:

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_dispatch.py
```

Хвост вывода (полный прогон, 46 проверок):

```
PASS  leg1 once exits 0
PASS  role mismatch: spec card not taken, dev card ran
PASS  role mismatch: no card dir for the spec card
PASS  matching role: stub moved dev card to reviewtest
PASS  card moved exactly once (board rev +1, runner never moves)  (rev 1 -> 2)
PASS  spec card untouched (still spec, unclaimed)
PASS  dev card claim released after run
PASS  audit: claim/start/exit entries landed
PASS  audit: entries carry role=dev and sessionId
PASS  heartbeat: card claimed
PASS  heartbeat: lease renewed mid-run, past initial expiry  (1790187880190 -> 1790187885206)
PASS  heartbeat: second dispatcher still refuses the card  (runs: [])
PASS  heartbeat: run ended and claim released
PASS  heartbeat: exit entry carries role+sessionId
PASS  sweep setup: claimed and card moved by the stub
PASS  sweep: expired claim dropped and card flagged blocked
PASS  sweep: card returned to the stage it was claimed from  (dev)
PASS  sweep: visible mark names the expiry  (claim expired (disp-x:dev))
PASS  sweep: ledger entry with role+sessionId
PASS  retries: once exits 0
PASS  retries: failing stub ran maxRetries times  (run-1.log,run-2.log,run-3.log)
PASS  retries: attempt counter persisted  ({"card-hb": 1, "card-retry": 3})
PASS  retries: exhausted card flagged blocked with reason  (maxRetries 3 exhausted)
PASS  retries: attempt numbers in the ledger  (["1/3", "2/3", "3/3"])
PASS  retries: retry entries audited
PASS  retries: flaky stub retried once then passed  (run-1.log,run-2.log)
PASS  retries: successful retry clears the counter
PASS  retries: flaky card not blocked
PASS  retries: passing stub is not retried  (run-1.log)
PASS  retries: passing card keeps no counter and no flag
PASS  cranks setup: two dispatchers hold one card each
PASS  cancel exits 0 on an own claim
PASS  cancel killed that card's child
PASS  cancel released that claim only
PASS  cancel left the other child running
PASS  cancel flags the card blocked so it is not re-dispatched  (turn cancelled by disp-a)
PASS  cancel refuses a foreign claim (non-zero exit)  (rc=3)
PASS  cancel refusal kills nothing
PASS  cancel refuses the planted foreign claim too
PASS  stop-all exits 0
PASS  stop-all released only this dispatcher's claims
PASS  stop-all killed only this dispatcher's child
PASS  stop-all does not flag the released card
PASS  cranks: cancel/stop-all audited with role+sessionId
PASS  audit: every dispatcher entry carries a role field  (37 entries)
PASS  audit: exit entries carry the CLI's sessionId

46/46 checks passed
```

Регрессии:

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_runner.py   -> 26/26 checks passed
$ ~/.hermes/tools-venv/bin/python scripts/e2e_roles.py    -> 35/35 assertions passed
$ npm run build:web                                      -> vue-tsc + vite OK
$ node --check server/acp-runner.mjs                     -> OK
```

## Что НЕ проверено живьём

- `release-all` (кран «снять без убийства») — код есть, e2e-проверки нет;
  путь тот же, что у `stop-all` минус `killClaimChild`.
- `RUNNER_DEBUG=1` вывод heartbeat — уровень логирования проверен код-ревью,
  в e2e не ассертится (по спецификации: не в леджер).
- Реальный CLI-агент (devin/hermes/opencode) — только `node`-заглушка;
  sniffing `sessionId` проверен на конвенции `SESSION: <id>`, форматы
  вывода живых CLI могут отличаться — тогда `sessionId` честно остаётся `''`.
- `ppidOf` через `ps` (non-Linux fallback) — на этой машине `/proc` есть,
  ветка `ps` не исполнялась.
- Реальная двухраннерная гонка за ОДНУ карточку — в leg 5 два `--serve`
  работали параллельно, но взяли разные карточки; rev-safe claim покрыт
  retry на 409, явный стресс не гонялся.
- Таймаут-убийство `SIGKILL` после 10-секундного grace — `SIGTERM` по
  `timeoutMin` сработал живьём (leg 2), SIGKILL-эскалация — код-ревью.

## Заметки реализации

- `timeoutMin` двоится как kill-timeout прогона: «прогон, переживший свой
  lease» в буквальном смысле невозможен — heartbeat доказывается тем, что
  `leaseUntil` растёт дальше первоначального срока пока ребёнок жив.
- Порядок в `cancel`: flag → release → kill. Claim держит карточку вне
  pickup, пока ставится метка; а отпущенный claim — единственный сигнал
  прогону «тебя убили нарочно», иначе его exit-путь посчитал бы это
  провальной попыткой и перемаркировал бы карточку `maxRetries`.
- `cancel` помечает карточку `blocked` — иначе следующий полл молча
  перезабрал бы её и «отмена хода» ничего бы не значила. `stop-all`/
  `release-all` карточки не маркируют — по F9.7 остановка не должна
  терять карточки, они возвращаются в работу.
- `claims.json` получил соседний ключ `attempts` — boardctl и старые
  потребители doc'а лишние ключи сохраняют при мутации, обратной
  совместимости не ломается.
