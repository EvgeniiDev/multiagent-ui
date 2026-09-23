# CodeAlive-AI/vibe-stack — что это и есть ли что взять

Дата обзора: 2026-09-23. Метод: GitHub REST API + `git clone --depth 1` в `/tmp/vibe-stack` (репозиторий склонирован, README/ROADMAP/docs/skills прочитаны целиком, сплошной греп по ключевым словам).

## 1. Что это такое

Это **не продукт и не фреймворк, а репозиторий-мнение**: «набор дефолтов» (opinionated stack), который говорит, какие инструменты брать для типовых задач — чтобы команда или агент не сравнивали эквивалентные альтернативы. README прямо заявляет: «Vibe Stack is an opinionated gentleman's kit: a curated set of self-hostable, production-ready technologies that covers the common 95% of product use cases without forcing teams or agents to compare equivalent alternatives» ([README.md](https://github.com/CodeAlive-AI/vibe-stack/blob/main/README.md)). Целевой пользователь — команда или агент, стартующие новый «AI-native» веб-продукт. Содержимое — таблицы дефолтов и prose-гайды: язык TypeScript + pnpm, UI React + Next.js, агенты Mastra, AI-UI assistant-ui, auth Better Auth, данные Drizzle + PostgreSQL, валидация Zod, логи Pino, компоненты Mantine, стили Tailwind v4, деплой Dokploy, трекинг ошибок Bugsink, обсервабилити OpenObserve + OpenTelemetry (таблицы «Web Application» и «Vibe Infra» в README). Установки/запуска как таковых нет: нет `package.json`, `tsconfig`, `Dockerfile`, `Makefile`, `docker-compose` на верхнем уровне (проверено `find -maxdepth 2`) — ставится и запускается не «vibe-stack», а проекты, которые по его гайдам создаются. Единственный исполняемый код — Python-скрипты внутри двух агентских скиллов (`skills/*/scripts/*.py`), поэтому GitHub и определяет язык репозитория как Python.

## 2. Зрелость

| Признак | Факт | Источник |
|---|---|---|
| Создан / последний push | 2026-06-29 / **2026-08-31** | GitHub API `/repos/CodeAlive-AI/vibe-stack` |
| Последний коммит | `1e0c071a0f7ab2c07d651c1ae7bd27bf72043268`, 2026-08-31, автор Codex, «docs: add verified Capacitor 8.5 plugin shortlist» | `git log -1`, API `/commits` |
| Всего файлов в репо | 117 (`git ls-files`) | локальный клон |
| Верхний уровень | `assets/`, `docs/`, `skills/`, `templates/`, `.gitignore`, `CONTRIBUTING.md`, `LICENSE`, `README.md`, `ROADMAP.md` | API `/git/trees/main?recursive=1` (139 записей, `truncated: false`) |
| Звёзды / форки / issues | 14 / 0 / 0 | GitHub API |
| Releases / tags | пустые списки `[]` | API `/releases`, `/tags` |
| CI | **нет**: `/contents/.github` → 404 | API |
| Лицензия | MIT («MIT License, Copyright (c) 2026 CodeAlive-AI») | `LICENSE` |
| Авторы | Codex (авто-коммиты, август) + Rodion Mostovoi (июнь–июль) | API `/commits?per_page=20` |

Топ-уровневые каталоги по существу два: `docs/` (5 md-файлов: `common-guide.md`, `languages/typescript.md`, `security-practices.md`, `vibe-infra.md`, `web-app.md`) и `skills/` (2 скилла). `templates/` — **пустой заглушка**: единственный файл `templates/README.md` (242 байта) со словами «Future starter templates will live here» и перечнем планируемых `next-mastra-app` и `vibe-infra-compose`.

Тесты на уровне репозитория отсутствуют, но внутри скиллов есть: `skills/apple-app-store-reviewer/tests/test_smoke.py` + фикстуры, `skills/agentic-capacitor/scripts/test_validate_capacitor.py`, плюс `skills/apple-app-store-reviewer/TEST-RESULTS.md` (таблица реально выполненных проверок) и `evals/evals.json`.

**Готовый продукт или аспирация?** Скорее «рабочий, но внутренне-документальный» артефакт: основная часть — законченные гайды с источниками, но ключевые обещания — планы. `ROADMAP.md` перечисляет раздел `Autonomous Development Practices` (в т.ч. «Issue-to-PR workflows for agent-driven development», «Guardrails for safe autonomous operations») в разделе **Planned**, а не Covered; Python, .NET и backend-only стеки в таблице Coverage помечены «Planned, not selected yet». То есть по нашей теме (автономный прогон задач агентами) репозиторий сам пишет: «ещё не сделано».

## 3. Что переиспользуемо

**Контента, относящегося к канбану, ролям, диспетчеру или общему стору состояния, в репозитории НЕТ.** Сплошной греп по клону (`grep -rniE "kanban|dispatcher|claim|backlog|worktree|agent client protocol|ACP|opencode|devin|websocket|board|card"` по `*.md`, `*.json`, `*.py`) не дал ни одного тематического попадания — совпадения только на слова «keyboard»/«keychain» и общие обороты («claim» в смысле «утверждение»). Ни карточек, ни стадий, ни очередей, ни lease/claim, ни ролей, ни ACP, ни интеграций с Hermes/OpenCode/Devin. Скиллы в `skills/` про мобильные iOS/Android-сборки (`agentic-capacitor`) и про аудит заявки в App Store (`apple-app-store-reviewer`) — к нашей панели отношения не имеют.

Переиспользуемое — только **методическое**, три вещи:

