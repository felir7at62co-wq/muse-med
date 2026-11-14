/** Exact text-only snapshot budgets from expected inputs expanded for one replay directory. */
import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction'
import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { parseSystemPromptSnapshot } from '@deepseek-ai/dsh-session-snapshot'

/** Independently reviewed inputs; measured tokens and actual model messages are excluded. */
export interface WorkingBudgetOracleInput {
  /** Complete normalized expected writer, including the Session header. */
  log: string
  /** Expected prompt sidecar, with any declared system-message changes. */
  prompt: string
  /** Expected tool schemas in request-header order. */
  schemas: readonly (readonly unknown[])[]
  /** The isolated replay's actual directory, before path redaction. */
  cwd: string
  /** Expected path prefixes whose owning tool publishes a different display spelling. */
  pathDisplays?: ReadonlyMap<string, string>
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function blockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
    case 'reasoning': return 4 + Math.ceil(block.text.length / 4)
    case 'tool-call': return 4 + Math.ceil(block.name.length / 4) + Math.ceil(block.arguments.length / 4)
    default: throw new Error(`Working-budget oracle needs an explicit request-price owner for ${block.type}`)
  }
}

function messageTokens(message: Message): number {
  if (message.role === 'system') {
    if (message.content.length === 0) return 0
    return 4 + Math.ceil(message.content.reduce((sum, block) => {
      if (block.type !== 'text') throw new Error('Working-budget oracle requires text-only system content')
      return sum + block.text.length
    }, 0) / 4)
  }
  return 4 + message.content.reduce((sum, block) => sum + blockTokens(block), 0)
}

function surfaceTokens(events: readonly SessionEvent[]): number {
  const folded = foldSurface(events)
  return folded.nodes.reduce((sum, seq) => {
    const event = events[seq]
    if (event === undefined) throw new Error(`Working-budget oracle has no event at ${seq}`)
    const message = deriveEventMessage(event, folded.projectedMessages)
    return sum + (message === null ? 0 : messageTokens(message))
  }, 0)
}

function toolsTokens(header: EpochHeader | undefined): number {
  return header?.tools === undefined || header.tools.length === 0 ? 0 : 4 + Math.ceil(JSON.stringify(header.tools).length / 4)
}

// Preserve the lexical spacing of model-visible JSON tool results. Re-stringifying
// their parsed objects changes their token price even when the values are identical.
function expandText(value: string, cwd: string, pathDisplays: ReadonlyMap<string, string> = new Map()): string {
  if (!value.includes('{{cwd}}')) return value
  // The working-directory context owner quotes its path with JSON.stringify.
  const directoryContext = 'Current working directory: "{{cwd}}".'
  if (value.includes(directoryContext)) {
    value = value.replaceAll(directoryContext, `Current working directory: ${JSON.stringify(cwd)}.`)
    if (!value.includes('{{cwd}}')) return value
  }
  let parsed: unknown
  try { parsed = JSON.parse(value) }
  catch (_error) { return expandPlainText(value, cwd, pathDisplays) }
  if (parsed === null || typeof parsed !== 'object') return expandPlainText(value, cwd, pathDisplays)
  return value.replace(/"(?:[^"\\]|\\.)*"/gu, literal => {
    const text: string = JSON.parse(literal)
    return JSON.stringify(expandText(text, cwd, pathDisplays))
  })
}

function expandPlainText(value: string, cwd: string, pathDisplays: ReadonlyMap<string, string>): string {
  for (const [prefix, display] of pathDisplays) value = value.replaceAll(prefix, display)
  return value.replaceAll('{{cwd}}', cwd)
}

function expandValue(value: unknown, cwd: string, pathDisplays: ReadonlyMap<string, string> | undefined): unknown {
  if (typeof value === 'string') return expandText(value, cwd, pathDisplays)
  if (Array.isArray(value)) return value.map(item => expandValue(item, cwd, pathDisplays))
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, expandValue(item, cwd, pathDisplays)]),
  )
  return value
}

/**
 * Reconstruct each expected request prefix and price it before volatile paths are redacted.
 * Public Session folding applies every append, positional replacement and message projection.
 * This owner supports the current text-only recordings with sub-heuristic replay usage;
 * routed binary prices and usage-calibrated recordings fail explicitly rather than guessing.
 * @param input - expected writer and sidecars plus the isolated directory.
 * @returns decoded current-writer events with expected paths and sidecars expanded.
 */
