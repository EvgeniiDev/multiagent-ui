# W5-A — Роли: связка «CLI + модель + файл промпта», привязка к стадиям

Работать в этом дереве (`/home/hermes/projects/acp-ui-w5-roles`, ветка `cc/w5-roles`), коммит в неё.

## Принцип, который нельзя нарушать

**Панель слабо связана с промптами.** В коде панели НЕТ ни одного текста промпта: роль — это данные,
панель по ним только запускает CLI и следит за состоянием. Промпт лежит файлом в каталоге проекта
(`.acp/roles/<role>.md`) и читается/пишется через мост.

## Что сделать

1. **`src/stores/roles.ts`** (новый) — KV-документ `roles.json`, `version: 1`:

```json
{
  "version": 1,
  "roles": [
    { "id": "dev", "label": "Разработчик", "cli": "devin",
      "args": ["-p", "--model", "swe-2-max", "--permission-mode", "dangerous"],
      "promptFile": ".acp/roles/dev.md", "maxConcurrent": 2,
      "pollIntervalSec": 15, "timeoutMin": 45 }
  ],
  "stageRoles": { "spec": "orchestrator", "plan": "plan-writer", "dev": "dev", "reviewtest": "reviewer" }
}
```

   - CRUD: `addRole`, `updateRole`, `removeRole`, `setStageRole(stage, roleId | null)`;
   - валидация: уникальный `id`; `cli` из известного набора (`hermes|opencode|devin|pi|codex`);
     `maxConcurrent ≥ 1`; `pollIntervalSec ≥ 5`; `timeoutMin ≥ 1`;
   - удалять роль, назначенную на стадию, нельзя без явного `force` — иначе видимая ошибка,
     а не тихое осиротение;
   - стиль — как у `src/stores/projects.ts`: `useKvStore` (или `loadKvStore` из `src/lib/host/storage.ts`),
     `scheduleSave`, тот же формат версионирования. **Никаких новых зависимостей.**

2. **`src/features/roles/RolesSection.vue`** (новый) + регистрация в `src/components/SettingsView.vue`
   (одна секция рядом с Projects). Список ролей, создание/редактирование/удаление: имя, CLI, аргументы,
   путь к файлу промпта, лимиты; отдельный блок «стадия → роль». Дизайн — строго на токенах приложения
   (27 токенов из `App.vue :root`), stroke-иконки вместо эмодзи, без теней, один акцент.

3. **Файл промпта через мост.** Хелпер в `src/lib/fsApi.ts` (или рядом): `readTextFile(path)` →
   `GET <bridge>/api/fs/read?path=`, `writeTextFile(path, content)` → `POST <bridge>/api/fs/write`
   с телом `{path, content}`. Мост уже отвечает: `{path, bytes, content}`, ошибки — `403` вне root,
   `415` бинарь, `413` больше 512 КБ, `404` нет файла. Порт моста бери так же, как это делает
   `DirectoryPicker.vue` (от `location.hostname`, порт агента). В UI: у роли кнопка «Открыть файл
   промпта» — просмотр и сохранение через мост, с честным показом ошибок моста.

4. **Бейдж и селектор роли на доске.** В шапке колонки (`src/features/board/BoardColumn.vue`) —
   селектор роли назначенной стадии (пусто = «как сейчас, берёт любой»); на карточке
   (`src/features/board/BoardCardItem.vue`) — бейдж роли стадии, а если под роль не настроен CLI —
   видимый бейдж `no runner for role`. Файлы доски тебе разрешены, но **не меняй** модель карточки
   в `src/stores/board.ts` (кроме, при необходимости, одного вычисляемого геттера).

## Проверка (обязательна, отчёт — реальный вывод)

1. `npm run build:web` — зелёный (файлы CRLF: однострочные якоря `patch` или python с `newline=''`).
2. `scripts/e2e_roles.py` (новый, playwright, `~/.hermes/tools-venv/bin/python`) — сам поднимает
   `dist-web` на порту **25983**, и проверяет:
   - роль создаётся, сохраняется и переживает перезагрузку страницы;
   - дубликат `id` и невалидные лимиты отклоняются с видимым сообщением;
   - удаление роли, назначенной на стадию, отклоняется без `force`;
   - роль показывается в шапке колонки и бейджем на карточке стадии;
   - при роли без известного CLI виден бейдж `no runner for role`;
   - ноль `pageerror`.
   Тестовые данные — **внутри рабочего каталога** (`./tmp-roles-test`), не в `/tmp` и не в `~/.hermes`.
3. `REPORT.md` в корне дерева: `STATUS`, что сделано, вывод команд, что осталось не проверенным.

## Запрещено

`systemctl`, правки вне этого дерева, новые зависимости, тексты промптов в коде панели.
Коммит: `git -c user.name=EvgeniiDev -c user.email=88941336+EvgeniiDev@users.noreply.github.com commit`.
