/** Muse video processing uses the current Host account and bounded gateway receipts. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MuseMediaPostprocessClient, type MuseMediaPostprocessInput, type MuseMediaPostprocessJobKey } from '../src/mediakit.ts'
import { writeMuseSession } from '../src/session.ts'

const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const input: MuseMediaPostprocessInput = { operation: 'upscale', scriptId: 123, taskId: 456,
  videoUrl: 'https://source.example/video.mp4?sig=private-source', resolution: '1080p' }
const jobKey = brandString<MuseMediaPostprocessJobKey>('d'.repeat(64))
const ready = { state: 'ready', jobKey, unit: 'CNY', amount: '4.50' }
const completed = { state: 'completed', videoUrl: 'https://storage.example/video.mp4?sig=private-output', downloadOrigin: 'https://storage.example' }

async function fixture(fetcher?: typeof fetch, signedIn = true, requestTimeoutMs = 1_000) {
  const root = await mkdtemp(join(tmpdir(), 'muse-media-postprocess-')); roots.push(root)
  const baseUrl = 'https://muse.example', sessionFile = join(root, 'session.json')
  async function signIn(name: string) {
    await writeMuseSession(sessionFile, { baseUrl, cookie: `__Host-muse=private-session-${name}`, username: name })
  }
  if (signedIn) await signIn('member')
  return { sessionFile, signIn, client: new MuseMediaPostprocessClient({ baseUrl, sessionFile, requestTimeoutMs,
    ...(fetcher === undefined ? {} : { fetcher }) }) }
}

it('previews, submits and queries one job via fixed gateway routes without following redirects', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ...ready, supplier_api_key: 'private' }))
    .mockResolvedValueOnce(Response.json({ state: 'accepted', supplierTaskId: 'private' }))
    .mockResolvedValueOnce(Response.json({ ...completed, supplierTaskId: 'private' }))
  vi.stubGlobal('fetch', fetcher)
  const { client } = await fixture()
  const localInput = { ...input, otherHostData: 'private' }
  const quote = await client.preview(localInput)
  expect(quote).toEqual(ready)
  if (quote.state !== 'ready') throw Error('Expected a ready preview')
  expect(await client.submit({ ...localInput, jobKey: quote.jobKey })).toEqual({ state: 'accepted' })
  expect(await client.status(quote.jobKey)).toEqual(completed)
  const requests = [
    ['preview', input], ['jobs', { ...input, jobKey }], [`jobs/${jobKey}`, undefined],
  ] as const
  expect(fetcher).toHaveBeenCalledTimes(requests.length)
  requests.forEach(([route, body], index) => {
    expect(fetcher).toHaveBeenNthCalledWith(index + 1, new URL(`https://muse.example/api/media-postprocess/${route}`),
      expect.objectContaining({ method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { cookie: '__Host-muse=private-session-member', origin: 'https://muse.example', accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    if (body === undefined) expect(fetcher.mock.calls[index]?.[1]).not.toHaveProperty('body')
  })
})

it('carries Jubian credentials only in the request header and sends a default-routing quote amount', async () => {
  const token = 'offline-provider-token'
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ...ready, defaultRouting: true }))
    .mockResolvedValueOnce(Response.json({ state: 'rejected', code: 'MEDIAKIT_CAPACITY_LIMIT' }))
    .mockResolvedValueOnce(Response.json({ ...ready, echoed: token }))
  const { client } = await fixture(fetcher)
  const quote = await client.preview(input, undefined, token)
  expect(quote).toEqual({ ...ready, defaultRouting: true })
  await expect(client.submit({ ...input, jobKey, quoteAmount: ready.amount }, undefined, token))
    .resolves.toEqual({ state: 'rejected', code: 'MEDIAKIT_CAPACITY_LIMIT' })
  await expect(client.preview(input, undefined, token)).rejects.toMatchObject({ code: 'MEDIAKIT_INVALID_RESPONSE' })
  expect(fetcher.mock.calls.map(([, request]) => new Headers(request?.headers).get('X-Jubian-Token')))
    .toEqual([token, token, token])
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(input))
  expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ ...input, jobKey, quoteAmount: ready.amount }))
})

it.each([
  ['media_source_unverified', 'MEDIAKIT_SOURCE_UNVERIFIED'],
  ['existing_media_processing', 'MEDIAKIT_EXISTING_PROCESSING'],
  ['unsupported_conflict', 'MEDIAKIT_UNAVAILABLE'],
])('reports preview conflict %s as a stable code without provider details', async (responseCode, code) => {
  const { client } = await fixture(vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
    code: responseCode, message: 'private-provider-detail',
  }, { status: 409 })))
  await expect(client.preview(input)).rejects.toMatchObject({ code, message: `Muse video processing: ${code}` })
})

it('treats a 404 only on a preview as ineligible and an explicit none as not found', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('internal routing detail', { status: 404 }))
    .mockResolvedValueOnce(Response.json({ state: 'ineligible', raw: 'internal' }))
    .mockResolvedValueOnce(new Response('internal routing detail', { status: 404 }))
    .mockResolvedValueOnce(Response.json({ state: 'not_found' }))
  const { client } = await fixture(fetcher)
  expect(await client.preview(input)).toEqual({ state: 'ineligible' })
  expect(await client.preview(input)).toEqual({ state: 'ineligible' })
  expect(await client.status(jobKey)).toEqual({ state: 'unknown', code: 'MEDIAKIT_UNAVAILABLE' })
  expect(await client.status(jobKey)).toEqual({ state: 'not_found' })
})

it('returns only explicit gateway decisions for the one-time fallback claim', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ claimed: true }))
    .mockResolvedValueOnce(Response.json({ claimed: false }))
    .mockResolvedValueOnce(Response.json({ claimed: 'true' }))
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
  const { client } = await fixture(fetcher)
  const { signal } = new AbortController()
  await expect(client.claimFallback(jobKey, signal)).resolves.toBe(true)
  await expect(client.claimFallback(jobKey)).resolves.toBe(false)
  await expect(client.claimFallback(jobKey)).rejects.toMatchObject({ code: 'MEDIAKIT_INVALID_RESPONSE' })
  await expect(client.claimFallback(jobKey)).rejects.toMatchObject({ code: 'MEDIAKIT_UNAVAILABLE' })
  expect(fetcher).toHaveBeenCalledTimes(4)
  for (const [url, request] of fetcher.mock.calls) {
    expect(url).toEqual(new URL(`https://muse.example/api/media-postprocess/jobs/${jobKey}/fallback`))
    expect(request).toMatchObject({ method: 'POST', redirect: 'manual', body: '{}',
      headers: { 'content-type': 'application/json' } })
    expect(request?.signal).toBeInstanceOf(AbortSignal)
  }
})

it('allows the existing route only for a new preview when there is no local Muse session', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const { client } = await fixture(fetcher, false)
  await expect(client.preview(input)).resolves.toEqual({ state: 'ineligible' })
  await expect(client.submit({ ...input, jobKey })).resolves.toEqual({ state: 'unknown', code: 'MEDIAKIT_SIGN_IN_REQUIRED' })
  await expect(client.status(jobKey)).resolves.toEqual({ state: 'unknown', code: 'MEDIAKIT_SIGN_IN_REQUIRED' })
  await expect(client.claimFallback(jobKey)).rejects.toMatchObject({ code: 'MEDIAKIT_SIGN_IN_REQUIRED' })
  expect(fetcher).not.toHaveBeenCalled()
})

it('reports a damaged local session without sending a request or disclosing session file content', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const { client, sessionFile } = await fixture(fetcher, false)
  await writeFile(sessionFile, 'unreadable private-session')
  await expect(client.preview(input)).rejects.toMatchObject({ message: 'Muse video processing: MEDIAKIT_UNAVAILABLE' })
  expect(fetcher).not.toHaveBeenCalled()
})

it.each([303, 401])('requires sign-in when the gateway rejects a preview with HTTP %s', async (http) => {
  const { client } = await fixture(async () => new Response(null, { status: http }))
  await expect(client.preview(input)).rejects.toMatchObject({ code: 'MEDIAKIT_SIGN_IN_REQUIRED' })
})

it.each([303, 401, 403, 409, 429, 503])('preserves uncertainty for non-200 submission HTTP %s without retries or raw text', async (http) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('private upstream rejection', { status: http }))
  const { client } = await fixture(fetcher)
  expect(await client.submit({ ...input, jobKey })).toEqual({ state: 'unknown',
    code: http === 303 || http === 401 ? 'MEDIAKIT_SIGN_IN_REQUIRED' : 'MEDIAKIT_UNAVAILABLE' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each([
  { state: 'rejected', code: 'MEDIAKIT_PERMISSION_DENIED' },
  { state: 'conflict', code: 'idempotency_conflict' },
  { state: 'conflict', code: 'preview_mismatch' },
  { state: 'unknown', code: 'submission_unconfirmed' },
])('uses only acknowledgements declared by the authenticated gateway', async (reply) => {
  const { client } = await fixture(async () => Response.json({ ...reply, upstreamMessage: 'private' }))
  expect(await client.submit({ ...input, jobKey })).toEqual(reply)
})

it('reports an unconfirmed submit on transport failure and drops arbitrary diagnostic codes', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(Error('private gateway internals'))
    .mockResolvedValueOnce(Response.json({ state: 'failed', code: 'secret-raw-diagnostic' }))
    .mockResolvedValueOnce(Response.json({ state: 'pending', code: { raw: 'private' }, videoUrl: completed.videoUrl }))
    .mockResolvedValueOnce(Response.json({ state: 'unknown', code: 'MEDIAKIT_RESULT_ORIGIN_UNAPPROVED' }))
  const { client } = await fixture(fetcher)
  expect(await client.submit({ ...input, jobKey })).toEqual({ state: 'unknown', code: 'MEDIAKIT_UNAVAILABLE' })
  expect(await client.status(jobKey)).toEqual({ state: 'failed' })
  expect(await client.status(jobKey)).toEqual({ state: 'pending' })
  expect(await client.status(jobKey)).toEqual({ state: 'unknown', code: 'MEDIAKIT_RESULT_ORIGIN_UNAPPROVED' })
  expect(fetcher).toHaveBeenCalledTimes(4)
})

it.each([
  ['bad URL', 'not-a-url', completed.downloadOrigin],
  ['non-HTTPS', 'http://storage.example/video.mp4', completed.downloadOrigin],
  ['credentials', 'https://user:p@storage.example/video.mp4', completed.downloadOrigin],
  ['password', 'https://:p@storage.example/video.mp4', completed.downloadOrigin],
  ['fragment', 'https://storage.example/video.mp4#secret', completed.downloadOrigin],
  ['unexpected origin', 'https://other.example/video.mp4', completed.downloadOrigin],
  ['origin with path', completed.videoUrl, 'https://storage.example/results'],
])('does not expose downloads with %s', async (_reason, videoUrl, downloadOrigin) => {
  const { client } = await fixture(async () => Response.json({ ...completed, videoUrl, downloadOrigin }))
  expect(await client.status(jobKey)).toEqual({ state: 'unknown', code: 'MEDIAKIT_INVALID_RESPONSE' })
})

it.each([
  { ...ready, amount: '0.00' }, { ...ready, amount: '10.123' }, { ...ready, unit: 'USD' }, { ...ready, jobKey: 'a/b?c' },
])('refuses a malformed quote instead of inviting fallback or submission', async (reply) => {
  const { client } = await fixture(async () => Response.json(reply))
  await expect(client.preview(input)).rejects.toMatchObject({ code: 'MEDIAKIT_INVALID_RESPONSE' })
})

it('withholds both private output and a missing-route result after an account replacement', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const { client, signIn } = await fixture(fetcher)
  fetcher.mockImplementationOnce(async () => { await signIn('other'); return Response.json(completed) })
    .mockImplementationOnce(async () => { await signIn('third'); return new Response(null, { status: 404 }) })
  expect(await client.status(jobKey)).toEqual({ state: 'unknown', code: 'MEDIAKIT_ACCOUNT_CHANGED' })
  await expect(client.preview(input)).rejects.toMatchObject({ code: 'MEDIAKIT_ACCOUNT_CHANGED' })
})

it('opens no transport for a stopped caller and cancels a stalled reply when the deadline expires', async () => {
  const cancelled = vi.fn(), fetching = vi.fn<typeof fetch>()
  fetching.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'content-type': 'application/json' } }))
  const { client } = await fixture(fetching, true, 500)
  const stop = new AbortController()
  stop.abort()
  await expect(client.submit({ ...input, jobKey }, stop.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetching).not.toHaveBeenCalled()
  expect(await client.submit({ ...input, jobKey })).toEqual({ state: 'unknown', code: 'MEDIAKIT_UNAVAILABLE' })
  expect(fetching).toHaveBeenCalledTimes(1)
  expect(cancelled).toHaveBeenCalledTimes(1)
})

it.each([
  () => new Response(null, { headers: { 'content-type': 'application/json' } }),
  () => new Response(JSON.stringify(ready)),
  () => new Response('not JSON', { headers: { 'content-type': 'application/json' } }),
  () => Response.json({ ...ready, extra: '字'.repeat(6_000) }),
  () => Response.json({ ...ready, echoed: 'private-session-member' }),
])('rejects a missing, unbounded or unsafe reply as fixed diagnostics', async (reply) => {
  const { client } = await fixture(async () => reply())
  await expect(client.preview(input)).rejects.toMatchObject({ message: 'Muse video processing: MEDIAKIT_INVALID_RESPONSE' })
})

it('keeps the fixed HTTP error if discarding an unread response fails', async () => {
  const { client } = await fixture(async () => new Response(new ReadableStream({
    cancel() { throw new Error('private error during cleanup') },
  }), { status: 403 }))
  await expect(client.preview(input)).rejects.toMatchObject({ code: 'MEDIAKIT_UNAVAILABLE' })
})

it('keeps the fixed validation error if discarding an oversized reply fails', async () => {
  const { client } = await fixture(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16_385)) },
    cancel() { throw new Error('private error during cleanup') },
  }), { headers: { 'content-type': 'application/json' } }))
  await expect(client.preview(input)).rejects.toMatchObject({ code: 'MEDIAKIT_INVALID_RESPONSE' })
})
