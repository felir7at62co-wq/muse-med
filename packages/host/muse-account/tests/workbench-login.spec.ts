import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { writeMuseSession } from '../src/session.ts'
import { MuseWorkbenchLogin } from '../src/workbench-login.ts'

const roots: string[] = []
const baseUrl = 'https://accounts.example'
const challenge = 'c'.repeat(43)
const code = 'g'.repeat(43)

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(fetcher?: typeof fetch) {
  const home = await mkdtemp(join(tmpdir(), 'muse-workbench-'))
  roots.push(home)
  const sessionFile = join(home, 'account.json')
  const signIn = (username: string) => writeMuseSession(sessionFile, { baseUrl, username, cookie: '__Host-muse=' + username })
  return { client: new MuseWorkbenchLogin({ sessionFile, baseUrl, requestTimeoutMs: 1000, ...(fetcher ? { fetcher } : {}) }), signIn }
}

it('authenticates only the currently signed-in owner at each mounted workbench path', async () => {
  const fetched = vi.fn<typeof fetch>(async () => Response.json({ ok: true }))
  const { client, signIn } = await fixture(fetched)
  await signIn('one')
  const owner = await client.identity()
  const studio = new URL(baseUrl + '/jingliu/fwp/v2/projects')
  const workshop = new URL(baseUrl + '/jubengongfang/v1/factory/video-transcribe/status')
  await client.mounted('jingliu', owner, studio, {})
  await client.mounted('script-workshop', owner, workshop, { method: 'POST', redirect: 'follow' })
  await client.mounted('jingliu', owner, new URL(baseUrl + '/jingliu/fwp/media/generated/a.png'), { redirect: 'manual' })
  expect(fetched.mock.calls.map(([url, init]) => [
    url instanceof Request ? url.url : new URL(url).href, new Headers(init?.headers).get('cookie'), new Headers(init?.headers).get('origin'), init?.redirect,
  ])).toEqual([[studio.href, '__Host-muse=one', baseUrl, 'error'], [workshop.href, '__Host-muse=one', baseUrl, 'error'],
    [baseUrl + '/jingliu/fwp/media/generated/a.png', '__Host-muse=one', baseUrl, 'manual']])
  await expect(client.mounted('jingliu', owner, workshop, {})).rejects.toThrow()
  await expect(client.mounted('script-workshop', owner, studio, {})).rejects.toThrow()
  await expect(client.mounted('script-workshop', owner, new URL(baseUrl + '/jubengongfang/v1/%2e%2e/admin'), {})).rejects.toThrow()
  for (const other of ['https://user@accounts.example/jubengongfang/v1/x', 'https://:secret@accounts.example/jubengongfang/v1/x', baseUrl + '/jubengongfang/v1/x#part']) {
    await expect(client.mounted('script-workshop', owner, new URL(other), {})).rejects.toMatchObject({ code: 'gateway-rejected' })
  }
  await expect(client.mounted('jingliu', owner, new URL('/api/account', baseUrl), {})).rejects.toThrow()
  await expect(client.mounted('jingliu', owner, new URL('https://studio.example/jingliu/fwp/v2/projects'), {})).rejects.toThrow()
  await signIn('two')
  await expect(client.mounted('jingliu', owner, studio, {})).rejects.toThrow()
  expect(fetched).toHaveBeenCalledTimes(3)
  const global = vi.fn<typeof fetch>(async () => Response.json({ ok: true }))
  vi.stubGlobal('fetch', global)
  const plain = await fixture()
  await plain.signIn('three')
  await plain.client.mounted('script-workshop', await plain.client.identity(), workshop, {})
  expect(global).toHaveBeenCalledOnce()
})

it('uses the private Host session only at its issuer and hands out a single workbench code', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ code, expiresIn: 60, privateField: 'discard' }))
  vi.stubGlobal('fetch', fetcher)
  const { client, signIn } = await fixture()
  await signIn('writer')
  const before = await client.identity()
  const grant = await client.issue('script-workshop', challenge)
  expect(grant).toEqual({ code, expiresIn: 60, accountId: before })
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher).toHaveBeenCalledWith(baseUrl + '/api/workbench-login/grant', expect.objectContaining({
    method: 'POST', redirect: 'error',
    headers: { cookie: '__Host-muse=writer', origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ audience: 'script-workshop', challenge }),
  }))
  await signIn('editor')
  expect(await client.identity()).not.toBe(before)
})

it('refuses an absent login or invalid challenge before contacting the gateway', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const { client, signIn } = await fixture(fetcher)
  await expect(client.issue('jingliu', challenge)).rejects.toMatchObject({ code: 'invalid-credentials' })
  await signIn('editor')
  await expect(client.issue('jingliu', 'short')).rejects.toMatchObject({ code: 'gateway-rejected' })
  expect(fetcher).not.toHaveBeenCalled()
})

it('rejects a grant when the account changes during authorization', async () => {
  const { client, signIn } = await fixture(async () => {
    await signIn('other')
    return Response.json({ code, expiresIn: 60 })
  })
  await signIn('writer')
  await expect(client.issue('jingliu', challenge)).rejects.toMatchObject({ code: 'gateway-rejected' })
})

it.each([
  [() => new Response('private', { status: 401 }), 'invalid-credentials'],
  [() => new Response(new ReadableStream({ cancel() { throw Error('private') } }), { status: 403 }), 'gateway-rejected'],
  [() => Response.json({ code: 'bad', expiresIn: 60 }), 'gateway-rejected'],
  [() => Response.json({ code, expiresIn: 3600 }), 'gateway-rejected'],
  [() => { throw Error('private') }, 'gateway-unavailable'],
] as const)('bounds grant failures without exposing the upstream response', async (reply, failure) => {
  const { client, signIn } = await fixture(async () => reply())
  await signIn('writer')
  await expect(client.issue('jingliu', challenge)).rejects.toMatchObject({ code: failure })
})
