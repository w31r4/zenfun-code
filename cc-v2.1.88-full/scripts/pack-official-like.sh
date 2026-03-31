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

# Bundle minimal runtime externals so artifact can run without install.
# Current build keeps zod external for correctness.
if [[ "$MODE" == "vendor" ]]; then
  rm -rf "$OUT_DIR/node_modules"
  mkdir -p "$OUT_DIR/node_modules"
  rm -rf "$OUT_DIR/node_modules/zod"
  cp -R "$ROOT_DIR/node_modules/zod" "$OUT_DIR/node_modules/zod"
  rm -rf "$OUT_DIR/node_modules/@anthropic-ai/sandbox-runtime"
  mkdir -p "$OUT_DIR/node_modules/@anthropic-ai"
  cp -R "$ROOT_DIR/node_modules/@anthropic-ai/sandbox-runtime" "$OUT_DIR/node_modules/@anthropic-ai/sandbox-runtime"

  copy_if_exists() {
    local src="$1"
    local dest="$2"
    if [[ -e "$src" ]]; then
      mkdir -p "$(dirname "$dest")"
      rm -rf "$dest"
      cp -R "$src" "$dest"
      echo "  bundled: ${dest#$OUT_DIR/}"
    fi
  }

  echo "Bundling runtime external packages..."

  # Optional/runtime externals used by current build config.
  copy_if_exists "$ROOT_DIR/node_modules/tree-sitter" "$OUT_DIR/node_modules/tree-sitter"
  copy_if_exists "$ROOT_DIR/node_modules/tree-sitter-bash" "$OUT_DIR/node_modules/tree-sitter-bash"
  copy_if_exists "$ROOT_DIR/node_modules/fsevents" "$OUT_DIR/node_modules/fsevents"

  # Native tokenizer variants (if installed).
  if [[ -d "$ROOT_DIR/node_modules/@anthropic-ai" ]]; then
    shopt -s nullglob
    for pkg in "$ROOT_DIR"/node_modules/@anthropic-ai/tokenizer-*; do
      copy_if_exists "$pkg" "$OUT_DIR/node_modules/@anthropic-ai/$(basename "$pkg")"
    done
    shopt -u nullglob
  fi

  # Native sharp/runtime variants (if installed).
  if [[ -d "$ROOT_DIR/node_modules/@img" ]]; then
    shopt -s nullglob
    pkg_candidates=( "$ROOT_DIR"/node_modules/@img/sharp-* "$ROOT_DIR"/node_modules/@img/sharp-libvips-* )
    shopt -u nullglob
    for pkg in $(printf '%s\n' "${pkg_candidates[@]}" | sort -u); do
      copy_if_exists "$pkg" "$OUT_DIR/node_modules/@img/$(basename "$pkg")"
    done
  fi
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
    "claude": "cli.js"
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
    "@anthropic-ai/sandbox-runtime": "^0.0.44"
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
