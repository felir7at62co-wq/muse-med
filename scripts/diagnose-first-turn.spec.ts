import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { expect, it } from 'vitest'

const privateMetadata = { private: 'private-metadata-sentinel' }
const metadataRows: Array<[string, object]> = [
  ['provider object', { type: 'request/header', data: { header: { config: { provider: privateMetadata, model: 'claude' } } } }],
  ['model object', { type: 'request/header', data: { header: { config: { provider: 'gateway', model: privateMetadata } } } }],
  ['oversized provider', { type: 'request/header', data: { header: { config: { provider: 'x'.repeat(1025), model: 'claude' } } } }],
  ['empty model', { type: 'request/header', data: { header: { config: { provider: 'gateway', model: '' } } } }],
  ['turn object', { type: 'turn/start', data: { turn: privateMetadata } }],
  ['zero turn', { type: 'turn/start', data: { turn: 0 } }],
  ['fractional turn', { type: 'turn/start', data: { turn: 1.5 } }],
  ['unsafe turn', { type: 'turn/start', data: { turn: Number.MAX_SAFE_INTEGER + 1 } }],
  ['step object', { type: 'assistant/message', data: { turn: 1, step: privateMetadata } }],
  ['negative step', { type: 'assistant/message', data: { turn: 1, step: -1 } }],
  ['finish object', { type: 'assistant/message', data: { turn: 1, step: 1,
    stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: privateMetadata } } }] } }],
  ['unknown finish', { type: 'assistant/message', data: { turn: 1, step: 1,
    stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'private-metadata-sentinel' } } }] } }],
  ['end object', { type: 'turn/end', data: { turn: 1, reason: { kind: privateMetadata } } }],
  ['unknown end', { type: 'turn/end', data: { turn: 1, reason: { kind: 'private-metadata-sentinel' } } }],
]

it.each(metadataRows)('rejects %s without printing private metadata', (_name, row) => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-first-turn-invalid-'))
  try {
    const file = join(dir, 'session.v4.jsonl')
    writeFileSync(file, [
      { type: 'session', version: 4 }, row,
      { type: 'assistant/message', data: { turn: 1, step: 1 } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n')
    const script = fileURLToPath(new URL('./diagnose-first-turn.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.stdout).toBe('')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Could not read a valid Muse session log')
    expect(result.stderr).not.toContain('private-metadata-sentinel')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('reports first-turn structure without printing private session content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-first-turn-'))
  try {
    const file = join(dir, 'session.v4.jsonl.zstd')
    const rows = [
      { type: 'session', version: 4, id: 'private-session-id' },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'private prompt' }] } },
      { type: 'request/header', data: { header: { config: { provider: 'yunying', model: 'claude-opus' }, tools: [{ name: 'read' }] } } },
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: { content: [{ type: 'text', text: 'private answer' }, { type: 'tool-call', arguments: 'private args' }] },
          stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'tool-calls' } } }],
        },
      },
      { type: 'tool/call', data: { turn: 1, arguments: 'private args' } },
      { type: 'tool/result', data: { turn: 1, message: { content: 'private result' } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    writeFileSync(file, Buffer.concat([
      zstdCompressSync(Buffer.from(`${JSON.stringify(rows[0])}\n`)),
      zstdCompressSync(Buffer.from(`${rows.slice(1).map(row => JSON.stringify(row)).join('\n')}\n`)),
    ]))
    const script = fileURLToPath(new URL('./diagnose-first-turn.mjs', import.meta.url))
    const output = execFileSync(process.execPath, [script, file], { encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual({ turns: [{
      turn: 1,
      steps: [{
        step: 1,
        provider: 'yunying',
        model: 'claude-opus',
        toolSchemaCount: 1,
        blocks: { text: 1, reasoning: 0, toolCall: 1, other: 0 },
        finish: 'tool-calls',
      }],
      toolCalls: 1,
      toolResults: 1,
      end: 'completed',
    }] })
    expect(output).not.toMatch(/private/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
