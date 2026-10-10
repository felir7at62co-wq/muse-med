import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MuseAsrClient } from '../src/asr.ts'
import { writeMuseSession } from '../src/session.ts'

const dirs: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(fetcher?: typeof fetch) {
  const dir = await mkdtemp(join(tmpdir(), 'muse-asr-client-'))
  dirs.push(dir)
  const baseUrl = 'https://muse.test', sessionFile = join(dir, 'session.json'), file = join(dir, 'clip.mp3')
  await writeMuseSession(sessionFile, { baseUrl, cookie: '__Host-muse=secret-session', username: 'alice' })
  await writeFile(file, 'mock mp3')
  return {
    client: new MuseAsrClient({ baseUrl, sessionFile, requestTimeoutMs: 2000, ...(fetcher === undefined ? {} : { fetcher }) }),
    file,
    sessionFile,
  }
}

it('uses the current account cookie and a persisted UUID without returning credentials', async () => {
  const id = randomUUID(), seen: Array<{ url: string; init: RequestInit }> = []
  const fetcher: typeof fetch = async (url, init) => {
    seen.push({ url: url instanceof URL ? url.href : typeof url === 'string' ? url : url.url, init: init! })
    return new Response(JSON.stringify({ id, status: 'processing' }), { status: 202 })
  }
  const { client, file } = await fixture(fetcher)
  expect(await client.submit(file, id, 'a'.repeat(64), 'zh')).toEqual({ id, status: 'processing' })
  expect(await client.get(id)).toEqual({ id, status: 'processing' })
  expect(seen.map(item => item.url)).toEqual(['https://muse.test/api/asr/jobs', `https://muse.test/api/asr/jobs/${id}`])
  expect(new Headers(seen[0]!.init.headers).get('cookie')).toContain('__Host-muse=secret-session')
  expect(JSON.stringify(await client.get(id))).not.toContain('secret-session')
})

it('reports an unconfigured server and a missing old task as distinct failures', async () => {
  const id = randomUUID()
  const missing = await fixture(async () => new Response('{}', { status: 404 }))
  await expect(missing.client.submit(missing.file, id, 'a'.repeat(64), 'zh')).rejects.toMatchObject({ code: 'server-not-configured' })
  await expect(missing.client.get(id)).rejects.toMatchObject({ code: 'job-not-found' })
  const unavailable = await fixture(async () => new Response('{}', { status: 503 }))
  await expect(unavailable.client.get(id)).rejects.toMatchObject({ code: 'server-not-configured' })
})


it('retains word times and rejects invalid nested timing from the gateway', async () => {
  const id = randomUUID()
  let words = [{ start: 1, end: 2, text: 'hello' }]
  const setup = await fixtureForWords()
  async function fixtureForWords() {
    return await fixture(async () => new Response(JSON.stringify({ id, status: 'complete', segments: [{ start: 0, end: 3, text: 'hello', words }] })))
  }
  expect((await setup.client.get(id)).segments?.[0]?.words).toEqual(words)
  words = [{ start: -1, end: 2, text: 'hello' }]
  await expect(setup.client.get(id)).rejects.toMatchObject({ code: 'response-invalid' })
})

it('retains optional speaker identities and rejects malformed gateway identities', async () => {
  const id = randomUUID()
  let speaker: unknown = 'speaker_1'
  const setup = await fixture(async () => Response.json({ id, status: 'complete', segments: [{ start: 0, end: 1, text: '你好', speaker_id: speaker }] }))
  expect((await setup.client.get(id)).segments?.[0]?.speaker_id).toBe('speaker_1')
  for (speaker of ['', '  ', 0, null, { id: 'speaker_1' }]) {
    await expect(setup.client.get(id)).rejects.toMatchObject({ code: 'response-invalid' })
  }
  speaker = undefined
  expect((await setup.client.get(id)).segments?.[0]).not.toHaveProperty('speaker_id')
})

it.each(['subtitles', 'screenplay'] as const)('sends %s purpose only when submitting a new purpose-bound task', async (purpose) => {
  const id = randomUUID(), headers: Headers[] = []
  const setup = await fixture(async (_url, init) => {
    headers.push(new Headers(init?.headers))
    return new Response(JSON.stringify({ id, status: 'processing', purpose, service_version: purpose === 'subtitles' ? 'flash' : 'standard-v2' }))
  })
  expect((await setup.client.submit(setup.file, id, 'a'.repeat(64), 'zh', purpose)).purpose).toBe(purpose)
  await setup.client.get(id)
  expect(headers.map(row => row.get('x-muse-asr-purpose'))).toEqual([purpose, null])
  await setup.client.submit(setup.file, id, 'a'.repeat(64), 'zh')
  expect(headers[2]?.has('x-muse-asr-purpose')).toBe(false)
})

