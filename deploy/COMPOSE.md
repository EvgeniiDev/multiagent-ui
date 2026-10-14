# Docker Compose deployment

Основной стек описан в `compose.yaml` (корень репо), `network_mode: host`.
Голосовая транскрибация предоставляется отдельным проектом
`../audio-video-to-text`, а не Compose-сервисом ACP UI.

Режим пяти постоянных chat bridges выбирается отдельно: `docker` по умолчанию
или явный `host`. Используй `node scripts/acp-bridges.mjs status` и инструкции
в [BRIDGE-MODES.md](BRIDGE-MODES.md); прямой `docker compose up/stop` для
`bridge-*` запрещён, потому что он обходит единый mode guard.

## Состав

| Сервис | Команда | Порт |
|---|---|---|
| bridge-hermes/opencode/devin/pi | `node deploy/acp-ws-bridge.mjs --port 2590X --required-mode docker --cmd "..."` | 25901–25904 |
| bridge-codex | `node deploy/acp-ws-bridge.mjs --port 25907 --required-mode docker --cmd "node deploy/codex-acp.mjs" --agent-name "Codex"` | 25907 |
| state | `node server/acp-state-server.mjs` | 25900 |
| runner | `node server/acp-runner.mjs --serve` | — |
| https-front | `node server/https-front.mjs` | 25809, 25906, 25910–25914, 25917; `25906` проксирует host `127.0.0.1:8099` |
| web | `python3 -m http.server 25808` в `dist-web/` | 25808 |
| cron | `acp-pm-wakeup.mjs` в цикле `sleep 1800` | — |

### Внешняя зависимость голоса

`../audio-video-to-text` должен отдельно слушать host `127.0.0.1:8099` и
предоставлять `POST /v1/audio/transcriptions`. HTTPS-front принимает UI-запросы
на `25906` и проксирует их на этот API. Compose ACP UI не запускает и не
контролирует жизненный цикл transcriber; без внешнего API голосовой ввод
недоступен. Старый STT listener `25905`, `server/stt-server.py`,
`Dockerfile.stt` и `gigaam-venv` больше не являются частью развёртывания.

cron заменяет `acp-pm-wakeup.timer` (`OnBootSec=10min`, `OnUnitInactiveSec=30min` —
примерно каждые 30 мин; в стеке ровно каждые 30 мин, без OnBootSec-задержки).

## Образы

- `Dockerfile.node` — `node:22-slim` + `npm install -g ws` (мосты требуют `ws`).


## Монты

- `/home/hermes/projects:/home/hermes/projects:rw` — мосты/раннер пишут
  briefs/логи/артефакты в проекты.
- Рантаймы/CLI хоста (bind, строки в yaml): `/home/hermes/.local` (node, hermes,
  opencode, pi-acp), `/home/hermes/.local/share/devin`
  (бинарь devin), `/usr/bin/pi` (ro).
- TLS: `/home/hermes/.hermes/acp-tls:ro` (`ACP_TLS_DIR`).
- Данные: `/home/hermes/projects/acp-ui-state:rw` (`STATE_DIR`).
- Код: `.` → `/repo:ro` (серверы не меняются, dist-web пересобирается на хосте).

PATH в node-контейнерах: `/home/hermes/.local/bin:...` как в юнитах.
`HOME=/home/hermes` чтобы `os.homedir()`/`--root` совпадали с хостом.
Env: `ACP_STATE_URL=http://127.0.0.1:25900`, `STATE_URL=...`,
`ROOT_DIR=/home/hermes/projects`, `RUNNER_ID=host-runner`.

## Host provisioning (run BEFORE enabling managed execution)

Preflight runs INSIDE the state/runner containers, where /tmp is
container-private — a host /tmp dir is invisible there. Provisioning is
therefore per-container, in `compose.prod-env.yaml` (runner boot wrapper:
`install -d -m 0700 /tmp/compound-engineering-1001` before exec; service
user is 1001 so the dir is uid-owned 0700). Keep the HOST dir too for
local probes (`preparation_binding_probe.mjs` on the host resolves
TMPDIR to the host /tmp):

```bash
# Host probes only — never reaches container preflight:
install -d -m 0700 -o 1001 -g 1001 /tmp/compound-engineering-1001
# Verify: ls -ld /tmp/compound-engineering-1001  # drwx------ hermes hermes
```

Background: the runner runs uid 1001 and ce-skills document
`<tmp>/compound-engineering-<uid>` as their writable scratch root;
`preflightBinding(fsCheck)` refuses with `root_missing` when it is absent
(proven 2026-10-03: probe fails closed without it; restored 23/23 with
it). Provisioning satisfies the gate — never bypass the preflight.

The prod ops token (`/home/hermes/.acp-ops/ops-token`, provision per the
`ACP_OPS_TOKEN_FILE` comment in `compose.yaml`) is likewise required on
the host before the managed stack can serve `retire` — it binds
read-only into the state container alone.

## Managed execution enablement (parent deploys, prod state kept)

`compose.prod-env.yaml` stacks on `compose.yaml` and turns on the proved
surface — core start/validation + F1 fusion environment + preparation —
against the REAL production `STATE_DIR` (no isolated `-u7` tree):

```bash
cd /home/hermes/projects/acp-ui-lead-integration   # parent deploy checkout (integration branch worktree)
# precondition: acp-ui-agent-modes f1 profile up (env-controller+egress-gw)
docker compose -p acp-ui -f compose.yaml -f compose.prod-env.yaml \
  config   # render check only — services, mounts, env resolve
# then (manager clearance only; state+runner recreated, rest untouched):
docker compose -p acp-ui -f compose.yaml -f compose.prod-env.yaml \
  up -d --no-deps state runner
```

Rollback (explicit, logged, parent-captured private
`.agent-tmp/autonomous/rollback/restore.yaml`):
`docker compose -p acp-ui -f compose.yaml
up -d --no-deps state runner` — flags unset, managed surface 501-gated
again, prod board/claims/state untouched (managed aggregates persist but
are inert without the flags).

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
