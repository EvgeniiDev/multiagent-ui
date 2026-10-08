# acp-ui — agent rules

## Testing and release verification

Read and follow [TESTING.md](TESTING.md) before changing behavior, testing,
or deploying. Select checks by the affected user flow; documentation-only
changes require content/link/diff checks. Do not claim production readiness
without verifying the actual deployed artifacts and affected user flow.

## UI design system

Read and follow [docs/design-system.md](docs/design-system.md) for UI changes.
Use `src/components/ui/UiButton.vue` for new or modified action buttons and
shared theme tokens/field primitives. Component appearance must not depend on
parent scoped CSS. Keep page CSS for layout; extend shared primitives when a
new variant is needed. Verify actual browser styles, theme, focus, disabled,
and touch sizing as required by TESTING.md.

## Runtime: docker compose only

The stack lives in `compose.yaml` (repo root). Control it with
`docker compose up -d` / `docker compose down` from this directory.
The old systemd user units (`acp-bridge-*`, `acp-ui-web`, `acp-state`,
`acp-runner`, `acp-https`, `acp-stt`, `acp-pm-wakeup.*`) are disabled —
do not re-enable them, do not start services by hand (`python -m
http.server`, `nohup`, bare `node server/...`). Before starting
anything: `docker compose ps` + `ss -tlnp`.

## One port — one owner

| Port | Service |
|---|---|
| 25808 | web (`dist-web/`) |
| 25809, 25906, 25910–25914 | https-front |
| 25900 | state server |
| 25901–25904, 25907 | bridges: hermes / opencode / devin / pi / codex |
| 25905 | stt |

A stray process on an occupied port is killed, not worked around.
Never "fix it nearby" with a second server on another port.

## Bridge: single source of truth

The live bridge source is `deploy/acp-ws-bridge.mjs`; the copy at
`~/.hermes/acp-ws-bridge.mjs` is an `install.sh` artifact. Edit the
source. Sacred invariants: per-session routing (a `session/load`
replay must reach only its own tab) and per-socket request-id
namespacing on the shared child. Do not break either.

## Frontend builds and deployment

`npm run build:web` may run on the host or inside the agent container.
The live `dist-web/` is bind-mounted into the `web` container; verify its
actual mount before publishing. Publish built assets to that mount, keep
older hashed assets for open tabs, and replace `index.html` last.
The Docker socket allows agents inside ACP UI to inspect and manage the
existing stack; service lifecycle still follows the Compose rules above.

## UI-only changes: leave agent bridges running

When changing only the frontend, do not stop, restart, recreate, or rebuild
any agent bridge, and do not kill its agent CLI child processes. Bridges are
independent services; frontend builds, browser tests, and publishing
`dist-web/` do not require bridge lifecycle changes.

Do not run stack-wide `docker compose down`, `restart`, or `up` for a UI-only
release. Publish the frontend assets to the verified web mount as described
above. If a web service operation is actually needed, target `web` only and
use `--no-deps` where supported.

Bridge lifecycle changes belong to a bridge/backend change or recovery from
a separately diagnosed bridge failure, never to routine UI deployment.

## Tauri: hands off

All `@tauri-apps/*` usage sits behind the `isTauriHost()` runtime
switch (`src/lib/platform.ts`, `src/lib/host/`); in the browser it is
dead code (lazy `import` inside the Tauri branch only). Do not fix web
behavior through Tauri branches or vice versa. Removing Tauri is a
bundle-size optimization, not a bugfix — don't sneak it into other work.

## A sleeping agent is not a working agent

If the session jsonl stops growing for >2–3 min while the `pi` process
sits in `ep_poll` with zero IO/CPU delta, the model call is stuck, not
working. Recover with a fresh `session/prompt` (stop button + new
message) or by killing the `pi` child (the bridge reports "agent CLI
exited"). `nohup ... &` with "read the log next step" is banned —
results must come back through the tool result.

## Endless tools in the feed = replay

Opening an old session replays its whole transcript via `session/load`;
hundreds of toolCall cards rendering at once is history, not live
calls. Do not "fix" it by killing processes.
