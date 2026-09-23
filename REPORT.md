# REPORT — cc/v2-composer

## STATUS

**DONE** — обе задачи закрыты, два коммита на ветке `cc/v2-composer`:

- `14c05f9` fix(scope): point the registry seam at the real projects store
- (задача 2) feat(chat): composer rework — one-line autogrow field + uniform icon buttons

## Задача 1 — стаб-стор снят

**Что было.** `src/features/scope/registry.ts` ре-экспортировал
`./__local-projects-stub.ts`, а `features/settings/ProjectsSection.vue` —
настоящий `src/stores/projects.ts`. Обе реализации — `defineStore('projects')`:
Pinia регистрирует стор по id один раз, поэтому **кто инициализировался первым
(App.vue → стаб), тот и отдавался всем** — `window.__projects` в e2e был
экземпляром стаба, у которого `removeProject(Common)` молча возвращался
(без throw) → 4 падения в `e2e_projects_registry.py` (2 ассерта × 2 ширины).

**Что сделано.**

- `src/features/scope/registry.ts` → ре-экспорт настоящего стора
  (`useProjectsStore` + `type Project` из `../../stores/projects`), шов оставлен
  однострочным — публичные имена контракта (`docs/control-center-v2-plan.md`
  §Контракты) не менялись.
- `src/features/scope/__local-projects-stub.ts` удалён (`git rm`).
- Вызывающие не тронуты — все используемые члены (`projects`, `activeProjectId`,
  `activeProject`, `projectNames`, `projectIdForCwd`, `sessionsOfProject`,
  `initProjectsStore`, `addProject`, `updateProject`, `removeProject`,
  `setActiveProject`) есть в настоящем сторе; расхождения сигнатур
  (`initProjectsStore(baseUrl?)`, `createProjectFolder(input, baseUrl?)`)
  обратно-совместимы с текущими вызовами.
- Теперь один Pinia-стор на приложение: проект, созданный в
  Settings → Projects, сразу виден в селекторе скоупа; `removeProject(Common)`
  бросает `The Common project cannot be deleted` — проверено
  e2e (`store removeProject(Common) throws` на обеих ширинах).

## Задача 2 — композер

**Поверхность:** Command/Inspect — приоритет фокус и скорость, единственный
залитый акцентом элемент — Send.

### Slop-скор (claude-design, 10 tells)

**До: 1/10.** Сработал tell #10 (wrong surface): на командной поверхности
композер в покое показывал трёхстрочное поле (`rows="3"`), кнопка вложений
была отдельным hairline-боксом вне рамки поля, а Send — текстовой пилюлей,
которая в disabled оставалась самым громким элементом строки (полупрозрачная
заливка акцентом). Остальные tells не сработали: градиентов/блюра/эмодзи/
центр-стека/тайл-гридов нет, акцент терракотовый (выбранный, не default
indigo), шрифт — принятая продуктовая система `--font-ui`.

**После: 0/10.** Композиция переписана под поверхность: один hairline-контрол
(поле + вложения), поле в покое = одна строка вровень с кнопками, один
акцентный элемент. Дополнительно убраны не-слоп дефекты: нет контракта
автороста, disabled-кнопка занимала акцентный слот.

### Что сделано (`src/components/ChatView.vue`, зона `.input-row`)

- **Поле — одна строка в покое.** `rows="1"`, без собственной рамки;
  line-height 20px + padding 14px = **34px**, вровень с кнопками (на ≤800px —
  22px + 22px = **44px**, font-size 16px против iOS-zoom). Авторост на
  `watch(inputText)` → `scrollHeight` → `height = clamp(min, min(scrollHeight,
  200px))`; выше потолка — `overflow-y: auto`. Сброс к минимуму после отправки
  и очистки; при росте лента, прибитая к низу, переприбивается (без прыжков).
  `ResizeObserver` на боксе пересчитывает высоту при смене ширины (resize
  вьюпорта, drawer) — реагирует только на width, петель нет.
