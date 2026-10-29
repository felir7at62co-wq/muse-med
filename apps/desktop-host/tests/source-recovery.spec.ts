import { createHash } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import Llm, { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as Recovery from '../src/source-recovery.ts'
import * as Pruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { Context } from '@deepseek-ai/cordis'
import { recoveryIndex, recoverPage, serializeRecoveryPage, type Config } from '../src/source-recovery.ts'

class ExactQuery extends SessionQueryEngine {
  override async searchSessions(): Promise<never> { throw new Error('not used') }
  override async searchEvents(): Promise<never> { throw new Error('not used') }
}

const config: Config = { maxEntries: 20, maxIndexBytes: 8192, maxPageChars: 40, maxOutputCharacters: 7500, maxCacheBytes: 100000 }
const indexSchema = z.object({ source_recovery: z.object({ entries: z.array(z.unknown()), omitted: z.number() }) })
const pageSchema = z.looseObject({ seq: z.number(), text: z.string(), next_offset: z.number().nullable() })
const configWith = (values: Partial<Config>): Config => Object.assign({}, config, values)
function recorded(text: string, tool = 'read', meta: JsonValue = { path: '/a.md', offset: 1,
  totalLines: 1, lines: [{ number: 1, text }] }) {
  const session = Session.create(SessionId('recovery-test'))
  const callId = ToolCallId('read-1')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name: tool, arguments: '{}' }],
    source: { kind: 'model', provider: 'mock', model: 'mock' } }) }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId, name: tool, arguments: '{}' })
  const result = session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: false }), meta }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { session, seq: result.seq }
}
function events(session: Session) {
  // Existing test fixture inspection of the in-memory Session log.
  return session.snapshotEvents()
}
function prune(session: Session) {
  const ctx = new Context()
  ctx.provide('tokenMeter', { estimateMessage: () => 30 } as never)
  const pruner = new Pruner.ToolResultPruner(ctx, { thresholdChars: 70, headChars: 10, tailChars: 5 })
  pruner.pruneSession(session)
}

