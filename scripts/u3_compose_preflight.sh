#!/usr/bin/env bash
# scripts/u3_compose_preflight.sh — U3 deployment-readiness proof, executed by
# the PARENT against the LIVE compose stack. It restarts nothing, opens no
# listeners, and never prints secrets. `docker compose run --rm --no-deps`
# creates an EPHEMERAL container sharing the runner service spec (uid/mounts)
# — the running services are untouched.
#
# Usage:
#   scripts/u3_compose_preflight.sh [COMPOSE_DIR]
#     COMPOSE_DIR defaults to the live stack checkout (/home/hermes/projects/acp-ui).
#     Pass THIS repo dir to validate the prepared (undeployed) compose spec.
#
# Exit 0 = all required checks pass; 1 = at least one hard failure.
# Checks the live stack cannot satisfy yet (pre-U7 deploy) are reported as
# GAP and do not fail the run — they become PASS requirements after deploy.

set -u
CDIR="${1:-/home/hermes/projects/acp-ui}"
STATE_DIR_IN_CONTAINER="/home/hermes/.hermes/acp-ui-state"
TOKEN_FILE="${STATE_DIR_IN_CONTAINER}/execution/internal-token"
WS_ROOT="/home/hermes/projects/.acp-workspaces"
REPO_UNDER_TEST="/home/hermes/projects/acp-ui"
RUNNER_UID_EXPECTED="1001"
RUNNER_GID_EXPECTED="1001"

PASS=0; FAIL=0; GAP=0
ok()  { PASS=$((PASS+1)); echo "PASS  $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $*"; }
gap() { GAP=$((GAP+1)); echo "GAP   $*  (expected until U7 deploy)"; }

dc() { docker compose --project-directory "$CDIR" -f "$CDIR/compose.yaml" "$@"; }
xstate() { dc exec -T state sh -c "$1"; }
# Ephemeral runner-namespace shell: uid 1001 + runner mounts, no deps started.
xrun()   { dc run --rm --no-deps --entrypoint sh runner -c "$1" 2>/dev/null; }

echo "== compose dir: $CDIR"
dc ps --format 'table {{.Name}}\t{{.State}}\t{{.Status}}' 2>/dev/null | sed 's/^/   /'

# --- 1. actual identities — reported, not assumed -----------------------------
# A running container may predate the current spec's `user:` — the RUNNING
# uid and the SPEC uid are recorded separately; they are different objects.
state_uid=$(xstate 'id -u' 2>/dev/null | tr -d '[:space:]')
echo "info  running state container uid=$state_uid (live identity, whatever it is)"
runner_live_uid=$(dc exec -T runner id -u 2>/dev/null | tr -d '[:space:]')
echo "info  running runner container uid=${runner_live_uid:-unavailable} (container start-time identity)"
runner_spec_uid=$(xrun 'id -u' | tr -d '[:space:]')
echo "info  oneoff runner (current spec) uid=${runner_spec_uid:-unavailable}"
[ -n "$runner_spec_uid" ] && [ "$runner_spec_uid" != "0" ] \
  && ok "oneoff runner spec uid=$runner_spec_uid (non-root)" \
  || echo "note  oneoff runner spec uid='${runner_spec_uid:-?}' — record actual before deploy"
if xstate 'command -v git' >/dev/null 2>&1; then
  ok "git present in state image"
else
  gap "git MISSING in state image — Dockerfile.node installs it; rebuild required"
fi

# --- 2. git ownership: uid1001 repo read by root state -----------------------
# Expected: bare git fails 'dubious ownership'; per-command scoped
# -c safe.directory=<validated realpath> succeeds. Never a global wildcard.
toplevel=$(xstate "git -c safe.directory=$REPO_UNDER_TEST -C $REPO_UNDER_TEST rev-parse --show-toplevel" 2>/dev/null)
if [ -n "$toplevel" ]; then
  ok "root state reads uid1001 repo via scoped safe.directory ($toplevel)"
