/** Private shared voice transport never leaks session/provider credentials into results or failures. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { MuseVoiceSlotsClient } from '../src/voice-slots.ts'
import { writeMuseSession } from '../src/session.ts'
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const request = { action: 'acquire' as const, script_id: 2708, character_id: 'zhou', voice_period_id: 'adult', operation_key: 'original-key' }
async function fixture(fetcher: typeof fetch, signedIn = true) {
  const root = await mkdtemp(join(tmpdir(), 'muse-voice-slots-')); roots.push(root)
  const sessionFile = join(root, 'session.json'), baseUrl = 'https://muse.example'
  if (signedIn) await writeMuseSession(sessionFile, { baseUrl, cookie: '__Host-muse=private-session', username: 'member' })
  return { sessionFile, baseUrl, client: new MuseVoiceSlotsClient({ baseUrl, sessionFile, requestTimeoutMs: 1000, fetcher }) }
}
it('uses the current cookie and provider secret in one no-redirect request only', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', headers: { cookie: '__Host-muse=private-session',
      origin: 'https://muse.example', 'x-jubian-token': 'private-jubian' }, body: JSON.stringify(request) })
    return Response.json({ state: 'available' })
  })
  const f = await fixture(fetcher)
  expect(await f.client.request(request, 'private-jubian')).toEqual({ state: 'available' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('rejects a signed-out account without making a network request', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const f = await fixture(fetcher, false)
  await expect(f.client.request(request, 'private-jubian')).rejects.toMatchObject({ code: 'sign-in-required' })
  expect(fetcher).not.toHaveBeenCalled()
})
it.each([[303, 'sign-in-required'], [401, 'sign-in-required'], [404, 'not-configured'], [405, 'not-configured'],
  [503, 'unavailable'], [403, 'rejected'], [409, 'rejected'], [429, 'rejected']])('bounds HTTP %s diagnostics without response text', async (status, code) => {
  const f = await fixture(async () => new Response('private-jubian private-session', { status }))
  await expect(f.client.request(request, 'private-jubian')).rejects.toMatchObject({ code })
})
it('does not retry a transport failure or expose its secret-bearing message', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('private-jubian private-session') })
  const f = await fixture(fetcher)
  await expect(f.client.request(request, 'private-jubian')).rejects.toMatchObject({ code: 'network', message: 'Muse voice registration coordination: network' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('rejects malformed JSON and a changed account while reading a response', async () => {
  const invalid = await fixture(async () => new Response('private invalid JSON'))
  await expect(invalid.client.request(request, 'private-jubian')).rejects.toMatchObject({ code: 'response-invalid' })
  const changed = await fixture(async () => {
    await writeMuseSession(changed.sessionFile, { baseUrl: changed.baseUrl, cookie: '__Host-muse=another', username: 'another' })
    return Response.json({ state: 'reserved' })
  })
  await expect(changed.client.request(request, 'private-jubian')).rejects.toMatchObject({ code: 'account-changed' })
})

it('uses the default Host fetch transport with the current private session', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ state: 'available' }))
  vi.stubGlobal('fetch', fetcher)
  const f = await fixture(fetcher)
  const client = new MuseVoiceSlotsClient({ baseUrl: f.baseUrl, sessionFile: f.sessionFile, requestTimeoutMs: 1000 })
  expect(await client.request(request, 'private-jubian')).toEqual({ state: 'available' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each([new Uint8Array([0xc3, 0x28]), Buffer.from('"' + '字'.repeat(5500) + '"')])('rejects malformed UTF8 and oversized bytes', async (bytes) => {
  const f = await fixture(async () => new Response(bytes))
  await expect(f.client.request(request, 'private-jubian')).rejects.toMatchObject({ code: 'response-invalid' })
})
it('cancels an oversized streamed reply without retaining or exposing its contents', async () => {
  let cancelled = false
  const f = await fixture(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(16000)); controller.enqueue(new Uint8Array(1000))
  }, cancel() { cancelled = true } })))
  await expect(f.client.request(request, 'private-jubian')).rejects.toMatchObject({ code: 'response-invalid' })
  expect(cancelled).toBe(true)
})
it('bounds disconnected response failures and refuses an absent body', async () => {
  const failed = await fixture(async () => new Response(new ReadableStream({ start(controller) {
    controller.error(new Error('private provider contents'))
  } })))
  await expect(failed.client.request(request, 'private-jubian')).rejects.toMatchObject({ code: 'network' })
  const empty = await fixture(async () => new Response(null))
  await expect(empty.client.request(request, 'private-jubian')).rejects.toMatchObject({ code: 'response-invalid' })
})

it('retains a fixed HTTP failure when cancelling its unread private body rejects', async () => {
  const f = await fixture(async () => new Response(new ReadableStream({
    cancel() { throw new Error('private-token upstream failure') },
  }), { status: 503 }))
  await expect(f.client.request(request, 'private-jubian')).rejects.toMatchObject({ code: 'unavailable',
    message: 'Muse voice registration coordination: unavailable' })
})
