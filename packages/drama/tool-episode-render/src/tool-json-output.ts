/** Shared canonical output for audio review and local dialogue patch tools. */
import type { DefineToolOptions, ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'

const schema = { type: 'object', additionalProperties: true } as const

/** Preserve the measured result for later review and render it as readable JSON. */
export const jsonEvidenceOutput = {
  schema,
  preserveBodyMeta: true,
  presentationMeta: (_args, result) => result,
  render: (_args, result) => [{ type: 'text', text: JSON.stringify(result, null, 2) }],
} satisfies DefineToolOptions<ParameterSchemaSpec, typeof schema>['output']
