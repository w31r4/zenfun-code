# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

This repository contains decompiled/extracted source of Claude Code v2.1.88 in three forms:

- **cc-v2.1.88-src/** — Flat directory of ~1,627 JS files extracted (likely from source maps). These are individual module files with no directory structure.
- **cc-v2.1.88-build/** — Rebuildable TypeScript project with proper directory structure, `package.json`, `tsconfig.json`, and a custom `build.ts`. This is the primary working directory.
- **cc-v2.1.88-full/** — Full extracted package including `node_modules/`, `vendor/` (ripgrep binaries, native addons), and structured `src/`.

## Build Commands

```bash
# Install dependencies (from cc-v2.1.88-build/)
cd cc-v2.1.88-build && bun install

# Build the bundle (produces dist/cli.js)
cd cc-v2.1.88-build && bun run build

# Run the built CLI
cd cc-v2.1.88-build && node dist/cli.js
```

## Build System

The build (`cc-v2.1.88-build/build.ts`) uses Bun's bundler with a custom plugin that:

1. **Shims `bun:bundle`** — The original uses Bun's compile-time `feature()` macro. The shim (`shims/bun-bundle.ts`) evaluates feature flags at runtime. Enabled features are listed in the `ENABLED_FEATURES` set.
2. **Stubs missing packages** — Internal Anthropic packages (`@ant/*`, `@anthropic-ai/mcpb`, etc.) and optional deps are auto-stubbed with no-op exports. The stub generator scans all imports to produce matching named exports.
3. **Stubs missing relative imports** — Source files that reference modules not recovered from the source map get stub replacements.
4. **Build-time macros** — `MACRO.VERSION`, `MACRO.BUILD_TIME`, etc. are defined in the `MACROS` object and injected via `define`.
5. **Post-build patching** — Fixes undefined `defaultN` symbols (lodash-es memoize, getStreamAsBuffer, isEqual) and injects zod v4 `util` namespace when the bundler drops it.

Entry point: `src/entrypoints/cli.tsx` → bundles to `dist/cli.js`.

## Architecture (cc-v2.1.88-build/src/)

The source is TypeScript + React (Ink for terminal UI). Key layers:

- **entrypoints/** — CLI entry (`cli.tsx`), SDK entry. `main.tsx` bootstraps auth, settings, telemetry, and launches the REPL.
- **tools/** — Each tool (Bash, FileEdit, FileRead, FileWrite, Glob, Grep, Agent, etc.) is a directory with its own implementation. `Tool.ts` defines the base tool interface. `tools.ts` registers all tools.
- **commands/** — Slash commands (`/help`, `/config`, `/compact`, `/model`, `/vim`, etc.), each in its own directory.
- **services/** — Business logic: API calls (`api/`), MCP server management (`mcp/`), LSP (`lsp/`), OAuth (`oauth/`), compaction (`compact/`), memory extraction, plugin loading, analytics/growthbook.
- **components/** — React/Ink UI components: permission dialogs, diff views, message rendering, prompt input, settings screens.
- **ink/** — Forked/customized Ink terminal renderer with custom layout engine (yoga-layout), rendering pipeline, and keypress handling.
- **hooks/** — React hooks for tool permissions, notifications.
- **state/** — Application state management.
- **context/** — React context providers.
- **utils/** — Utilities organized by domain: git, github, bash, permissions, settings, sandbox, model selection, telemetry, MCP, memory, shell, etc.
- **tasks/** — Background task types: RemoteAgent, LocalAgent, LocalShell, DreamTask, InProcessTeammate.
- **skills/** — Bundled skill definitions.
- **plugins/** — Bundled plugin system.
- **schemas/** — JSON schemas for settings validation.
- **coordinator/** — Multi-agent coordination logic.

## Key Patterns

- Feature flags via `feature('FLAG_NAME')` from `bun:bundle` — controls which code paths are active.
- Tools follow a consistent directory-per-tool pattern under `src/tools/`.
- The UI is React-based using a customized Ink renderer (`src/ink/`), not the standard Ink package.
- MCP (Model Context Protocol) is a first-class integration (`services/mcp/`, `tools/MCPTool/`).
- Zod v4 is used for schema validation but is kept external during bundling due to complex re-export chains.