it('accepts old responses without route metadata and rejects invalid optional route metadata', async () => {
  const id = randomUUID()
  let payload: object = { id, status: 'processing' }
  const setup = await fixture(async () => new Response(JSON.stringify(payload)))
  expect(await setup.client.get(id)).toEqual(payload)
  for (const metadata of [{ purpose: 'other' }, { service_version: 'unknown' }]) {
    payload = { id, status: 'processing', ...metadata }
    await expect(setup.client.get(id)).rejects.toMatchObject({ code: 'response-invalid' })
  }
})

it.each(['queue_full', 'upload_busy', 'request_rate', 'provider_rate', 'daily_quota'] as const)('reports safe %s and Retry-After without upstream diagnostic text', async (errorCode) => {
  const setup = await fixture(async () => new Response(JSON.stringify({ error_code: errorCode, detail: 'provider-secret' }), { status: 429, headers: { 'retry-after': '12' } }))
  await expect(setup.client.submit(setup.file, randomUUID(), 'a'.repeat(64), 'zh', 'screenplay')).rejects.toMatchObject({ code: errorCode, retryAfterSeconds: 12 })
  await expect(setup.client.get(randomUUID())).rejects.not.toThrow('provider-secret')
})

it('distinguishes a purpose conflict and ignores unrecognized error data', async () => {
  const conflict = await fixture(async () => new Response(JSON.stringify({ error_code: 'idempotency_conflict' }), { status: 409 }))
  await expect(conflict.client.get(randomUUID())).rejects.toMatchObject({ code: 'idempotency_conflict' })
  const other = await fixture(async () => new Response(JSON.stringify({ error_code: 'provider-secret' }), { status: 429, headers: { 'retry-after': 'not-a-number' } }))
  await expect(other.client.get(randomUUID())).rejects.toMatchObject({ code: 'request-rejected', retryAfterSeconds: undefined })
})

it('distinguishes a temporary admission pause from an unconfigured transcription endpoint', async () => {
  const paused = await fixture(async () => new Response('deployment private detail', { status: 503, headers: { 'retry-after': '2' } }))
  await expect(paused.client.submit(paused.file, randomUUID(), 'a'.repeat(64), 'zh', 'screenplay')).rejects.toMatchObject({ code: 'server-unavailable', retryAfterSeconds: 2 })
  const missing = await fixture(async () => new Response('{}', { status: 405, headers: { 'retry-after': '2' } }))
  await expect(missing.client.submit(missing.file, randomUUID(), 'a'.repeat(64), 'zh')).rejects.toMatchObject({ code: 'server-not-configured' })
})

it('requires a local login and never dispatches a signed-out status query', async () => {
  const transport = vi.fn<typeof fetch>()
  const setup = await fixture(transport)
  await rm(setup.sessionFile)
  await expect(setup.client.get(randomUUID())).rejects.toMatchObject({ code: 'sign-in-required' })
  expect(transport).not.toHaveBeenCalled()
})

it.each([303, 401])('requires renewed authentication after gateway status %s', async (status) => {
  const setup = await fixture(async () => new Response('', { status }))
  await expect(setup.client.get(randomUUID())).rejects.toMatchObject({ code: 'sign-in-required' })
})

it('uses the default transport and the WAV media type for a local WAV upload', async () => {
  const id = randomUUID()
  const transport = vi.fn<typeof fetch>(async () => Response.json({ id, status: 'silent', retentionExpired: true }))
  vi.stubGlobal('fetch', transport)
  const setup = await fixture()
  const wav = `${setup.file}.WAV`
  await writeFile(wav, 'mock wav')
  expect(await setup.client.submit(wav, id, 'b'.repeat(64), 'auto')).toEqual({ id, status: 'silent', retentionExpired: true })
  expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get('content-type')).toBe('audio/wav')
})

it('bounds network failures and unreadable error bodies without leaking provider details', async () => {
  const offline = await fixture(async () => { throw new Error('PRIVATE_PROVIDER_DETAIL') })
  await expect(offline.client.get(randomUUID())).rejects.toMatchObject({ code: 'server-unavailable' })
  const invalidError = await fixture(async () => new Response('PRIVATE_PROVIDER_DETAIL', { status: 500 }))
  await expect(invalidError.client.get(randomUUID())).rejects.toMatchObject({ code: 'request-rejected' })
  const nonObject = await fixture(async () => Response.json(null, { status: 400 }))
  await expect(nonObject.client.get(randomUUID())).rejects.toMatchObject({ code: 'request-rejected' })
  const hugeRetry = await fixture(async () => Response.json({}, { status: 503, headers: { 'retry-after': '9007199254740992' } }))
  await expect(hugeRetry.client.get(randomUUID())).rejects.toMatchObject({ code: 'server-not-configured' })
})

it.each([null, [], 'string', { id: undefined }, { id: 7 }, { id: 'bad' }, { status: 'private' }, { retentionExpired: 1 }])(
  'rejects invalid job metadata before exposing response data (%j)', async (invalid) => {
    const id = randomUUID()
    const setup = await fixture(async () => Response.json(typeof invalid === 'object' && invalid !== null && !Array.isArray(invalid)
      ? { id, status: 'processing', ...invalid } : invalid))
    await expect(setup.client.get(id)).rejects.toMatchObject({ code: 'response-invalid' })
  },
)

