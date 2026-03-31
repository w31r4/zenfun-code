import * as React from 'react'
import type { AgentMemoryScope } from '../../tools/AgentTool/agentMemory.js'
import { Box, Text } from '../../ink.js'

type SnapshotUpdateDialogProps = {
  agentType: string
  scope: AgentMemoryScope
  snapshotTimestamp: string
  onComplete: (choice: 'merge' | 'keep' | 'replace') => void
  onCancel: () => void
}

export function SnapshotUpdateDialog(
  props: SnapshotUpdateDialogProps,
): React.ReactNode {
  React.useEffect(() => {
    props.onCancel()
  }, [props])

  return (
    <Box flexDirection="column">
      <Text>Snapshot update dialog is unavailable in this source build.</Text>
      <Text dimColor>{`Agent: ${props.agentType} @ ${props.snapshotTimestamp}`}</Text>
      <Text dimColor>{`Scope: ${String(props.scope)}`}</Text>
    </Box>
  )
}
