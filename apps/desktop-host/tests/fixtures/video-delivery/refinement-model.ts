/** Real offline export, Word and present calls for a synthetic accepted precision edit. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'

export const name = 'refinement-delivery-fixture'
export const inject = ['llm', 'tools']

export function apply(ctx: Context): void {
  const results: { name: string; isError: boolean }[] = []
  const errors: string[] = []
  ctx.on('tools/result', (exec, result) => {
    results.push({ name: exec.name, isError: result.isError })
    if (result.isError) errors.push(`${exec.name}: ${JSON.stringify(result.content)}`)
  })
  class FixtureAdapter extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      await writeFile('fixture-tool-results.json', JSON.stringify(results))
      await writeFile('fixture-errors.txt', errors.join('\n'))
      const stem = 'refined/final/exported/episode-1-22222222-2222-4222-8222-222222222222'
      const calls = [
        { name: 'screenplay_project', args: { request: { method: 'export', project: 'refined/qa/screenplay-project.json',
          candidate_id: 'c:22222222-2222-4222-8222-222222222222', directory: 'refined/final/exported' } } },
        { name: 'present', args: { files: [{ path: `${stem}.md` }, { path: `${stem}.modification-notes.md` }] } },
        ...(process.env.MUSE_TEST_PRIMARY_RUNTIME ? [
          { name: 'screenplay_export_docx', args: { inputs: [resolve(`${stem}.md`)], output: resolve('refined/final/accepted.docx') } },
          { name: 'present', args: { files: [{ path: 'refined/final/accepted.docx' }] } },
          { name: 'present', args: { files: [{ path: 'refined/final/accepted.docx' }, { path: `${stem}.modification-notes.md` }] } },
        ] : []),
        { name: 'present', args: { files: [{ path: `${stem}.modification-notes.md` }] } },
      ]
      const next = calls[results.length]
      if (next !== undefined) {
        if (results.length === calls.length - 1) {
          const report = await readFile(`${stem}.modification-notes.md`, 'utf8')
          await writeFile('fixture-exported-report.md', report)
          await writeFile(`${stem}.modification-notes.md`, `${report}\nFalse full-pass claim.\n`)
        }
        const id = ToolCallId(`refinement-delivery-${results.length + 1}`), args = JSON.stringify(next.args)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: next.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: next.name, arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const text = '已核对正式剧本与独立修改说明；篡改说明被拒绝。'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['refinement-delivery-fixture'], new FixtureAdapter())
}
