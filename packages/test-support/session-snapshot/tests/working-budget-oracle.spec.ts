/** Recorded writer inputs exercise exact portable budget oracles without changing their artifacts. */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseToolSchemasSnapshot } from '@deepseek-ai/dsh-session-snapshot'
import { assertWorkingBudgetExpectations, deriveShadowedBudgetExpectations, deriveWorkingBudgetExpectations } from '../../../../snapshots/session/working-budget-oracle.ts'
import type { WorkingBudgetOracleInput } from '../../../../snapshots/session/working-budget-oracle.ts'

async function input(name: string, cwd: string): Promise<WorkingBudgetOracleInput> {
  const [log, prompt, schemaText] = await Promise.all([
    readFile(new URL(`../../../../snapshots/session/${name}/writer.expected.jsonl`, import.meta.url), 'utf8'),
    readFile(new URL(`../../../../snapshots/session/${name}/system-prompt.expected.md`, import.meta.url), 'utf8'),
    readFile(new URL(`../../../../snapshots/session/${name}/tool-schemas.expected.json`, import.meta.url), 'utf8'),
  ])
  const schemas = parseToolSchemasSnapshot(schemaText)
  return { log, prompt, schemas: [schemas.initial, ...schemas.changes], cwd }
}

describe('recorded working-budget expectations', () => {
  it('prices native visualization paths from the tool display policy while keeping the working directory absolute', async () => {
    const original = await input('muse-visualize', '/home/runner/work/dsh-log-snap-B54lk8')
    const native = { ...original,
      pathDisplays: new Map([['{{cwd}}/.dsh/visualize/sessions/{{session:1}}/',
        '~/work/dsh-log-snap-B54lk8/.dsh/visualize/sessions/session-00000000-0000-4000-8000-000000000001/']]) }
    const measured = deriveWorkingBudgetExpectations(native)
    expect([...measured.values()]).toEqual([9546, 13536, 13825, 13975])
    const absolute = deriveWorkingBudgetExpectations(original)
    expect([...absolute.values()].slice(0, 2)).toEqual([...measured.values()].slice(0, 2))
    expect(absolute).not.toEqual(measured)
    expect(() => { assertWorkingBudgetExpectations(absolute, measured) }).toThrow('differs from expected-input estimate')
  })

  it('prices the same recorded inputs at each replay directory before path redaction', async () => {
    const short = await input('muse-creation-source-id-recovery', '/tmp/replay')
    const long = { ...short, cwd: '/tmp/a-much-longer-workspace-parent/another-directory/replay' }
    const first = deriveWorkingBudgetExpectations(short)
    const second = deriveWorkingBudgetExpectations(long)
    expect(first.size).toBeGreaterThan(0)
    expect(second.size).toBe(first.size)
    expect([...first.values()]).not.toEqual([...second.values()])
    assertWorkingBudgetExpectations(first, first)
    expect(() => { assertWorkingBudgetExpectations(first, second) }).toThrow('differs from expected-input estimate')
  })

  it('rejects a one-token measurement error and a deleted model-visible input', async () => {
    const original = await input('muse-creation-source-id-recovery', '/tmp/replay')
    const expected = deriveWorkingBudgetExpectations(original)
    const measured = new Map(expected)
    const first = measured.entries().next().value
    if (first === undefined) throw new Error('Missing recorded budget')
    measured.set(first[0], first[1] + 1)
    expect(() => { assertWorkingBudgetExpectations(measured, expected) }).toThrow('differs from expected-input estimate')
    // The fixture's long task stays a valid logged message; removing its text must alter the exact price.
    const lines = original.log.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    const user = lines.find(row => row.type === 'user/message')
    if (user === undefined) throw new Error('Missing recorded user input')
    const data = user.data as { content: { type: string; text?: string }[] }
    data.content = data.content.map(block => block.type === 'text' ? { ...block, text: '' } : block)
    const withoutInput = deriveWorkingBudgetExpectations({ ...original, log: lines.map(row => JSON.stringify(row)).join('\n') + '\n' })
    expect(withoutInput).not.toEqual(expected)
    expect(() => { assertWorkingBudgetExpectations(expected, withoutInput) }).toThrow('differs from expected-input estimate')
    expect(original.log).toBe((await input('muse-creation-source-id-recovery', '/tmp/replay')).log)
  })

  it('rejects even one wrong token in an expected compaction span', async () => {
    const original = await input('muse-small-window-compaction', '/tmp/replay')
    const expected = deriveShadowedBudgetExpectations(original)
    expect(expected.size).toBe(2)
    const measured = new Map(expected)
    const first = measured.entries().next().value
    if (first === undefined) throw new Error('Missing recorded compaction span')
    measured.set(first[0], first[1] + 1)
    expect(() => { assertWorkingBudgetExpectations(measured, expected) }).toThrow('differs from expected-input estimate')
    const longer = deriveShadowedBudgetExpectations({ ...original, cwd: '/tmp/a-longer-workspace-parent/replay' })
    expect(longer).not.toEqual(expected)
  })

  it.each(['compaction-summary-failure-recovery', 'muse-small-window-compaction'])(
    'folds replacements while keeping all unshadowed inputs in %s', async (name) => {
      const original = await input(name, '/tmp/replay')
      expect(original.log).toContain('"op":"replace"')
      const expected = deriveWorkingBudgetExpectations(original)
      expect(expected.size).toBeGreaterThan(0)
      const rows = original.log.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      const replacements = rows.flatMap((row, index) => typeof row.surfaceOp === 'object' && row.surfaceOp !== null
        ? [{ index, op: row.surfaceOp as { startSeq: number; endSeq: number } }] : [])
      const last = replacements.at(-1)
      if (last === undefined) throw new Error('Missing recorded replacement')
      const shadowed = rows[last.op.startSeq + 1]
      if (shadowed === undefined) throw new Error('Missing shadowed event')
      const data = shadowed.data as { message?: { content: { type: string; text: string }[] }; content: { type: string; text: string }[] }
      const message = shadowed.type === 'user/message' ? data : data.message
      if (message === undefined) throw new Error('Missing shadowed message')
      message.content = [{ type: 'text', text: 'Shadowed input with a deliberately different price. '.repeat(40) }]
      const changedShadow = deriveWorkingBudgetExpectations({ ...original, log: rows.map(row => JSON.stringify(row)).join('\n') + '\n' })
      const later = [...expected].filter(([index]) => index > last.index)
      expect(later.length).toBeGreaterThan(0)
      for (const [index, count] of later) expect(changedShadow.get(index)).toBe(count)
      const retained = rows.findLast(row => row.type === 'user/message' && row.surfaceOp === 'append')
      if (retained === undefined) throw new Error('Missing retained input')
      const retainedData = retained.data as { content: { type: string; text: string }[] }
      retainedData.content[0]!.text += '\nA retained input must remain priced. '.repeat(8)
      const changedRetained = deriveWorkingBudgetExpectations({ ...original, log: rows.map(row => JSON.stringify(row)).join('\n') + '\n' })
      expect(() => { assertWorkingBudgetExpectations(expected, changedRetained) }).toThrow('differs from expected-input estimate')
    },
  )
})
