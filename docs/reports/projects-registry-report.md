STATUS: DONE

## Что сделано — по пунктам, с путями файлов

- `src/stores/projects.ts` (новый) — реестр проектов + frozen contract буквально:
  `Project`, `useProjectsStore` с `projects`, `activeProjectId` (`'all'` | id,
  persisted), `activeProject`, `projectNames`, `projectIdForCwd` (longest-prefix,
  boundary-aware: `/a` vs `/ab` не путаются), `sessionsOfProject`,
  `initProjectsStore` (KV `projects.json` `{version:1, projects, activeProjectId}`,
  sanitize при загрузке как `sanitizeCard` в `board.ts`, гарантия `Common` →
  `/home/hermes/projects`), `addProject`, `createProjectFolder` (mkdir через
  бридж первым шагом, ошибка 403/HTTP видна пользователю), `updateProject`,
  `removeProject` (Common удалить нельзя — throw), `setActiveProject`.
  `createProjectFolder` принимает опциональный `baseUrl` вторым аргументом
  (расширение сверх контракта — иначе стор не знал бы, какой бридж вызывать;
  W2 может игнорировать/передавать свой).
- `src/features/settings/fsApi.ts` (новый) — обёртка бриджа как у
  `DirectoryPicker`: `bridgeBaseUrlForAgentUrl` (та же деривация из ws-URL, что в
  `App.vue`/`NewSessionDialog.vue`), `defaultBridgeBaseUrl` (page host + 25901,
  fallback для голого dist-web без настроенных агентов), `fsRoot`/`fsList`/`fsMkdir`
  (ошибки бриджа, включая 403 вне root, возвращаются текстом).
  В `src/lib/host/**` не лез (чужое).
- `src/features/settings/ProjectsSection.vue` (новый) — админ-раздел
  Settings → Projects: форма (имя + `DirectoryPicker` для папки), «Create project
  (new folder)» (mkdir → регистрация), «Add existing folder» (регистрация),
  список с Rename (имя/путь/заметки), Delete (подтверждение `confirm`, у Common
  кнопка disabled + тултип; стор-гард дополнительно бросает ошибку), заметки.
  Никаких полей/кнопок GitHub/GitLab. Стор монтируется здесь же
  (`initProjectsStore(fsBaseUrl)`), хэндл выставлен на `window.__projects` для
  e2e-проверки контракта.
- `src/components/SettingsView.vue` (только подключение секции) — импорт +
  `<ProjectsSection />` между Agents и Config File.
- `scripts/e2e_dashboard.py` (обязательный фикс фикстуры) — `ts()` больше не
  датирует «сегодня 12:00 UTC» (до полудня — будущее, 5 ассертов падали);
  теперь clamp `min(fixture, now-5min)`. Утверждения не менялись.
- `scripts/e2e_projects_registry.py` (новый) — 47 ассертов: Common в чистом
  профиле, создание с новой папкой (папка реально на диске через bridge API),
  добавление существующей через DirectoryPicker, rename/delete, Common
  удалить нельзя (disabled + `removeProject` throws), `activeProjectId` после
  reload, `projectIdForCwd`/`sessionsOfProject` на реальном сторе (ловушка
  `/a` vs `/ab`), zero pageerror; всё на 1440 и 390.
- Скриншоты: `docs/projects-admin-1440x900.png`, `docs/projects-admin-390x844.png`.

## Контракт — подтверждение, что API из брифа реализован буквально (имя за именем)

`src/stores/projects.ts` экспортирует: `Project { id, name, path, notes?, createdAt }`;
`useProjectsStore` возвращает `projects: Ref<Project[]>`, `activeProjectId: Ref<string>`,
`activeProject: ComputedRef<Project|null>`, `projectNames: ComputedRef<string[]>`,
`projectIdForCwd(cwd): string|null`, `sessionsOfProject<T extends {cwd?: string}>(sessions: T[]): T[]`,
`initProjectsStore(): Promise<void>`, `addProject({name,path}): Promise<Project>`,
`createProjectFolder({name,path}): Promise<Project>`,
`updateProject(id, patch): Promise<void>`, `removeProject(id): Promise<void>`,
`setActiveProject(id): Promise<void>`. Плюс `ready` сверх контракта (нужен секции,
  чтобы не рисовать пустой список до загрузки KV).

## Доказательства — хвост сборки, вывод e2e_projects_registry.py, три перепрогнанных набора

- Сборка: `npm run build:web` → `vue-tsc --noEmit` чисто, `✓ built in ~2.7s`
  (`dist-web/assets/index-*.js 462kB`).
- `scripts/e2e_projects_registry.py` (сервер dist-web на 25988, бридж 25901):
  **47/47 assertions passed**, exit 0 — на 1440 и 390, zero pageerrors.
- `scripts/e2e_board.py` (25999): **16/16**; `scripts/e2e_touch.py` (25996):
  **17/17**; починенный `scripts/e2e_dashboard.py` (25998): **16/16**
  (запуск ~04:00 UTC — до полудня, т.е. в окне, где старая фикстура падала).
- Тестовые папки `w1e2e-*` после прогона удалены с диска.

## Integration requests / Left as is

- Integration requests: нет (App.vue/SessionList/ProjectsView/ui.ts не трогал).
- Left as is: селектор проекта в шапке + скоуп сессий/канбана/дашборда — это
  работа W2 поверх этого реестра (контракт заморожен, имена не менять).
- Замечание: бридж отвечает `Access-Control-Allow-Methods: GET, OPTIONS`, но
  `POST /api/fs/mkdir` с `Content-Type: application/json` из браузера работает
  (OPTIONS 204 + простой POST проходят; e2e создание папки это доказывает).
- Чужие `scripts/e2e_*.py`, `package.json`, `src/lib/**` — не тронуты.
