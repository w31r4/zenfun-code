import { parse as parseYamlNode } from 'yaml/dist/index.js'

/**
 * YAML parsing wrapper.
 *
 * Uses Bun.YAML (built-in, zero-cost) when running under Bun, otherwise uses
 * the npm yaml parser via its stable file path export. We import from
 * yaml/dist/index.js directly because some recovered node_modules trees do not
 * contain the package root entrypoint metadata required for `require('yaml')`.
 */

export function parseYaml(input: string): unknown {
  if (typeof Bun !== 'undefined') {
    return Bun.YAML.parse(input)
  }
  return parseYamlNode(input)
}
