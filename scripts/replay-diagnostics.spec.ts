/** Replay diagnostics retain role relationships without writing into recorded owners. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { normalizeSessionSnapshots, redactSessionSnapshotIds, scrubSessionSnapshot } from '@deepseek-ai/dsh-session-snapshot'
import { writeReplayDiagnostics } from '../snapshots/replay-diagnostics.ts'

function log(id: string, parent?: string): string {
  return [
    { type: 'session', version: 4, id, createdAt: 1, cwd: '/diagnostic/workspace', isSeeded: false,
      delegationDepth: parent === undefined ? 0 : 1, ...parent === undefined ? {} : { parentSession: parent } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'system/message', data: { turn: 1, step: 1, message: { role: 'system',
      content: [{ type: 'text', text: 'business note unchanged' }], source: { kind: 'system-prompt' }, id: `message-${id}` } }, surfaceOp: 'append' },
    { type: 'request/header', data: { reason: 'initial', header: { config: { provider: 'fixture', model: 'fixture' },
      tools: [{ name: 'fixture_tool', description: 'Fixture tool.', parameters: { type: 'object', properties: {} } }] } } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'session-log-deepseek/delivery-accepted', data: { sessionId: id, sessionFormatVersion: 4, throughSeq: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
}

it('saves isolated parent/child evidence while preserving committed input bytes and model text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-replay-diagnostics-'))
  try {
    const owner = join(root, 'recorded-owner.jsonl'), parent = log('parent-live'), child = log('child-live', 'parent-live')
    await writeFile(owner, parent)
    const context = { sessionIds: ['parent-live', 'child-live'], cwd: '/diagnostic/workspace' }
    await Promise.all(['first', 'second'].map(name => writeReplayDiagnostics(join(root, name), [parent, child], context)))
    expect(await readFile(owner, 'utf8')).toBe(parent)
    const output = join(root, 'first')
    expect((await readdir(output)).sort()).toEqual([
      'system-prompt.1.expected.md', 'system-prompt.expected.md', 'tool-schemas.1.expected.json',
      'tool-schemas.expected.json', 'writer.1.expected.jsonl', 'writer.expected.jsonl',
    ])
    const primary: unknown = JSON.parse((await readFile(join(output, 'writer.expected.jsonl'), 'utf8')).split('\n')[0] ?? '')
    const descendant: unknown = JSON.parse((await readFile(join(output, 'writer.1.expected.jsonl'), 'utf8')).split('\n')[0] ?? '')
    if (typeof primary !== 'object' || primary === null || !('id' in primary)) throw new Error('primary evidence has no Session identity')
    expect(primary).toMatchObject({ version: 4 })
    const writer = await readFile(join(output, 'writer.expected.jsonl'), 'utf8')
    expect(scrubSessionSnapshot(writer)).toBe(writer)
    expect(redactSessionSnapshotIds([writer])).toEqual([writer])
    expect(normalizeSessionSnapshots([writer], { sessionIds: ['{{session:1}}'], cwd: '{{cwd}}' }, { nativeWriterOutput: true }))
      .toHaveLength(1)
    expect(descendant).toMatchObject({ parentSession: primary.id, version: 4 })
    expect(await readFile(join(output, 'system-prompt.1.expected.md'), 'utf8')).toBe('business note unchanged\n')
    expect(await readFile(join(output, 'tool-schemas.expected.json'), 'utf8')).toContain('fixture_tool')
    expect(await readFile(join(root, 'second/writer.expected.jsonl'), 'utf8'))
      .toBe(await readFile(join(output, 'writer.expected.jsonl'), 'utf8'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
