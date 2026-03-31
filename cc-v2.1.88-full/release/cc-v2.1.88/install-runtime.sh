#!/usr/bin/env bash
set -euo pipefail
if command -v bun >/dev/null 2>&1; then
  bun install --production
else
  npm install --omit=dev
fi
