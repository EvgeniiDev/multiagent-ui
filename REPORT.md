STATUS: DONE — all five items implemented, e2e 23/23 green. Registry was
exercised through the contract-faithful stub (W1's `src/stores/projects.ts`
lands separately); the seam flip is one line, see Integration requests.

## Что сделано

1. **Селектор проекта в шапке** — `src/components/ProjectScopeSelector.vue`
   (новый): `All` + список проектов из реестра, смонтирован в новой
   `.scope-bar` наверху `.main-area` в `src/App.vue` — виден на всех видах
   (chat/projects/board/dashboard). `src/stores/ui.ts` — единственный вход
   скоупа для видов: `activeProjectId` и `activeProject` — делегирующие
   computed в реестр (`features/scope/registry.ts` → стор `projects`),
   `setActiveProject(id)` — делегирующая запись. Своя копия состояния не
   хранится нигде: значение и персистенция (`projects.json`,
   `activeProjectId`) живут в реестре по контракту W1. Просроченный id
   селектор мягко сбрасывает в `all` (computed-get + watch).
2. **Сессии по проекту** — `src/components/SessionList.vue`: вид и поведение
   прежние (плотные строки, scope-строка агента, ⟳, скрытие строки); список
   пропускается через `projectsStore.sessionsOfProject(visibleSessions)` —
   показываются сессии, чей `cwd` внутри пути проекта; при `All` фильтра нет.
   Сессии вне всех проектов видны только в `All` и помечены тегом
   `unassigned` (`.row-tag`); сессия внутри `Common`, но не внутри более
   узкого проекта, считается привязанной к `Common` (не unassigned).
3. **Projects-вид подчинён селектору** — `src/components/ProjectsView.vue`:
   источник строк — реестр (`projectsStore.projects`), а не вывод из сессий.
   Сессии/usage/turns раскладываются по владельцу через `projectIdForCwd`
   (longest-prefix — вложенные проекты не дублируют сессию). При выбранном
   проекте список показывает только его и detail открыт на нём без клика;
   при `All` — все. Сессиям вне проектов строки не соответствует (их место —
   All-скоуп сайдбара, как в брифе).
4. **Старт сессии в контексте проекта** — `NewSessionDialog.vue` получил
   опциональный `initialCwd`; кнопка «New session» в шапке Projects
   подставляет `activeProject.path`, при `All` поле пустое (как раньше —
   см. Left as is про §A «старт в Common»).
5. **Welcome screen** — `.welcome-screen` получила кнопку «New session»
   (`.welcome-new-session`) и тот же `NewSessionDialog` с `initial-cwd` —
   старт доступен без соединения; подтверждение ведёт в Chat.

Попутно исправлен pre-existing баг (файл мой): на ≤800px `.mobile-hamburger`
был `position:fixed; top:0.5rem; z-index:50` — под верхним rail (z 95), т.е.
drawer с сессиями на телефоне не открывался вообще. Кнопка перенесена в
`.scope-bar` (статичный поток, правый край, 44px).

## Что проверено

Всё ниже — **против стаба** `src/features/scope/__local-projects-stub.ts`
(тот же Pinia id `projects`, тот же документ `acp-ui:projects.json`
`{version, projects, activeProjectId}` — сиды теста совпадают с форматом W1).
Против реального стора W1 пока ничего — файла в ветке нет; интеграцию
проверяет Hermes после слияния (флип = раскомментировать две строки в
`registry.ts`, удалить стаб).

- e2e_project_scope.py, 23/23 (1440x900 + 390x844): чистый профиль →
  All+Common; сид реестра → All+Common+Alpha+Beta; фильтрация сайдбара по
  Alpha/Beta (2 и 1 строка); `unassigned` только на внешней сессии;
  персистенция выбора в `projects.json` + после reload; Projects-вид
  подчинён селектору (3→1 строка, detail без клика); `initialCwd` в диалоге
  (путь Alpha при скоупе, пусто при All); New session с welcome-screen без
  соединения → `chat-view`; ноль `pageerror`; селект 44px на 390.

## Доказательства

Сборка (`npm run build:web`, vue-tsc + vite):

```
dist-web/assets/index-cqwkSiKP.js   457.26 kB │ gzip: 161.92 kB
✓ built in 2.64s
```

`~/.hermes/tools-venv/bin/python scripts/e2e_project_scope.py` (сам поднимает
dist-web на 25987):

