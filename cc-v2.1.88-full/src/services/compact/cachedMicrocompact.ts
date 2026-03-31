export type CacheEditsBlock = {
  type: 'cache_edits'
  edits: Array<{
    type: 'delete'
    tool_use_id: string
  }>
}

export type PinnedCacheEdits = {
  userMessageIndex: number
  block: CacheEditsBlock
}

export type CachedMCState = {
  registeredTools: Set<string>
  toolOrder: string[]
  deletedRefs: Set<string>
  sentTools: Set<string>
  toolMessageGroups: string[][]
  pinnedEdits: PinnedCacheEdits[]
}

export function createCachedMCState(): CachedMCState {
  return {
    registeredTools: new Set(),
    toolOrder: [],
    deletedRefs: new Set(),
    sentTools: new Set(),
    toolMessageGroups: [],
    pinnedEdits: [],
  }
}

export function isCachedMicrocompactEnabled(): boolean {
  return false
}

export function isModelSupportedForCacheEditing(_model: string): boolean {
  return false
}

export function getCachedMCConfig(): {
  triggerThreshold: number
  keepRecent: number
} {
  return {
    triggerThreshold: 25,
    keepRecent: 8,
  }
}

export function registerToolResult(state: CachedMCState, toolUseId: string): void {
  if (state.registeredTools.has(toolUseId)) {
    return
  }
  state.registeredTools.add(toolUseId)
  state.toolOrder.push(toolUseId)
}

export function registerToolMessage(
  state: CachedMCState,
  toolUseIds: string[],
): void {
  if (toolUseIds.length > 0) {
    state.toolMessageGroups.push([...toolUseIds])
  }
}

export function getToolResultsToDelete(_state: CachedMCState): string[] {
  return []
}

export function createCacheEditsBlock(
  _state: CachedMCState,
  toolUseIds: string[],
): CacheEditsBlock | null {
  if (toolUseIds.length === 0) {
    return null
  }
  return {
    type: 'cache_edits',
    edits: toolUseIds.map(tool_use_id => ({
      type: 'delete',
      tool_use_id,
    })),
  }
}

export function markToolsSentToAPI(state: CachedMCState): void {
  for (const id of state.toolOrder) {
    state.sentTools.add(id)
  }
}

export function resetCachedMCState(state: CachedMCState): void {
  state.registeredTools.clear()
  state.toolOrder.length = 0
  state.deletedRefs.clear()
  state.sentTools.clear()
  state.toolMessageGroups.length = 0
  state.pinnedEdits.length = 0
}
