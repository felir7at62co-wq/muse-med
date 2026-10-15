import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { streamWithModelLease } from '../src/model-direct.ts'
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

it.each([401, 429, 503])('never contacts the supplier when admission returns %i', async (status) => {
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; return new Response('', { status }) }
  await expect(drain(streamWithModelLease({ baseUrl, sessionFile, revision, requestTimeoutMs: 1000, fetcher }, 'glm-test',
    new AbortController().signal, () => { throw new Error('Supplier must not start') }))).rejects.toMatchObject({ code: status === 401 ? 'AUTH' : 'RATE_LIMIT' })
  expect(calls).toBe(1)
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
  await expect(drain(streamWithModelLease(options, 'glm-test', controller.signal, finished))).rejects.toThrow('cancelled')
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
  await result
  expect(supplierSignal?.aborted).toBe(true)
  expect(calls).toEqual(kind === 'login' ? ['POST', 'DELETE'] : ['POST', 'GET', 'DELETE'])
})


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
