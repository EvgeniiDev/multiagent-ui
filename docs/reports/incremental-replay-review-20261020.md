# Code Review Results: incremental replay, 20 октября 2026

Исправлено 12 замечаний: 11 ошибок поведения и один пробел интеграционного тестирования. После повторного ревью исправлений новых actionable-замечаний нет.

Scope: `80dbb2e -> bceda3c`, включая интеграцию `7f3ba13`; затем отдельный corrective review изменений относительно `bceda3c`. Коммит `7f3ba13` уже был влит через `e2bcc27` до этой сессии ревью. Исправления этой сессии находятся в `main`, `45a7f908ca6863d8b4b3af73c570d17899cd9b70`.

Intent: ускорить повторное открытие истории без потери сообщений, вложений, результатов инструментов и изоляции вкладок. Mode: markdown local-apply, разрешено пользователем. Релиз подготовлен из чистого `/tmp/acp-panel-repair`; посторонние изменения канонического checkout сохранены.

Reviewers: correctness, testing, reliability, security, maintainability, frontend-races, project-standards, performance, api-contract. API и frontend-races включены из-за нового протокола cursor/cache; reliability из-за reconnect/retry и общего ACP-процесса. Независимый peer: Claude Opus 5 (`claude-opus-5`), route Claude; model receipt подтверждён, requested effort high, actual effort unverified. Первый запуск не создал артефакт из-за отсутствующего jq; повторный запуск завершился. Выполнена независимая проверка воспроизведений и отдельный corrective review.

## Applied

Номера стабильны после итогового объединения. Строки указывают на reviewed-код `bceda3c`; #6 найден в corrective diff и исправлен до коммита.

| # | Уровень | Исходная точка | Исправление | Reviewer; confidence |
|---|---|---|---|---|
| 1 | P1 | `deploy/acp-ws-bridge.mjs:762` | Запросы prompt ждут завершения load; load при активном prompt не создаёт replay-курсор. Pending prompt сохраняется после закрытия его сокета. | adversarial-claude; 100 |
| 2 | P1 | `deploy/acp-ws-bridge.mjs:821` | Каждая попытка начинает с исходного snapshot; частичный буфер и resync-состояние сбрасываются. Мост отбрасывает withheld-кадры ошибочного load. | reliability, adversarial-claude; 100 |
| 3 | P1 | `src/lib/sessionRuntime.ts:1645` | Курсор хранится вместе с transcript конкретного runtime; reconnect не берёт более новый курсор другой вкладки. | julik-frontend-races; 100 |
| 4 | P1 | `src/lib/sessionRuntime.ts:824` | После отправки курсора shared cache больше не заменяет snapshot текущего запроса. | julik-frontend-races; 100 |
| 5 | P1 | `src/lib/sessionRuntime.ts:865` | Live-изменения инвалидируют старый курсор; усечённый хвост не подтверждает более ранний checkpoint. | correctness, adversarial-claude; 100 |
| 6 | P2 | `src/lib/sessionRuntime.ts:1144` | Смещение вложений применяется только после подтверждённого tagged suffix; старый мост сохраняет обычную нумерацию полного replay. | corrective-correctness; 100 |
| 7 | P2 | `src/lib/sessionRuntime.ts:877` | В checkpoint сохраняется абсолютное число пользовательских ходов; вложения и outbox учитывают скрытый префикс. | correctness; 100 |
| 8 | P2 | `deploy/acp-ws-bridge.mjs:790` | Команды, config, mode, session info и usage проходят через suppression без потери состояния; итоговый ответ содержит конечный cursor. | api-contract; 75 |
| 9 | P2 | `scripts/e2e_history_cache.py:150` | Добавлен браузерный тест настоящего UI с настоящим мостом и тестовым ACP-процессом: рост, divergence, cap, metadata, отказ и повторная попытка. | adversarial-claude; 75 |
| 10 | P2 | `src/lib/historyCache.ts:146` | Кэш помечает усечённые tool details; Load full history позволяет восстановить исходные длинные результаты. | api-contract; 75 |
| 11 | P2 | `src/lib/sessionRuntime.ts:2348` | После ошибки полной загрузки кнопка остаётся доступной, ошибка видна в UI; необработанного rejection нет. | adversarial-claude; 75 |
| 12 | P2 | `src/lib/sessionRuntime.ts:865` | Reducer начинает suffix с последней cached-строки, поэтому продолжение текста, thought и tool updates изменяет правильное сообщение. | testing; 75 |

