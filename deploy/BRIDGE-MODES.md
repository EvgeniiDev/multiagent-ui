# ACP bridge runtime modes

This control plane covers exactly five persistent chat bridges: Hermes, OpenCode, Devin, Pi, and Codex. Web, state, runner, F1 workers, Porch supervision, and other services remain outside the host-mode switch.

## Selection and safety

- `~/.config/acp-ui-bridge-state/selected` is the single persisted selector. A fresh install initializes it to `docker`; only the exact values `docker` and `host` are accepted.
- The controller serializes mode changes with a controller `flock`. Each supported Docker Compose and systemd bridge launch also acquires the same per-bridge kernel `flock` lease at `~/.config/acp-ui-bridge-state/locks/<bridge>.lock`, held by the bridge process for its full lifetime. This blocks direct host-unit starts and concurrent Compose starts even when they bypass the controller.
- `deploy/install.sh` provisions one stable lock inode per bridge (directory mode `2770`, lock files `0660`, owned by the user). Missing, symlinked, aliased, hard-linked, or wrongly owned lock paths fail closed. Do not remove or replace a lock file while any bridge may be running.
- The controller has no `--lock-held` bypass flag. The selected-mode guard remains active for the bridge lifetime; Compose receives its selector bind read-only.
- The controller never falls back. If the selected host environment, Docker configuration, startup, port ownership, or health verification fails, it reports failure and does not start the other mode; after a handoff failure, the requested mode remains selected and any already-stopped bridge stays stopped.
- A mode change stops the previous selected owner, waits for all five ports to become free, then starts the requested owner. Unknown listeners are reported, never killed.
- Stopping a bridge interrupts clients/agent work. The controller refuses that transition unless `--accept-interruption` is supplied. Close/drain user work first; this flag is explicit consent to the interruption, not a drain detector.
- Host processes run as `hermes` with direct access to the host user's filesystem and credentials. This is a broader boundary than the existing containers. Use host mode only when that access is intended.

## Commands

From the canonical checkout (`~/projects/acp-ui`):

```sh
node scripts/acp-bridges.mjs status
node scripts/acp-bridges.mjs preflight --mode docker
node scripts/acp-bridges.mjs preflight --mode host
node scripts/acp-bridges.mjs switch --mode host --accept-interruption
node scripts/acp-bridges.mjs switch --mode docker --accept-interruption
```

`status` reports desired mode, observed Docker container/systemd owner, and each expected port. `preflight` is read-only. `switch` is the only supported handoff; do not use direct `docker compose up/stop` or old `acp-bridge-*.service` units for these five bridges.

The current Compose project name is pinned to `acp-ui` by the controller, even when invoked from a feature worktree. It starts/stops only the five `bridge-*` services with `--no-deps`; it does not restart web/state/runner or the broader stack.

## Host Pi setup

The host Pi ACP must match the container-pinned Pi `0.85.1` and `pi-acp 0.0.33`, including the repo's independent-session patch. Check the exact package versions in `Dockerfile.node` and patch marker in `deploy/patch-pi-acp-multisession.mjs` before provisioning. As the `hermes` user, run:

```sh
deploy/provision-host-pi.sh
node scripts/acp-bridges.mjs preflight --mode host
```

Provisioning changes npm packages under `~/.local`; it does not start or stop bridges. Host preflight refuses activation if any CLI is unavailable, Pi versions differ, the Pi adapter patch is absent, or `ws` cannot be resolved.

## Startup supervision

`deploy/systemd/acp-ui-bridges.service` runs `reconcile` at user-session startup. In Docker mode the Compose services retain their existing restart policy. In host mode the controller starts the five dedicated `acp-ui-bridge-host@*.service` units; every host unit reruns the read-only host preflight in `ExecStartPre` (including direct `systemctl start`) and then runs `guard-start --mode host --bridge %i` to require the selected mode and a clean live ownership inventory before acquiring its per-bridge lease and binding. This closes the direct-systemd-start path even for older Docker containers that do not hold the new lease. The legacy `acp-bridge-*.service` units are not installed or enabled by the new installer.

## Live migration caveat

Host mode runs as `hermes` and allows a broader filesystem boundary than Docker. Before touching any bridge, the switch builds the five updated Docker images; a build failure leaves the current containers untouched. It then serializes any required recreation of legacy direct-command Docker bridges into lock-guarded Compose launches, verifying each port before proceeding; finally it performs the ordinary Docker-to-host handoff. This may restart all five bridges and still requires the explicit `--accept-interruption` flag.
