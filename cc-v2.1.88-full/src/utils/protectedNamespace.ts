function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.toLowerCase().trim()
  return normalized === '1' || normalized === 'true'
}

export function checkProtectedNamespace(): boolean {
  // External/source builds default to non-protected.
  // Allow explicit opt-in for testing.
  return isTruthyEnv(process.env.CLAUDE_CODE_PROTECTED_NAMESPACE)
}
