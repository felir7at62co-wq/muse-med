/** Diagnostic child notices must be delivered before the parent reports their outcomes. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { expect } from 'vitest'

function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function diagnosticNotices(content: string, tool: string, count: number, completedText: string): string[] {
  const events = parseSessionLog(content)
  const calls = events.filter(event => event.type === 'tool/call')
  expect(calls.map(event => event.data.name), 'diagnostic delegation inventory').toEqual(Array.from({ length: count }, () => tool))
  const notices = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled')
  expect(notices, 'delivered child terminal notices').toHaveLength(count)
  const replies = events.filter(event => event.type === 'assistant/message')
    .map(event => ({ event, text: textOf(event.data.message.content) })).filter(reply => reply.text !== '')
  expect(replies.map(reply => reply.text), 'parent diagnostic completion answer').toEqual([completedText])
  const completed = replies[0]
  if (completed === undefined) throw new Error('Missing parent diagnostic completion answer')
  const childIds: string[] = []
  return calls.map((call) => {
    expect(JSON.parse(call.data.arguments)).not.toHaveProperty('run_in_background')
    const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId)
    if (result?.type !== 'tool/result') throw new Error('Missing diagnostic delegation acknowledgement')
    const acknowledgement = textOf(result.data.message.content)
    expect(acknowledgement).toMatch(/^started subagent [^\n]+$/u)
    const childId = acknowledgement.slice('started subagent '.length)
    const notice = notices.find(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled'
      && event.data.source.senderSessionId === childId)
    if (notice?.type !== 'user/message') throw new Error(`Missing terminal notice for acknowledged child ${childId}`)
    expect(childIds, 'each diagnostic child has one distinct outcome').not.toContain(childId)
    childIds.push(childId)
    expect(result.data.message.isError).toBe(false)
    expect(events.filter(event => event.type === 'subagent/catalog')).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({ childId, mode: 'external' }),
    }))
    expect(call.seq).toBeLessThan(result.seq)
    expect(result.seq).toBeLessThan(notice.seq)
    expect(notice.seq, 'child terminal notice precedes parent completion').toBeLessThan(completed.event.seq)
    return textOf(notice.data.content)
  })
}

/**
 * Check all product-provider diagnostics and preserve completed output after cleanup fails.
 * @param content - Complete persisted parent Session from the finished diagnostic scenario.
 */
export function assertProductSubagentDiagnostics(content: string): void {
  const notices = diagnosticNotices(content, 'subagent_codex', 5, 'PARENT_OBSERVED_DIAGNOSTICS')
  for (const [index, notice] of notices.entries()) {
    if (index === 4) {
      expect(notice).toContain('finished. It cannot receive follow-up messages.')
      expect(notice).toContain('ANSWER_SURVIVES_CLEANUP_FAILURE')
      expect(notice).not.toContain('failed before it finished')
      continue
    }
    expect(notice).toContain('failed before it finished')
    expect(notice).toContain(index < 2
      ? 'Product subagent failure (product: Claude Code; stage: query-run; category: limit)'
      : 'Product subagent failure (product: Codex; stage: turn; category: transport; HTTP status: 503)')
    if (index % 2 === 0) expect(notice).toContain('partial assistant text')
    else {
      expect(notice).toContain('It left no closing message.')
      expect(notice).not.toContain('partial assistant text')
    }
  }
}

/**
 * Check real ACP permission-rejection notices before the parent reports their diagnostics.
 * @param content - Complete persisted parent Session from the finished ACP diagnostic scenario.
 */
export function assertAcpSubagentDiagnostics(content: string): void {
  const notices = diagnosticNotices(content, 'subagent_acp', 2, 'PARENT_OBSERVED_ACP_DIAGNOSTIC')
  for (const notice of notices) {
    expect(notice).toContain('was stopped before it finished.')
    expect(notice).toContain('It left no closing message.')
    expect(notice).toContain('ACP unattended decision (policy: reject; request: execute; decision: denied)')
  }
}