function expectedEvents(input: WorkingBudgetOracleInput): SessionEvent[] {
  const parsedPrompt = parseSystemPromptSnapshot(input.prompt)
  const prompts = [parsedPrompt.initial, ...parsedPrompt.changes].map(prompt => prompt.endsWith('\n') ? prompt.slice(0, -1) : prompt)
  const rows = input.log.split('\n').filter(line => line.trim().length > 0).map(line => object(JSON.parse(line), 'Writer row'))
  let promptIndex = 0
  let headerIndex = 0
  for (const row of rows) {
    if (row.type === 'system/message') {
      const data = object(row.data, 'System data')
      const message = object(data.message, 'System message')
      if (!Array.isArray(message.content)) throw new Error('System content must be an array')
      const prompt = prompts[promptIndex++]
      if (prompt === undefined) throw new Error('Working-budget oracle is missing a prompt sidecar')
      for (const value of message.content) {
        const block = object(value, 'System block')
        if (block.type === 'text' && block.text === '{{system}}') block.text = prompt
      }
    } else if (row.type === 'request/header') {
      const data = object(row.data, 'Request data')
      const header = object(data.header, 'Request header')
      const schemas = input.schemas[headerIndex++]
      if (schemas === undefined) throw new Error('Working-budget oracle is missing tool schemas')
      if (header.tools === '{{tools}}') {
        if (schemas.length === 0) delete header.tools
        else header.tools = schemas
      }
    }
  }
  if (promptIndex !== prompts.length || headerIndex !== input.schemas.length) throw new Error('Working-budget oracle sidecar count differs from the expected writer')
  const expanded = rows.map(row => JSON.stringify(expandValue(row, input.cwd, input.pathDisplays))).join('\n') + '\n'
  const events = parseSessionLog(expanded)
  if (events.length !== rows.length - 1) throw new Error('Working-budget oracle requires one current-writer row per event')
  return events
}

/**
 * Price each expected request using the current replay directory.
 * @param input - committed writer and sidecars plus the replay directory.
 * @returns exact request counts keyed by zero-based writer record index.
 */
export function deriveWorkingBudgetExpectations(input: WorkingBudgetOracleInput): ReadonlyMap<number, number> {
  const events = expectedEvents(input)
  const counts = new Map<number, number>()
  let header: EpochHeader | undefined
  for (const [index, event] of events.entries()) {
    if (event.seq !== index) throw new Error('Working-budget oracle requires contiguous current-writer events')
    if (event.type === 'request/header') header = event.data.header
    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      const usage = event.data.usage
      const total = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      const message = deriveEventMessage(event)
      const anchor = toolsTokens(header) + surfaceTokens(events.slice(0, index)) + (message === null ? 0 : messageTokens(message))
      if (total >= anchor) throw new Error('Working-budget oracle needs an explicit usage-calibrated fixture owner')
    }
    if (event.type === 'request/context' && event.data.workingContextTokens !== undefined) {
      counts.set(index + 1, toolsTokens(header) + surfaceTokens(events.slice(0, index)))
    }
  }
  return counts
}

/**
 * Compare every measured count with its independently reconstructed expectation.
 * @param measured - runtime counts, keyed by current-writer record index.
 * @param expected - counts derived only from expected inputs and replay cwd.
 * @throws when an entry is absent, non-integral, negative or differs by even one token.
 */
export function assertWorkingBudgetExpectations(
  measured: ReadonlyMap<number, unknown>, expected: ReadonlyMap<number, number>,
): void {
  for (const [index, count] of expected) {
    const value = measured.get(index)
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new Error(`Session row ${index + 1} must report a non-negative integer working context estimate`)
    }
    if (value !== count) throw new Error(`Session row ${index + 1}: exact working context estimate ${value} differs from expected-input estimate ${count}`)
  }
  if (measured.size !== expected.size) throw new Error('Working-budget request inventory differs from the expected writer')
}

/**
 * Price each compaction claim from its exact expected current surface span.
 * @param input - committed writer and sidecars plus the replay directory.
 * @returns shadowed-span counts keyed by zero-based writer record index.
 */
export function deriveShadowedBudgetExpectations(input: WorkingBudgetOracleInput): ReadonlyMap<number, number> {
  const events = expectedEvents(input)
  const counts = new Map<number, number>()
  for (const [index, event] of events.entries()) {
    if (event.type !== 'compaction/summary' && event.type !== 'compaction/prune') continue
    const prefix = events.slice(0, index)
    const surface = foldSurface(prefix)
    const { start, end } = event.data.shadowedRange
    const first = surface.nodes.indexOf(start)
    const last = surface.nodes.indexOf(end)
    if (first < 0 || last < first) throw new Error('Expected compaction claim has no current surface span')
    const selected = surface.nodes.slice(first, last + 1)
    if (JSON.stringify(selected) !== JSON.stringify(event.data.shadowedSeqs)) throw new Error('Expected compaction claim omits a surface node')
    counts.set(index + 1, selected.reduce((sum, seq) => {
      const source = prefix[seq]
      if (source === undefined) throw new Error('Expected compaction source is absent')
      const message = deriveEventMessage(source, surface.projectedMessages)
      return sum + (message === null ? 0 : messageTokens(message))
    }, 0))
  }
  return counts
}
