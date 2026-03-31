import { homedir } from 'os'
import { join } from 'path'
import * as React from 'react'
import { Box, Text } from '../../ink.js'

export async function computeDefaultInstallDir(): Promise<string> {
  return join(homedir(), '.claude', 'assistant')
}

type NewInstallWizardProps = {
  defaultDir: string
  onInstalled: (dir: string) => void
  onCancel: () => void
  onError: (message: string) => void
}

export function NewInstallWizard(props: NewInstallWizardProps): React.ReactNode {
  React.useEffect(() => {
    props.onError('Assistant install wizard is unavailable in this source build.')
  }, [props])

  return (
    <Box flexDirection="column">
      <Text>Assistant install wizard is unavailable in this source build.</Text>
      <Text dimColor>{`Default install directory: ${props.defaultDir}`}</Text>
    </Box>
  )
}
