import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { streamWithModelLease } from '../src/model-direct.ts'
import { safeMuseModelStream } from '../src/model-errors.ts'
import { writeMuseSession, readMuseSession } from '../src/session.ts'

let root: string
const baseUrl = 'https://muse.test'
let revision: string
let sessionFile: string
const id = 'c0b928a2-9bea-416b-80f0-cbd051fba1c9'
const lease = (): object => ({ id, apiKey: 'temporary.signed.token', baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  deadline: Date.now() + 60000, requestMs: 60000, checkMs: 1000 })
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'muse-direct-client-'))
  sessionFile = join(root, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl, username: 'fixture', cookie: '__Host-muse=fixture-session' })
  const session = await readMuseSession(sessionFile, baseUrl)
  if (!session) throw new Error('Missing fixture login')
  revision = session.revision
})
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }) })
async function drain(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}
async function* finished(): AsyncGenerator<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }

it('keeps content out of admission, acquires once, returns supplier chunks and releases on completion', async () => {
  const calls: string[] = []
  const fetcher: typeof fetch = async (url, init) => {
    calls.push(init?.method ?? '')
    expect(new URL(url instanceof Request ? url.url : url).origin).toBe(baseUrl)
    expect(new Headers(init?.headers).get('cookie')).toBe('__Host-muse=fixture-session')
    if (init?.method === 'POST') expect(JSON.parse(typeof init.body === 'string' ? init.body : '')).toEqual({ model: 'glm-test' })
    return Response.json(init?.method === 'POST' ? lease() : { released: true })
  }
  const chunks = await drain(streamWithModelLease({ baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test',
    new AbortController().signal, (access, signal) => {
      expect(access.apiKey).toBe('temporary.signed.token'); expect(signal.aborted).toBe(false)
      return finished()
    }))
  expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  expect(calls).toEqual(['POST', 'DELETE'])
  expect(JSON.stringify(chunks)).not.toContain('temporary.signed.token')
})

it.each([
  [400, 'INVALID_REQUEST'], [401, 'AUTH'], [403, 'AUTH'], [404, 'INVALID_REQUEST'],
  [429, 'RATE_LIMIT'], [500, 'SERVER'], [503, 'SERVER'],
] as const)('never contacts the supplier when admission returns %i (%s)', async (status, code) => {
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; return new Response('', { status }) }
  await expect(drain(streamWithModelLease({ baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test',
    new AbortController().signal, () => { throw new Error('Supplier must not start') }))).rejects.toMatchObject({ code })
  expect(calls).toBe(1)
})

it.each([
  ['fetch failure', 'MODEL_ACCESS_UNCERTAIN'],
  ['body failure', 'MODEL_ACCESS_UNCERTAIN'],
  ['uncancelled AbortError', 'MODEL_ACCESS_UNCERTAIN'],
  ['fetch cancellation', 'ABORTED'],
  ['body cancellation', 'ABORTED'],
  ['invalid JSON', 'INVALID_CONFIG'],
])('keeps %s admission failures safe and outside default retry', async (kind, code) => {
  const secret = 'synthetic-secret https://supplier.test/private Cookie=synthetic-cookie'
  const upstream = new Error(secret, { cause: new Error(secret) })
  if (kind === 'uncancelled AbortError') upstream.name = 'AbortError'
  const controller = new AbortController()
  const supplier = vi.fn(finished)
  const fetcher = vi.fn<typeof fetch>(async () => {
    if (kind === 'fetch cancellation') controller.abort(upstream)
    if (kind === 'fetch failure' || kind === 'fetch cancellation' || kind === 'uncancelled AbortError') throw upstream
    if (kind === 'invalid JSON') return new Response(secret)
    const response = Response.json(lease())
    vi.spyOn(response, 'text').mockImplementation(async () => {
      if (kind === 'body cancellation') controller.abort(upstream)
      throw upstream
    })
    return response
  })
  const pending = drain(safeMuseModelStream(() => streamWithModelLease(
    { baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test', controller.signal, supplier,
  )))
  await expect(pending).rejects.toMatchObject({ code, failure: { code } })
  await expect(pending).rejects.not.toHaveProperty('cause')
  const failure: unknown = await pending.catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(LlmError)
  if (!(failure instanceof LlmError)) throw new Error('Expected a safe model failure')
  expect(failure.message).not.toContain('synthetic')
  expect(failure.message).not.toContain('supplier.test')
  expect(JSON.stringify(failure)).not.toContain('synthetic')
  expect(JSON.stringify(failure)).not.toContain('supplier.test')
  const policy = resolveRetryPolicy(undefined, 'fixture')
  expect(policy.mode).toBe('normal')
  if (policy.mode !== 'normal') throw new Error('Expected the default retry policy')
  expect(policy.retryableCodes).not.toContain(failure.code)
  expect(supplier).not.toHaveBeenCalled()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each([
  [400, 'INVALID_REQUEST'], [401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [503, 'SERVER'],
] as const)('preserves safe HTTP facts for admission %i (%s)', async (status, code) => {
  const secret = 'synthetic-secret https://supplier.test/private Cookie=synthetic-cookie'
  const supplier = vi.fn(finished)
  const fetcher = vi.fn<typeof fetch>(async () => new Response(secret, {
    status, headers: { 'retry-after': '2', 'x-request-id': 'synthetic-request' },
  }))
  const pending = drain(safeMuseModelStream(() => streamWithModelLease(
    { baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test', new AbortController().signal, supplier,
  )))
  await expect(pending).rejects.toMatchObject({ code, failure: { code, status, providerRetryAfterMs: 2000 } })
  await expect(pending).rejects.not.toHaveProperty('cause')
  const failure: unknown = await pending.catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(LlmError)
  if (!(failure instanceof LlmError)) throw new Error('Expected a safe model failure')
  expect(failure.message).not.toContain('synthetic')
  expect(failure.message).not.toContain('supplier.test')
  expect(JSON.stringify(failure)).not.toContain('synthetic')
  expect(JSON.stringify(failure)).not.toContain('supplier.test')
  expect(failure.failure).not.toHaveProperty('requestId')
  expect(supplier).not.toHaveBeenCalled()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each(['0', '-1', 'Infinity', 'synthetic-secret', 'Sat, 01 Jan 2000 00:00:00 GMT'])(
  'omits an invalid or expired admission Retry-After value %s', async (retryAfter) => {
    const fetcher: typeof fetch = async () => new Response('', { status: 429, headers: { 'retry-after': retryAfter } })
    const pending = drain(safeMuseModelStream(() => streamWithModelLease(
      { baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test', new AbortController().signal, finished,
    )))
    await expect(pending).rejects.toMatchObject({ code: 'RATE_LIMIT', failure: { status: 429 } })
    await expect(pending).rejects.not.toHaveProperty('failure.providerRetryAfterMs')
  },
)

it('preserves a future admission Retry-After date as a positive delay', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(new Date('2026-10-21T00:00:00Z'))
    const fetcher: typeof fetch = async () => new Response('', {
      status: 503, headers: { 'retry-after': 'Wed, 21 Oct 2026 00:00:03 GMT' },
    })
    await expect(drain(safeMuseModelStream(() => streamWithModelLease(
      { baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test', new AbortController().signal, finished,
    )))).rejects.toMatchObject({ code: 'SERVER', failure: { status: 503, providerRetryAfterMs: 3000 } })
  } finally { vi.useRealTimers() }
})

it.each(['empty', 'cancelled', 'cleanup failure'])('preserves HTTP rejection after %s body cleanup', async (kind) => {
  const response = new Response(kind === 'empty' ? null : 'unread', { status: 403 })
  const cancel = response.body && vi.spyOn(response.body, 'cancel')
  if (kind === 'cleanup failure') cancel?.mockRejectedValue(new Error('synthetic-cleanup-secret'))
  const fetcher: typeof fetch = async () => response
  await expect(drain(safeMuseModelStream(() => streamWithModelLease(
    { baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test', new AbortController().signal, finished,
  )))).rejects.toMatchObject({ code: 'AUTH', failure: { status: 403 } })
  if (cancel) expect(cancel).toHaveBeenCalledTimes(1)
})

it.each(['caller', 'deadline'])('releases known access before dispatch after %s cancellation', async (kind) => {
  const controller = new AbortController()
  const timeout = kind === 'deadline'
    ? vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(AbortSignal.abort(new DOMException('expired', 'TimeoutError')))
    : undefined
  const calls: string[] = []
  const supplier = vi.fn(finished)
  const fetcher: typeof fetch = async (_url, init) => {
    calls.push(String(init?.method))
    if (init?.method === 'POST' && kind === 'caller') controller.abort(new Error('synthetic-cancellation-secret'))
    return Response.json(init?.method === 'POST' ? lease() : {})
  }
  try {
    await expect(drain(safeMuseModelStream(() => streamWithModelLease(
      { baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test', controller.signal, supplier,
    )))).rejects.toMatchObject({ code: kind === 'caller' ? 'ABORTED' : 'MODEL_REQUEST_DEADLINE' })
    const policy = resolveRetryPolicy(undefined, 'fixture')
    expect(policy.mode).toBe('normal')
    if (policy.mode !== 'normal') throw new Error('Expected the default retry policy')
    expect(policy.retryableCodes).not.toContain(kind === 'caller' ? 'ABORTED' : 'MODEL_REQUEST_DEADLINE')
    expect(calls).toEqual(['POST', 'DELETE'])
    expect(supplier).not.toHaveBeenCalled()
  } finally { timeout?.mockRestore() }
})

it('keeps an unclassified supplier failure outside default retry after admission succeeds', async () => {
  const calls: string[] = []
  const fetcher: typeof fetch = async (_url, init) => {
    calls.push(String(init?.method)); return Response.json(init?.method === 'POST' ? lease() : {})
  }
  const supplier = vi.fn(async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'Partial result' }
    throw new Error('synthetic-secret https://supplier.test/private Cookie=synthetic-cookie')
  })
  const chunks: StreamChunk[] = []
  const pending = (async () => {
    for await (const chunk of safeMuseModelStream(() => streamWithModelLease(
      { baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test', new AbortController().signal, supplier,
    ))) chunks.push(chunk)
  })()
  await expect(pending).rejects.toMatchObject({ code: 'UNKNOWN', failure: { code: 'UNKNOWN' } })
  await expect(pending).rejects.not.toHaveProperty('cause')
  const failure: unknown = await pending.catch((error: unknown) => error)
  expect(JSON.stringify(failure)).not.toContain('synthetic')
  const policy = resolveRetryPolicy(undefined, 'fixture')
  expect(policy.mode).toBe('normal')
  if (policy.mode !== 'normal') throw new Error('Expected the default retry policy')
  expect(policy.retryableCodes).not.toContain('UNKNOWN')
  expect(chunks).toEqual([{ type: 'text-delta', index: 0, text: 'Partial result' }])
  expect(supplier).toHaveBeenCalledTimes(1)
  expect(calls).toEqual(['POST', 'DELETE'])
})

it.each(['bad', 'oversized', 'private', 'invalid', 'missing'])('rejects %s credentials without starting the supplier', async (kind) => {
  const value = kind === 'oversized' ? 'x'.repeat(8193) : kind === 'bad' ? 'not-json'
    : JSON.stringify(kind === 'private' ? { ...lease(), baseURL: 'http://10.0.0.1' }
      : kind === 'invalid' ? { ...lease(), baseURL: 'not-url' } : {})
  const fetcher: typeof fetch = async () => new Response(value)
  await expect(drain(streamWithModelLease({ baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test',
    new AbortController().signal, () => { throw new Error('Supplier must not start') }))).rejects.toBeDefined()
})

it('does not acquire for a stale login or a previously cancelled request', async () => {
  const fetcher: typeof fetch = async () => { throw new Error('Admission must not start') }
  const options = { baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }
  await expect(drain(streamWithModelLease({ ...options, revision: 'stale' }, 'glm-test', new AbortController().signal, finished))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  const controller = new AbortController(); controller.abort(Error('cancelled'))
  await expect(drain(streamWithModelLease(options, 'glm-test', controller.signal, finished))).rejects.toMatchObject({ code: 'ABORTED' })
})

it('releases without dispatch when login changes while admission is pending', async () => {
  const calls: string[] = []
  const fetcher: typeof fetch = async (_url, init) => {
    calls.push(String(init?.method))
    if (init?.method === 'POST') await writeMuseSession(sessionFile, { baseUrl, username: 'next', cookie: '__Host-muse=new-login' })
    return Response.json(lease())
  }
  await expect(drain(streamWithModelLease({ baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test',
    new AbortController().signal, finished))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  expect(calls).toEqual(['POST', 'DELETE'])
})

it('preserves output when release is unavailable and never retries admission or generation', async () => {
  const calls: string[] = []
  const fetcher: typeof fetch = async (_url, init) => {
    calls.push(String(init?.method)); if (init?.method === 'DELETE') throw Error('offline')
    return Response.json(lease())
  }
  expect(await drain(streamWithModelLease({ baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test', new AbortController().signal, finished))).toHaveLength(1)
  expect(calls).toEqual(['POST', 'DELETE'])
})

it.each(['ok', 'rejected', 'login'])('checks %s session liveness and settles the checker before release', async (kind) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  let checked!: () => void
  const observed = new Promise<void>((resolve) => { checked = resolve })
  const controller = new AbortController()
  const calls: string[] = []
  const fetcher: typeof fetch = async (_url, init) => {
    calls.push(String(init?.method))
    if (init?.method === 'GET') { checked(); return Response.json({}, { status: kind === 'rejected' ? 401 : 200 }) }
    return Response.json(lease())
  }
  let supplierSignal: AbortSignal | undefined
  const result = drain(streamWithModelLease({ baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test', controller.signal,
    async function* (_access, signal) {
      supplierSignal = signal; entered()
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled' } } }
    }))
  await started
  if (kind === 'login') await writeMuseSession(sessionFile, { baseUrl, username: 'next', cookie: '__Host-muse=next' })
  await vi.advanceTimersByTimeAsync(1000)
  if (kind !== 'login') await observed
  if (kind === 'ok') {
    await vi.waitFor(() => { expect(vi.getTimerCount()).toBe(1) })
    controller.abort()
  }
  expect(await result).toMatchObject([{ type: 'finish', reason: kind === 'ok'
    ? { kind: 'aborted', failure: { code: 'ABORTED' } }
    : { kind: 'error', failure: { code: 'MODEL_ACCESS_CHECK_FAILED', ...kind === 'rejected' ? { status: 401 } : {} } },
  }])
  expect(supplierSignal?.aborted).toBe(true)
  expect(calls).toEqual(kind === 'login' ? ['POST', 'DELETE'] : ['POST', 'GET', 'DELETE'])
})

it.each(['http', 'transport', 'supplier throw'])(
  'keeps a failed liveness check distinct from %s failure without repeating the request', async (kind) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const calls: string[] = []
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const fetcher: typeof fetch = async (_url, init) => {
      calls.push(String(init?.method))
      if (init?.method !== 'GET') return Response.json(init?.method === 'POST' ? lease() : {})
      if (kind === 'transport') throw new Error('synthetic-secret')
      return new Response('synthetic-secret', { status: 429, headers: { 'retry-after': '2' } })
    }
    const result = drain(safeMuseModelStream(() => streamWithModelLease(
      { baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test', new AbortController().signal,
      async function* (_access, signal) {
        entered()
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        if (kind === 'supplier throw') throw new Error('synthetic-secret')
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'synthetic-secret' } } }
      },
    )))
    const settled = result.catch((error: unknown) => error)
    await started
    await vi.advanceTimersByTimeAsync(1000)
    if (kind === 'supplier throw') {
      expect(await settled).toMatchObject({ code: 'MODEL_ACCESS_CHECK_FAILED', failure: {
        code: 'MODEL_ACCESS_CHECK_FAILED', status: 429, providerRetryAfterMs: 2000,
      } })
      expect(await settled).not.toHaveProperty('cause')
    } else {
      const chunks = await result
      expect(chunks).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: {
        code: 'MODEL_ACCESS_CHECK_FAILED', ...kind === 'http' ? { status: 429, providerRetryAfterMs: 2000 } : {},
      } } }])
      expect(JSON.stringify(chunks)).not.toContain('synthetic-secret')
    }
    const policy = resolveRetryPolicy(undefined, 'fixture')
    if (policy.mode !== 'normal') throw new Error('Expected bounded provider retry policy')
    expect(policy.retryableCodes).not.toContain('MODEL_ACCESS_CHECK_FAILED')
    expect(calls).toEqual(['POST', 'GET', 'DELETE'])
  },
)

it.each(['finish', 'throw'])(
  'retains an in-flight access deadline when the supplier cancels through %s', async (delivery) => {
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal)
    const calls: string[] = []
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const fetcher: typeof fetch = async (_url, init) => {
      calls.push(String(init?.method))
      return Response.json(init?.method === 'POST' ? lease() : {})
    }
    const result = drain(safeMuseModelStream(() => streamWithModelLease(
      { baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test', new AbortController().signal,
      async function* (_access, signal) {
        entered()
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        if (delivery === 'throw') throw new Error('synthetic-secret')
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'synthetic-secret' } } }
      },
    )))
    const settled = result.catch((error: unknown) => error)
    try {
      await started
      deadline.abort(new DOMException('synthetic-secret', 'TimeoutError'))
      if (delivery === 'throw') {
        expect(await settled).toMatchObject({ code: 'MODEL_REQUEST_DEADLINE', failure: { code: 'MODEL_REQUEST_DEADLINE' } })
        expect(await settled).not.toHaveProperty('cause')
      } else {
        expect(await result).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_REQUEST_DEADLINE' } } }])
      }
      expect(calls).toEqual(['POST', 'DELETE'])
    } finally { timeout.mockRestore() }
  },
)


it('uses the default transport without exposing the temporary credential to gateway calls', async () => {
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => Response.json(init?.method === 'POST' ? lease() : {}))
  expect(await drain(streamWithModelLease({ baseUrl, sessionFile, revision, requestTimeoutMs: 1000 }, 'glm-test',
    new AbortController().signal, finished))).toHaveLength(1)
})

it('releases after supplier failure and after the consumer stops early', async () => {
  const calls: string[] = []
  const fetcher: typeof fetch = async (_url, init) => {
    calls.push(String(init?.method)); return Response.json(init?.method === 'POST' ? lease() : {})
  }
  const options = { baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }
  let closed = false
  const stream = streamWithModelLease(options, 'glm-test', new AbortController().signal, async function* () {
    try { yield { type: 'text-delta', index: 0, text: 'partial' }; throw Error('supplier disconnected') }
    finally { closed = true }
  })
  await expect(drain(stream)).rejects.toThrow('supplier disconnected')
  expect(closed).toBe(true)
  for await (const _chunk of streamWithModelLease(options, 'glm-test', new AbortController().signal, finished)) break
  expect(calls).toEqual(['POST', 'DELETE', 'POST', 'DELETE'])
})
