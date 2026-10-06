import { describe, expect, it } from 'vitest'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSettlementMessage, withContinuableReturnGuidance } from '../src/continuation-messages.ts'

const childId = SessionId('settled-child')
const summary = { type: 'text', text: `Background subagent ${childId} finished and will do no further work unless you send it more.` }
const reasoning: ContentBlock = { type: 'reasoning', text: 'private child reasoning' }
const toolCall: ContentBlock = { type: 'tool-call', id: ToolCallId('child-call'), name: 'read', arguments: '{}' }

describe('continuable settlement content', () => {
  it('includes the exact parent id and communication tool in continuable return guidance', () => {
    const parentId = SessionId('parent-with-"quotes"')
    const prompt: ContentBlock[] = [{ type: 'text', text: 'Inspect the media manifest.' }]
    const guided = withContinuableReturnGuidance(parentId, prompt)
    expect(guided[0]).toEqual(prompt[0])
    expect(prompt).toHaveLength(1)
    const guidance = guided[1]
    expect(guidance?.type).toBe('text')
    if (guidance?.type !== 'text') throw new Error('continuable return guidance is missing')
    expect(guidance.text).toContain(`send_message({ agent_id: ${JSON.stringify(parentId)}`)
  })

  it('reports a missing structured artifact as unfinished while retaining closing text', () => {
    const message = createSettlementMessage(childId, { stopReason: 'structured-output-missing', output: [{ type: 'text', text: 'Partial explanation' }] })
    expect(message.content).toEqual([
      { type: 'text', text: `Background subagent ${childId} finished without returning the requested structured result.` },
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'Partial explanation' },
    ])
  })
  it.each([
    ['reasoning before the answer', [reasoning, { type: 'text', text: 'answer' }]],
    ['a tool call after the answer', [{ type: 'text', text: 'answer' }, toolCall]],
  ] satisfies [string, ContentBlock[]][])('reports only the closing text with %s', (_label, output) => {
    const original = structuredClone(output)
    const message = createSettlementMessage(childId, { stopReason: 'completed', output })

    expect(message.role).toBe('user')
    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'answer' },
    ])
    expect(output).toEqual(original)
  })

  it.each([
    ['absent output', undefined],
    ['empty output', []],
    ['reasoning-only output', [reasoning]],
    ['empty text', [{ type: 'text', text: '' }]],
  ] satisfies [string, ContentBlock[] | undefined][])('reports no closing message for %s', (_label, output) => {
    const message = createSettlementMessage(childId, { stopReason: 'completed', ...output === undefined ? {} : { output } })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'It left no closing message.' },
    ])
  })

  it('preserves text block order and bytes around omitted reasoning and tool calls', () => {
    const first: ContentBlock = { type: 'text', text: '  first\n' }
    const second: ContentBlock = { type: 'text', text: '\n第二段  ' }
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [reasoning, first, toolCall, second],
    })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      first,
      second,
    ])
  })
})