- **Кнопки — единая геометрия.** `.icon-btn`: квадрат 34×34 (≥44×44 на
  телефоне), `border-radius: var(--radius-md)` = 6px, `box-shadow: none`,
  `focus-visible` = контур 2px `--text-accent` + `outline-offset: 2px`.
  Иконки — inline stroke-SVG 16px, `stroke-width` 1.5, `currentColor`
  (скрепка + paper-plane); эмодзи в разметке нет. Send — единственная заливка
  `--bg-primary` + `--text-on-accent`; **disabled Send — тихая hairline**
  (`--border-faint` + `--text-muted`), не полупрозрачная заливка.
- **Композиция.** `.composer-box`: одна рамка `1px --border-faint`,
  `--radius-lg` 10px вокруг поля; кнопка вложений — ghost-глиф внутри слева
  (hover `--tint-hover`, staged = `--tint-active` + `--text-accent`); Send
  снаружи справа; все элементы `align-items: flex-end` — при росте поля
  кнопки остаются на последней строке. Отступы 6–8px. Плейсхолдер
  `--text-muted`. `.attach-tray`/`.attach-chip` не тронуты.
- **Тёмная тема:** все цвета через токены; аудит контраста (логика
  `scripts/e2e_dark_contrast.py`, порт перенесён на разрешённый 25998) —
  0 провалов в dark и light.

## Доказательства

`npm run build:web` — зелёный (vue-tsc + vite, `✓ built in 2.5s`).

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_projects_registry.py
…
47/47 assertions passed

$ ~/.hermes/tools-venv/bin/python scripts/e2e_project_scope.py
…
23/23 assertions passed

$ ~/.hermes/tools-venv/bin/python scripts/e2e_composer.py        # новый, порт 25986
…
PASS  1440: textarea rest height ~= button height (+-4px)  (textarea 34.0 vs buttons 34.0)
PASS  1440: 4 lines grow the field  (34 -> 94)
PASS  1440: ~15 lines cap at ~200px  (h=200)
PASS  1440: capped field scrolls internally  ({'h': 200, 'scroll': 314, 'client': 200, 'oy': 'auto'})
PASS  1440: sending returns the field to rest height  (h=34 value='')
PASS  390: all row buttons share one geometry >= 44px  ({(44, 44)})
PASS  390: textarea rest height ~= button height (+-4px)  (textarea 44.0 vs buttons 44.0)
…
30/30 assertions passed

$ ~/.hermes/tools-venv/bin/python scripts/e2e_touch.py
…
17/17 assertions passed

$ ~/.hermes/tools-venv/bin/python scripts/e2e_dashboard.py       # dist-web на 25998
…
16/16 assertions passed

# контраст: scripts/e2e_dark_contrast.py через import-патч PORT/BASE -> 25998
PASS  dark mode: zero contrast failures
PASS  light mode: zero contrast failures
RATIO  --text-muted on --bg-main: 6.44:1
RATIO  --text-muted on --bg-sidebar: 7.10:1
RATIO  --text-on-accent on --bg-primary: 5.40:1
RATIO  --text-accent on --bg-main: 7.32:1
7/7 assertions passed
```

Скриншоты: `docs/composer-before-1440x900.png` (до), `docs/composer-1440x900.png`,
`docs/composer-1024x768.png`, `docs/composer-390x844.png` (после);
`docs/dark-chat-1440x900.png` перегенерирован аудитом.

## Integration requests

- `scripts/e2e_dark_contrast.py` жёстко прошит на порт 25994 — вне разрешённого
  для этого worktree диапазона (25986–25999). Прогнала его логику через
  module-import с `PORT`/`BASE` = 25998; в следующих волнах стоит вынести порт
  в переменную окружения или разрешить 25994.
- `e2e_white_text.py` (порт 25992, тоже вне диапазона) меряет `.send-btn`:
  кнопка осталась с теми же токенами (`--text-on-accent` на `--bg-primary`),
  ассерт сохранится — но класс теперь icon-only, проверка текста там
  фактически по computed color кнопки.
