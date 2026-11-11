/** Request attribution survives generator suspension and never records model content. */
import { expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MuseModelRequestTrace, type MuseModelRequestMetadata } from '../src/model-request-trace.ts'

const baseURL = 'https://company.test/api/desktop-models/studio'
const options = (id: string): GenerateOptions => ({ provider: 'muse-cloud-studio', model: 'writer',
  sessionId: SessionId(id), messages: [] })
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const header = 'x-muse-client-request-id'
const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }

it('attributes iterator creation and every interleaved generator resumption to its own request', async () => {
  const records: MuseModelRequestMetadata[] = [], seen: { session: string; id: string | null }[] = []
  const trace = new MuseModelRequestTrace('https://company.test', value => records.push(value))
  function source(request: GenerateOptions): AsyncIterable<StreamChunk> {
    const capture = (): void => { seen.push({ session: String(request.sessionId),
      id: trace.headers({ ...request, baseURL }, new Headers()).get(header) }) }
    capture()
    return (async function* () {
      capture()
      yield { type: 'text-delta', index: 0, text: 'private generated text' } as const
      await Promise.resolve()
      capture()
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } } as const
      capture()
      yield finish
    })()
  }
  const a = options('a'), b = options('b')
  const first = trace.stream(a, () => source(a))[Symbol.asyncIterator]()
  const second = trace.stream(b, () => source(b))[Symbol.asyncIterator]()
  await Promise.all([first.next(), second.next()])
  await Promise.all([second.next(), first.next()])
  await Promise.all([first.next(), second.next()])
  await Promise.all([first.next(), second.next()])
  const aIds = new Set(seen.filter(value => value.session === 'a').map(value => value.id))
  const bIds = new Set(seen.filter(value => value.session === 'b').map(value => value.id))
  expect(aIds.size).toBe(1); expect(bIds.size).toBe(1)
  expect([...aIds][0]).toMatch(uuid); expect([...bIds][0]).toMatch(uuid)
  expect([...aIds][0]).not.toBe([...bIds][0])
  expect(records.filter(record => record.phase === 'finish')).toHaveLength(2)
  expect(records.filter(record => record.phase === 'finish').map(record => record.usage)).toEqual([
    { inputTokens: 3, outputTokens: 1, totalTokens: 4 }, { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
  ])
  expect(JSON.stringify(records)).not.toContain('private generated text')
  expect(trace.headers({ ...a, baseURL }, new Headers({ [header]: 'spoof' })).has(header)).toBe(false)
})

it('keeps return and throw callbacks inside the same request and records each terminal outcome once', async () => {
  const records: MuseModelRequestMetadata[] = [], ids: (string | null)[] = []
  const trace = new MuseModelRequestTrace('https://company.test', value => records.push(value)), request = options('a')
  const capture = (): void => { ids.push(trace.headers({ ...request, baseURL }, new Headers()).get(header)) }
  const source = (): AsyncIterable<StreamChunk> => ({ [Symbol.asyncIterator]() { capture(); return {
    async next() { await Promise.resolve(); capture(); return { done: false, value: { type: 'text-delta', index: 0, text: 'secret' } as const } },
    async return() { await Promise.resolve(); capture(); return { done: true, value: undefined } },
    async throw(error) { await Promise.resolve(); capture(); throw error },
  } } })
  const first = trace.stream(request, source)[Symbol.asyncIterator]()
  await first.next(); await first.return?.()
  expect(new Set(ids).size).toBe(1)
  expect(records.at(-1)).toMatchObject({ phase: 'finish', outcome: 'consumer_closed', usage: null, stop: null })
  const second = trace.stream(request, source)[Symbol.asyncIterator]()
  await second.next(); await expect(second.throw?.(Error('private thrown diagnostic'))).rejects.toThrow('private thrown diagnostic')
  expect(records.filter(record => record.phase === 'finish')).toHaveLength(2)
  expect(records.at(-1)).toMatchObject({ outcome: 'thrown', usage: null })
  expect(records[0]?.client_request_id).not.toBe(records[2]?.client_request_id)
  expect(JSON.stringify(records)).not.toMatch(/private thrown diagnostic|secret/u)
})

it('sends its header only to the company relay after deleting contributed spoofed values', async () => {
  const trace = new MuseModelRequestTrace('https://company.test', () => {}), request = options('a')
  const values: (string | null)[] = []
  const urls = [baseURL, 'https://company.test.evil/api/desktop-models/studio', 'https://supplier.test/v1',
    'https://company.test:444/api/desktop-models/studio', 'https://company.test/unrelated']
  for await (const _chunk of trace.stream(request, async function* () {
    for (const url of urls) values.push(trace.headers({ ...request, baseURL: url }, new Headers({ [header]: 'spoof' })).get(header))
    values.push(trace.headers({ ...request, model: 'other', baseURL }, new Headers()).get(header))
    yield finish
  })) { /* Consume the owned stream. */ }
  expect(values[0]).toMatch(uuid)
  expect(values.slice(1)).toEqual([null, null, null, null, null])
})

