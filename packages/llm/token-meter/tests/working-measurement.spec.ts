/** Working-budget calibration remains separate from billing and HUD measurement. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AssistantStreamAccumulator, createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { EpochHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { estimateToolsTokens } from '../src/estimate.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const header: EpochHeader = {
  config: { provider: 'mock', model: 'working' },
  tools: [{ name: 'lookup', description: 'Look up a local record.', parameters: { type: 'object' } }],
}

function meter(): TokenMeter {
  const ctx = new Context()
  contexts.push(ctx)
  new SessionProjectionRegistry(ctx)
  return new TokenMeter(ctx)
}

/** Keep the recorded stream equal to the durable answer so the anchor has no rewrite delta. */
function sessionWithUsage(usage?: TokenUsage) {
  const session = Session.create(SessionId('working-measure'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const system = session.append('system/message', { turn: 1, step: 1,
    message: createSystemMessage('Keep the project rules.') }, { surfaceOp: 'append' }).seq
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'older project record '.repeat(100) }], source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
  session.append('request/header', { header, reason: 'initial' })
  const stream = new AssistantStreamAccumulator()
  stream.push({ time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } })
  stream.push({ time: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Recorded answer.' } } })
  stream.push({ time: 2, chunk: { type: 'finish', reason: { kind: 'stop' } } })
  const assistant = session.append('assistant/message', { turn: 1, step: 1, stream: [...stream.snapshot()],
    message: createAssistantMessage({ content: [{ type: 'text', text: 'Recorded answer.' }],
      source: { provider: 'mock', model: 'working' } }),
    ...(usage === undefined ? {} : { usage }),
  }, { surfaceOp: 'append' }).seq
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { session, system, user, assistant }
}

function calibrated(scale = 5) {
  const service = meter()
  const estimated = service.measure(sessionWithUsage().session)
  const usage = { inputTokens: estimated.totalTokens * scale, outputTokens: 0 }
  return { service, estimated, usage, ...sessionWithUsage(usage) }
}

describe('working-context measurements', () => {
  it('distributes a matching usage anchor over the complete priced request without changing measure', () => {
    const { service, session, estimated, usage } = calibrated()
    const original = service.measure(session)
    const working = service.measureWorkingContext(session)
    expect(working.baseline).toEqual({ kind: 'usage', tokens: usage.inputTokens, usage })
    expect(working.totalTokens).toBe(usage.inputTokens)
    expect(working.surfaceTokens).toBe(estimated.surfaceTokens * 5)
    expect(working.nodes.map(node => node.tokens)).toEqual(estimated.nodes.map(node => node.tokens * 5))
    expect(working.nodes.map(node => node.heuristicTokens)).toEqual(estimated.nodes.map(node => node.heuristicTokens))
    expect(working.totalTokens - working.surfaceTokens).toBe(estimateToolsTokens(header) * 5)
    expect(service.measure(session)).toEqual(original)
    expect(Object.isFrozen(working)).toBe(true)
    expect(working.nodes.every(Object.isFrozen)).toBe(true)
  })

  it('keeps retained system, tools and newly appended input at their calibrated prices', () => {
    const { service, session, system, usage } = calibrated()
    const original = service.measureWorkingContext(session)
    const message = createUserMessage({ content: [{ type: 'text', text: 'new pending input' }], source: { kind: 'user' } })
    const appended = session.append('user/message', message, { surfaceOp: 'append' }).seq
    const working = service.measureWorkingContext(session)
    expect(working.nodes.find(node => node.seq === system)).toEqual(original.nodes.find(node => node.seq === system))
    expect(working.nodes.find(node => node.seq === appended)?.tokens).toBe(service.estimateMessage(message) * 5)
    expect(working.totalTokens - working.surfaceTokens).toBe(estimateToolsTokens(header) * 5)
    expect(working.totalTokens).toBe(original.totalTokens + service.estimateMessage(message) * 5)
    expect(working.surfaceDeltaTokens).toBe(working.totalTokens - usage.inputTokens)
    expect(service.measure(session).totalTokens).toBe(usage.inputTokens + service.estimateMessage(message))
  })

  it('removes only the replaced history share and keeps the remaining overhead after a checkpoint', () => {
    const { service, session, system, user, assistant, usage } = calibrated()
    const before = service.measureWorkingContext(session)
    const checkpoint = createUserMessage({ content: [{ type: 'text', text: 'Retain the project rules and pending work.' }],
      source: { kind: 'user' } })
    const replacement = session.append('user/message', checkpoint, {
      surfaceOp: { op: 'replace', startSeq: user, endSeq: assistant }, sourceEventSeqs: [user, assistant],
    }).seq
    const working = service.measureWorkingContext(session)
    expect(working.nodes.map(node => node.seq)).toEqual([system, replacement])
    const systemPrice = before.nodes.find(node => node.seq === system)?.tokens
    if (systemPrice === undefined) throw new Error('missing system price')
    expect(working.totalTokens).toBe(systemPrice + estimateToolsTokens(header) * 5 + service.estimateMessage(checkpoint) * 5)
    expect(working.totalTokens).toBeGreaterThan(0)
    expect(working.totalTokens).toBeLessThan(before.totalTokens)
    expect(working.baseline).toEqual(before.baseline)
    expect(working.surfaceDeltaTokens).toBe(working.totalTokens - usage.inputTokens)
    expect(working.nodes[0]?.tokens).toBe(systemPrice)
    expect(working.nodes[1]?.heuristicTokens).toBe(service.estimateMessage(checkpoint))
    expect(service.measure(session).totalTokens).toBeGreaterThan(working.totalTokens)
  })

  it('rounds each calibrated component upward and preserves the node sum', () => {
    const service = meter()
    const estimated = service.measure(sessionWithUsage().session)
    const usage = { inputTokens: estimated.totalTokens * 2 + 1, outputTokens: 0 }
    const { session } = sessionWithUsage(usage)
    const working = service.measureWorkingContext(session)
    expect(working.totalTokens).toBeGreaterThanOrEqual(usage.inputTokens)
    expect(working.totalTokens).toBeLessThan(usage.inputTokens + working.nodes.length + 1)
    expect(working.nodes.reduce((total, node) => total + node.tokens, 0)).toBe(working.surfaceTokens)
    expect(working.nodes.every((node, index) => node.tokens >= (estimated.nodes[index]?.tokens ?? 0) * 2)).toBe(true)
  })

  it('uses disjoint cache buckets without charging reasoning output twice', () => {
    const service = meter()
    const estimated = service.measure(sessionWithUsage().session)
    const base = estimated.totalTokens
    const usage = { inputTokens: base, cacheReadTokens: base, cacheWriteTokens: base,
      outputTokens: base, reasoningTokens: base / 2 }
    const { session } = sessionWithUsage(usage)
    const working = service.measureWorkingContext(session)
    expect(working.totalTokens).toBe(base * 4)
    expect(working.baseline).toEqual({ kind: 'usage', tokens: base * 4, usage })
    expect(working.nodes.map(node => node.tokens)).toEqual(estimated.nodes.map(node => node.tokens * 4))
  })

  it.each([undefined, { inputTokens: 1, outputTokens: 0 }])('keeps measure semantics without a reusable usage anchor (%j)', (usage) => {
    const service = meter()
    const { session } = sessionWithUsage(usage)
    expect(service.measureWorkingContext(session)).toEqual(service.measure(session))
    expect(service.measureWorkingContext(session).baseline.kind).toBe('estimated')
  })

  it('does not reuse the old multiplier after a model or tool-envelope change', () => {
    const { service, session } = calibrated()
    for (const replacement of [
      { ...header, config: { ...header.config, model: 'different-model' } },
      { ...header, tools: [] },
    ]) {
      expect(service.measureWorkingContext(session, replacement)).toEqual(service.measure(session, replacement))
      expect(service.measureWorkingContext(session, replacement).baseline.kind).toBe('estimated')
    }
  })

  it('keeps a zero-priced anchor finite instead of deriving a multiplier', () => {
    const service = meter()
    const session = Session.create(SessionId('empty-working-anchor'))
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'working' } }, reason: 'initial' })
    session.append('assistant/message', { turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [], source: { provider: 'mock', model: 'working' } }),
      usage: { inputTokens: 100, outputTokens: 0 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    expect(service.measureWorkingContext(session)).toEqual(service.measure(session))
    expect(Number.isFinite(service.measureWorkingContext(session).totalTokens)).toBe(true)
  })
})
