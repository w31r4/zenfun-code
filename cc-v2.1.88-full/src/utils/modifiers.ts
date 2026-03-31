export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

let prewarmed = false
let nativeModifiers:
  | { prewarm?: () => void; isModifierPressed?: (m: string) => boolean }
  | null
  | undefined

function getNativeModifiers():
  | { prewarm?: () => void; isModifierPressed?: (m: string) => boolean }
  | null {
  if (nativeModifiers !== undefined) {
    return nativeModifiers
  }
  try {
    // Keep optional native dep runtime-only; don't make build fail if absent.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const req = (0, eval)('require') as NodeJS.Require
    nativeModifiers = req('modifiers-napi') as {
      prewarm?: () => void
      isModifierPressed?: (m: string) => boolean
    }
  } catch {
    nativeModifiers = null
  }
  return nativeModifiers
}

/**
 * Pre-warm the native module by loading it in advance.
 * Call this early to avoid delay on first use.
 */
export function prewarmModifiers(): void {
  if (prewarmed || process.platform !== 'darwin') {
    return
  }
  prewarmed = true
  // Load module in background if present.
  const mod = getNativeModifiers()
  if (mod?.prewarm) {
    try {
      mod.prewarm()
    } catch {
      // Ignore errors during prewarm
    }
  }
}

/**
 * Check if a specific modifier key is currently pressed (synchronous).
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  const mod = getNativeModifiers()
  if (!mod?.isModifierPressed) {
    return false
  }
  return mod.isModifierPressed(modifier)
}