else
  if xstate 'command -v git' >/dev/null 2>&1; then
    bad "scoped safe.directory read of $REPO_UNDER_TEST failed as root"
  else
    gap "scoped safe.directory read untestable — no git in state image yet"
  fi
fi
bare=$(xstate "git -C $REPO_UNDER_TEST rev-parse --show-toplevel" 2>&1)
if echo "$bare" | grep -q 'dubious ownership'; then
  ok "bare git read refused (dubious ownership) — scoped flag is load-bearing"
elif [ "${bare#/}" != "$bare" ] && [ -d "$bare" ]; then
  echo "note  bare git read succeeded ($bare) — same-uid state or trusted repo; scoped flag not load-bearing here"
elif [ -n "$bare" ] && ! echo "$bare" | grep -q 'not found'; then
  echo "note  bare git read returned: $bare"
fi

# --- 3. internal token: state-side provisioning + runner readability ---------
tspec=$(xstate "stat -c '%u:%g:%a' $TOKEN_FILE" 2>/dev/null)
case "$tspec" in
  "${RUNNER_UID_EXPECTED}:${RUNNER_GID_EXPECTED}:600")
    ok "token file owned ${tspec%%:*}:${tspec#*:}" ;;
  "")  gap "token file absent — state image has no U3 provisioning yet" ;;
  *)   bad "token file ownership/mode is '$tspec' (want ${RUNNER_UID_EXPECTED}:${RUNNER_GID_EXPECTED}:600)" ;;
esac
if [ -n "$tspec" ]; then
  if xrun "test -r $TOKEN_FILE && head -c 0 $TOKEN_FILE >/dev/null"; then
    ok "runner uid1001 can READ the token (contents never printed)"
  else
    bad "runner uid1001 CANNOT read $TOKEN_FILE — ownership/traversal broken"
  fi
fi

# --- 4. workspace root: identical absolute path, uid1001 writable ------------
sstat=$(xstate "ls -ld $WS_ROOT" 2>/dev/null)
if [ -n "$sstat" ]; then ok "workspace root visible to state: $sstat"
else gap "workspace root $WS_ROOT absent in state namespace (created on first managed run)"
fi
rid="${runner_spec_uid:-$(xrun 'id -u' | tr -d '[:space:]')}"
if xrun "ls -d $WS_ROOT >/dev/null 2>&1"; then
  ok "workspace root visible to runner at identical absolute path"
  probe="$WS_ROOT/.u3-preflight-probe.$$"
  if xrun "mkdir '$probe' && touch '$probe/w' && rm -rf '$probe'"; then
    ok "runner oneoff (uid=$rid) can CREATE/WRITE/DELETE under workspace root"
  else
    bad "runner oneoff (uid=$rid) cannot write under $WS_ROOT — provisioning broken"
  fi
else
  gap "workspace root not visible to runner yet — will be provisioned on first managed run"
fi

# --- 5. config intent (only meaningful on the prepared spec) ------------------
if [ "$CDIR" != "/home/hermes/projects/acp-ui" ]; then
  envs=$(dc config 2>/dev/null)
  echo "$envs" | grep -q "ACP_WORKSPACE_DIR: /home/hermes/projects/.acp-workspaces" \
    && ok "prepared spec: ACP_WORKSPACE_DIR set" \
    || bad "prepared spec missing ACP_WORKSPACE_DIR"
  echo "$envs" | grep -q "ACP_EXEC_TOKEN_UID: \"1001\"\|ACP_EXEC_TOKEN_UID: '1001'\|ACP_EXEC_TOKEN_UID: 1001" \
    && ok "prepared spec: ACP_EXEC_TOKEN_UID=1001" \
    || bad "prepared spec missing ACP_EXEC_TOKEN_UID=1001"
fi

echo "== $PASS pass / $FAIL fail / $GAP expected-gap"
[ "$FAIL" -eq 0 ]
