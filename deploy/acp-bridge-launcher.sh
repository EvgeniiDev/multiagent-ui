#!/bin/sh
set -eu

usage() {
  printf '%s\n' 'usage: acp-bridge-launcher.sh <hermes|opencode|devin|pi|codex> <command> [args...]' >&2
  exit 64
}

[ "$#" -ge 2 ] || usage
bridge=$1
shift
case "$bridge" in
  hermes|opencode|devin|pi|codex) ;;
  *) usage ;;
esac

lock_dir=${ACP_BRIDGE_LOCK_DIR:-${HOME:-}/.config/acp-ui-bridge-state/locks}
case "$lock_dir" in
  /*) ;;
  *) printf 'refusing relative bridge lock directory: %s\n' "$lock_dir" >&2; exit 78 ;;
esac
lock_file="$lock_dir/$bridge.lock"
if [ ! -d "$lock_dir" ] || [ -L "$lock_dir" ]; then
  printf 'bridge lock directory missing or unsafe: %s\n' "$lock_dir" >&2
  exit 78
fi
resolved_lock_dir=$(/usr/bin/realpath -e -- "$lock_dir" 2>/dev/null) || {
  printf 'cannot resolve bridge lock directory: %s\n' "$lock_dir" >&2
  exit 78
}
if [ "$resolved_lock_dir" != "$lock_dir" ]; then
  printf 'bridge lock directory path contains symlinks or aliases: %s\n' "$lock_dir" >&2
  exit 78
fi
if [ ! -f "$lock_file" ] || [ -L "$lock_file" ]; then
  printf 'bridge lock file missing or unsafe: %s\n' "$lock_file" >&2
  exit 78
fi
lock_links=$(/usr/bin/stat -c '%h' -- "$lock_file" 2>/dev/null) || {
  printf 'cannot inspect bridge lock file: %s\n' "$lock_file" >&2
  exit 78
}
if [ "$lock_links" != 1 ]; then
  printf 'bridge lock file must have exactly one hard link: %s\n' "$lock_file" >&2
  exit 78
fi
if [ ! -x /usr/bin/flock ]; then
  printf '%s\n' 'required util-linux flock executable is missing' >&2
  exit 78
fi

# A shared kernel lease is retained by the bridge process for its whole life.
# The stable pre-provisioned lock inode must never be removed or replaced.
umask 0007
exec /usr/bin/flock --no-fork --nonblock --conflict-exit-code 78 "$lock_file" "$@"
