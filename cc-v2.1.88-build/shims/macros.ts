/**
 * Build-time macros that are normally inlined by the bundler.
 * We define them as a global for runtime access.
 */

;(globalThis as any).MACRO = {
  VERSION: '2.1.88-dev',
  BUILD_TIME: new Date().toISOString(),
  PACKAGE_URL: '@anthropic-ai/claude-code',
  README_URL: 'https://code.claude.com/docs/en/overview',
  ISSUES_EXPLAINER: 'report the issue at https://github.com/anthropics/claude-code/issues',
  FEEDBACK_CHANNEL: 'https://github.com/anthropics/claude-code/issues',
  NATIVE_PACKAGE_URL: '@anthropic-ai/claude-code',
  VERSION_CHANGELOG: '',
}
