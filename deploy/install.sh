#!/usr/bin/env bash
# Install the LAN deployment: filesystem-aware ACP bridges + the web bundle
# server, all as systemd *user* units (no root required).
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
BRIDGE_SRC="$REPO_DIR/deploy/acp-ws-bridge.mjs"
BRIDGE_DST="$HOME/.hermes/acp-ws-bridge.mjs"
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

mkdir -p "$HOME/.hermes" "$UNIT_DST"
install -m 0755 "$BRIDGE_SRC" "$BRIDGE_DST"
echo "installed bridge -> $BRIDGE_DST"

for unit in "$UNIT_SRC"/*.service; do
  name="$(basename "$unit")"
  sed "s|%h/projects/acp-ui/dist-web|$WEB_DIR|" "$unit" > "$UNIT_DST/$name"
  echo "installed unit  -> $UNIT_DST/$name"
done

# The web unit ships with a source-checkout path; make sure it points at the
# directory actually passed in.
if [[ "$WEB_DIR" != "$HOME/projects/acp-ui/dist-web" ]]; then
  sed -i "s|WorkingDirectory=.*|WorkingDirectory=$WEB_DIR|" "$UNIT_DST/acp-ui-web.service"
fi

systemctl --user daemon-reload
systemctl --user enable --now acp-ui-web.service \
  acp-bridge-hermes.service acp-bridge-opencode.service \
  acp-bridge-devin.service acp-bridge-pi.service

echo
echo "Active units:"
systemctl --user is-active acp-ui-web.service \
  acp-bridge-hermes.service acp-bridge-opencode.service \
  acp-bridge-devin.service acp-bridge-pi.service | paste -sd' '
echo "Web UI: http://$(hostname -I | awk '{print $1}'):25808"