1. **Формат упаковки роли-скилла** — `skills/apple-app-store-reviewer/`: короткий `SKILL.md` с YAML-фронтматтером (`name`, `description`, `license`, `compatibility`, `metadata.version`), отдельный человеческий `README.md`, библиотека `references/*.md`, детерминированные `scripts/*.py`, `tests/` с фикстурами, `evals/evals.json`, `CHECKSUMS.sha256`, `references/provenance.md` (честный список источников и что из них НЕ было взято), `TEST-RESULTS.md` (таблица «Check | Command | Result»). Это готовый образец того, как оформлять версионированные промпты ролей под стадии — с указанием версии, источников и границ применимости.
2. **Содержимое `docs/common-guide.md`** — разделы «Minimum Agent-Ready Contract» (агент перед началом знает: что менять, как запустить, как проверить, что не трогать, когда остановиться и спросить), «Verification» (единый короткий путь `lint/typecheck/test/build`), «Evidence» («Generated summaries are not evidence unless they link back to source files, test output, logs…`). Это прямо ложится в текст промпта роли и в поля карточки.
3. **Стиль документов с источниками** — каждая рекомендация заканчивается списком ссылок на официальные доки (`docs/web-app.md`, «Sources» в `docs/common-guide.md`).

## 4. Пересечение с нашим проектом и рекомендация

Что у нас есть (из `/home/hermes/projects/acp-ui`): Vue 3-панель без бэкенда, состояние в локальном KV (`docs/control-center-requirements.md`, N3: «Всё состояние — локальный KV-стор (localStorage на web, Tauri store на десктопе)… никакого бэкенда»), автозабор задач (`docs/control-center-roles-requirements.md`, F9.4 «Диспетчер (автозабор)»), роли, привязанные к стадиям (`docs/control-center-v2-requirements.md`, раздел D «Роли (F9) — привязка к стадиям»), код в `src/stores`, `src/lib/transport`, `src/lib/host`, `src/features/board`.

Пересечения по существу нет, и более того — дефолты vibe-stack **противоречат** нашей архитектуре: React/Next.js против нашего Vue 3, PostgreSQL + Drizzle + Dokploy против «LAN, без бэкенда». Ссылаться на этот репозиторий как на источник по архитектуре нельзя.

**Рекомендация — ignore (как источник), borrow ideas (только по оформлению промптов/скиллов).** Адоптировать нечего: ноль строк кода, ноль моделей данных, ноль описаний очередей/лейзов/статусов. Идеи, которые стоит взять: формат упаковки ролей-промптов с версией и provenance (п. 3.1) и чек-лист «Minimum Agent-Ready Contract» + «Evidence» как поля/содержимое карточки и промпта роли (п. 3.2).

**Смежная, более релевантная ссылка** (не часть задачи, но чтобы не искать заново): у той же организации есть `CodeAlive-AI/ai-driven-development` (146 звёзд, push 2026-09-21) — «Practices, protocols, and skills for AI-driven software development… for Claude Code, Codex, OpenCode, Cursor, Antigravity» (GitHub API `/orgs/CodeAlive-AI/repos`). Именно там, а не в vibe-stack, живут практики агентных workflow; если понадобится аналогичное исследование — начинать стоит с него.

## 5. Доказательства (evidence)

- `https://github.com/CodeAlive-AI/vibe-stack` — страница репозитория (HTML): верхний уровень — `assets/`, `docs/`, `skills/`, `templates/`, `.gitignore`, `CONTRIBUTING.md`, `LICENSE`, `README.md`, `ROADMAP.md`.
- `raw.githubusercontent.com/CodeAlive-AI/vibe-stack/main/README.md` — 200, содержимое прочитано полностью; таблицы дефолтов, раздел Coverage, «For Agents», «Contributions».
- `api.github.com/repos/CodeAlive-AI/vibe-stack` — `created_at: 2026-06-29T12:12:54Z`, `pushed_at: 2026-08-31T06:47:58Z`, `size: 2813`, `stargazers_count: 14`, `forks_count: 0`, `open_issues_count: 0`, `license.spdx_id: MIT`, `language: Python`, `archived: false`.
- `api.github.com/repos/.../git/trees/main?recursive=1` — `truncated: false`, 139 записей; `templates/` содержит только `blob 242 templates/README.md`.
- `api.github.com/repos/.../releases` → `[]`; `/tags` → `[]`; `/contents/.github` → 404; `search/issues?q=repo:...+type:issue` → `total_count: 0`.
- `api.github.com/repos/.../commits?per_page=20` — 20 коммитов, новейший 2026-08-31T06:47:47Z (Codex), человеческие коммиты Rodion Mostovoi — июнь–июль 2026.
- Локальный клон `/tmp/vibe-stack` (commit `1e0c071`): `git ls-files | wc -l` = 117; греп по ключевым словам — 0 тематических совпадений; `find -maxdepth 2` — нет `package.json`, `tsconfig*`, `Dockerfile*`, `docker-compose*`, `Makefile`, `*.toml`.
- Прочитаны целиком: `ROADMAP.md`, `templates/README.md`, `skills/README.md`, `docs/common-guide.md`, `docs/web-app.md`, фронтматтер `skills/apple-app-store-reviewer/SKILL.md`, `skills/apple-app-store-reviewer/evals/README.md`, `TEST-RESULTS.md`, `CHECKSUMS.sha256` (первые строки), `skills/agentic-capacitor/SKILL.md`.
- Наш контекст: `/home/hermes/projects/acp-ui/docs/control-center-requirements.md` (N3), `control-center-roles-requirements.md` (F9.4), `control-center-v2-requirements.md` (раздел D, F10.1), дерево `src/{stores,lib/transport,lib/host,features/board}`.

Ограничения: снимок состояния — на 2026-09-23; «зрелость» оценена по публичным метрикам GitHub и содержимому файлов, без запуска чего-либо из репозитория (в нём нечего запускать, кроме Python-скриптов скиллов).
