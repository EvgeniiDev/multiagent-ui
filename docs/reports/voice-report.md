# W7 — Голосовой ввод в композер: исторический отчёт

STATUS: HISTORICAL — superseded by the 2026-10-11 HTTP API migration at the end of this file.

## Что сделано

- `src/lib/stt.ts` (новый): клиент сервиса в стиле `fsApi.ts`/`host/storage.ts`.
  `sttHealth()` — проба `GET http://<location.hostname>:25905/health` с
  таймаутом 1.5 с, как у state-сервера; `VITE_STT_URL` переопределяет базу.
  `StreamingStt` — `open()` (таймаут 4 с), `push(Int16Array)`, `stop()`
  (`{"type":"stop"}`), `reset()`, `close()`; колбэки `onPartial`/`onFinal`/
  `onError`/`onClose(hadFinal)`, close эмитится ровно один раз.
- `src/components/VoiceInput.vue` (новый): кнопка микрофона в `.input-row`
  между composer-box и Send — та же квадратная геометрия, что у `.icon-btn`
  (34×34, `border-radius: 6px`, без тени, stroke-SVG; 44×44 на ≤800px), но
  свой класс `.voice-btn`, чтобы не менять счёт `.input-row .icon-btn`,
  который проверяет `e2e_composer.py`. Захват: `getUserMedia({audio:
  {channelCount:1, echoCancellation:true, noiseSuppression:true}})` →
  `AudioContext({sampleRate:16000})` (где опцию игнорируют — JS-ресемплер
  с линейной интерполяцией и переносом хвоста между колбэками) → один
  переиспользуемый `ScriptProcessorNode` → чанки ровно по 1600 сэмплов
  (100 мс) PCM16 → `ws.send`. Состояния: idle / connecting / listening
  (accent-тинт + стоп-квадрат + мигающая точка) / stopping; таймер идёт в
  статус-строку. Повторный клик и Escape останавливают; клик во время
  connecting отменяет взлёт (generation-страж против гонок await).
- `src/components/ChatView.vue`: поле завёрнуто в `.composer-field`; во время
  диктовки текст textarea прозрачен (`caret-color` остаётся), а оверлей
  `.voice-overlay` с метрикой шрифта 1:1 рисует `typed | committed | volatile
  | typed` — committed обычным `--text-primary`, volatile приглушённым
  `--text-muted`. По `final` текст вставляется по позиции каретки
  (`voiceAt` двигается, если пользователь правит поле во время записи),
  с пробелом-разделителем — тот же пробел заранее виден в оверлее, скачка
  нет. Строка `.voice-status` над рядом: таймер «Listening… m:ss» /
  «Starting microphone…» / «Finishing…» / ошибка. `handleSend` и Escape
  останавливают диктовку до отправки.
- Честные отказы: сервис недоступен → кнопка disabled + title «Voice input
  unavailable — speech service not reachable» (ре-проба каждые 15 с);
  отказ микрофона → строка «Microphone access denied — check browser
  permissions», всё возвращается в idle; обрыв ws в середине → «Speech
  service connection lost — kept recognised text» и последняя гипотеза
  остаётся в поле; нет финала за 9 с → то же сохранение с понятной ошибкой.
- `scripts/e2e_voice.py` (новый): свой `dist-web` на порту 25991, chromium с
  `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`,
  `route_web_socket` отдаёт заглушку STT (партиалы на 3-м и 7-м бинарных
  кадрах, финал на stop) поверх обычного ACP-мока; состояние-сервер :25900
  глушится, чтобы панель падала в localStorage (боевой инстанс на хосте
  держит `activeView:"projects"` и прятал сайдбар). Данные теста —
  `./tmp-voice-test/stub-transcript.json`, скриншоты — `docs/voice-*.png`.

## Вывод команд

```
$ npm run build:web
✓ 275 modules transformed.  ✓ built in 2.83s   (vue-tsc без ошибок)

$ ~/.hermes/tools-venv/bin/python scripts/e2e_voice.py
PASS  mic button mounts in the input row
PASS  mic button is a 34x34 square  (34.0x34.0)
PASS  mic button: radius 6px, no shadow  ({'border-top-left-radius': '6px', 'box-shadow': 'none'})
PASS  mic button carries an svg icon, no emoji
PASS  click opens STT ws and shows the listening state
PASS  status line shows the listening timer  (Listening… 0:00)
PASS  binary PCM frames reached the stub  (7 frames, 22400 B)
PASS  committed span carries the settled words  ({'c': 'the quick', 'v': 'brown fox'})
PASS  volatile span carries the hypothesis  ({'c': 'the quick', 'v': 'brown fox'})
PASS  committed renders in the normal field colour  ({'color': 'rgb(43, 39, 35)'})
PASS  volatile renders muted  ({'color': 'rgb(120, 109, 98)'})
PASS  typed text still visible in the overlay
PASS  final text stays in the field after stop  ('note: the quick brown fox')
PASS  stop frame reached the stub
PASS  overlay cleared once idle
PASS  second click starts a new take
PASS  Escape stops the take and keeps the text  ('note: the quick brown fox the quick brown fox')
PASS  two STT sessions opened in total  ({'opens': 2, 'binary_frames': 8, 'binary_bytes': 24576, 'stops': 2})
PASS  dropped ws surfaces a visible error  (Speech service connection lost — kept recognised text)
PASS  recognised text stays in the field after a drop  ('the quick brown fox')
PASS  mic button idles again after the drop
PASS  service down disables the mic button
PASS  disabled button explains itself in the title  ('Voice input unavailable — speech service not reachable')
PASS  light: volatile muted text >= 4.5:1  (4.76:1 rgb(120, 109, 98) on rgb(251, 248, 243))
PASS  light: error line >= 4.5:1  (5.37:1 rgb(179, 64, 46) on rgb(251, 248, 243))
PASS  dark: volatile muted text >= 4.5:1  (6.44:1 rgb(179, 167, 155) on rgb(42, 37, 33))
PASS  dark: error line >= 4.5:1  (7.32:1 rgb(240, 161, 132) on rgb(42, 37, 33))
PASS  denied mic shows a visible reason  ('Microphone access denied — check browser permissions')
PASS  button returns to idle after the denial
PASS  zero pageerror events

30/30 assertions passed
```

