# Инкрементальный replay: merge и выкладка, 20 октября 2026

## Интеграция

Коммит `7f3ba13716a315c13fa381835f94a9e5b1fb63b7` найден в
`/tmp/acp-device-sync`, ветка `wip/panel-work-before-repair-20261019`.
Влит настоящим merge в main: `e2bcc27` (родители `80dbb2e`, `7f3ba13`).
`git merge-base --is-ancestor 7f3ba13 main` проходит. Исходный worktree
и посторонние изменения канонического checkout сохранены.

Разрешён конфликт в `deploy/acp-ws-bridge.mjs`: сохранена очередь загрузок
одной сессии из cbc52b5 и добавлены replay gates/курсор из 7f3ba13.
Расширение acpUIResume передаёт `{seq, hh}` от браузера мосту; агент его
не получает. Мост проверяет SHA-256 префикса и передаёт только суффикс.
При несовпадении, укороченной истории или превышении лимита буфера клиент
получает полную пересинхронизацию. Сам агент по-прежнему воспроизводит
полную историю внутри моста: выигрыш относится к WebSocket-трафику,
десериализации и обработке в браузере, а не к объёму работы адаптера.

При интеграции исправлены два крайних случая:

- сохранение userTurnBase после suffix-only загрузки, чтобы следующие
  открытия сохраняли правильные номера пользовательских сообщений,
  вложения и возможность загрузить старую историю;
- после превышения replay buffer cap полная пересинхронизация больше не
  переключается обратно на suppression при совпавшем позднем хэше
  и не дублирует кадр, переполнивший буфер.

Порог остаётся 64 MiB; ACP_REPLAY_BUFFER_CAP_BYTES позволяет проверить
этот путь с маленьким буфером. Поведение старого моста остаётся совместимым.
Из UI-diff убрана посторонняя нормализация окончаний строк.

## Локальные проверки

- Unit: 52/52 (session replay/activity, cache budget/shared cache, new-session gate).
- Replay cursor harness: 16/16; отдельный прогон малого cap: 7/7.
- Маршрутизация: 14/14, включая одну сессию в двух окнах и закрытие
  исходного сокета посреди replay. Heartbeat/watchdog: 22/22.
- Bridge lifecycle/status: 4/4; восстановление pre-start deadlock прошло.
- Browser с изолированным state и моками ACP: history cache 48/48,
  session restore 33/33. Restore-suite после успешных assertions выдаёт
  предупреждение Playwright о задаче при закрытии browser; код выхода 0.
- Финальная build:web, включая check:ui и vue-tsc, прошла.
- Проведён ручной review интеграционного diff: область ограничена merge,
  совместимостью очереди replay и двумя регрессионными исправлениями.

## Выкладка и настоящий браузер

Источник релиза: `/tmp/acp-panel-repair`, main, e2bcc27.
Проверен bind mount web: `/home/hermes/projects/acp-ui/dist-web` →
`/repo/dist-web`. Сохранены старые assets; index.html заменён последним.
Frontend: `index-BacxtxGd.js`, SHA-256
`ce31e1462a660da611b9df5149add8a0be013c7c23451bc443eef6d92ec5b88a`.
Байты HTTPS-ответа совпадают с release artifact.
Bridge source SHA-256:
`83be62565f51a7f788930a2b3d2b22a6657bb3d479cae94bc246973d7f0abd09`.

Через контроллер последовательно перезапущены Devin (PID 2959792),
OpenCode (2961019), Hermes (2961404), Pi (2961790). Все пять listener owners
подтверждены. Codex (PID 1024589) оставлен работающим: эта агентская сессия
является его потомком, и assertRestartCallerOutside корректно запрещает
самоуничтожающий перезапуск. Новый source для Codex опубликован, но его
активация требует команды из независимого терминала:

```sh
cd /home/hermes/projects/acp-ui
node scripts/acp-bridges.mjs restart --bridge codex --accept-interruption
```

Настоящий Chromium на `https://192.168.1.222:25809`:

| Мост | Повторное открытие | Проверенный префикс | Replay-событий получено |
|---|---:|---:|---:|
| Devin | 3615 ms | 1933 из 1935 | 2, 1727 bytes |
| OpenCode | 328 ms | 2 из 2 | 0 |
| Hermes | 467 ms | 1 из 1 | 0 |
| Pi | 4503 ms | 62 из 62 | 0 исторических; дополнительно пришло live-событие |

Для Codex подтверждено обычное полное восстановление на старом процессе.
Два дополнительных окна Devin при изменившемся префиксе корректно получили
resynced:true и одинаковые 20 сообщений/641 tool calls. Во всех проверенных
окнах восстановление завершилось, поле ввода доступно; ошибок JS/JSON-RPC нет.

Board: настоящая managed-карточка 49739980-2c79-468e-9fac-a8fd8cd96f67
прочитана (HTTP200) во время восстановления большой Devin-сессии и после
reload. Задерживался настоящий ответ session/load, не подменялся его результат.
Для изоляции вкладок подменены только сохранённые UI-метаданные sessions.json;
managed backend и ACP оставались настоящими.

Проверки не отправляли session/prompt; изменения общих UI-документов запрещены
в тестовых контекстах. Генерация ответов моделями не проверялась. Web/state и
прочие runtime-сервисы не перезапускались. Открытым вкладкам нужен reload.

Локальные receipts без переписки:
`/tmp/acp-incremental-live-qa.json`, `/tmp/acp-incremental-board-qa.json`;
логи `/tmp/acp-incremental-{unit-final,bridge-final,routing-final,build-final,browser-cache,restore-browser}.log`.

Дополнительно на проде проверена кнопка Load earlier history: из настоящего
Pi-транскрипта локально оставлен хвост с корректным курсором и offset;
после resume кнопка доступна, полный replay по нажатию проходит без курсора
(skipped:0) и кнопка исчезает. Высота — 28 px при 1440 px и 44 px при 390 px,
focus-visible имеет outline 2 px; disabled даёт opacity 0.5/cursor not-allowed.
Цвет и рамка соответствуют общему ghost UiButton текущей Graphite-темы.
При смене ширины закрыт настоящий mobile sidebar, скрывающий чат;
это исправление тестового сценария, код приложения не менялся.
Receipt: `/tmp/acp-incremental-control-qa.json`.
