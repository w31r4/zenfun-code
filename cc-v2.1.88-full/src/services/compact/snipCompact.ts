import type { Message } from '../../types/message.js'

export const SNIP_NUDGE_TEXT =
  'Context is getting long. Consider using snip-style cleanup before /compact.'

export type SnipCompactResult = {
  messages: Message[]
  tokensFreed: number
  boundaryMessage?: Message
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.toLowerCase().trim()
  return normalized === '1' || normalized === 'true'
}

export function isSnipRuntimeEnabled(): boolean {
  return isTruthyEnv(process.env.CLAUDE_CODE_ENABLE_SNIP)
}

export function isSnipMarkerMessage(message: Message): boolean {
  return message.type === 'system' && message.subtype === 'snip_marker'
}

export function shouldNudgeForSnips(_messages: Message[]): boolean {
  // Keep nudges off by default in this extracted build.
  return false
}

export function snipCompactIfNeeded(
  messages: Message[],
  _options?: { force?: boolean },
): SnipCompactResult {
  return {
    messages,
    tokensFreed: 0,
  }
}
