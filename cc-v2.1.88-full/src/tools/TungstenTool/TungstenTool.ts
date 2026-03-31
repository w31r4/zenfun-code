import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'

const TUNGSTEN_TOOL_NAME = 'Tungsten'

const inputSchema = lazySchema(() => z.object({}).passthrough())
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    ok: z.boolean(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

export function clearSessionsWithTungstenUsage(): void {
  // No-op in source build fallback.
}

export function resetInitializationState(): void {
  // No-op in source build fallback.
}

export const TungstenTool = buildTool({
  name: TUNGSTEN_TOOL_NAME,
  maxResultSizeChars: 50_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return process.env.USER_TYPE === 'ant'
  },
  isConcurrencySafe() {
    return true
  },
  async description() {
    return 'Run Tungsten terminal actions.'
  },
  async prompt() {
    return 'Execute Tungsten terminal operations when available.'
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: jsonStringify(output),
    }
  },
  async call() {
    return {
      data: {
        ok: false,
        message: 'Tungsten tool is unavailable in this source build.',
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
