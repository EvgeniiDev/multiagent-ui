# W15 — Модель как шаг роли: отчёт

STATUS: DONE

Карточка `d7993f11` (@trin4ik 11.09: «нарезка — самая сильная модель,
после нарезки compacting и переключение на слабую; оркестрацию не должны
вести самые сильные»). Рабочее дерево `acp-ui-w15-modelstep`, ветка
`cc/w15-modelstep`.

Координация со scope guard'ом: `boardctl show 9e2b023a` — watchdog ещё в
`Dev / in_progress`, но его ветка `cc/w15-watchdog` указывает на тот же
коммит `53a0fc3`, что и база моей ветки (их worktree чистый, разницы нет):
ребейзить было не на что, начал с общей точки. Если watchdog вольётся
первым, конфликт в `acp-runner.mjs` тривиальный — разные блоки кода.

## Чего не хватало (по брифу)

- Модель запекалась в `args[]` роли раз на весь прогон; переход «сильная
  планирует → слабая ведёт» внутри одной роли не выражался.
- Леджер писал `role=dev`, но не говорил, какая модель работала на каком
  шаге.

## Что изменено

- `src/stores/roles.ts` — опциональное поле `Role.models` —
  `RoleModels {plan, execute}`, свободные строки (панель имён моделей не
  знает). `sanitizeModels` — пермиссивный restore: поле держится только при
  двух непустых строках, кривое — выкидывается (не роль). `validateModels` —
  строгая запись: `models` присутствует ⇒ оба ключа непустые, иначе
  `Error('models.plan and models.execute must be non-empty strings')`
  (покрывает `models: ''`, полупару и отсутствующий ключ).
- `server/acp-runner.mjs`:
  - `stepModel(role, stage)` — шаг из стадии карточки: `plan` →
    `models.plan`, всё остальное (`spec`/`dev`/`reviewtest`) →
    `models.execute`; невалидный `models` = отсутствует;
  - `substArgs(args, model)` — `{models.plan}`/`{models.execute}` в
    `args[]` подменяются моделью ТЕКУЩЕГО шага при spawn; оставшийся
    плейсхолдер (роль без `models`) — stderr-варнинг, строка уходит в argv
    как есть;
  - `appendActivity` получил `model` — пишется только когда есть
    (поля `...(model ? {model} : {})`), без `models` у роли поля нет
    вообще — леджер не выдумывает;
  - claim несёт `model` шага — audit-записи sweep / `cancel` / `stop-all`
    (`model: claim?.model`) называют модель без перечитывания роли.
- `src/stores/activity.ts` — `model?: string` в `ActivityEntry`
  (документированно «never invented»).
- `src/features/roles/RolesSection.vue` — опциональная пара инпутов
  `role-model-plan` / `role-model-execute`, видна только когда args
  содержат `{models.*}`-плейсхолдер или пара уже заполнена (простой случай
  не смущается); строка роли показывает `models plan→X execute→Y`.
- `scripts/e2e_modelstep.py` — новый сьют: state server на **25917**,
  web на **25962** для панельной ноги, `tmp-modelstep-test/`, stub
  `node stub-cli.mjs` сбрасывает argv в `<cardDir>/argv.json`.
  Зарегистрирован в `scripts/e2e_all.py` строкой `("model step", …)`.

## Решение по семантике плейсхолдера (важно)

`{models.plan}` и `{models.execute}` — ОБА резолвятся в `models[step]`,
шаг = стадия карточки. Написание — документация, решает шаг. Причина:
подстановка по ключу (`{models.plan}` → всегда plan) сделала бы плейсхолдер
бесполезным — литеральная строка в args делает то же самое — и не
выражала бы главное: ОДНА роль, привязанная к plan+dev стадиям, меняет
модель между шагами («переход внутри одной роли» из описания карточки).
Леджерный `model` при этом всегда равен подставленному в argv значению —
честность структурная, а не конвенция. Leg A сьюта нарочно пишет
`{models.execute}` в args и ждёт plan-модель на plan-шаге — различает
семантики.

Грань честности: роль с `models` и ЛИТЕРАЛЬНЫМ `--model foo` в args даст в
argv `foo`, а в леджере `models[step]` — поле читается как «модель шага по
данным роли», не как парс argv. Считаю допустимым: поле заявляет модель
шага из роли; такая роль просто неконсистентна.

## Проверка

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_modelstep.py
```

Хвост вывода (полный прогон, 27 проверок):

```
PASS  step model recorded on the live plan claim  ("model": "model-plan-x")
PASS  step model recorded on the live exec claim  ("model": "model-exec-y")
PASS  leg A once exits 0
PASS  plan-step child argv carries --model <models.plan>  (["-p", "--model", "model-plan-x", "--prompt-file", ".../card-plan/00_brief.md"])
PASS  execute-step child argv carries --model <models.execute>  (["-p", "--model", "model-exec-y", "--prompt-file", ".../card-exec/00_brief.md"])
PASS  ledger: every plan-step card entry carries model=model-plan-x
PASS  ledger: every exec-step card entry carries model=model-exec-y
PASS  card state survives the model switch (artefacts in card dirs)
PASS  cancel exits 0
PASS  cancel audit entry carries the claim's model  ("model": "audit-model-z")
PASS  leg C once exits 0
PASS  no models: argv unchanged (--model fixed-model)
PASS  no models: ledger card entries have NO model field
PASS  leg D once exits 0  (run card-bad: args reference {models.*} but role 'dev' carries no valid models — placeholder left literal)
PASS  malformed models: placeholder left literal in argv  ("--model", "{models.plan}")
PASS  malformed models: stderr warning names it
PASS  malformed models: ledger card entries have NO model field
PASS  model pair hidden while args carry no placeholder
PASS  model pair appears once args reference {models.*}
PASS  store rejects models as a bare empty string  ("models.plan and models.execute must be non-empty strings")
PASS  store rejects a half-empty model pair
PASS  store rejects a model pair missing a key
PASS  form rejects a half-filled model pair
PASS  full model pair saves
PASS  role row shows the model pair
PASS  models persisted into roles.json  ("models": {"plan": "strong-model", "execute": "cheap-model"})
PASS  zero pageerror events

27/27 checks passed
```

Регрессии:

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_runner.py    -> 26/26 checks passed
$ ~/.hermes/tools-venv/bin/python scripts/e2e_dispatch.py  -> 46/46 checks passed
$ ~/.hermes/tools-venv/bin/python scripts/e2e_roles.py     -> 35/35 assertions passed
$ npm run build:web                                      -> vue-tsc + vite OK
$ node --check server/acp-runner.mjs                     -> OK
```

## Что НЕ проверено живьём

- Реальный CLI-агент (devin/hermes/codex) с `--model` — только
  `node`-заглушка, сбрасывающая argv; живой CLI может требовать другой
  синтаксис флага (плейсхолдер подставляется внутрь любого аргумента —
  `--model=X` и `--model X` оба работают).
- Панельная нога прогнана против `dist-web` этой ветки (build:web свежий);
  с реальным state server и живым бордом связка «роль с models → две
  стадии» в полном пайплайне end-to-end не прогонялась — покрыто e2e
  ногами на своём state-сервере.
- `sweep`/`stop-all` записи с `model` — путь `claim.model` тот же, что у
  проверенного `cancel`; отдельной ноги для каждого крана нет.
- Панель нигде не ОТОБРАЖАЕТ `model` из леджера — по брифу достаточно
  поля; при желании лента может дорисовать его без изменений раннера.
