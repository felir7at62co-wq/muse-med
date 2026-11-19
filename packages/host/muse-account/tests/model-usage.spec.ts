import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { MuseModelUsageReporter } from '../src/model-usage.ts'
import type { MuseModelRequestMetadata } from '../src/model-request-trace.ts'
import { MuseModelRequestTrace } from '../src/model-request-trace.ts'
import { readMuseSession, writeMuseSession } from '../src/session.ts'

const baseUrl = 'https://muse.example'
const roots: string[] = []
const reporters: MuseModelUsageReporter[] = []
afterEach(async () => {
  await Promise.all(reporters.splice(0).map(reporter => reporter.dispose()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(fetcher: typeof fetch, failed = vi.fn()): Promise<{
  reporter: MuseModelUsageReporter
  revision: string
  sessionFile: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'muse-model-usage-'))
  roots.push(root)
  const sessionFile = join(root, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl, cookie: '__Host-muse=original', username: 'original' })
  const session = await readMuseSession(sessionFile, baseUrl)
  if (session === null) throw new Error('Missing fixture session')
  const reporter = new MuseModelUsageReporter({ baseUrl, sessionFile, requestTimeoutMs: 1000, fetcher }, failed)
  reporters.push(reporter)
  return { reporter, revision: session.revision, sessionFile }
}

function record(): MuseModelRequestMetadata {
  return { event: 'model_client_request_metadata', phase: 'finish',
    client_request_id: brandString<Branded<'MuseClientRequestId'>>('58ba3b25-132c-4397-8b40-2545ba74f9cb'),
    session_id: null, provider: 'supplier-direct', model: 'sample-model', purpose: null, outcome: 'finished', stop: 'stop',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 20, reasoningTokens: 1 } }
}

it('keeps a direct request attributed to its captured account after another login is saved', async () => {
  let sent!: () => void
  const observed = new Promise<void>((resolve) => { sent = resolve })
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(new URL(url instanceof Request ? url.url : url).href).toBe(baseUrl + '/api/muse.account/usage')
    const headers = new Headers(init?.headers)
    expect(headers.get('cookie')).toBe('__Host-muse=original')
    expect(headers.get('origin')).toBe(baseUrl)
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
      id: record().client_request_id, provider: 'supplier-direct', model: 'sample-model', status: 200,
      inputTokens: 15, outputTokens: 5, totalTokens: 20, cachedInputTokens: 3, reasoningTokens: 1,
    })
    sent()
    return new Response(null, { status: 204 })
  })
  const { reporter, revision, sessionFile } = await fixture(fetcher)
  const report = await reporter.prepare(revision)
  expect(report).toBeTypeOf('function')
  await writeMuseSession(sessionFile, { baseUrl, cookie: '__Host-muse=replacement', username: 'replacement' })
  report?.(record())
  await observed
  expect(await reporter.prepare(revision)).toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each(['error', 'aborted', 'stop'])(
  'keeps absent or synthetic-zero %s usage unknown and reports a safe failed receipt without retry', async (stop) => {
    let sent!: () => void
    const observed = new Promise<void>((resolve) => { sent = resolve })
    const failed = vi.fn()
    const { reporter, revision } = await fixture(async (_url, init) => {
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '')
      expect(body).toMatchObject({ status: stop === 'stop' ? 200 : null, inputTokens: null, outputTokens: null, totalTokens: null,
        cachedInputTokens: null, reasoningTokens: null })
      sent()
      return new Response('PRIVATE_GATEWAY_DETAIL', { status: 503 })
    }, failed)
    const report = await reporter.prepare(revision)
    report?.({ ...record(), stop, usage: stop === 'stop' ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 } : null })
    await observed
    // Disposal waits for confirmation handling as well as transport completion.
    await reporter.dispose()
    expect(failed).toHaveBeenCalledExactlyOnceWith()
  },
)

it('aborts and drains owned transport on disposal and never sends another receipt', async () => {
  let entered!: () => void, settled = false
  const started = new Promise<void>((resolve) => { entered = resolve })
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    const abort = (): void => { settled = true; reject(new Error('private abort')) }
    init?.signal?.addEventListener('abort', abort, { once: true })
    entered()
  }))
  const { reporter, revision } = await fixture(fetcher)
  const report = await reporter.prepare(revision)
  report?.(record())
  await started
  await reporter.dispose()
  expect(settled).toBe(true)
  report?.(record())
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(await reporter.prepare(revision)).toBeUndefined()
})

it('contains a failed default transport and its diagnostic callback without retrying', async () => {
  const originalFetch = globalThis.fetch
  let reported!: () => void
  const complete = new Promise<void>((resolve) => { reported = resolve })
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('PRIVATE_NETWORK_DETAIL') })
  const { revision, sessionFile } = await fixture(fetcher)
  const reporter = new MuseModelUsageReporter({ baseUrl, sessionFile, requestTimeoutMs: 1000 }, () => {
    reported()
    throw new Error('PRIVATE_OBSERVER_DETAIL')
  })
  reporters.push(reporter)
  try {
    globalThis.fetch = fetcher
    const report = await reporter.prepare(revision)
    report?.(record())
    await complete
    await reporter.dispose()
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally { globalThis.fetch = originalFetch }
  expect(globalThis.fetch).toBe(originalFetch)
})

it('reports one terminal receipt with partial usage and preserves the original stream chunks', async () => {
  const receipts: MuseModelRequestMetadata[] = []
  const trace = new MuseModelRequestTrace(baseUrl, () => undefined)
  const chunks = [{ type: 'usage' as const, usage: { inputTokens: 4, outputTokens: 2 } },
    { type: 'finish' as const, reason: { kind: 'stop' as const } }]
  try {
    const actual = []
    const stream = trace.stream({ provider: 'supplier', model: 'model', messages: [] }, async function* () {
      yield* chunks
    }, metadata => receipts.push(metadata))
    for await (const chunk of stream) actual.push(chunk)
    expect(actual).toEqual(chunks)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ phase: 'finish', stop: 'stop', usage: { inputTokens: 4, outputTokens: 2 } })
  } finally { trace.dispose() }
})
