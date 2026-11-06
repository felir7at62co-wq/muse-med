/** Product review pages survive the real pressure-pruning pass without losing JSON fields. */
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner, { PRUNE_MARKER, resolveConfig } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import Llm, { createMessage, createToolResultMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Tools from '@deepseek-ai/dsh-tools'
import * as yaml from 'js-yaml'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { Config } from '../src/manuscript-revisions.ts'
import { formatManuscriptReport, manuscriptReportVersion } from '../src/manuscript-report.ts'

const route = 'review-pressure'
const entries = z.array(z.object({ id: z.string(), config: z.unknown().optional() }))
const manifestSchema = z.object({ report_sha256: z.string(),
  report_sections: z.array(z.object({ section: z.string(), total_items: z.number() })) })
const pageSchema = z.object({ items: z.array(z.object({ id: z.number(), quote: z.string() })),
  continuation: z.object({ report_offset: z.number() }).nullable() })

class CapacityAdapter extends LlmAdapter {
  streamCalls = 0
  constructor(private readonly contextWindow: number) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.contextWindow } })
  }
  override async * stream(): AsyncIterable<StreamChunk> {
    this.streamCalls++
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function exactReport(characters: number) {
  const data = { task_key: '精确预算', records: [{ id: 1, quote: '' }], advisory: true }
  data.records[0]!.quote = '甲'.repeat(characters - JSON.stringify(data).length)
  return data
}

it.each(['short-drama', 'creation'])('retains complete reports and every page under %s pressure pruning', async (preset) => {
  const maximum = Config({}).manuscriptReportMaxResultCharacters
  expect(maximum).toBe(8000)
  const raw = await readFile(new URL(`../presets/${preset}/agent.cordis.yml`, import.meta.url), 'utf8')
  const group = entries.parse(yaml.load(raw, { schema: entryListSchema })).find(row => row.id === 'compaction')
  const prunerRow = entries.parse(group?.config).find(row => row.id === 'tool-result-pruner')
  const parsedPruner = z.object({ thresholdChars: z.number(), headChars: z.number(), tailChars: z.number(),
    preserveToolNames: z.array(z.string()).optional() }).parse(prunerRow?.config)
  const prunerInput = { thresholdChars: parsedPruner.thresholdChars, headChars: parsedPruner.headChars,
    tailChars: parsedPruner.tailChars,
    ...(parsedPruner.preserveToolNames === undefined ? {} : { preserveToolNames: parsedPruner.preserveToolNames }) }
  const prunerConfig = resolveConfig(prunerInput)
  expect(prunerConfig).toEqual({ thresholdChars: 8192, headChars: 4096, tailChars: 1024,
    preserveToolNames: preset === 'short-drama' ? ['skill'] : [] })

  const rows = Array.from({ length: 15 }, (_, index) => ({ id: index + 1, quote: `甲OS：${'保留全部原句和字段。'.repeat(110)}` }))
  const report = { task_key: '分组审查', records: rows, semantic_assessment: 'not_performed' }
  const version = manuscriptReportVersion(report, process.cwd())
  const complete = exactReport(maximum)
  const safe = [formatManuscriptReport(complete, version, { maxCharacters: maximum }),
    formatManuscriptReport(report, version, { maxCharacters: maximum })]
  expect(safe[0]).toHaveLength(maximum)
  expect(JSON.parse(safe[0]!)).toEqual(complete)
  const manifest = manifestSchema.parse(JSON.parse(safe[1]!))
  expect(manifest.report_sections).toEqual([{ section: 'records', total_items: rows.length }])
  const collected: typeof rows = []
  let offset = 1
  for (;;) {
    const text = formatManuscriptReport(report, version, { maxCharacters: maximum,
      cursor: { report_sha256: version, report_section: 'records', report_offset: offset } })
    safe.push(text)
    const page = pageSchema.parse(JSON.parse(text))
    collected.push(...page.items)
    if (page.continuation === null) break
    offset = page.continuation.report_offset
  }
  expect(collected).toEqual(rows)
  expect(safe.every(text => text.length <= maximum)).toBe(true)

  const threshold = JSON.stringify(exactReport(prunerConfig.thresholdChars))
  const oversized = JSON.stringify(exactReport(prunerConfig.thresholdChars + 1))
  const texts = [...safe, threshold, oversized]
  const ctx = new Context()
  try {
    await ctx.plugin(Llm); await ctx.plugin(Sessions); await ctx.plugin(SessionProjections)
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    new TokenMeter(ctx)
    new ToolResultPruner(ctx, prunerInput)
    const agent = await ctx.agentLoop.create(SessionId(`review-pruning-${preset}`), { provider: route, model: route })
    const session = agent.session
    const calls = texts.map((text, index) => ({ text, id: ToolCallId(`review-page-${index}`) }))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: { provider: route, model: route } }, reason: 'initial' })
    session.append('assistant/message', { turn: 1, step: 1, stream: [],
      message: createMessage({ role: 'assistant', source: { kind: 'model', provider: route, model: route },
        content: calls.map(call => ({ type: 'tool-call', id: call.id, name: 'manuscript_work', arguments: '{"action":"audit"}' })) }) },
    { surfaceOp: 'append' })
    for (const call of calls) {
      session.append('tool/call', { turn: 1, step: 1, callId: call.id, name: 'manuscript_work', arguments: '{"action":"audit"}' })
      session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: call.id,
        content: [{ type: 'text', text: call.text }], isError: false }) }, { surfaceOp: 'append' })
    }
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const before = ctx.tokenMeter.measure(session).totalTokens
    const adapter = new CapacityAdapter(before * 2 - 2)
    ctx.llm.registerAdapter([route], adapter)
    const compact = new BasicCompactionEngine(ctx, { auto: false, thresholdRatio: 0.5,
      headroomTokens: 0, maxTokens: 32, retainTokens: 0 })
    expect(await compact.compactIfNeeded(agent, 'pressure', new AbortController().signal)).toBeNull()
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeLessThan(before - 1)
    expect(session.surface.replaceGeneration).toBe(1)
    expect(adapter.streamCalls).toBe(0)
    const results = session.deriveMessages().flatMap(message => message.role === 'tool'
      ? [message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')] : [])
    expect(results.slice(0, -1)).toEqual([...safe, threshold])
    for (const [index, text] of safe.entries()) expect(JSON.parse(results[index]!)).toEqual(JSON.parse(text))
    expect(results.at(-1)).toContain(PRUNE_MARKER)
    expect(results.at(-1)).not.toBe(oversized)
  } finally {
    await ctx.fiber.dispose()
  }
})