describe('source recovery', () => {
  it('pages the original recorded text by Unicode code point and identifies the original file scope', () => {
    const text = '开头😀' + '甲'.repeat(100) + '结尾', { session, seq } = recorded(text)
    prune(session)
    const index = indexSchema.parse(JSON.parse(recoveryIndex(events(session), config)!))
    expect(index.source_recovery.entries).toMatchObject([{ seq, path: '/a.md', read_file_scope: 'complete',
      recorded_result: 'original_logged_event_not_verified_complete', file_version: 'not_recorded' }])
    let offset = 0, joined = ''
    do {
      const page = recoverPage(events(session), seq, 0, offset, 7)
      joined += page.text
      expect(page.text_sha256).toBe(createHash('sha256').update(text).digest('hex'))
      offset = page.next_offset ?? -1
    } while (offset !== -1)
    expect(joined).toBe(text)
  })

  it('reserves the JSON locator before shrinking escaped text and advances the cursor exactly', () => {
    const text = ('\\\"\n😀').repeat(1000), { session, seq } = recorded(text)
    let offset = 0, joined = ''
    do {
      const page = pageSchema.parse(JSON.parse(serializeRecoveryPage(recoverPage(events(session), seq, 0, offset, 3000), 1024)))
      expect(Array.from(JSON.stringify(page)).length).toBeLessThanOrEqual(1024)
      expect(page.seq).toBe(seq)
      joined += page.text
      offset = page.next_offset ?? -1
    } while (offset !== -1)
    expect(joined).toBe(text)
    expect(() => serializeRecoveryPage(recoverPage(events(session), seq, 0, 0, 20), 10)).toThrow(/metadata/)
  })

  it('does not claim a partial or truncated original read covers the file', () => {
    const text = '长行... (line truncated to 2000 chars)' + 'x'.repeat(100)
    const { session, seq } = recorded(text, 'read', { path: '/a.md', offset: 2, totalLines: 5,
      lines: [{ number: 2, text: '长行... (line truncated to 2000 chars)' }] })
    prune(session)
    expect(recoverPage(events(session), seq, 0, 0, 10).read_file_scope).toBe('truncated')
    const partial = recorded('x'.repeat(100), 'read', { path: '/b.md', offset: 2, totalLines: 5,
      lines: [{ number: 2, text: 'x'.repeat(100) }] })
    expect(recoverPage(events(partial.session), partial.seq, 0, 0, 10).read_file_scope).toBe('partial')
  })

  it('treats new line cursors and changed versions as incomplete, retaining legacy metadata support', () => {
    for (const [extra, expected] of [
      [{ continuation: { offset: 1, column: 4 }, versionBefore: 'v1', versionAfter: 'v1' }, 'truncated'],
      [{ column: 4, versionBefore: 'v1', versionAfter: 'v1' }, 'partial'],
      [{ versionBefore: 'v1', versionAfter: 'v2' }, 'unknown'],
      [{ versionBefore: 'v1', versionUnavailable: true }, 'unknown'],
    ] as const) {
      const { session, seq } = recorded('abc', 'read', { path: '/a.md', offset: 1, totalLines: 1,
        lines: [{ number: 1, text: 'abc' }], ...extra })
      expect(recoverPage(events(session), seq, 0, 0, 3).read_file_scope).toBe(expected)
    }
  })

  it('does not index without a committed replacement, and rejects unrelated event and invalid page', () => {
    const { session, seq } = recorded('a'.repeat(100))
    expect(recoveryIndex(events(session), config)).toBeUndefined()
    expect(() => recoverPage(events(session), seq, 1, 0, 1)).toThrow(/not recorded text/)
    expect(() => recoverPage(events(session), seq, 0, 101, 1)).toThrow(/offset exceeds/)
    expect(() => recoverPage(events(session), seq, 0, 0, 0)).toThrow(/limit/)
    const other = recorded('x'.repeat(100), 'bash')
    prune(other.session)
    expect(recoveryIndex(events(other.session), config)).toBeUndefined()
    expect(() => recoverPage(events(other.session), other.seq, 0, 0, 1)).toThrow(/No successful original read/)
  })
  it('attributes a reused call id at the original result time', () => {
    const { session, seq } = recorded('a'.repeat(100))
    const callId = ToolCallId('read-1')
    session.append('turn/start', { turn: 2 }); session.append('step/start', { turn: 2, step: 1 })
    session.append('assistant/message', { turn: 2, step: 1, stream: [], message: createMessage({ role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' } }) }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 2, step: 1, callId, name: 'bash', arguments: '{}' })
    const shell = session.append('tool/result', { turn: 2, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'not a read' }], isError: false }) },
    { surfaceOp: 'append' })
    expect(recoverPage(events(session), seq, 0, 0, 10).text).toBe('a'.repeat(10))
    expect(() => recoverPage(events(session), shell.seq, 0, 0, 10)).toThrow(/No successful original read/)
  })

  it('reconstructs the same source index after a summary replacement and replay', () => {
    const { session, seq } = recorded('关联的正文'.repeat(30))
    const id = CompactionId('compact-1')
    const start = session.append('compaction/start', { compactionId: id, turn: null })
    const summary = session.append('compaction/summary', { compactionId: id, summary: [{ type: 'text', text: '摘要' }],
      shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: 100,
      provider: 'mock', model: 'mock' })
    session.append('user/message', createUserMessage({ source: { kind: 'compact-checkpoint', compactionId: id },
      content: [{ type: 'text', text: '摘要' }] }), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [start.seq, summary.seq, seq] })
    session.append('compaction/end', { compactionId: id, turn: null })
    const expected = recoveryIndex(events(session), config)
    expect(expected).toContain(`"seq":${seq}`)
    const restored = Session.create(SessionId('recovery-restored'), events(session))
    expect(recoveryIndex(events(restored), config)).toBe(expected)
  })

  it('ignores an uncommitted prune marker and reports an omitted entry when metadata exceeds budget', () => {
    const { session, seq } = recorded('x'.repeat(100), 'read', { path: '/'.repeat(5000), offset: 1,
      totalLines: 1, lines: [{ number: 1, text: 'x'.repeat(100) }] })
    session.append('compaction/prune', { shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq], shadowedTokenCount: 100 })
    expect(recoveryIndex(events(session), config)).toBeUndefined()
    prune(session)
    const serialized = recoveryIndex(events(session), configWith({ maxIndexBytes: 512, maxOutputCharacters: 1024 }))!
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(512)
    expect(indexSchema.parse(JSON.parse(serialized)).source_recovery).toMatchObject({ entries: [], omitted: 1 })
  })

  it.each([[100000, 1], [0, 2]])('emits one index and respects cache budget %i', async (maxCacheBytes, expectedReads) => {
    const ctx = new Context()
    try {
      await ctx.plugin(Llm); await ctx.plugin(Sessions); await ctx.plugin(SessionProjections); await ctx.plugin(SystemPrompt)
      await ctx.plugin(Tools); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(ExactQuery)
      ctx.tools.register(defineTool({ name: 'read', description: 'Test read', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => '曾经读过的原句'.repeat(30) }))
      await ctx.plugin(Recovery, configWith({ maxCacheBytes }))
      const exactRead = vi.spyOn(ctx.sessionQuery, 'readEvent')
      let sourceSeq = -1
      const adapter = new MockAdapter([toolCallResponse('r1', 'read', {}), textResponse('完成'),
        () => toolCallResponse('recover-1', 'source_recover', { seq: sourceSeq, block: 0, offset: 0, limit: 20 }),
        () => toolCallResponse('recover-2', 'source_recover', { seq: sourceSeq, block: 0, offset: 20, limit: 20 }),
        textResponse('继续'), textResponse('再继续')])
      ctx.llm.registerAdapter(['mock'], adapter)
      const agent = await ctx.agentLoop.create(SessionId('recovery-loop'), { provider: 'mock', model: 'mock' }, { cwd: '/tmp' })
      const run = async () => {
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }))
        await agent.whenIdle()
      }
      await run()
      expect(recoveryIndex(events(agent.session), config)).toBeUndefined()
      const source = events(agent.session).find(event => event.type === 'tool/result')
      expect(source).toBeDefined()
      sourceSeq = source!.seq
      prune(agent.session)
      await run(); await run()
      const notices = agent.session.deriveMessages().flatMap(message => message.role === 'user'
        && message.source.kind === 'muse-manuscript' ? message.content.flatMap(block =>
          block.type === 'text' && block.text.startsWith('{"source_recovery":') ? [block.text] : []) : [])
      expect(notices).toHaveLength(1)
      expect(indexSchema.parse(JSON.parse(notices[0]!)).source_recovery.entries).toHaveLength(1)
      expect(ctx.tools.schemas(agent).map(tool => tool.name)).toContain('source_recover')
      const result = events(agent.session).find(event => event.type === 'tool/result'
        && event.data.message.toolCallId === 'recover-1')
      expect(result?.type === 'tool/result' && result.data.message.isError).toBe(false)
      expect(JSON.stringify(result)).toContain('曾经读过的原句')
      expect(exactRead).toHaveBeenCalledTimes(expectedReads)
    } finally { await ctx.fiber.dispose() }
  })

})
