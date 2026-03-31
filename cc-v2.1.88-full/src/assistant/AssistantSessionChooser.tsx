import * as React from 'react'
import type { AssistantSession } from './sessionDiscovery.js'
import { Box, Text } from '../ink.js'

type AssistantSessionChooserProps = {
  sessions: AssistantSession[]
  onSelect: (id: string) => void
  onCancel: () => void
}

export function AssistantSessionChooser(
  props: AssistantSessionChooserProps,
): React.ReactNode {
  React.useEffect(() => {
    props.onCancel()
  }, [props])

  return (
    <Box flexDirection="column">
      <Text>Assistant session chooser is unavailable in this source build.</Text>
      <Text dimColor>{`Detected sessions: ${props.sessions.length}`}</Text>
    </Box>
  )
}
