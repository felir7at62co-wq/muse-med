/** Current-account media transport, bounded replies and owned stream lifecycle. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MuseMediaClient } from '../src/media.ts'
import type { MuseMediaJobId, MuseMediaOptions, MuseMediaRequestId } from '../src/media-types.ts'
import { writeMuseSession } from '../src/session.ts'

const origin = 'https://muse.test'
const cookie = '__Host-muse=' + 'A'.repeat(43)
const id = brandString<MuseMediaJobId>('11111111-1111-4111-8111-111111111111')
const requestId = brandString<MuseMediaRequestId>('stable-request')
const clients: MuseMediaClient[] = []
const directories: string[] = []
const result = { state: 'ok', job_id: id, tool: 'get_video', files: [], automatic_resubmit: false,
  data: { title: 'Public video', stats: { play_count: null } } }
const saved = { state: 'cloud_saved', job_id: id, tool: 'download_media', request_id: requestId,
  files: [{ name: 'video.mp4', bytes: 3, sha256: 'a'.repeat(64), kind: 'video' }],
  file_coverage: { reported: 1, accepted: 1, rejected: 0, complete: true, truncated: false }, automatic_resubmit: false }

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  const promise = new Promise<Value>((accept) => { resolve = accept })
  return { promise, resolve }
}

function requestBody(init: RequestInit | undefined) {
  if (typeof init?.body !== 'string') throw new Error('Fixture requires a JSON body')
  // The fixture reads the exact request authored by the typed transport under test.
  return JSON.parse(init.body) as { id: string; params: { name: string; arguments: Record<string, string> } }
}

function rpc(init: RequestInit | undefined, value: object = result, isError = false, responseId?: string): Response {
  return Response.json({ jsonrpc: '2.0', id: responseId ?? requestBody(init).id,
    result: { isError, structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] } })
}

function address(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

async function fixture(overrides: Partial<MuseMediaOptions> = {}, signedIn = true) {
  const directory = await mkdtemp(join(tmpdir(), 'muse-media-client-'))
  directories.push(directory)
  const sessionFile = join(directory, 'session.json')
  if (signedIn) await writeMuseSession(sessionFile, { baseUrl: origin, username: 'alice', cookie })
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => rpc(init))
  const client = new MuseMediaClient({ baseUrl: origin, sessionFile, requestTimeoutMs: 60000, fileTimeoutMs: 60000,
    maxReplyBytes: 1048576, maxFileBytes: 536870912, fetcher, ...overrides })
  clients.push(client)
  return { client, fetcher, sessionFile }
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.dispose()))
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it('does not issue a request without a matching saved Muse login', async () => {
  const value = await fixture({}, false)
  await expect(value.client.status()).rejects.toMatchObject({ code: 'sign-in-required' })
  await writeMuseSession(value.sessionFile, { baseUrl: 'https://another.test', username: 'alice', cookie })
  await expect(value.client.status()).rejects.toMatchObject({ code: 'sign-in-required' })
  expect(value.fetcher).not.toHaveBeenCalled()
})

it('uses the current private cookie, origin and unique matching RPC ID without supplier keys', async () => {
  const value = await fixture()
  const receipt = await value.client.data('get_video', { platform: 'douyin', content_id: '123' })
  expect(receipt.data).toEqual(result.data)
  const [url, init] = value.fetcher.mock.calls[0]!
  expect(address(url)).toBe(origin + '/api/media/mcp/')
  expect(init?.headers).toEqual({ cookie, origin, accept: 'application/json', 'content-type': 'application/json' })
  expect(init?.redirect).toBe('manual')
  expect(requestBody(init).params).toEqual({ name: 'get_video', arguments: { platform: 'douyin', content_id: '123' } })
  expect(JSON.stringify(receipt)).not.toContain(cookie)
})

it('retains a failed MCP tool receipt and submits each download only once with its original key', async () => {
  const value = await fixture()
  value.fetcher.mockImplementationOnce(async (_url, init) => rpc(init, { state: 'failed', code: 'job_not_found' }, true))
  await expect(value.client.data('get_video', { platform: 'douyin', content_id: '123' })).resolves
    .toEqual({ state: 'failed', code: 'job_not_found' })
  value.fetcher.mockImplementationOnce(async (_url, init) => rpc(init, saved))
  await expect(value.client.download({ platform: 'bilibili', content_id: 'av170001', requestId })).resolves
    .toMatchObject({ state: 'cloud_saved', request_id: requestId })
  expect(requestBody(value.fetcher.mock.calls[1]![1]).params.arguments.request_id).toBe(requestId)
  expect(value.fetcher).toHaveBeenCalledTimes(2)
})

it.each([
  [401, 'sign-in-required'], [403, 'company-access-required'], [404, 'not-found'],
  [409, 'request-conflict'], [429, 'rate-limited'], [503, 'unavailable'],
])('maps HTTP %s to a fixed safe failure', async (status, code) => {
  const value = await fixture()
  value.fetcher.mockResolvedValueOnce(new Response('private error ' + cookie, { status, headers: { 'retry-after': '17' } }))
  await expect(value.client.get(id)).rejects.toMatchObject({ code, ...(status === 429 ? { retryAfter: 17 } : {}) })
  expect(value.fetcher).toHaveBeenCalledTimes(1)
})

it('rejects a changed login or logout before returning account-owned results', async () => {
  const value = await fixture()
  value.fetcher.mockImplementationOnce(async (_url, init) => {
    await writeMuseSession(value.sessionFile, { baseUrl: origin, username: 'bob', cookie: '__Host-muse=' + 'B'.repeat(43) })
    return rpc(init)
  })
  await expect(value.client.data('get_video', { platform: 'douyin', content_id: '123' })).rejects.toMatchObject({ code: 'account-changed' })
  value.fetcher.mockImplementationOnce(async (_url, init) => {
    await rm(value.sessionFile)
    return rpc(init)
  })
  await expect(value.client.data('get_video', { platform: 'douyin', content_id: '123' })).rejects.toMatchObject({ code: 'account-changed' })
})

it('refuses wrong RPC IDs, missing structured data, secret fields and incomplete saved claims', async () => {
  const value = await fixture()
  value.fetcher.mockImplementationOnce(async (_url, init) => rpc(init, result, false, 'another-request'))
  await expect(value.client.data('get_video', { platform: 'douyin', content_id: '123' })).rejects
    .toMatchObject({ code: 'invalid-response' })
  value.fetcher.mockImplementationOnce(async (_url, init) => Response.json({ jsonrpc: '2.0', id: requestBody(init).id,
    result: { isError: false, content: [{ type: 'text', text: '{}' }] } }))
  await expect(value.client.data('get_video', { platform: 'douyin', content_id: '123' })).rejects
    .toMatchObject({ code: 'invalid-response' })
  for (const data of [{ cookie: 'a supplier secret' }, { title: cookie }, { title: cookie.slice('__Host-muse='.length) }]) {
    value.fetcher.mockImplementationOnce(async (_url, init) => rpc(init, { ...result, data }))
    await expect(value.client.data('get_video', { platform: 'douyin', content_id: '123' })).rejects
      .toMatchObject({ code: 'invalid-response' })
  }
  value.fetcher.mockImplementationOnce(async (_url, init) => rpc(init,
    { ...saved, file_coverage: { ...saved.file_coverage, complete: false } }))
  await expect(value.client.download({ platform: 'bilibili', content_id: '1', requestId })).rejects
    .toMatchObject({ code: 'invalid-response' })
})

it('bounds whole reply bytes and rejects malformed UTF-8', async () => {
  const value = await fixture({ maxReplyBytes: 4 })
  value.fetcher.mockResolvedValueOnce(Response.json({ ready: true }))
  await expect(value.client.status()).rejects.toMatchObject({ code: 'invalid-response' })
  const other = await fixture()
  other.fetcher.mockResolvedValueOnce(new Response(Uint8Array.from([0xff]), { headers: { 'content-type': 'application/json' } }))
  await expect(other.client.status()).rejects.toMatchObject({ code: 'invalid-response' })
})

it('aborts a blocked body on deadline and does not retry an uncertain submission', async () => {
  const deadline = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  const value = await fixture()
  const entered = deferred<undefined>()
  const cancel = vi.fn()
  value.fetcher.mockImplementationOnce(async () => {
    entered.resolve(undefined)
    return new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } })
  })
  const pending = value.client.download({ platform: 'douyin', content_id: '1', requestId })
  const assertion = expect(pending).rejects.toMatchObject({ code: 'unconfirmed' })
  await entered.promise
  deadline.abort(new DOMException('Controlled deadline', 'TimeoutError'))
  await assertion
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(value.fetcher).toHaveBeenCalledTimes(1)
})

it('honors caller cancellation before network and while reading a response', async () => {
  const value = await fixture()
  const before = new AbortController()
  before.abort()
  await expect(value.client.status(before.signal)).rejects.toMatchObject({ code: 'cancelled' })
  expect(value.fetcher).not.toHaveBeenCalled()
  const caller = new AbortController(), entered = deferred<undefined>()
  const cancel = vi.fn()
  value.fetcher.mockImplementationOnce(async () => {
    entered.resolve(undefined)
    return new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } })
  })
  const pending = value.client.status(caller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  await entered.promise
  caller.abort()
  await rejected
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('reads REST pages/status and rejects a receipt bound to another job', async () => {
  const value = await fixture()
  value.fetcher.mockResolvedValueOnce(Response.json({ jobs: [result], next_offset: 100 }))
  await expect(value.client.list(undefined, 0)).resolves.toMatchObject({ jobs: [{ job_id: id }], next_offset: 100 })
  value.fetcher.mockResolvedValueOnce(Response.json({ ready: true,
    limits: { requests_per_minute: 60, concurrent_requests: 2, downloads_per_day: 20, concurrent_downloads: 2 } }))
  await expect(value.client.status()).resolves.toMatchObject({ ready: true })
  value.fetcher.mockResolvedValueOnce(Response.json({ ...result, job_id: '22222222-2222-4222-8222-222222222222' }))
  await expect(value.client.get(id)).rejects.toMatchObject({ code: 'invalid-response' })
})

it('streams only an owned manifest file without exposing Response headers or private account fields', async () => {
  const value = await fixture()
  value.fetcher.mockResolvedValueOnce(Response.json(saved))
    .mockResolvedValueOnce(new Response('abc', { headers: { 'content-length': '3' } }))
  const output = await value.client.withFile(id, 'video.mp4', async (transfer) => {
    expect(Object.keys(transfer).sort()).toEqual(['assertCurrent', 'body', 'file', 'job', 'signal'])
    expect(transfer.file).toEqual(saved.files[0])
    const bytes = await new Response(transfer.body).text()
    await transfer.assertCurrent()
    return bytes
  })
  expect(output).toBe('abc')
  expect(address(value.fetcher.mock.calls[1]![0])).toBe(origin + `/api/media/jobs/${id}/files/video.mp4`)
})

it.each([
  ['video (1).mp4', 'video%20(1).mp4'], ['cover image.jpg', 'cover%20image.jpg'],
  ['video.mp4 ', 'video.mp4%20'], ['a'.repeat(128), 'a'.repeat(128)],
])('retains an exact safe manifest filename through file lookup and URL encoding: %j', async (name, encoded) => {
  const value = await fixture(), entry = { ...saved.files[0]!, name }
  value.fetcher.mockResolvedValueOnce(Response.json({ ...saved, files: [entry] }))
    .mockResolvedValueOnce(new Response('abc', { headers: { 'content-length': '3' } }))
  await expect(value.client.withFile(id, name, async (transfer) => {
    expect(transfer.file).toEqual(entry)
    return await new Response(transfer.body).text()
  })).resolves.toBe('abc')
  expect(value.fetcher).toHaveBeenCalledTimes(2)
  expect(address(value.fetcher.mock.calls[1]![0])).toBe(origin + `/api/media/jobs/${id}/files/${encoded}`)
})

it('does not substitute a sanitized alias for the exact manifest member', async () => {
  const value = await fixture(), consume = vi.fn()
  value.fetcher.mockResolvedValueOnce(Response.json({ ...saved, files: [{ ...saved.files[0]!, name: 'video (1).mp4' }] }))
  await expect(value.client.withFile(id, 'video_1.mp4', consume)).rejects.toMatchObject({ code: 'not-found' })
  expect(value.fetcher).toHaveBeenCalledTimes(1)
  expect(consume).not.toHaveBeenCalled()
})

it.each(['../video.mp4', 'dir/video.mp4', 'dir\\video.mp4', '.video.mp4', 'video..mp4', 'v'.repeat(129),
  'video.mp4\n', 'video.mp4\r\n'])('rejects an unsafe wire manifest name before requesting file bytes: %j', async (name) => {
  const value = await fixture(), consume = vi.fn()
  value.fetcher.mockResolvedValueOnce(Response.json({ ...saved, files: [{ ...saved.files[0]!, name }] }))
  await expect(value.client.withFile(id, name, consume)).rejects.toMatchObject({ code: 'invalid-response' })
  expect(value.fetcher).toHaveBeenCalledTimes(1)
  expect(consume).not.toHaveBeenCalled()
})

it('blocks publication after an account change during streamed import', async () => {
  const value = await fixture()
  value.fetcher.mockResolvedValueOnce(Response.json(saved)).mockResolvedValueOnce(new Response('abc'))
  let published = false
  await expect(value.client.withFile(id, 'video.mp4', async (transfer) => {
    await new Response(transfer.body).arrayBuffer()
    await writeMuseSession(value.sessionFile, { baseUrl: origin, username: 'bob', cookie: '__Host-muse=' + 'B'.repeat(43) })
    await transfer.assertCurrent()
    published = true
  })).rejects.toMatchObject({ code: 'account-changed' })
  expect(published).toBe(false)
})

it('requires complete stream consumption before returning a file callback result', async () => {
  const value = await fixture()
  value.fetcher.mockResolvedValueOnce(Response.json(saved)).mockResolvedValueOnce(new Response('abc'))
  await expect(value.client.withFile(id, 'video.mp4', async () => 'not consumed')).rejects
    .toMatchObject({ code: 'file-incomplete' })
})

it('rejects unlisted files before requesting bytes and incomplete or oversized file transfers', async () => {
  const value = await fixture({ maxFileBytes: 3 })
  value.fetcher.mockResolvedValueOnce(Response.json(saved))
  await expect(value.client.withFile(id, '../private', async () => {})).rejects.toMatchObject({ code: 'not-found' })
  expect(value.fetcher).toHaveBeenCalledTimes(1)
  value.fetcher.mockResolvedValueOnce(Response.json(saved)).mockResolvedValueOnce(new Response('ab'))
  await expect(value.client.withFile(id, 'video.mp4', async transfer => await new Response(transfer.body).arrayBuffer())).rejects
    .toMatchObject({ code: 'file-incomplete' })
  value.fetcher.mockResolvedValueOnce(Response.json(saved)).mockResolvedValueOnce(new Response('abcd'))
  await expect(value.client.withFile(id, 'video.mp4', async transfer => await new Response(transfer.body).arrayBuffer())).rejects
    .toMatchObject({ code: 'file-too-large' })
})

it('disposal cancels and awaits import callback cleanup before settling', async () => {
  const value = await fixture()
  value.fetcher.mockResolvedValueOnce(Response.json(saved)).mockResolvedValueOnce(new Response('abc'))
  const entered = deferred<undefined>(), cancelled = deferred<undefined>(), cleanup = deferred<undefined>()
  const pending = value.client.withFile(id, 'video.mp4', async (transfer) => {
    await new Response(transfer.body).arrayBuffer()
    transfer.signal.addEventListener('abort', () => { cancelled.resolve(undefined) }, { once: true })
    entered.resolve(undefined)
    await cleanup.promise
  })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  await entered.promise
  let disposed = false
  const stopping = value.client.dispose().then(() => { disposed = true })
  await cancelled.promise
  expect(disposed).toBe(false)
  cleanup.resolve(undefined)
  await rejected
  await stopping
  expect(disposed).toBe(true)
  await expect(value.client.status()).rejects.toMatchObject({ code: 'cancelled' })
})

it('confirms an import only after full consumption and native publication using its exact lease and digest', async () => {
  const value = await fixture()
  const lease = '22222222-2222-4222-8222-222222222222'
  let published = false
  value.fetcher.mockImplementation(async (url, init) => {
    const path = new URL(address(url)).pathname
    if (path.endsWith('/imported')) {
      expect(published).toBe(true)
      expect(init?.method).toBe('POST')
      expect(await new Response(init?.body).json()).toEqual({ lease, sha256: saved.files[0]!.sha256 })
      return Response.json({ state: 'acknowledged' })
    }
    if (path.endsWith('/files/video.mp4')) return new Response('abc', { headers: { 'x-muse-media-lease': lease } })
    return Response.json(saved)
  })
  const output = await value.client.withFile(id, 'video.mp4', async (transfer) => {
    expect(value.fetcher).toHaveBeenCalledTimes(2)
    expect(await new Response(transfer.body).text()).toBe('abc')
    published = true
    return 'verified local file'
  }, undefined, true)
  expect(output).toBe('verified local file')
  expect(value.fetcher).toHaveBeenCalledTimes(3)
})

it.each(['ordinary-read', 'consumer-failed', 'incomplete', 'legacy-server'] as const)(
  'does not confirm a %s transfer', async (kind) => {
    const value = await fixture()
    value.fetcher.mockResolvedValueOnce(Response.json(saved)).mockResolvedValueOnce(new Response('abc', {
      headers: kind === 'legacy-server' ? {} : { 'x-muse-media-lease': '22222222-2222-4222-8222-222222222222' },
    }))
    const operation = value.client.withFile(id, 'video.mp4', async (transfer) => {
      if (kind === 'incomplete') return 'no read'
      await new Response(transfer.body).text()
      if (kind === 'consumer-failed') throw Error('Local decoder rejected video')
      return 'read'
    }, undefined, kind !== 'ordinary-read')
    if (kind === 'incomplete' || kind === 'consumer-failed') await expect(operation).rejects.toBeDefined()
    else await expect(operation).resolves.toBe('read')
    expect(value.fetcher).toHaveBeenCalledTimes(2)
  },
)

it('keeps a verified local file when confirmation is unavailable without retrying', async () => {
  const value = await fixture()
  value.fetcher.mockResolvedValueOnce(Response.json(saved)).mockResolvedValueOnce(new Response('abc', {
    headers: { 'x-muse-media-lease': '22222222-2222-4222-8222-222222222222' },
  })).mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
  await expect(value.client.withFile(id, 'video.mp4', async (transfer) => {
    await new Response(transfer.body).arrayBuffer()
    return 'local_ready'
  }, undefined, true)).resolves.toBe('local_ready')
  expect(value.fetcher).toHaveBeenCalledTimes(3)
})

it('preserves committed local delivery if the account changes or cancellation arrives during confirmation', async () => {
  const value = await fixture()
  const controller = new AbortController()
  value.fetcher.mockResolvedValueOnce(Response.json(saved)).mockResolvedValueOnce(new Response('abc', {
    headers: { 'x-muse-media-lease': '22222222-2222-4222-8222-222222222222' },
  })).mockImplementationOnce(async () => {
    await writeMuseSession(value.sessionFile, { baseUrl: origin, username: 'bob', cookie: '__Host-muse=' + 'B'.repeat(43) })
    controller.abort()
    return Response.json({ state: 'acknowledged' })
  })
  await expect(value.client.withFile(id, 'video.mp4', async (transfer) => {
    await new Response(transfer.body).arrayBuffer()
    return 'committed_local_file'
  }, controller.signal, true)).resolves.toBe('committed_local_file')
  expect(value.fetcher).toHaveBeenCalledTimes(3)
})
