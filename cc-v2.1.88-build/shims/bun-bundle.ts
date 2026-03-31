/**
 * Shim for bun:bundle's feature() macro.
 * In the real build, feature() is evaluated at compile time by bun's bundler.
 * Here we evaluate at runtime — all external-build features default to false.
 */

const ENABLED_FEATURES = new Set([
  'BUILTIN_EXPLORE_PLAN_AGENTS',
  'DUMP_SYSTEM_PROMPT',
  'TRANSCRIPT_CLASSIFIER',
  'COMPACTION_REMINDERS',
  'PROMPT_CACHE_BREAK_DETECTION',
  'EXTRACT_MEMORIES',
  'TREE_SITTER_BASH',
  'BRIDGE_MODE',
  'COMMIT_ATTRIBUTION',
  'SLOW_OPERATION_LOGGING',
  'HISTORY_PICKER',
  'HISTORY_SNIP',
  'HOOK_PROMPTS',
  'CONNECTOR_TEXT',
  'TOKEN_BUDGET',
])

export function feature(name: string): boolean {
  return ENABLED_FEATURES.has(name)
}
