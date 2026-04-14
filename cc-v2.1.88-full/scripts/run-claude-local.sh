#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/node"
mkdir -p "$CACHE_DIR"

# Keep runtime gate behavior aligned with the public CLI by default.
# Callers can still opt in explicitly with CLAUDE_CODE_ENABLE_ALL_GATES=1.
if [[ -z "${CLAUDE_CODE_GB_OVERRIDES:-}" ]]; then
  export CLAUDE_CODE_GB_OVERRIDES='{"tengu_auto_mode_config":{"enabled":"enabled","disableFastMode":false,"allowModels":["sonnet","opus","claude-sonnet-4-5","claude-sonnet-4-6","claude-opus-4-1","claude-opus-4-5","claude-opus-4-6"]}}'
fi

# Remove potentially broken localstorage flags inherited from NODE_OPTIONS.
if [[ -n "${NODE_OPTIONS:-}" ]]; then
  CLEANED_NODE_OPTIONS="$(echo "$NODE_OPTIONS" \
    | sed -E 's/(^|[[:space:]])--localstorage-file(=[^[:space:]]+)?//g; s/[[:space:]]+/ /g; s/^ //; s/ $//')"
  if [[ -n "$CLEANED_NODE_OPTIONS" ]]; then
    export NODE_OPTIONS="$CLEANED_NODE_OPTIONS"
  else
    unset NODE_OPTIONS
  fi
fi

exec node --localstorage-file="$CACHE_DIR/localstorage.json" dist/cli.js "$@"
