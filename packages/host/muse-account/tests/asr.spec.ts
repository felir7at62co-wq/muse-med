import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MuseAsrClient } from '../src/asr.ts'
import { writeMuseSession } from '../src/session.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(fetcher: typeof fetch) {
  const dir = await mkdtemp(join(tmpdir(), 'muse-asr-client-'))
  dirs.push(dir)
  const baseUrl = 'https://muse.test', sessionFile = join(dir, 'session.json'), file = join(dir, 'clip.mp3')
  await writeMuseSession(sessionFile, { baseUrl, cookie: '__Host-muse=secret-session', username: 'alice' })
  await writeFile(file, 'mock mp3')
  return { client: new MuseAsrClient({ baseUrl, sessionFile, requestTimeoutMs: 2000, fetcher }), file }
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
