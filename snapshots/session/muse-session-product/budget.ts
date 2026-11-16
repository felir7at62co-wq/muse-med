/** Budget-only representation of this fixture's dynamic tool announcements. */
import { foldSurface } from '@deepseek-ai/dsh-session'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { restorePinnedToolSchemas } from '@deepseek-ai/dsh-session-snapshot'
import type { WorkingBudgetOracleInput } from '../working-budget-oracle.ts'

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Session-product budget requires an object')
  }
  return value as Record<string, unknown>
}

function restorePolicyRoot(row: Record<string, unknown>, cwd: string): void {
  if (row.type !== 'user/message') return
  const data = object(row.data)
  const source = object(data.source)
  if (source.kind !== 'runtime-context') return
  // sandbox-policy, like working-directory context, JSON-quotes the native root.
  const restore = (value: unknown) => typeof value === 'string'
    ? value.replaceAll('session workspace: "{{cwd}}"', `session workspace: ${JSON.stringify(cwd)}`)
    : value
  if (Array.isArray(data.content)) {
    for (const value of data.content) {
      const block = object(value)
      if (block.type === 'text') block.text = restore(block.text)
    }
  }
  if (Array.isArray(source.sections)) {
    for (const value of source.sections) {
      const section = object(value)
      if (section.name === 'sandbox:policy') section.text = restore(section.text)
    }
  }
}

/**
 * Preserve each tool-addition's structural JSON price without broadening the shared oracle.
 * The original announcements and historical headers are validated before their budget-only
 * copies become text blocks with identical role and block overhead. The caller's writer and
 * sidecars remain unchanged; other non-text blocks remain subject to the shared oracle.
 * @param input - This fixture's independent writer, sidecars and actual replay directory.
 * @returns A detached input used only for exact token calculation, never writer comparison.
 */
export function sessionProductBudgetInput(input: WorkingBudgetOracleInput): WorkingBudgetOracleInput {
  const rows = input.log.split('\n').filter(line => line.trim() !== '').map(line => object(JSON.parse(line)))
  let headerIndex = 0
  for (const row of rows) {
    restorePolicyRoot(row, input.cwd)
    if (row.type !== 'request/header') continue
    const data = object(row.data)
    const schemas = input.schemas[headerIndex++]
    if (schemas === undefined) throw new Error('Session-product budget is missing tool schemas')
    data.header = restorePinnedToolSchemas(data.header, schemas)
  }
  if (headerIndex !== input.schemas.length) throw new Error('Session-product budget has extra tool schemas')
  // Keep original tool-name/header references under the public Session validator.
  const serialize = () => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  const originalSurface = foldSurface(parseSessionLog(serialize()))
  for (const row of rows) {
    if (row.type !== 'developer/message') continue
    const data = object(row.data)
    const message = object(data.message)
    if (!Array.isArray(message.content)) throw new Error('Session-product budget requires message content')
    let additions = false
    message.content = message.content.map((value: unknown) => {
      const block = object(value)
      if (block.type !== 'tool-addition') return block
      additions = true
      return { type: 'text', text: JSON.stringify(block) }
    })
    // Text does not carry tool-activation metadata; the source reference was checked above.
    if (additions) delete data.headerSeq
  }
  const log = serialize()
  const pricedSurface = foldSurface(parseSessionLog(log))
  if (JSON.stringify(pricedSurface.nodes) !== JSON.stringify(originalSurface.nodes)
    || JSON.stringify(pricedSurface.replacements) !== JSON.stringify(originalSurface.replacements)) {
    throw new Error('Session-product budget changed the selected message surface')
  }
  return { ...input, log }
}
