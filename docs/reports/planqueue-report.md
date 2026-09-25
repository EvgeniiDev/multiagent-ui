# W15 — Файл-план как автопилот (plan-queue): отчёт

STATUS: DONE

## Что сделано

- `server/acp-runner.mjs` — единственное разрешённое изменение файла, в
  пути записи брифа (`runCard` → `briefText`):
  - `ensureChecklist(dir)`: при старте прогона, если `03_checklist.md`
    отсутствует, выводит его из пунктов `02_plan.md` (`planItems` — терпимо
    к `- `, `* `, нумерованным `1.`/`1)` строкам; уже-чекбоксные строки
    `- [ ]`/`- [x]` переносятся со своей меткой; заголовки, проза, таблицы
    и `STATUS:`-строки пунктами не являются). Файл существует → читается
    как есть и НИКОГДА не перегенерируется — его чекбоксы и есть состояние
    прогресса (исполнитель или правка руками). Плана нет или в плане нет
    пунктов списка → файла не создаётся.
  - `firstOpenItem(checklist)` + одна строка в `00_brief.md`:
    `Продолжай с первого незакрытого пункта 03_checklist.md: <текст пункта>`
    — только когда чек-лист существует и в нём есть открытый `- [ ]`.
    Парсинга плана в раннере нет: он поднимает пункты в чекбоксы и читает
    метки; «что сделано» решает исполнитель по строке брифа + промпту роли.
- `src/stores/artifacts.ts`: `03_checklist.md` добавлен в `FIXED_FILES`
  (сегодняшний bridge отдаёт в `list` только каталоги, поэтому хранилище
  пробует фиксированные имена); новый экспортируемый `parseChecklist()`
  (`- [ ]`/`- [x]` строки → `{done, text}`, прочие строки — проза) и
  константа `CHECKLIST_FILE`.
- `src/features/board/CardDrawer.vue`: в секции Artifacts — read-only блок
  «Plan checklist» (`data-testid="checklist"`): прогресс `n/m`, по строке
  на пункт с `disabled` чекбоксом, закрытые пункты зачёркнуты (`check-row.done`).
  Сам файл по-прежнему открывается как обычный артефакт из списка.
- `.acp/roles/dev.md`: контракт исполнителя — продолжать с первого `- [ ]`
  и отмечать `- [x]` по мере готовности (п.5 спеки: бриф + промпт роли).
- `.acp/README.md`: `03_checklist.md` описан в контракте каталога карточки.
- `scripts/e2e_planqueue.py` (новый): свой state server на :25917
  (`tmp-planqueue-test`), свой web на :25997; роль `dev` = `node stub-cli.mjs`
  (при `STUB_MARK=1` отмечает первый открытый пункт — работа исполнителя;
  всегда пишет `04_impl_log.md`, exit 0). Зарегистрирован в
  `scripts/e2e_all.py` строкой `("plan queue", …)`.

## Вывод команд

```
$ npm run build:web
> vue-tsc --noEmit && vite build --mode web
✓ built in 2.96s   (vue-tsc чисто)

$ ~/.hermes/tools-venv/bin/python scripts/e2e_planqueue.py
PASS  run1 once exits 0
PASS  run1 derives 03_checklist.md
PASS  run1 checklist: all items unchecked, verbatim texts  (- [ ] design schema | - [ ] build drawer | - [ ] wire e2e | - [ ] final cleanup)
PASS  run1 brief carries the continuation line
PASS  run1 brief names the first open item
PASS  run2 once exits 0
PASS  run2 stub marked item 1, rest stay open  (- [x] design schema | - [ ] build drawer | …)
PASS  run3 once exits 0
PASS  run3 brief names the next open item (continuation, not restart)  (…: build drawer)
PASS  run3 did not regenerate over the stub's mark
PASS  run4 once exits 0
PASS  run4 hand edit respected (no regeneration over user state)  (файл == HAND_EDIT побайтово)
PASS  run4 brief names the hand-chosen first open item  (…: wire e2e (hand rewrite))
PASS  run5 once exits 0
PASS  run5 all checked -> no continuation line
PASS  run5 all-done file untouched
PASS  run6 once exits 0 (malformed plan is no crash)
PASS  fresh card: brief written
PASS  fresh card: no continuation line
PASS  fresh card: no checklist derived (no plan)
PASS  malformed plan: no checklist file
PASS  malformed plan: no continuation line
PASS  drawer artifact list includes 03_checklist.md  (00_brief.md,02_plan.md,03_checklist.md,04_impl_log.md,run-1.log…run-6.log)
PASS  drawer renders one row per checklist item  (5)
PASS  drawer checkboxes reflect the marks (2 of 5 checked)
PASS  drawer checklist texts verbatim (incl. hand edit)
PASS  drawer checkboxes are read-only
PASS  drawer shows progress 2/5
PASS  done rows carry the .done style  (2)
PASS  zero pageerror events

30/30 assertions passed
```

Регрессии (после изменений, та же сборка):

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_runner.py
…
26/26 checks passed

$ ~/.hermes/tools-venv/bin/python scripts/e2e_card_pipeline.py
…
41/41 assertions passed

$ ~/.hermes/tools-venv/bin/python scripts/e2e_dispatch.py
…
46/46 checks passed
```

`ss -ltn` перед тестом: :25900 слушает живая панель (не трогаем — suite её
роутит в 500), :25907/:25917/:25997 свободны; в tmp-* каталоги после себя
suite чистит (`finally: rmtree`).

## Что не проверено

- Реальный CLI-агент, который правда закрывает пункты за несколько прогонов
  с падением посередине — только stub, имитирующий метку `- [x]`; контракт
  «бриф + промпт роли» с живой моделью не гонялся.
- `--serve` (долгий цикл) — только `--once`; деривация сидит в `runCard`,
  вызываемом из `passOnce`, т.е. работает в обоих режимах, но цикл живьём
  не крутился.
- Живая панель на :25900 с настоящим bridge `acp-ws-bridge.mjs` — UI-нога
  проверена против точной копии его семантики (`dirs`-only list,
  `{path, bytes, content}`/404), не против живого процесса.
- Вложенные/многоуровневые списки в плане выравниваются в плоские пункты
  (ведущие пробелы обрезаются) — в спеке не требовалось.

## Заметки реализации

- Деривация стоит в `runCard` до записи брифа и до `claimCard`/spawn: свежий
  чек-лист (все пункты открыты) уже даёт строку-намёк в первом же брифе —
  семантически «начни с первого пункта», что и требует спека
  («hint есть, когда есть открытые пункты»; у свежей карточки без плана
  строки нет).
- Существующий `03_checklist.md` читается и возвращается как есть —
  `ensureChecklist` ничего не пишет поверх; это и есть «hand-editing is
  respected» (e2e сравнивает файл побайтово после прогона).
- Чек-лист попадает под общий `PIPELINE_DOC_RE` (`NN_*.md`): если
  исполнитель допишет `STATUS:` последней строкой чек-листа, токен будет
  виден панели как у любого pipeline-документа — осознанно оставлено
  существующей конвенции, наш генератор `STATUS:` не пишет.
- Коммит один, ветка `cc/w15-planqueue`, merge не делаем.
