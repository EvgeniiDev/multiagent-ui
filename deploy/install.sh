#!/usr/bin/env bash
# Install the LAN deployment: web server plus the mode-aware supervisor for
# the five ACP bridges (Docker by default; host only by explicit selection).
#
#   ./deploy/install.sh [--web-dir /path/to/dist-web]
#
# Prerequisites:
#   * Node.js + npm (global npm prefix must provide the `ws` package:
#       npm install -g ws)
#   * agent CLIs on PATH: hermes, opencode, devin, pi (+ `pi-acp` adapter)
#   * `npm run build:web` already run in the repo root (produces dist-web/)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$REPO_DIR" != "$HOME/projects/acp-ui" ]]; then
  echo "error: install only from canonical checkout $HOME/projects/acp-ui (found $REPO_DIR)" >&2
  exit 1
fi
BRIDGE_SRC="$REPO_DIR/deploy/acp-ws-bridge.mjs"
BRIDGE_OWNER_SRC="$REPO_DIR/deploy/bridge-process-owner.mjs"
BRIDGE_STATUS_SRC="$REPO_DIR/deploy/bridge-session-statuses.mjs"
BRIDGE_MODE_SRC="$REPO_DIR/deploy/bridge-mode.mjs"
BRIDGE_LOCK_LAUNCHER_SRC="$REPO_DIR/deploy/acp-bridge-launcher.sh"
BRIDGE_DST="$HOME/.hermes/acp-ws-bridge.mjs"
BRIDGE_OWNER_DST="$HOME/.hermes/bridge-process-owner.mjs"
BRIDGE_STATUS_DST="$HOME/.hermes/bridge-session-statuses.mjs"
BRIDGE_MODE_DST="$HOME/.hermes/bridge-mode.mjs"
UNIT_SRC="$REPO_DIR/deploy/systemd"
UNIT_DST="$HOME/.config/systemd/user"
WEB_DIR="$REPO_DIR/dist-web"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --web-dir) WEB_DIR="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -d "$WEB_DIR" ]]; then
  echo "error: web bundle not found at $WEB_DIR — run 'npm run build:web' first" >&2
  exit 1
fi

if ! node -e "require.resolve('ws')" 2>/dev/null; then
  echo "error: the 'ws' package is not resolvable — run 'npm install -g ws'" >&2
  exit 1
fi
if [[ ! -x "$BRIDGE_LOCK_LAUNCHER_SRC" ]]; then
  echo "error: bridge lock launcher must exist and be executable: $BRIDGE_LOCK_LAUNCHER_SRC" >&2
  exit 1
fi

# Refuse to touch anything while a retired acp-bridge-*.service unit is still
# active OR enabled: an old per-bridge unit could race the new supervisor for
# bridge ports and agent sessions. Fail closed on probe errors too: a failed
# systemctl query is an unknown inventory state, never evidence of absence.
# Recover manually.
retired_active=()
guard_failed=0
for name in hermes opencode devin pi codex; do
  unit="acp-bridge-$name.service"
  load_state=""
  if ! load_state=$(systemctl --user show --property=LoadState --value "$unit" 2>/dev/null); then
    echo "error: cannot probe retired unit $unit (systemctl query failed); refusing to install on unknown inventory" >&2
    guard_failed=1
    continue
  fi
  case "$load_state" in
    not-found) continue ;;
    loaded|masked) ;;
    *)
      echo "error: ambiguous LoadState for retired unit $unit: '${load_state:-<empty>}'" >&2
      guard_failed=1
      continue
      ;;
  esac
  active_state=""
  if active_state=$(systemctl --user is-active "$unit" 2>/dev/null); then
    if [[ "$active_state" == "active" ]]; then
      retired_active+=("$unit (active: $active_state)")
      continue
    fi
    echo "error: ambiguous active state of retired unit $unit: '${active_state:-<empty>}'" >&2
    guard_failed=1
    continue
  else
    active_rc=$?
    # `is-active` returns 3 only for a known inactive unit. Unknown, empty,
    # and every other nonzero response mean inventory is not trustworthy.
    if [[ "$active_rc" -ne 3 || "$active_state" != "inactive" ]]; then
      echo "error: cannot determine active state of retired unit $unit (status=$active_rc, got '${active_state:-<empty>}'); refusing to install" >&2
      guard_failed=1
      continue
    fi
  fi
  enabled_state=""
  if enabled_state=$(systemctl --user is-enabled "$unit" 2>/dev/null); then
    if [[ "$enabled_state" == "disabled" ]]; then
      echo "error: ambiguous enablement status for retired unit $unit: disabled returned success" >&2
      guard_failed=1
    else
      retired_active+=("$unit (enabled: $enabled_state)")
    fi
    continue
  else
    enabled_rc=$?
    # `is-enabled` returns 1 for the precise disabled state. Treat all other
    # output/status combinations as enabled or indeterminate; never infer safety.
    if [[ "$enabled_rc" -eq 1 && "$enabled_state" == "disabled" ]]; then
      continue
    fi
    echo "error: cannot determine enablement of retired unit $unit (status=$enabled_rc, got '${enabled_state:-<empty>}'); refusing to install" >&2
    guard_failed=1
  fi
done
if [[ "$guard_failed" -ne 0 ]]; then
  echo "refusing to install before manual recovery: inspect each retired unit with" >&2
  echo "  systemctl --user status <unit>; systemctl --user is-enabled <unit>" >&2
  echo "then re-run $0" >&2
  exit 1
