// Lightweight fallback type surface for extracted source builds.

export type ApiKeySource = string
export type HookEvent = string
export type ExitReason = string

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | string

export type PermissionUpdate = {
  source?: string
  rule?: string
  [key: string]: unknown
}

export type PermissionResult = {
  behavior: 'allow' | 'deny' | 'ask'
  message?: string
  updatedInput?: Record<string, unknown>
  [key: string]: unknown
}

export type PermissionRequestResult = {
  decision?: 'approve' | 'block'
  reason?: string
  [key: string]: unknown
}

export type ModelUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  [key: string]: number | undefined
}

export type HookInput = {
  hook_event_name?: HookEvent
  [key: string]: unknown
}

export type AsyncHookJSONOutput = {
  async: true
  asyncTimeout?: number
}

export type SyncHookJSONOutput = {
  continue?: boolean
  suppressOutput?: boolean
  stopReason?: string
  [key: string]: unknown
}

export type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput

export type SDKStatus = 'compacting' | null

export type SDKAssistantMessageError =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'unknown'
  | 'max_output_tokens'

export type SDKPermissionDenial = {
  tool_name: string
  tool_use_id: string
  tool_input: Record<string, unknown>
}

export type SDKUserMessage = {
  type: 'user'
  message: unknown
  uuid?: string
  session_id?: string
  isSynthetic?: boolean
  parent_tool_use_id?: string | null
  tool_use_result?: unknown
  timestamp?: string
  [key: string]: unknown
}

export type SDKUserMessageReplay = SDKUserMessage & {
  isReplay: true
  uuid: string
  session_id: string
}

export type SDKAssistantMessage = {
  type: 'assistant'
  message: unknown
  uuid: string
  session_id: string
  parent_tool_use_id?: string | null
  error?: SDKAssistantMessageError
  [key: string]: unknown
}

export type SDKResultMessage = {
  type: 'result'
  subtype: string
  uuid: string
  session_id: string
  is_error?: boolean
  result?: string
  errors?: string[]
  usage?: unknown
  modelUsage?: Record<string, ModelUsage>
  permission_denials?: SDKPermissionDenial[]
  [key: string]: unknown
}

export type SDKSystemMessage = {
  type: 'system'
  subtype: string
  uuid: string
  session_id: string
  [key: string]: unknown
}

export type SDKPartialAssistantMessage = {
  type: 'stream_event'
  event: unknown
  uuid: string
  session_id: string
  parent_tool_use_id?: string | null
}

export type SDKCompactBoundaryMessage = {
  type: 'system'
  subtype: 'compact_boundary'
  compact_metadata: {
    trigger: 'manual' | 'auto'
    pre_tokens: number
    preserved_segment?: {
      head_uuid: string
      anchor_uuid: string
      tail_uuid: string
    }
  }
  uuid: string
  session_id: string
}

export type SDKStatusMessage = {
  type: 'system'
  subtype: 'status'
  status: SDKStatus
  permissionMode?: PermissionMode
  uuid: string
  session_id: string
}

export type SDKToolProgressMessage = {
  type: 'tool_progress'
  tool_use_id: string
  tool_name: string
  elapsed_time_seconds: number
  parent_tool_use_id?: string | null
  task_id?: string
  uuid: string
  session_id: string
}

export type SDKRateLimitInfo = {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  resetsAt?: number
  utilization?: number
  [key: string]: unknown
}

export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKUserMessageReplay
  | SDKResultMessage
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKToolProgressMessage
  | {
      type: 'rate_limit_event'
      rate_limit_info: SDKRateLimitInfo
      uuid: string
      session_id: string
      [key: string]: unknown
    }
  | {
      type: string
      uuid?: string
      session_id?: string
      [key: string]: unknown
    }

export type SDKSessionInfo = {
  sessionId: string
  summary: string
  lastModified: number
  fileSize?: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  tag?: string
  createdAt?: number
}
