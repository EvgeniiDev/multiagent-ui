#!/bin/sh
# porch entrypoint that routes pi-cli backend launches through the repo-owned
# same-process RPC boundary shim (deploy/pi-rpc-boundary.mjs).
#
# Why a wrapper: porch resolves the pi binary from PORCH_BIN_PI, but
# server/execution/porch-runtime.mjs buildChildEnv() deliberately scrubs all
# PORCH_* keys from caller-supplied env. Exporting it inside this wrapper —
# before exec'ing the real porch — injects it below the scrub boundary, into
# porch's own process env, which resolve_binary() then honors.
#
# All porch subcommands (delegate/status/events/cancel/list) exec the real
# porch transparently; PORCH_BIN_PI is only consulted when the pi-cli backend
# spawns its child.
#
# Wired via ACP_PORCH_CLI on the runner service (isolated compose overlay
# only). Opt-in, no external-source edits.
set -eu
PI_BOUNDARY_ROOT=${PI_BOUNDARY_ROOT:-/repo}
export PORCH_BIN_PI="$PI_BOUNDARY_ROOT/deploy/pi-rpc-boundary.mjs"
REAL_PORCH=${PI_BOUNDARY_REAL_PORCH:-"$HOME/.pi/agent/skills/pragmatic-orchestration/scripts/porch"}
exec "$REAL_PORCH" "$@"
