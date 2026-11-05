/** Runtime assertions for the synthetic current-catalog compaction pressure scenarios. */
import { expect, it } from 'vitest'
// The Loader-owned MJS fixture intentionally has no declaration artifact.
// @ts-expect-error The runtime fixture is imported directly for its assertion behavior.
import * as pressureModule from '../snapshots/session/compaction-output-reserve/pressure-fixture.mjs'

interface Request {
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
  readonly messages: readonly { readonly content: readonly { readonly type: 'text'; readonly text: string }[] }[]
}
interface FixtureAgent {
  readonly session: {
    requestHeader(): { config: { maxTokens: number } }
    snapshotEvents(): object[]
  }
}
interface Handlers {
  'agent/created': (event: { agent: FixtureAgent }) => void
  'llm/stream': (request: Request, next: () => AsyncIterable<string>) => AsyncIterable<string>
  'agent/turn-stopping': (event: { agent: FixtureAgent }) => void
}
interface FixtureContext {
  on<K extends keyof Handlers>(event: K, handler: Handlers[K]): void
  readonly llm: { resolveModelInfo(): Promise<{ context: { contextWindow: number } }> }
  readonly tokenMeter: { measure(): { totalTokens: number } }
  readonly compaction: { config: { thresholdRatio: number; headroomTokens: number; maxTokens: number } }
}
const { apply } = pressureModule as { apply: (ctx: FixtureContext) => void }

function fixture(maxTokens = 32) {
  const handlers: Partial<Handlers> = {}
  let tokens = 6637
  let delegated = 0
  const summary = { type: 'compaction/summary', data: { shadowedTokenCount: 384, maxTokens, shadowedRange: { end: 0 } } }
  const result = { type: 'tool/result', data: { message: { isError: false, content: [{ type: 'text', text: 'alpha\n' }] } } }
  const final = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'PROACTIVE COMPACTION COMPLETE' }] } } }
  const events = [{ type: 'turn/start' }, summary, result, final]
  const agent: FixtureAgent = { session: { requestHeader: () => ({ config: { maxTokens: 1000 } }), snapshotEvents: () => events } }
  const ctx: FixtureContext = {
    on<K extends keyof Handlers>(event: K, handler: Handlers[K]) { handlers[event] = handler },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 9460 } }) },
    tokenMeter: { measure: () => ({ totalTokens: tokens }) },
    compaction: { config: { thresholdRatio: 0.8, headroomTokens: 1800, maxTokens } },
  }
  apply(ctx)
  handlers['agent/created']!({ agent })
  return {
    result,
    final,
    delegated: () => delegated,
    async stream(summary: boolean, totalTokens: number, outputCap = summary ? maxTokens : 1000) {
      tokens = totalTokens
      const output = []
      const next = async function* () { delegated++; yield 'replayed' }
      for await (const chunk of handlers['llm/stream']!({ provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: outputCap,
        messages: [{ content: [{ type: 'text', text: summary ? 'You are now acting as a compaction engine' : 'Continue the original task' }] }] }, next)) output.push(chunk)
      return output
    },
    stop() { handlers['agent/turn-stopping']!({ agent }) },
  }
}

it.each([32, 1800])('accepts one reserved-pressure summary with its actual %i output cap and resumed final answer', async (maxTokens) => {
  const run = fixture(maxTokens)
  expect(await run.stream(false, 6637)).toEqual(['replayed'])
  expect(await run.stream(true, 6676)).toEqual(['replayed'])
  expect(await run.stream(false, 6430)).toEqual(['replayed'])
  expect(run.delegated()).toBe(3)
  expect(() => { run.stop() }).not.toThrow()
})

it('rejects a normal stream that consumes the summary slot without pressure compaction', async () => {
  const run = fixture()
  await run.stream(false, 6637)
  await expect(run.stream(false, 6676)).rejects.toThrow('Pressure request 1')
  expect(run.delegated()).toBe(1)
})

it('rejects a summary that did not cross the reserved threshold', async () => {
  const run = fixture()
  await expect(run.stream(true, 6637)).rejects.toThrow('threshold 6660')
  expect(run.delegated()).toBe(0)
})

it('rejects a history that would compact even without output reservation', async () => {
  const run = fixture()
  await expect(run.stream(true, 7568)).rejects.toThrow('without output reservation')
  expect(run.delegated()).toBe(0)
})

it('rejects an auxiliary stream using the conversation output cap', async () => {
  const run = fixture()
  await expect(run.stream(true, 6676, 1000)).rejects.toThrow()
  expect(run.delegated()).toBe(0)
})

it('rejects stopping after the summary without resuming the original turn', async () => {
  const run = fixture()
  await run.stream(false, 6637)
  await run.stream(true, 6676)
  expect(() => { run.stop() }).toThrow()
})

it('rejects a summary emitted as the final assistant response', async () => {
  const run = fixture()
  await run.stream(false, 6637)
  await run.stream(true, 6676)
  await run.stream(false, 6430)
  run.final.data.message.content[0]!.text = 'The request established a durable compaction premise.'
  expect(() => { run.stop() }).toThrow()
})

it('rejects a failed marker tool even when the final response matches', async () => {
  const run = fixture()
  await run.stream(false, 6637)
  await run.stream(true, 6676)
  await run.stream(false, 6430)
  run.result.data.message.isError = true
  expect(() => { run.stop() }).toThrow()
})