Все пункты committed: `45a7f90 fix(review): preserve incremental replay checkpoints and isolate live prompts`. Базовая гонка prompt/load существовала раньше; incremental gate добавлял к ней повреждение курсора, поэтому #1 исправлен вместе с новым контрактом.

## Проверки

Регрессии воспроизведены на исходном runtime. Сохранены red/green-проверки потери/дублирования suffix, shared-cache race, сохранённого курсора, частичного retry, вложений и boundary continuation. Реальный bridge routing тест падал 3 утверждениями до исправления и прошёл 17/17 после него. Найденная corrective review несовместимость вложений со старым мостом также прошла red/green.

- Runtime и outbox: `node --test scripts/test_session_replay_activity.mjs scripts/test_prompt_outbox.mjs`, 68/68.
- Реальный cache serializer/budget: `node --test scripts/test_history_cache_budget.mjs`, 4/4. Всего этих unit-проверок 72.
- `node scripts/e2e_bridge_routing.mjs`: 17/17.
- `node scripts/e2e_bridge_replay_resume.mjs`: 20/20.
- `TEST_REPLAY_BUFFER_CAP=1 node scripts/e2e_bridge_replay_resume.mjs`: 7/7.
- Bridge status: 4/4; heartbeat/watchdog: 22/22.
- `PLAYWRIGHT_MODULE=/tmp/acp-picker-qa/node_modules/playwright node scripts/test_replay_protocol_browser.cjs`: 5 сценариев, настоящий frontend и мост, тестовый ACP-агент. Нет вызовов провайдера. Проверены точный порядок/состав строк, divergence, cap, commands и ошибка полной загрузки с повторной попыткой через кнопку.
- `~/.hermes/tools-venv/bin/python scripts/e2e_history_cache.py`: 48/48; `scripts/e2e_session_restore.py`: 33/33. Здесь ACP подменён, state изолирован.
- Финальная `npm run build:web`: успешно, включая `check:ui` для 68 Vue-файлов и `vue-tsc`. `git diff --check` пройден.

## Фактическая выкладка

Источник релиза: чистый main checkout `/tmp/acp-panel-repair`, `45a7f90`. Web bind mount повторно проверен: `/home/hermes/projects/acp-ui/dist-web` в `/repo/dist-web`. Старые assets сохранены, index.html заменён последним. Web/state/runner не перезапускались.

Frontend: `index-CRPC6S1J.js`; SHA-256 `32e88b632e533dcbdc484ded788548a5752c4249661523f69404a180650ae1a3`. Байты ответа на `https://192.168.1.222:25809` совпали с release artifact.

Bridge source SHA-256: `5e9f60376d0ea3d33c958e224f0b74168f165fc3194fc40e3092d068212e91ec`. Источник опубликован в canonical `deploy/acp-ws-bridge.mjs`. Перед lifecycle проверены controller status, слушатели и отсутствие working-turn у четырёх обновляемых мостов. Через controller последовательно обновлены Devin PID3181654, OpenCode PID3182409, Hermes PID3183126, Pi PID3185050. Все владельцы портов подтверждены, выбранный режим host сохранён.

Образы не менялись: web `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`, state `sha256:66ec5b5f1e7db15f82f0bcde10ab1ae655e9484551e7575ae2cb6d318f22f9bd`. CLI/адаптеры этим исправлением не обновлялись.

Настоящий Chromium на рабочем адресе успешно завершил восстановление всех пяти мостов. Ввод доступен, pageerror/JSON-RPC errors отсутствуют. Codex проверен на старом процессе, без нового протокола.