```
PASS  clean profile: selector shows All + auto-provisioned Common  (All,Common)
PASS  selector lists All + every registered project  (All,Common,Alpha,Beta)
PASS  All scope: sidebar shows every session  (alpha one,alpha two,beta one,loose work,orphan job)
PASS  Alpha scope: only Alpha sessions in sidebar  (alpha one,alpha two)
PASS  All scope: outside session carries 'unassigned' tag
PASS  All scope: exactly one unassigned row (Common loose is assigned)
PASS  scope persisted into projects.json  (p-beta)
PASS  scope survives reload  (p-beta)
PASS  reloaded Beta scope still filters sessions  (beta one)
PASS  Projects at All lists the registry (Common, Alpha, Beta)
PASS  Projects scoped: list shows only Alpha
PASS  Projects scoped: detail shows Alpha without a click
PASS  Projects scoped: detail lists Alpha's two sessions  (2 rows)
PASS  New session dialog prefills scoped project path  ('/home/hermes/projects/alpha')
PASS  New session dialog at All keeps cwd empty (as before)  ('')
PASS  welcome screen offers New session with no connection
PASS  welcome New session starts a session and lands on Chat
PASS  dialog closes after confirm
PASS  390: scope select is a full-height touch target  (44px)
PASS  390: drawer session list filtered to Alpha
PASS  390: Projects scoped to Alpha shows one row
PASS  390: inline detail mounts under the scoped row
PASS  zero pageerror events
23/23 assertions passed
```

Перепрогнанные наборы (из этого worktree, на собранном `dist-web`):

- `scripts/e2e_board.py` — **16/16** (dist-web на 25999).
- `scripts/e2e_touch.py` — **17/17** (25996). Проекты-часть проходит на одной
  строке `Common` — реестр без сида содержит только её.
- `scripts/e2e_projects_ux.py` — **падает, ожидаемо**: `FAIL seeded long
  project list (1 rows)`, затем таймаут на `.project-row` nth(19). Скрипт
  проверяет старую семантику «проекты выводятся из сессий» (26 cwd → 26
  строк); по v2 §B источник списка — реестр, и все 26 сидовых cwd лежат внутри
  `Common` → 1 строка. Это не «до слияния W1» — поведение сохранится и с
  настоящим стором: фикстуре нужен сид `acp-ui:projects.json`. Скрипт чужой —
  не правил, см. Integration requests. Пройденные до падения ассерты
  (New session из шапки/чата, диалог, агенты) — PASS.
- Скриншоты: `docs/scope-{1440x900,1024x768,390x844}.png`.

## Integration requests

- **После слияния W1**: в `src/features/scope/registry.ts` раскомментировать
  импорт из `../../stores/projects` (две строки, помечены `TODO(w1-merge)`) и
  удалить `__local-projects-stub.ts`. Проверить, что реальный стор пишет
  `activeProjectId` в тот же документ `projects.json` — тогда e2e-сиды и
  персистенция переносятся без правок.
- **`scripts/e2e_projects_ux.py`** (чужой): его фикстуре нужен сид
  `acp-ui:projects.json` с проектами под cwd `proj-XX`, либо переосмысление
  ассерта про длинный список — сейчас он проверяет отменённую семантику
  «проект = cwd из сессий». До правки он будет падать и после слияния W1.
- **`stores/session.ts`** (не просил правок, наблюдение): `visibleSessions`
  требует `activeAgentName` — после перезагрузки сайдбар пуст до выбора
  агента. Не блокирует скоуп, но с реестром фильтр «молчит» на пустом списке.

## Left as is

- **Борд и дашборд** читают селектор, но не фильтруются — это W3/W4 по плану
  (`stores/board.ts`, `DashboardView.vue` вне моего владения).
- **§A «New session без проекта стартует в Common»**: по буквальному тексту
  брифа при `All` поле cwd диалога пусто («работать как раньше»). Если
  владелец хочет префилл пути `Common` при `All` — одна строка в `scopeCwd`
  (App.vue + ProjectsView.vue), оставлено на интеграцию.
- `sessionsOfProject` в стабе — path-containment по активному проекту (как в
  брифе «cwd лежит внутри пути проекта»): при вложенных проектах сессии
  дочернего видны и в родительском скоупе. Если W1 выбрал ownership
  (longest-prefix), сайдбар автоматически возьмёт его семантику.
