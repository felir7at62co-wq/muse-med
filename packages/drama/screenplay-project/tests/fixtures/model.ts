/** External-model fixture that consumes canonical results rather than issuing project commands directly. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type { ProjectRequest } from '../../src/schema.ts'

export const name = 'screenplay-fixture'
export const inject = ['llm', 'tools']

export function apply(ctx: Context): void {
  let step = 0
  let last: unknown
  ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'screenplay_project') {
      if (!result.isError) last = result.value
      step += 1
    }
    return undefined
  })
  class FixtureAdapter extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      let request: ProjectRequest | undefined
      const project = 'project.json'
      switch (step) {
        case 0: request = { method: 'init', project, mode: 'faithful', instructions: '保留人物心理归属。' }; break
        case 1: request = { method: 'import_source', project, expected_revision: 0, path: 'source.txt', source_kind: 'text' }; break
        case 2: {
          const value = z.object({ source: z.object({ id: z.string() }) }).parse(last)
          request = { method: 'read_source', project, source_id: value.source.id, start: 1, count: 1 }
          break
        }
        case 3: {
          const value = z.object({ revision: z.number(), units: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(last)
          const unit = value.units[0]!
          request = { method: 'propose_fact', project, expected_revision: value.revision,
            fact: { kind: 'thought', origin: 'source', actor: '甲', layer: 'present', summary: unit.text,
              anchors: [{ unit_id: unit.id, quote: unit.text }] } }
          break
        }
        case 4: {
          const value = z.object({ revision: z.number(), fact: z.object({ id: z.string() }) }).parse(last)
          request = { method: 'review_fact', project, expected_revision: value.revision, fact_id: value.fact.id,
            decision: 'approve', reason: '本会话尝试自行批准。' }
          break
        }
      }
      if (request !== undefined) {
        const id = ToolCallId(`screenplay-call-${step + 1}`)
        const argumentsText = JSON.stringify({ request })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'screenplay_project', argumentsDelta: argumentsText }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'screenplay_project', arguments: argumentsText } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const text = '来源已导入，事实仍待独立审校；没有验收任何剧集。'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['screenplay-fixture'], new FixtureAdapter())
}
