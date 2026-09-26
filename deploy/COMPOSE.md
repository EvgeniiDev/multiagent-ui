# Docker Compose deployment

Systemd user-юниты переведены в `compose.yaml` (корень репо). Порты те же,
`network_mode: host` — STATE_URL/CORS/фронт-маппинг не меняются.
Код серверов не менялся.

## Состав

| Сервис | Команда | Порт |
|---|---|---|
| bridge-hermes/opencode/devin/pi | `node server/acp-ws-bridge.mjs --port 2590X --cmd "..."` | 25901–25904 |
| state | `node server/acp-state-server.mjs` | 25900 |
| runner | `node server/acp-runner.mjs --serve` | — |
| https-front | `node server/https-front.mjs` | 25809, 25906, 25910–25914 |
| web | `python3 -m http.server 25808` в `dist-web/` | 25808 |
| stt | хост-venv python + `server/stt-server.py` | 25905 |
| cron | `acp-pm-wakeup.mjs` в цикле `sleep 1800` | — |

cron заменяет `acp-pm-wakeup.timer` (`OnBootSec=10min`, `OnUnitInactiveSec=30min` —
примерно каждые 30 мин; в стеке ровно каждые 30 мин, без OnBootSec-задержки).

## Образы

- `Dockerfile.node` — `node:22-slim` + `npm install -g ws` (мосты требуют `ws`).
- `Dockerfile.stt` — `python:3.12-slim` + `ffmpeg` только. torch/gigaam НЕ ставятся
  (долго, ~GB): контейнер монтирует готовый хост-venv
  `/home/hermes/.hermes/gigaam-venv` (ro) и запускает его python.
  Дополнительно монтируются `/home/hermes/.hermes/GigaAM-src:ro`
  (gigaam стоит editable-ссылкой на исходники) и `/home/hermes/.local:ro`
  (venv-python — симлинк в uv-каталог `~/.local/share/uv`).
  Fallback: оставить stt на хосте (`systemctl --user start acp-stt`) —
  он слушает 25905, фронт его найдёт.

## Монты

- `/home/hermes/projects:/home/hermes/projects:rw` — мосты/раннер пишут
  briefs/логи/артефакты в проекты.
- Рантаймы/CLI хоста (bind, строки в yaml): `/home/hermes/.local` (node, hermes,
  opencode, pi-acp, gigaam-venv bin), `/home/hermes/.local/share/devin`
  (бинарь devin), `/usr/bin/pi` (ro).
- TLS: `/home/hermes/.hermes/acp-tls:ro` (`ACP_TLS_DIR`).
- Данные: `/home/hermes/.hermes/acp-ui-state:rw` (`STATE_DIR`).
- Код: `.` → `/repo:ro` (серверы не меняются, dist-web пересобирается на хосте).

PATH в node-контейнерах: `/home/hermes/.local/bin:...` как в юнитах.
`HOME=/home/hermes` чтобы `os.homedir()`/`--root` совпадали с хостом.
Env: `ACP_STATE_URL=http://127.0.0.1:25900`, `STATE_URL=...`,
`ROOT_DIR=/home/hermes/projects`, `RUNNER_ID=host-runner`,
`PORT/STT_WINDOW_S/STT_HOP_S` для stt.

## Туда (systemd → compose)

```bash
systemctl --user stop acp-ui-web acp-bridge-hermes acp-bridge-opencode \
  acp-bridge-devin acp-bridge-pi acp-state acp-runner acp-https acp-stt
systemctl --user stop acp-pm-wakeup.timer
systemctl --user disable acp-ui-web acp-bridge-hermes acp-bridge-opencode \
  acp-bridge-devin acp-bridge-pi acp-state acp-runner acp-https acp-stt \
  acp-pm-wakeup.timer
systemctl --user daemon-reload
docker compose up -d --build
```

## Обратно (compose → systemd)

```bash
docker compose down
systemctl --user enable --now acp-ui-web acp-bridge-hermes acp-bridge-opencode \
  acp-bridge-devin acp-bridge-pi acp-state acp-runner acp-https acp-stt
systemctl --user enable --now acp-pm-wakeup.timer
```
