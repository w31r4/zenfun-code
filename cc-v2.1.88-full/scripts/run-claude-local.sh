#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/node"
mkdir -p "$CACHE_DIR"

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