it('closes an iterator without return support and preserves the supplied return value', async () => {
  const records: MuseModelRequestMetadata[] = []
  const trace = new MuseModelRequestTrace('https://company.test', record => records.push(record))
  const chunk: StreamChunk = { type: 'text-delta', index: 0, text: 'private-stream-text' }
  const iterator = trace.stream(options('returnless'), () => ({
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: chunk }) }),
  }))[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ done: false, value: chunk })
  expect(await iterator.return?.('returned-value')).toEqual({ done: true, value: 'returned-value' })
  expect(records.map(record => record.phase)).toEqual(['start', 'finish'])
  expect(records[1]).toMatchObject({ outcome: 'consumer_closed', usage: null })
  expect(JSON.stringify(records)).not.toMatch(/private-stream-text|returned-value/u)
  trace.dispose()
})

it('closes a throwless source in the request context before propagating the caller error', async () => {
  const records: MuseModelRequestMetadata[] = [], ids: (string | null)[] = []
  const trace = new MuseModelRequestTrace('https://company.test', record => records.push(record))
  const request = options('throwless'), failure = new Error('private caller failure')
  let closed = false
  const iterator = trace.stream(request, () => ({ [Symbol.asyncIterator]: () => ({
    next: async () => {
      ids.push(trace.headers({ ...request, baseURL }, new Headers()).get(header))
      return { done: false, value: { type: 'text-delta', index: 0, text: 'private-stream-text' } as const }
    },
    return: async () => {
      await Promise.resolve()
      ids.push(trace.headers({ ...request, baseURL }, new Headers()).get(header))
      closed = true
      return { done: true, value: undefined }
    },
  }) }))[Symbol.asyncIterator]()
  await iterator.next()
  await expect(iterator.throw?.(failure)).rejects.toBe(failure)
  expect(closed).toBe(true)
  expect(ids).toHaveLength(2)
  expect(ids[0]).toMatch(uuid)
  expect(ids[1]).toBe(ids[0])
  expect(records.map(record => record.phase)).toEqual(['start', 'finish'])
  expect(records[1]).toMatchObject({ outcome: 'thrown', usage: null })
  expect(JSON.stringify(records)).not.toMatch(/private caller failure|private-stream-text/u)
  trace.dispose()
})

it('propagates the same caller error when the source has neither throw nor return support', async () => {
  const records: MuseModelRequestMetadata[] = []
  const trace = new MuseModelRequestTrace('https://company.test', record => records.push(record))
  const failure = new Error('private unhandled source error')
  const iterator = trace.stream(options('minimal-source'), () => ({
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
  }))[Symbol.asyncIterator]()
  await expect(iterator.throw?.(failure)).rejects.toBe(failure)
  expect(records.map(record => record.phase)).toEqual(['start', 'finish'])
  expect(records[1]).toMatchObject({ outcome: 'thrown', usage: null })
  expect(JSON.stringify(records)).not.toContain('private unhandled source error')
  trace.dispose()
})

it('preserves authoritative usage and safe response identities without retaining other replay or request fields', async () => {
  const records: MuseModelRequestMetadata[] = []
  const trace = new MuseModelRequestTrace('https://company.test', value => records.push(value))
  const request = { ...options('usage'), messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'private-input-key' }] }] }
  for await (const _chunk of trace.stream(request, async function* () {
    yield { type: 'usage', usage: { inputTokens: 2538, outputTokens: 1665, totalTokens: 6379, cacheReadTokens: 2176 } } as const
    yield { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { response: { kind: 'pi-ai', version: 2,
      responseId: 'chatcmpl-safe', responseModel: 'resolved-model', stopReason: 'toolUse', apiKey: 'private-replay-key' }, blocks: ['private-block'] } } as const
  })) { /* Preserve the adapter stream unmodified. */ }
  expect(records.at(-1)).toMatchObject({ outcome: 'finished', stop: 'tool-calls', response_id: 'chatcmpl-safe',
    response_model: 'resolved-model', response_stop: 'toolUse',
    usage: { inputTokens: 2538, outputTokens: 1665, totalTokens: 6379, cacheReadTokens: 2176 } })
  expect(JSON.stringify(records)).not.toMatch(/private-input-key|private-replay-key|private-block/u)
})