22400 B / 7 кадров = 3200 B на кадр = 1600 сэмплов PCM16 — пайплайн
захват→ресемпл→нарезка 100 мс проверен сквозной.

## Замечание для оркестратора (баг в server/stt-server.py, не мой файл)

`GET /health` не отдаёт CORS-заголовков (`acp-state-server.mjs` шлёт
`access-control-allow-origin: *`, stt-server — нет). Fetch из браузерной
сборки с другого origin браузером отклоняется, хотя сервис жив.
Воспроизведение: `fetch('http://<host>:25905/health')` со страницы панели →
TypeError. Обход с моей стороны: `sttHealth()` после неудачи повторяет пробу
с `mode:'no-cors'` — resolved означает «порт отвечает» (ответ opaque, тело
не читается). WS-сокету CORS не нужен — стрим работает и так. Правильный
фикс на сервере: `CORSMiddleware`/`access-control-allow-origin: *` —
тогда `verified` в ответе пробы станет true автоматически.

## Что не проверено

- Живая GigaAM end-to-end (по брифу сервис «проверено, не перепроверяй»;
  e2e идёт по контракту через заглушку + фейковый микрофон chromium).
- Tauri-shell и реальный https-деплой; `getUserMedia` требует secure
  context — на `http://<lan-ip>` браузер его не даст вообще, кнопка честно
  покажет «needs a secure context».
- Мобильная геометрия 44px — правило есть, но e2e мерил только десктопные
  34px (композерная сьютa ту же метрику проверяет по `.icon-btn`).
- `scripts/e2e_composer.py` на этой машине падает раньше моих правок —
  сьютa не глушит :25900 и упирается в живой state-сервер с
  `activeView:"projects"` (та же причина у всех старых сьютов без
  стаба; в моей — добавлен). Сама геометрия композера не тронута:
  `.icon-btn`-кнопок по-прежнему две, поле и рамка на месте.
- ScriptProcessorNode deprecated-warning в консоли (AudioWorklet требовал
  бы отдельного module-url; выбран один узел по букве брифа).

## 2026-10-11 — HTTP API migration (current)

STATUS: DEPLOYED; real-browser microphone E2E is not confirmed.

- Voice input now records mono PCM16 at 16 kHz, builds one WAV after stop,
  then submits multipart `POST /v1/audio/transcriptions` with `model=gigaam-v3`,
  `language=ru`, `response_format=text`. This API belongs to the neighboring
  `audio-video-to-text` project; there are no interim transcripts in this flow.
- HTTPS path: UI `:25809` → `https-front :25906` → host API `127.0.0.1:8099`.
  The dedicated `stt` Compose service and old `:25905` listener are absent.
- Verification: Node regression suite 9/9; `vue-tsc` + web build passed;
  Python E2E parser tests 2/2 and Python E2E scripts compile; Compose config
  validates without `stt`. The rebuilt entrypoint and current hashed JS/CSS
  match the live bind mount; all 70 staged assets were published before
  replacing `index.html`. Live `/` and the JS asset return HTTP 200; served JS
  contains the transcription endpoint and `25906`, not retired `25905`.
  Live `:25906/openapi.json` returns 200 and declares
  `POST /v1/audio/transcriptions`; CORS preflight returns 204 with
  `Access-Control-Allow-Origin: *`. A real test-WAV POST through the API was
  exercised earlier in this migration and its temporary upload was removed.
  Compose-only deployment requires the separately managed
  `../audio-video-to-text` service on host `127.0.0.1:8099`; its live OpenAPI
  endpoint was reachable during this verification.
- The Playwright Python package is available, but its Chromium headless-shell
  binary is not installed; `scripts/e2e_voice.py` stops at browser launch.
  Camoufox also lacks `~/.cache/camoufox/version.json`, so live microphone,
  permission, and visible-result behavior remain unverified.
- Rollback patch and pre-publication index backup are recorded in
  `/home/hermes/.hermes/backups/acp-ui-audio-video-transcriber-20261011.patch`
  and `/home/hermes/.hermes/backups/acp-ui-index-pre-final-20261011.html`.
