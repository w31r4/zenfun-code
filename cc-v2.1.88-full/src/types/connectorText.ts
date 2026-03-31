export type ConnectorTextBlock = {
  type: 'connector_text'
  connector_text: string
  citations?: unknown[]
}

export type ConnectorTextDelta = {
  type: 'connector_text_delta'
  connector_text: string
}

export function isConnectorTextBlock(
  value: unknown,
): value is ConnectorTextBlock {
  if (!value || typeof value !== 'object') {
    return false
  }

  const block = value as { type?: unknown; connector_text?: unknown }
  return (
    block.type === 'connector_text' &&
    typeof block.connector_text === 'string'
  )
}
