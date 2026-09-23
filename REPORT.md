# W-A — глобальный доступ к Settings/Traffic + кнопка «New project»

Ветка: `cc/v3-newproj`. Все правки — только в файлах из списка владения BRIEF.md.

## Что сделано

### Задача A — Settings и Traffic в панели скоупа (`src/App.vue`, только он)

- Кнопки **Settings** (`title="Settings"`) и **Traffic** (`title="ACP Traffic Monitor"`)
  перенесены из `.sidebar-header` (виден только на Chat — сайдбар монтируется лишь
  при `uiStore.activeView === 'chat'`) в `.scope-bar` справа (`.scope-actions`,
  `margin-left: auto`). Из шапки чата/сайдбара удалены, не дублируются.
- `title`/`aria-label` и поведение сохранены 1:1: Settings открывает модальный
  оверлей `SettingsView`, Traffic переключает панель `TrafficMonitor`. SVG-иконки
  перенесены как есть (inline stroke-SVG в `currentColor`, эмодзи не было).
- Геометрия: 34×34, `--radius-md`, hairline-граница `var(--border-faint)`,
  hover `var(--tint-hover)`, `focus-visible` контур `var(--text-accent)`; на ≤800px —
  44×44. Активное состояние Traffic — `var(--tint-active)` + акцент (как было).
- 390px: `.scope-bar` — `min-width: 0`, `flex-wrap: nowrap`, `overflow: hidden`;
  селектор сжимается, кнопки ≥44px, переноса строк и горизонтального скролла нет
  (проверено ассертами `scrollWidth <= clientWidth + 1`).
- Попутный фикс в том же файле: `.scope-bar` получил `position: relative; z-index: 95`
  (как у `.view-rail`) — иначе открытый drawer на 390px своим backdrop (z 90)
  перекрывал кнопки скоупа и чужой `e2e_projects_registry.py` падал на 390
  (клик по Settings перехватывался). После фикса чужой скрипт снова проходит
  390-часть полностью.

`src/components/ChatView.vue` не тронут вообще: проверка показала, что кнопок
Settings/Traffic там нет — они жили в сайдбаре `App.vue`. Удаление из «шапки чата»
по факту = удаление из `.sidebar-header`.

### Задача B — кнопка «New project» (`src/features/projects/NewProjectDialog.vue` — новый, `src/components/ProjectsView.vue`)

- В шапке вида Projects рядом с «New session» добавлена кнопка **New project**
  (`.new-project-cta`, ghost-стиль с акцентной рамкой; на ≤800px `min-height: 44px`).
- Диалог `NewProjectDialog.vue` — два режима: **New folder** (создать папку по пути)
  и **Existing folder** (указать существующую, путь — через переиспользуемый
  `DirectoryPicker`). Имя и путь обязательны, путь абсолютный (валидация в диалоге,
  ошибка — видимым `.np-error`, диалог не закрывается).
- Работает с настоящим стором: `import { useProjectsStore } from '../../stores/projects'`
  (`createProjectFolder({ name, path })`, `addProject({ name, path })`).
  `src/features/scope/registry.ts` не импортируется, `__local-projects-stub.ts` не тронут.
- После создания: `setActiveProject(newProject.id)` + родитель (`ProjectsView`)
  выбирает новый проект (`selectedCwd = path`) — детальная панель открывается сразу.
- Дубликат пути отклоняется видимой ошибкой
  `Path is already used by project "…"` — проект не создаётся. Причина гарда в диалоге:
  настоящий `stores/projects.ts:addProject` регистрирует вслепую (не проверяет дубликаты),
  поэтому проверка живёт на стороне UI.

## Проверки (реальные выводы, все команды — в корне репо)

- `npm run build:web` — зелёный (`vue-tsc --noEmit` + vite, 267 модулей).
- `~/.hermes/tools-venv/bin/python scripts/e2e_global_actions.py` (новый, порт **25985**):
  **52/52 PASS**, ноль `pageerror`. Покрывает: Settings/Traffic видимы (`is_visible()`)
  и открываются/закрываются на всех 4 видах; то же на 390×844 (кнопки 44×44, скролл 0px,
  `scrollWidth 390 <= clientWidth 390`); New project с новой папкой
  `/home/hermes/projects/e2e-<uniq>` — каталог реально на диске
  (`GET /api/fs/list?path=/home/hermes/projects` до/после через настоящий бридж 25901);
  existing-folder добавляет проект в селектор скоупа; новый проект — активный скоуп
  (значение селектора + отфильтрованный список сессий: `[]` под скоупом, `alpha one,beta one`
  на All); повторный путь — видимая ошибка, счётчик опций `4 -> 4`.
- `scripts/e2e_project_scope.py` — **23/23 PASS**.
- `scripts/e2e_touch.py` — **17/17 PASS**.
- `scripts/e2e_projects_registry.py` (чужой, не правился) — **43/47**, те же 4 известных
  фейла заглушки (`store removeProject(Common) throws` + `Common error message visible`,
  ×2 ширины): стаб `__local-projects-stub.ts` молча игнорирует удаление Common вместо
  throw — это ожидаемо до слияния параллельной ветки (в настоящем `stores/projects.ts`
  guard уже есть: `throw new Error('The Common project cannot be deleted')`).
- Скриншоты: `docs/global-actions-1440x900.png`, `docs/global-actions-390x844.png`.

## Важное наблюдение для параллельной ветки (не правилось — чужой файл)

`src/features/scope/registry.ts` сейчас резолвится в `__local-projects-stub.ts`, и оба
модуля (`stores/projects.ts` и стаб) объявлены как `defineStore('projects', …)` — один
Pinia id. Pinia кэширует инстансы по id (`pinia._s`), поэтому какой `useProjectsStore`
первым инстанцировался (в `App.vue` — стаб через seam), тот и возвращается **всем**
потребителям, включая мой диалог с импортом из `../../stores/projects`. Следствия,
замеренные живым playwright:

1. `createProjectFolder` исполнялся кодом стаба: `fetch('/api/fs/mkdir')` относительно
   page-origin (а не бриджа) + best-effort без throw. В e2e это закрыто проксированием
   page-origin `POST /api/fs/mkdir` на настоящий бридж внутри `wire()` нового скрипта;
   после мержа ветки-реестра оба импорта резолвятся в настоящий стор и прокси станет
   ненужным (at most удалить `handle_fs` POST-ветку).
2. Именно поэтому гард дубликатов и `setActiveProject` в диалоге написаны поверх
   публичного API стора, а не его внутренностей — переживут замену инстанса без правок.

## Integration requests

Нет — чужие файлы не понадобились. Единственное пересечение зафиксировано выше
(настоящий стор уже содержит нужный guard `removeProject(Common) throws`; делать
ничего не нужно, ждём мержа).
