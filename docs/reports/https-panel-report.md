# W17 — панель полностью работает по HTTPS (нет mixed content)

Ветка: `cc/w17-https`, worktree `acp-ui-w17-https`. Один коммит, в `control-center` не сливалось.
Цель: `https://<host>:25809` — единственная точка входа; браузер не должен блокировать
ни один запрос как mixed content.

## Что было не так

Страница `https://…:25809` грузилась, но половина панели была мёртвая: браузер режет
`http://…:25900` (общий state-сервер: доска, claims, роли, сессии, активность) и
`ws://…:25901–25904` (все четыре ACP-моста) как mixed content — панель молча падала
в localStorage, мосты не подключались, `https://…:25906/health` (STT) упирался в CORS.

## Изменения

**Конвенция в одном месте — `src/lib/host/secure.ts`** (привезён оркестратором в
`control-center`, здесь приземлен + два бага исправлены, см. ниже):
`securePortFor(port)` — insecure +10 (legacy-пары: панель 25808→25809, STT
25905→25906); `toSecureUrl(raw)` — ws→wss / http→https + смена порта,
уже-правильные URL не трогает; `isSecurePage()`, `securePanelUrl()`.

**Call sites:**

| Файл | Что строится | https-страница | http-страница |
|---|---|---|---|
| `src/lib/host/index.ts` `defaultWebConfig()` | `ws://<h>:2590{1..4}/` | `wss://<h>:2591{1..4}/` | без изменений, побайтово |
| `src/lib/host/storage.ts` `stateServerBase()` | `http://<h>:25900` | `https://<h>:25910` | без изменений, побайтово |
| `src/features/settings/fsApi.ts` `defaultBridgeBaseUrl()` | `http://<h>:25901` | `https://<h>:25911` | без изменений |

Третий call site — находка при проверке заявления «fs-API следуют за agent-URL
бесплатно»: `bridgeBaseUrlForAgentUrl` (и его инлайн-копии в `App.vue`,
`NewSessionDialog.vue`, `NewProjectDialog.vue`) действительно следуют — `wss:` →
`https:`. Но `defaultBridgeBaseUrl()` — фолбэк «ни одного remote-агента в конфиге» —
возвращал жёсткий `http://<h>:25901` и на https-странице давал бы mixed content.
Прогнан через тот же `toSecureUrl` — конвенция не размазана, место всё ещё одно.

`server/https-front.mjs` — версия из `control-center`: прокси на state и четыре
моста, `Access-Control-Allow-Origin: *` на каждом ответе, OPTIONS отвечает сам,
`ACP_FRONT_TARGETS` для тестовых портов. Байт-в-байт совпадает с control-center.

`src/lib/stt.ts` — уже умел `https://<h>:25906` / `wss://<h>:25906`; проверено,
не трогалось.

## Баги в secure.ts, пойманные E2E (не визуальным осмотром)

1. **`toSecureUrl` добавлял `/` к URL без пути.** `http://<h>:25900` →
   `https://<h>:25910/` → `${base}/health` = `//health` → state-сервер отвечал 404
   → проба падала → панель молча уходила в localStorage. Ровно тот же симптом,
   который лечит весь воркстрим — проявился бы и по https. Фикс: `rest = ''`.
   E2E до фикса показывал `https://acp.local:25910//health` → 404.
2. **`securePanelUrl()` дважды применял сдвиг порта.** На https-странице
   `location.port` уже secure (25809), `securePortFor(25809)` давал 25819.
   Фикс: возвращает `location.origin`. (Функция пока без вызывающих — оставлена
   для воркстрима, который будет показывать «правильный» URL.)

## Проверка — `scripts/e2e_https_panel.py` (зарегистрирован в `e2e_all.py`)