| Мост | Повторная загрузка | Подавлено transcript-кадров | Результат |
|---|---:|---:|---|
| OpenCode | 313 ms | 2/2 | 0 кадров в браузер |
| Hermes | 1202 ms | 1/1 | 0 кадров в браузер |
| Pi | 4672 ms | 62/62 | 0 кадров в браузер |
| Devin | 2289 ms | 1928/1935 | 7 state-кадров, 8642 bytes; успешная проверка prefix |
| Devin, изменившийся prefix | 5697 ms | 0/1935 | Корректный полный resync |

Два дополнительных окна одной Devin-сессии получили одинаковые 20 сообщений и 641 tool call. Board managed-карточка `49739980-2c79-468e-9fac-a8fd8cd96f67` читалась с HTTP200 во время восстановления большой истории и после reload. Для проверки ожидания задерживался настоящий ответ load; ACP и managed backend оставались настоящими. Сохранённые UI-метаданные в Board-тесте изолированы.

На рабочем Pi проверена кнопка Load full history: корректный локальный хвост с offset2 и cursor62, warm skipped62, затем полный load skipped0, кнопка исчезла. Высота 28px при 1440px и 44px при 390px; focus-visible outline2px; disabled opacity0.5/cursor not-allowed. Для этой UI-проверки optional shared cache локально отвечал404, чтобы более свежий серверный snapshot не заменял искусственно усечённый локальный хвост. Сам ACP был настоящим.

Первый запуск multi-bridge QA пересёкся с перезапуском сервисов и имел ошибочный 30s timeout в тестовом коде. После завершения рестартов и исправления параметра timeout весь сценарий прошёл. Первый тест кнопки получил более свежий shared snapshot вместо искусственного хвоста; это устранено изоляцией optional cache, код продукта не менялся.

QA не отправлял session/prompt, общие UI-документы не изменялись. Генерация ответов провайдеров не проверялась.

## Coverage и ограничения

12 пунктов исправлены, 1 peer-кандидат подавлен на confidence50: не измерено суммарное потребление памяти при множестве одновременно заполняющихся gate-буферов. У каждого gate есть лимит64MiB и watchdog; нагрузочный предел всего процесса остаётся непроверенным. Утверждение peer о записи unsettled cursor отклонено: существующие loading/replayMerge/stale guards запрещают такой flush. Два peer-кандидата объединены с совпадающими локальными причинами (#2, #5). Нет malformed returns или потерянных reviewer lenses. Settlement suppression не применялось: отдельного продуктового плана не найдено.

Полный CLI replay по-прежнему проходит внутри моста. Инкрементальность действует на участке bridge -> browser. Нестабильная сериализация истории агентом может вызывать безопасный full resync вместо ускорения; это наблюдалось у Devin. При live-изменениях старый checkpoint намеренно инвалидируется и следующее открытие восстанавливает полную историю.

Codex PID1024589 обслуживает эту агентскую сессию. `assertRestartCallerOutside` запрещает уничтожить собственную сессию; запрет не обходился. Новый source опубликован, но новый код в Codex-процессе ещё не активирован. После завершения текущей сессии выполнить из независимого терминала:

```sh
cd /home/hermes/projects/acp-ui
node scripts/acp-bridges.mjs status
ss -tlnp
node scripts/acp-bridges.mjs restart --bridge codex --accept-interruption
```

После перезапуска отдельно проверить cursor-based повторное открытие Codex. Открытым UI-вкладкам нужен reload.

Локальные артефакты: `/tmp/compound-engineering-1001/ce-code-review/20261020-incremental-review/` (findings-final.json, validation-final.json, corrective-review-final.json, semantic-decisions.json); `/tmp/acp-review-{live,board,control}-qa.json`; `/tmp/acp-review-deploy-receipt.json`. Логи тестов имеют префикс `/tmp/acp-review-`. Consumed peer-job directories удалены после классификации terminal outcomes; receipt сохранён в reviewer artifact.

---

> Verdict: исправленный код готов; четыре обновлённых моста и frontend проверены в production. Полная активация для всех пяти мостов ещё требует независимого перезапуска Codex.

Actionable: открытых замечаний к коду нет. Операционное действие: перезапустить Codex из независимого терминала после завершения этой сессии и проверить его повторное открытие.
