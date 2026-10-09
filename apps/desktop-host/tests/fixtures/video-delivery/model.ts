/** Offline delivery calls made through the real agent and tool executor. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'

export const name = 'video-delivery-fixture'
export const inject = ['llm', 'tools']

export function apply(ctx: Context): void {
  let step = 0
  ctx.on('tools/result', (exec) => { if (exec.name === 'present') step += 1 })
  class FixtureAdapter extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      const files = ['final/unaccepted.docx', 'final/unaccepted.md', 'final/unaccepted.xlsx',
        ...(process.env.MUSE_TEST_PRIMARY_RUNTIME ? ['final/forged.docx', 'converted-action/final/accepted.md'] : []), 'ordinary.docx']
      if (step < files.length) {
        const id = ToolCallId(`video-delivery-${step + 1}`)
        const path = files[step]!
        const argumentsText = JSON.stringify({ files: [{ path }] })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'present', argumentsDelta: argumentsText }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'present', arguments: argumentsText } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const text = '未验收视频交付被拒绝，普通文档已交付。'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['video-delivery-fixture'], new FixtureAdapter())
}
