/** Exact fixture-local tool-announcement prices retain the original Session surface. */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate'
import { parseToolSchemasSnapshot, restorePinnedToolSchemas } from '@deepseek-ai/dsh-session-snapshot'
import { sessionProductBudgetInput } from '../../../../snapshots/session/muse-session-product/budget.ts'
import { assertWorkingBudgetExpectations, deriveWorkingBudgetExpectations } from '../../../../snapshots/session/working-budget-oracle.ts'
import type { WorkingBudgetOracleInput } from '../../../../snapshots/session/working-budget-oracle.ts'

async function input(cwd = '/tmp/dsh-snapshot-123456'): Promise<WorkingBudgetOracleInput> {
  const owner = '../../../../snapshots/session/muse-session-product/'
  const [log, prompt, schemaText] = await Promise.all([
    readFile(new URL(`${owner}writer.expected.jsonl`, import.meta.url), 'utf8'),
    readFile(new URL(`${owner}system-prompt.expected.md`, import.meta.url), 'utf8'),
    readFile(new URL(`${owner}tool-schemas.expected.json`, import.meta.url), 'utf8'),
  ])
  const schemas = parseToolSchemasSnapshot(schemaText)
  return { log, prompt, schemas: [schemas.initial, ...schemas.changes], cwd }
}

function rows(log: string): Record<string, unknown>[] {
  return log.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}

function changedLog(source: WorkingBudgetOracleInput, change: (row: Record<string, unknown>) => void): WorkingBudgetOracleInput {
  const changed = rows(source.log)
  for (const row of changed) change(row)
  return { ...source, log: changed.map(row => JSON.stringify(row)).join('\n') + '\n' }
}

function announcements(row: Record<string, unknown>): { type: string; toolName?: string }[] {
  if (row.type !== 'developer/message') return []
  return (row.data as { message: { content: { type: string; toolName?: string }[] } }).message.content
}

describe('session-product exact budget', () => {
  it('prices both replay temp roots with the exact nine-token difference', async () => {
    const short = await input()
    const long = { ...short, cwd: '/home/runner/work/_temp/dsh-snapshot-123456' }
    const first = deriveWorkingBudgetExpectations(sessionProductBudgetInput(short))
    const second = deriveWorkingBudgetExpectations(sessionProductBudgetInput(long))
    expect([...first.keys()]).toEqual([15, 22, 31, 40, 47])
    expect([...second].map(([index, count]) => count - first.get(index)!)).toEqual([9, 9, 9, 9, 9])
    expect(short.log).toBe((await input()).log)
  })

  it('keeps both Windows runtime roots JSON-quoted before exact pricing', async () => {
    const cwd = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-log-snap-123456'
    const original = await input(cwd)
    // The physical Session header uses this host's absolute path; model-visible
    // Windows context remains unchanged and is the input being priced.
    const source = changedLog(original, (row) => { if (row.type === 'session') row.cwd = process.cwd() })
    const restored = sessionProductBudgetInput(source)
    const runtime = rows(restored.log).find(row => row.type === 'user/message'
      && (row.data as { source: { kind: string } }).source.kind === 'runtime-context')
    const text = (runtime?.data as { content: { text: string }[] }).content[0]!.text
    expect(text).toContain(`session workspace: ${JSON.stringify(cwd)}`)
    expect(deriveWorkingBudgetExpectations(restored).get(15)).toBe(9459)
    const unquoted = { ...restored, log: restored.log.replaceAll(
      JSON.stringify(`session workspace: ${JSON.stringify(cwd)}`).slice(1, -1),
      JSON.stringify('session workspace: "{{cwd}}"').slice(1, -1),
    ) }
    expect(deriveWorkingBudgetExpectations(unquoted).get(15)).toBe(9458)
    expect(original.log).toBe((await input(cwd)).log)
  })

  it('retains each role, message and block overhead while preserving the folded nodes', async () => {
    const original = await input()
    let headerIndex = 0
    const sourceRows = rows(original.log)
    for (const row of sourceRows) {
      if (row.type !== 'request/header') continue
      const data = row.data as { header: unknown }
      data.header = restorePinnedToolSchemas(data.header, original.schemas[headerIndex++]!)
    }
    const sourceEvents = parseSessionLog(sourceRows.map(row => JSON.stringify(row)).join('\n') + '\n')
    const copy = sessionProductBudgetInput(original)
    const pricedEvents = parseSessionLog(copy.log)
    expect(foldSurface(pricedEvents)).toEqual(foldSurface(sourceEvents))
    const developers = sourceEvents.filter(event => event.type === 'developer/message')
    expect(developers).toHaveLength(2)
    expect(developers.map(event => event.data.message.content.length)).toEqual([8, 6])
    for (const event of developers) {
      const source = event.data.message
      const priced = deriveEventMessage(pricedEvents[event.seq]!)
      expect(priced?.role).toBe(source.role)
      expect(priced?.id).toBe(source.id)
      expect(priced?.content).toHaveLength(source.content.length)
      const independentlyPriced = 4 + source.content.reduce((sum, block) => sum + 4 + Math.ceil(JSON.stringify(block).length / 4), 0)
      expect(estimateMessage(source)).toBe(independentlyPriced)
      expect(estimateMessage(priced!)).toBe(independentlyPriced)
    }
    expect(original.log).toBe((await input()).log)
  })

  it('charges tool names and keeps their historical header references validated', async () => {
    const original = await input()
    const expected = deriveWorkingBudgetExpectations(sessionProductBudgetInput(original))
    const changed = changedLog(original, (row) => {
      const block = announcements(row).find(item => item.toolName === 'hongguo_collections')
      if (block !== undefined) block.toolName = 'work_mapping'
    })
    const altered = deriveWorkingBudgetExpectations(sessionProductBudgetInput(changed))
    expect(altered).not.toEqual(expected)
    expect(() => { assertWorkingBudgetExpectations(expected, altered) }).toThrow('differs from expected-input estimate')
    const missing = changedLog(original, (row) => {
      const block = announcements(row).find(item => item.toolName === 'hongguo_collections')
      if (block !== undefined) block.toolName = 'missing_historical_tool'
    })
    expect(() => sessionProductBudgetInput(missing)).toThrow('must name exactly one tool')
  })

  it('rejects one extra token and a missing count without changing measured events', async () => {
    const expected = deriveWorkingBudgetExpectations(sessionProductBudgetInput(await input()))
    const extra = new Map(expected)
    const first = [...expected][0]!
    extra.set(first[0], first[1] + 1)
    expect(() => { assertWorkingBudgetExpectations(extra, expected) }).toThrow('differs from expected-input estimate')
    const missing = new Map(expected)
    missing.delete(first[0])
    expect(() => { assertWorkingBudgetExpectations(missing, expected) }).toThrow('must report a non-negative integer')
  })

  it('leaves other non-text blocks rejected by the shared oracle', async () => {
    const original = await input()
    const unsupported = changedLog(original, (row) => {
      const content = announcements(row)
      if (content.length > 0) content.push({ type: 'tool-removal', toolName: 'work_mapping' })
    })
    expect(() => deriveWorkingBudgetExpectations(sessionProductBudgetInput(unsupported)))
      .toThrow('explicit request-price owner for tool-removal')
  })
})
