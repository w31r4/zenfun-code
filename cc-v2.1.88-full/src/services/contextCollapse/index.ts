import type { QuerySource } from '../../constants/querySource.js'
import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'

type CollapseHealth = {
  totalSpawns: number
  totalErrors: number
  totalEmptySpawns: number
  emptySpawnWarningEmitted: boolean
  lastError?: string
}

type CollapseStats = {
  collapsedSpans: number
  stagedSpans: number
  collapsedMessages: number
  health: CollapseHealth
}

type CollapseResult = {
  messages: Message[]
}

type OverflowRecovery = {
  messages: Message[]
  committed: number
}

const DEFAULT_STATS: CollapseStats = {
  collapsedSpans: 0,
  stagedSpans: 0,
  collapsedMessages: 0,
  health: {
    totalSpawns: 0,
    totalErrors: 0,
    totalEmptySpawns: 0,
    emptySpawnWarningEmitted: false,
  },
}

let stats: CollapseStats = {
  ...DEFAULT_STATS,
  health: { ...DEFAULT_STATS.health },
}

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.toLowerCase().trim()
  return normalized === '1' || normalized === 'true'
}

export function isContextCollapseEnabled(): boolean {
  return isTruthyEnv(process.env.CLAUDE_CONTEXT_COLLAPSE)
}

export function initContextCollapse(): void {
  // Keep existing counters if already initialized in-process.
  emit()
}

export function resetContextCollapse(): void {
  stats = {
    ...DEFAULT_STATS,
    health: { ...DEFAULT_STATS.health },
  }
  emit()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getStats(): CollapseStats {
  return {
    ...stats,
    health: { ...stats.health },
  }
}

export async function applyCollapsesIfNeeded(
  messages: Message[],
  _context: ToolUseContext,
  _querySource?: QuerySource,
): Promise<CollapseResult> {
  if (!isContextCollapseEnabled()) {
    return { messages }
  }

  stats.health.totalSpawns += 1
  stats.health.totalEmptySpawns += 1
  if (stats.health.totalEmptySpawns >= 3) {
    stats.health.emptySpawnWarningEmitted = true
  }
  emit()

  return { messages }
}

export function recoverFromOverflow(
  messages: Message[],
  _querySource?: QuerySource,
): OverflowRecovery {
  return {
    messages,
    committed: 0,
  }
}

export function isWithheldPromptTooLong(
  message: unknown,
  isPromptTooLongMessage: (message: Message) => boolean,
  _querySource?: QuerySource,
): boolean {
  if (!isContextCollapseEnabled()) {
    return false
  }

  if (!message || typeof message !== 'object') {
    return false
  }

  const maybeMessage = message as Message
  if (maybeMessage.type !== 'assistant') {
    return false
  }

  return isPromptTooLongMessage(maybeMessage)
}