it('rejects malformed success JSON and accepts every published service version', async () => {
  const bad = await fixture(async () => new Response('private invalid JSON'))
  await expect(bad.client.get(randomUUID())).rejects.toMatchObject({ code: 'response-invalid' })
  for (const service_version of ['flash', 'standard-v1', 'standard-v2']) {
    const id = randomUUID()
    const setup = await fixture(async () => Response.json({ id, status: 'processing', service_version }))
    expect((await setup.client.get(id)).service_version).toBe(service_version)
  }
})

it.each([undefined, [], 'bad', [null], [{ start: '0', end: 1, text: 'bad' }],
  [{ start: 0, end: '1', text: 'bad' }], [{ start: 0, end: 0, text: 'bad' }], [{ start: 0, end: 1, text: 7 }],
  [{ start: 2, end: 3, text: 'later' }, { start: 1, end: 2, text: 'earlier' }],
  [{ start: 0, end: 2, text: 'bad words', words: {} }],
  [{ start: 0, end: 2, text: 'bad words', words: [{ start: 1, end: 3, text: 'outside' }] }],
  [{ start: 0, end: 3, text: 'bad words', words: [{ start: 1, end: 2, text: 'later' }, { start: 0, end: 1, text: 'earlier' }] }]])(
  'rejects missing, unordered or out-of-range completed transcript timings (%j)', async (segments) => {
    const id = randomUUID(), setup = await fixture(async () => Response.json({ id, status: 'complete', segments }))
    await expect(setup.client.get(id)).rejects.toMatchObject({ code: 'response-invalid' })
  },
)

it('accepts a complete sentence with no word timing array', async () => {
  const id = randomUUID(), segments = [{ start: 0, end: 1, text: 'complete' }]
  const setup = await fixture(async () => Response.json({ id, status: 'complete', segments }))
  expect((await setup.client.get(id)).segments).toEqual(segments)
})

it('does not dispatch pre-cancelled uploads or queries', async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ id: randomUUID(), status: 'processing' }))
  const f = await fixture(transport), controller = new AbortController(), reason = new Error('cancelled')
  controller.abort(reason)
  await expect(f.client.submit(f.file, randomUUID(), 'a'.repeat(64), 'zh', undefined, controller.signal)).rejects.toBe(reason)
  await expect(f.client.get(randomUUID(), controller.signal)).rejects.toBe(reason)
  expect(transport).not.toHaveBeenCalled()
})

it.each(['submit', 'get'] as const)('cancels %s transport and awaits it before rejecting with the caller reason', async (method) => {
  const entered = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<undefined>()
  const id = randomUUID(), controller = new AbortController(), reason = new Error('cancelled transport')
  const f = await fixture(async (_url, init) => {
    entered.resolve(init!.signal!); await release.promise
    init!.signal!.throwIfAborted()
    return Response.json({ id, status: 'processing' })
  })
  let settled = false
  const task = method === 'submit' ? f.client.submit(f.file, id, 'a'.repeat(64), 'zh', undefined, controller.signal)
    : f.client.get(id, controller.signal)
  const observed = task.then(() => { settled = true }, () => { settled = true })
  try {
    const signal = await entered.promise
    controller.abort(reason)
    await Promise.resolve(undefined)
    expect(signal.aborted).toBe(true)
    expect(settled).toBe(false)
  } finally { release.resolve(undefined); await observed }
  await expect(task).rejects.toBe(reason)
})

it.each([200, 429])('preserves cancellation while reading a %s response body', async (status) => {
  const reading = Promise.withResolvers<undefined>(), controller = new AbortController(), reason = new Error('cancelled body')
  const f = await fixture(async (_url, init) => new Response(new ReadableStream({
    start(stream) {
      init!.signal!.addEventListener('abort', () => { stream.error(init!.signal!.reason) }, { once: true })
    },
    pull() { reading.resolve(undefined) },
  }), { status }))
  const task = f.client.get(randomUUID(), controller.signal)
  const observed = task.catch(() => {})
  await reading.promise
  controller.abort(reason)
  await observed
  await expect(task).rejects.toBe(reason)
})

it('waits for an unread response body to close before returning a rejected status', async () => {
  const cancelling = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const f = await fixture(async () => new Response(new ReadableStream({
    async cancel() { cancelling.resolve(undefined); await release.promise },
  }), { status: 401 }))
  let settled = false
  const task = f.client.get(randomUUID())
  const observed = task.then(() => { settled = true }, () => { settled = true })
  try {
    await cancelling.promise
    expect(settled).toBe(false)
  } finally { release.resolve(undefined); await observed }
  await expect(task).rejects.toMatchObject({ code: 'sign-in-required' })
})

it('retains a bounded rejection when the unused response body is already errored', async () => {
  const f = await fixture(async () => new Response(new ReadableStream({
    start(stream) { stream.error(new Error('private transport detail')) },
  }), { status: 401 }))
  await expect(f.client.get(randomUUID())).rejects.toMatchObject({ code: 'sign-in-required' })
})