Ставит **настоящий** `server/https-front.mjs` на тестовые порты
(`ACP_FRONT_TARGETS`), за ним — настоящий `acp-state-server.mjs` со своим
`STATE_DIR` и stub-мост (`scripts/https_panel_stubs.mjs`: HTTP `/api/fs/*` +
реальный WS-handshake + минимальный ACP-протокол) и stub-STT (`/health`).
Бандл отдаётся по TLS **через этот же фронт**. Панель собирает продовые URL —
единственная прослойка это CONNECT-прокси, который мапит порт назначения
(`acp.local:25910` → тестовый слушатель state-TLS, и т.д.): браузер реально
открывает `https://acp.local:25910/...`, `wss://acp.local:25911/` — TLS-терминация,
CORS, wsProxy, апстримы — всё продовое, меняется только TCP-хоп. Продовые порты
этой машины (25900-25914 заняты живым деплоем) не трогаются.

Результат: **19/19**

```
PASS  https: session restores (bridge reachable)
PASS  https: replayed transcript rendered
PASS  https: board doc from the state server shows in the UI
PASS  https: page is a secure context
PASS  https: STT base resolves to https://acp.local:25906  (https://acp.local:25906/health)
PASS  https: agent dialed wss://acp.local:25911/           (wss://acp.local:25911/)
PASS  https: stub bridge saw the real ws upgrade through the front  (UPGRADE /)
PASS  https: state probed at https://acp.local:25910
PASS  https: ZERO http:// or ws:// requests (no mixed content)
PASS  http: session restores (bridge reachable)
PASS  http: replayed transcript rendered
PASS  http: board doc from the state server shows in the UI
PASS  http: state probed at the OLD http://acp.local:25900
PASS  http: agent dialed the OLD ws://acp.local:25901/
PASS  http: no https:// or wss:// requests to services
PASS  zero pageerror events
```

Цепочка https-ноги, замечу, настоящая end-to-end: `sessions.json` приехал через
`https://acp.local:25910` → панель подняла сохранённую сессию →
`wss://acp.local:25911/` (реальный upgrade на stub сквозь wsProxy фронта) →
`session/load` → ChatView → `VoiceInput` пробует `https://acp.local:25906/health`.
Карточка доски видна в UI — не строковая проверка URL.

## Регрессии

- `scripts/e2e_state_backend.py` — **18/18** (код storage.ts в деле)
- `scripts/e2e_session_restore.py` — **23/23**
- `scripts/e2e_all.py` — **24 сьюта, все зелёные**, включая `https panel` (19/19).
  Один прогон дал единственный FAIL: `e2e_dispatch` упал в своей фикстуре
  (`plant foreign claim -> 409`, rev-конфликт при записи claim-документа — к
  панели отношения не имеет); при соло-перепрогоне `e2e_dispatch` чист —
  56/56. Флаки в фикстуре сьюта, не в проверяемом коде.
- `npm run build:web` — vue-tsc + vite чисто

## Честно не проверено

- Реальный микрофон/GigaAM STT end-to-end: stub отвечает `/health`, сам поток
  PCM16 через `wss://…:25906/ws/stream` не гонялся (в леге https проверен адрес
  и CORS-путь; аудио-тракт — отдельная история).
- `securePanelUrl()` — вызывающих в коде нет; корректность — по коду/юнит-логике,
  в e2e не используется.
- Редактирование URL агента в Settings под https (`wss://` из поля ввода):
  `buildAgentConfig` пропускает `wss://`, но живого редактирования в e2e нет.
- Истинный телефон/десктоп-хост `.222` из LAN: проверено на `acp.local` +
  loopback через тот же фронт и тот же сертификат; IP-SAN 192.168.1.222 в e2e
  не участвовал (в браузере `ignore_https_errors`, имя хоста роли не играет).
- Вариант «https-страница + пользователь вручную вписал `ws://` в конфиг» —
  такой URL остаётся ws:// и браузер его отрежет (by design: `toSecureUrl`
  не трогает явно вписанное; seed покрывает дефолт).