it('omits invalid diagnostic counters while preserving every source chunk', async () => {
  const records: MuseModelRequestMetadata[] = []
  const trace = new MuseModelRequestTrace('https://company.test', value => records.push(value))
  const source: StreamChunk[] = [{ type: 'usage', usage: { inputTokens: Number.NaN, outputTokens: 1,
    totalTokens: Number.POSITIVE_INFINITY, cacheReadTokens: 0, cacheWriteTokens: -1, reasoningTokens: 0.5 } }, finish]
  const received: StreamChunk[] = []
  for await (const chunk of trace.stream(options('invalid-counters'), async function* () { yield* source })) received.push(chunk)
  expect(received).toHaveLength(source.length)
  received.forEach((chunk, index) => { expect(chunk).toBe(source[index]) })
  expect(records.at(-1)?.usage).toEqual({ outputTokens: 1, cacheReadTokens: 0 })
})

it('omits usage when every observed counter is invalid', async () => {
  const records: MuseModelRequestMetadata[] = []
  const trace = new MuseModelRequestTrace('https://company.test', value => records.push(value))
  for await (const _chunk of trace.stream(options('all-invalid-counters'), async function* () {
    yield { type: 'usage', usage: { inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY,
      totalTokens: -1, cacheReadTokens: 0.5, cacheWriteTokens: Number.MAX_SAFE_INTEGER + 1,
      reasoningTokens: Number.NEGATIVE_INFINITY } } as const
    yield finish
  })) { /* Consume the original adapter stream. */ }
  expect(records.at(-1)).not.toHaveProperty('usage')
})

it('redacts credential-bearing response identifiers for a request without a Session', async () => {
  const records: MuseModelRequestMetadata[] = []
  const trace = new MuseModelRequestTrace('https://company.test', record => records.push(record))
  const request: GenerateOptions = { provider: 'muse-cloud-studio', model: 'writer', messages: [], purpose: 'diagnostic' }
  for await (const _chunk of trace.stream(request, async function* () {
    trace.credential('fixture-secret')
    expect(trace.identifier('safe-response', 'id')).toBe('safe-response')
    expect(trace.identifier('response-fixture-secret', 'id')).toBeNull()
    yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: {
      kind: 'pi-ai', version: 2, responseId: 'response-fixture-secret', responseModel: 'safe-model', stopReason: 'stop',
    } } } as const
  })) { /* Consume the original adapter stream. */ }
  expect(records.at(-1)).toMatchObject({ session_id: null, purpose: 'diagnostic', response_id: null,
    response_model: 'safe-model', outcome: 'finished' })
  expect(JSON.stringify(records)).not.toContain('fixture-secret')
  trace.dispose()
})

it('does not expose malformed response metadata or a throwing logger and preserves source failures', async () => {
  const records: MuseModelRequestMetadata[] = [], request = options('malformed')
  const trace = new MuseModelRequestTrace('https://company.test', value => records.push(value))
  for await (const _chunk of trace.stream(request, async function* () {
    yield { ...finish, replayState: { response: { kind: 'pi-ai', version: 2, responseId: 'bad\nresponse' } } }
  })) { /* Read to the terminal finish. */ }
  expect(records.at(-1)).toMatchObject({ response_id: null, response_model: null })
  const broken = new MuseModelRequestTrace('https://company.test', () => { throw Error('private logger error') })
  const chunks: StreamChunk[] = []
  for await (const chunk of broken.stream(request, async function* () { yield finish })) chunks.push(chunk)
  expect(chunks).toEqual([finish])
  const iterator = trace.stream(request, () => { throw Error('private source error') })[Symbol.asyncIterator]()
  await expect(iterator.next()).rejects.toThrow('private source error')
  expect(records.at(-1)).toMatchObject({ outcome: 'thrown', usage: null })
  expect(JSON.stringify(records)).not.toContain('private source error')
})

it('disables attribution for suspended and future iterators without changing their chunks', async () => {
  const records: MuseModelRequestMetadata[] = [], ids: (string | null)[] = []
  const trace = new MuseModelRequestTrace('https://company.test', value => records.push(value)), request = options('disposed')
  const source = async function* () {
    trace.credential('private-credential')
    ids.push(trace.headers({ ...request, baseURL }, new Headers()).get(header))
    yield { type: 'text-delta', index: 0, text: 'first' } as const
    ids.push(trace.headers({ ...request, baseURL }, new Headers({ [header]: 'spoof' })).get(header))
    yield finish
  }
  const iterator = trace.stream(request, source)[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual({ type: 'text-delta', index: 0, text: 'first' })
  trace.dispose()
  expect((await iterator.next()).value).toEqual(finish)
  await iterator.next()
  const next: StreamChunk[] = []
  for await (const chunk of trace.stream(request, source)) next.push(chunk)
  expect(next).toEqual([{ type: 'text-delta', index: 0, text: 'first' }, finish])
  expect(ids[0]).toMatch(uuid)
  expect(ids.slice(1)).toEqual([null, null, null])
  expect(records).toHaveLength(1)
  expect(trace.identifier('private-credential', 'id')).toBeNull()
})
