# Repository Guidelines

## Project Structure & Module Organization
`cc-v2.1.88-full/` is the main working tree. Its `src/` folder contains the rebuilt CLI, `scripts/` holds local run and packaging helpers, `shims/` provides build-time replacements such as `bun:bundle`, and `release/` contains packaged output. `cc-v2.1.88/` is a reference snapshot; avoid editing it unless you are syncing upstream artifacts. `sandbox-runtime/` is a separate TypeScript package with its own `src/`, `test/`, ESLint, and Prettier config. Use `docs/` for design notes.

## Build, Test, and Development Commands
Run commands from the repo root unless noted otherwise.

- `bun run setup` installs dependencies in `cc-v2.1.88-full/`.
- `bun run build` bundles the CLI into `cc-v2.1.88-full/dist/cli.js`.
- `bun run start` launches the local wrapper script for interactive testing.
- `bun run claude -- --help` forwards arguments to the local launcher.
- `bun run parity` rebuilds with `CC_STRICT_PARITY=1` to check upstream-compat behavior.
- `bun run pack` or `bun run pack:vendor` creates release bundles under `cc-v2.1.88-full/release/cc-v2.1.88`.
- `cd sandbox-runtime && bun test` runs the sandbox test suite.
- `cd sandbox-runtime && bun run lint:check && bun run typecheck` validates style and types for the runtime package.

## Coding Style & Naming Conventions
Use ESM TypeScript/TSX, 2-space indentation, single quotes, and no semicolons unless surrounding code requires them. Match existing naming: command folders are kebab-case (`src/commands/remote-setup/`), shared modules are usually camelCase (`startupProfiler.ts`), and Ink entrypoints/components use `.tsx`. Keep fast-path imports dynamic in CLI entrypoints and avoid broad refactors in extracted code.

## Testing Guidelines
For `cc-v2.1.88-full`, verify each change with at least one build and one CLI smoke test, for example `bun run build`, `bash scripts/run-claude-local.sh --version`, or `node dist/cli.js --help`. In `sandbox-runtime`, add or update `*.test.ts` files near the affected area and run `bun test`. Call out any gaps when a change only has smoke coverage.

## Commit & Pull Request Guidelines
Recent commits use short imperative summaries such as `update readme` and `update dependency`. Keep that style, but make messages more specific when possible, for example `fix local launcher env handling`. PRs should describe the touched area, list verification commands, mention feature-flag or packaging impact, and include terminal output or screenshots when behavior changes are user-visible.

## Security & Configuration Tips
Do not commit tokens, local auth state, or machine-specific overrides. Keep experimental env vars in your shell or ignored files, and avoid checking in generated `dist/` or release artifacts unless the change is about packaging.
