#!/usr/bin/env bash
# acp-researcher-wakeup ExecStart — reference wrapper (not enabled).
#
# Two halves in one oneshot:
#   1. collect.py — deterministic harvest (Reddit RSS + tg-read), no model,
#      writes .acp/research/runs/<ts>/{items.jsonl,digest.md};
#   2. when the harvest found NEW items, the generic role-spawn runner
#      (server/acp-pm-wakeup.mjs) starts ONE researcher session with a brief
#      naming the fresh digest. No new items -> exit 0, zero model calls.
#
# Env knobs: ACP_REPO (repo root), PM_SCOPE (project label = config suffix),
# RESEARCH_PY (python), PM_ROLE_ID (default researcher).
set -euo pipefail

REPO="${ACP_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
PY="${RESEARCH_PY:-$HOME/.hermes/tools-venv/bin/python}"
SCOPE="${PM_SCOPE:-acp-ui}"
cd "$REPO"

n=$("$PY" scripts/research/collect.py \
      --config "scripts/research/sources.${SCOPE}.json" \
      --print-new-count 2>/dev/null | tail -1)
n="${n:-0}"
if ! [[ "$n" =~ ^[0-9]+$ ]] || [ "$n" -le 0 ]; then
  echo '{"skipped":"no-new-items"}'
  exit 0
fi

# Newest run dir = the digest the researcher should read.
RUN_DIR=$(ls -td .acp/research/runs/*/ 2>/dev/null | head -1)
export PM_DIGEST_PATH="${RUN_DIR%/}"
export PM_ROLE_ID="${PM_ROLE_ID:-researcher}"
export PM_KIND=researcher
export PM_WAKEUP_DIR="${PM_WAKEUP_DIR:-$REPO/.acp/research/wakeup}"
export PM_WAKEUP_DOC="${PM_WAKEUP_DOC:-researcher-wakeup.json}"
export PM_SESSION_PREFIX=reswake
export PM_REPORT_NAME=research-report.md
export PM_BRIEF_FILE="${PM_BRIEF_FILE:-$REPO/docs/researcher-brief-template.md}"
export PM_SCOPE="$SCOPE"

echo "{\"collect\":\"$n new items\",\"digest\":\"$PM_DIGEST_PATH\"}"
exec node "$REPO/server/acp-pm-wakeup.mjs" --force