fi
if [[ ${#retired_active[@]} -gt 0 ]]; then
  echo "error: retired bridge unit(s) still present: ${retired_active[*]}" >&2
  echo "refusing to install before manual recovery: stop and disable each retired unit, verify with" >&2
  echo "  systemctl --user stop <unit> && systemctl --user disable <unit>" >&2
  echo "  systemctl --user is-active <unit>; systemctl --user is-enabled <unit>" >&2
  echo "then re-run $0" >&2
  exit 1
fi

mkdir -p "$HOME/.hermes" "$UNIT_DST"
install -m 0755 "$BRIDGE_SRC" "$BRIDGE_DST"
install -m 0644 "$BRIDGE_OWNER_SRC" "$BRIDGE_OWNER_DST"
install -m 0644 "$BRIDGE_STATUS_SRC" "$BRIDGE_STATUS_DST"
install -m 0644 "$BRIDGE_MODE_SRC" "$BRIDGE_MODE_DST"
echo "installed bridge -> $BRIDGE_DST"
echo "installed process owner -> $BRIDGE_OWNER_DST"
echo "installed mode guard -> $BRIDGE_MODE_DST"

# OpenCode token-meter plugin: exact usage figures land in the panel ledger
# via `session.idle`. Global plugin dir — opencode auto-loads it at startup.
PLUGIN_SRC="$REPO_DIR/deploy/opencode/plugins/acp-token-meter.js"
PLUGIN_DST_DIR="$HOME/.config/opencode/plugins"
if [[ -f "$PLUGIN_SRC" ]]; then
  mkdir -p "$PLUGIN_DST_DIR"
  install -m 0644 "$PLUGIN_SRC" "$PLUGIN_DST_DIR/acp-token-meter.js"
  echo "installed plugin  -> $PLUGIN_DST_DIR/acp-token-meter.js"
fi

for name in acp-ui-web.service acp-ui-bridges.service 'acp-ui-bridge-host@.service'; do
  unit="$UNIT_SRC/$name"
  install -m 0644 "$unit" "$UNIT_DST/$name"
  echo "installed unit  -> $UNIT_DST/$name"
done

# The shared mode file is the sole selector. Fresh installations stay Docker-first.
MODE_DIR="$HOME/.config/acp-ui-bridge-state"
install -d -m 0700 "$MODE_DIR"
LOCK_DIR="$MODE_DIR/locks"
if [[ -L "$LOCK_DIR" ]]; then
  echo "error: bridge lock directory must not be a symlink: $LOCK_DIR" >&2
  exit 1
fi
install -d -m 2770 "$LOCK_DIR"
if [[ "$(stat -c '%u:%g' "$LOCK_DIR")" != "$(id -u):$(id -g)" ]]; then
  echo "error: bridge lock directory must be owned by $(id -u):$(id -g): $LOCK_DIR" >&2
  exit 1
fi
for bridge in hermes opencode devin pi codex; do
  lock="$LOCK_DIR/$bridge.lock"
  if [[ -L "$lock" || ( -e "$lock" && ! -f "$lock" ) ]]; then
    echo "error: bridge lock must be a regular non-symlink file: $lock" >&2
    exit 1
  fi
  if [[ ! -e "$lock" ]]; then
    (umask 0007; set -o noclobber; : > "$lock") || {
      echo "error: unable to create bridge lock file: $lock" >&2
      exit 1
    }
  fi
  if [[ "$(stat -c '%u:%g' "$lock")" != "$(id -u):$(id -g)" ]]; then
    echo "error: bridge lock file must be owned by $(id -u):$(id -g): $lock" >&2
    exit 1
  fi
  if [[ "$(stat -c '%h' "$lock")" != 1 ]]; then
    echo "error: bridge lock file must not have hard links: $lock" >&2
    exit 1
  fi
  chmod 0660 "$lock"
done
if [[ ! -e "$MODE_DIR/selected" ]]; then
  printf 'docker\n' > "$MODE_DIR/selected"
  chmod 0600 "$MODE_DIR/selected"
  echo "initialized bridge mode -> docker"
fi
case "$(tr -d '\r\n' < "$MODE_DIR/selected")" in
  docker|host) ;;
  *) echo "error: invalid bridge mode in $MODE_DIR/selected; edit it explicitly" >&2; exit 1 ;;
esac

# The web unit ships with a source-checkout path; make sure it points at the
# directory actually passed in. Bridge units remain tied to the canonical checkout.
if [[ "$WEB_DIR" != "$HOME/projects/acp-ui/dist-web" ]]; then
  sed -i "s|WorkingDirectory=.*|WorkingDirectory=$WEB_DIR|" "$UNIT_DST/acp-ui-web.service"
fi

systemctl --user daemon-reload
# Do not re-enable retired acp-bridge-*.service units: the supervisor starts
# exactly the selected five-bridge mode and never falls back.
systemctl --user enable --now acp-ui-web.service acp-ui-bridges.service

echo
echo "Active units:"
systemctl --user is-active acp-ui-web.service acp-ui-bridges.service | paste -sd' '
echo "Bridge mode: $(tr -d '\r\n' < "$MODE_DIR/selected")"
echo "Web UI: https://$(hostname -I | awk '{print $1}'):25809"
