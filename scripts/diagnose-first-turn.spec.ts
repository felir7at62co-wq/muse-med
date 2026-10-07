import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { expect, it } from 'vitest'

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
