import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { SDKMessage, SDKSessionInfo } from './coreTypes.js'

export type EffortLevel = 'low' | 'medium' | 'high' | 'max'

export type AnyZodRawShape = Record<string, unknown>

export type InferShape<Schema extends AnyZodRawShape> = {
  [K in keyof Schema]: unknown
}

export type SdkMcpToolDefinition<Schema extends AnyZodRawShape> = {
  name: string
  description: string
  inputSchema: Schema
  handler: (
    args: InferShape<Schema>,
    extra: unknown,
  ) => Promise<CallToolResult>
  annotations?: ToolAnnotations
  searchHint?: string
  alwaysLoad?: boolean
}

export type McpSdkServerConfigWithInstance = {
  name: string
  version?: string
  instance: unknown
}

export type SDKSessionOptions = {
  model?: string
  cwd?: string
  maxTurns?: number
  permissionMode?: string
  [key: string]: unknown
}

export type SessionMutationOptions = {
  cwd?: string
  [key: string]: unknown
}

export type ListSessionsOptions = {
  dir?: string
  limit?: number
  offset?: number
}

export type GetSessionInfoOptions = {
  dir?: string
}

export type GetSessionMessagesOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}

export type ForkSessionOptions = {
  cwd?: string
  [key: string]: unknown
}

export type ForkSessionResult = {
  sessionId: string
}

export type SessionMessage = SDKMessage

export type Options = SDKSessionOptions
export type InternalOptions = SDKSessionOptions & { internal?: true }

export type Query = AsyncIterable<SDKMessage>
export type InternalQuery = AsyncIterable<SDKMessage>

export type SDKSession = {
  id: string
  options: SDKSessionOptions
  prompt: (message: string) => Promise<unknown>
  getInfo: () => Promise<SDKSessionInfo | undefined>
}

export type SDKStatus = 'compacting' | null
