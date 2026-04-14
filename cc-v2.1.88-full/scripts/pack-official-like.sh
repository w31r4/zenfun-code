#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/release/cc-v2.1.88"
MODE="remote"

for arg in "$@"; do
  case "$arg" in
    --vendor-runtime)
      MODE="vendor"
      ;;
    --remote-runtime)
      MODE="remote"
      ;;
    *)
      if [[ "$arg" == -* ]]; then
        echo "Unknown option: $arg" >&2
        echo "Usage: $0 [output-dir] [--remote-runtime|--vendor-runtime]" >&2
        exit 1
      fi
      OUT_DIR="$arg"
      ;;
  esac
done

if [[ ! -f "$ROOT_DIR/dist/cli.js" ]]; then
  echo "dist/cli.js not found. Run: bun run build.ts" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cp "$ROOT_DIR/dist/cli.js" "$OUT_DIR/cli.js"
if [[ -f "$ROOT_DIR/dist/cli.js.map" ]]; then
  cp "$ROOT_DIR/dist/cli.js.map" "$OUT_DIR/cli.js.map"
fi
mkdir -p "$OUT_DIR/bin"

# Bundle runtime externals so artifact can run without install.
if [[ "$MODE" == "vendor" ]]; then
  rm -rf "$OUT_DIR/node_modules"
  cp -R "$ROOT_DIR/node_modules" "$OUT_DIR/node_modules"
  echo "Bundled full node_modules runtime"
else
  rm -rf "$OUT_DIR/node_modules"
fi

UPSTREAM_DIR="$ROOT_DIR/../cc-v2.1.88"
if [[ -f "$UPSTREAM_DIR/README.md" ]]; then
  cp "$UPSTREAM_DIR/README.md" "$OUT_DIR/README.md"
fi
if [[ -f "$UPSTREAM_DIR/LICENSE.md" ]]; then
  cp "$UPSTREAM_DIR/LICENSE.md" "$OUT_DIR/LICENSE.md"
fi

cat > "$OUT_DIR/package.json" <<'JSON'
{
  "name": "@anthropic-ai/claude-code",
  "version": "2.1.88-dev-rebuild",
  "bin": {
    "claude": "bin/claude"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "type": "module",
  "author": "Anthropic <support@anthropic.com>",
  "license": "SEE LICENSE IN README.md",
  "description": "Rebuilt Claude Code package from local recovered source.",
  "dependencies": {
    "zod": "^4.3.6",
    "@anthropic-ai/sandbox-runtime": "^0.0.44",
    "@anthropic-ai/mcpb": "^2.1.2",
    "@growthbook/growthbook": "^1.6.5",
    "@aws-sdk/credential-providers": "^3.1020.0",
    "cacache": "^20.0.4",
    "cli-highlight": "^2.1.11",
    "image-processor-napi": "^0.0.1"
  },
  "optionalDependencies": {
    "@img/sharp-darwin-arm64": "^0.34.5",
    "@img/sharp-darwin-x64": "^0.34.5",
    "@img/sharp-linux-arm": "^0.34.5",
    "@img/sharp-linux-arm64": "^0.34.5",
    "@img/sharp-linux-x64": "^0.34.5",
    "@img/sharp-linuxmusl-arm64": "^0.34.5",
    "@img/sharp-linuxmusl-x64": "^0.34.5",
    "@img/sharp-win32-arm64": "^0.34.5",
    "@img/sharp-win32-x64": "^0.34.5"
  }
}
JSON

cat > "$OUT_DIR/bin/claude" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  LINK_TARGET="$(readlink "$SCRIPT_PATH")"
  if [[ "$LINK_TARGET" == /* ]]; then
    SCRIPT_PATH="$LINK_TARGET"
  else
    SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
    SCRIPT_PATH="$SCRIPT_DIR/$LINK_TARGET"
  fi
done

ROOT_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
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

exec node --localstorage-file="$CACHE_DIR/localstorage.json" "$ROOT_DIR/cli.js" "$@"
SH
chmod +x "$OUT_DIR/bin/claude"

cat > "$OUT_DIR/install-runtime.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if command -v bun >/dev/null 2>&1; then
  bun install --production
else
  npm install --omit=dev
fi
SH
chmod +x "$OUT_DIR/install-runtime.sh"

echo "Packed official-like artifact at: $OUT_DIR"
echo "Run test:"
if [[ "$MODE" == "vendor" ]]; then
  echo "  cd \"$OUT_DIR\" && node cli.js --version"
else
  echo "  cd \"$OUT_DIR\" && bun install --production && node cli.js --version"
fi
