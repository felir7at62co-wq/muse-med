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
