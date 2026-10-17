import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MuseBrowserLogin } from '../src/browser-login.ts'
import { readMuseSession } from '../src/session.ts'
import type { MuseBrowserLoginId } from '../src/types.ts'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'muse-browser-host-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const sessionFile = join(home, 'session.json'), baseUrl = 'https://muse.test'
  const id = 'a'.repeat(43) as MuseBrowserLoginId, secret = 's'.repeat(43)
  const attempt = { id, secret, code: 'A1B2C3D4', authorizeUrl: baseUrl + '/desktop-login?attempt=' + id,
    expiresAt: Date.now() + 600_000, pollIntervalMs: 2000 }
  let approved = false
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    expect(init?.redirect).toBe('manual')
    if (url.pathname === '/api/desktop-login/start') return Response.json(attempt)
    if (url.pathname === '/api/desktop-login/check') {
      expect(init?.body).toBeInstanceOf(URLSearchParams)
      expect((init?.body as URLSearchParams).toString()).toBe(new URLSearchParams({ id, secret }).toString())
      return approved ? Response.json({ state: 'signed-in' }, { headers: { 'set-cookie': '__Host-muse=local-token; Path=/; Secure; HttpOnly' } })
        : Response.json({ state: 'pending' })
    }
    if (url.pathname === '/api/desktop-login/cancel') return Response.json({ state: 'cancelled' })
    if (url.pathname === '/api/muse.account') {
      expect(new Headers(init?.headers).get('cookie')).toBe('__Host-muse=local-token')
      return Response.json({ username: 'writer' })
    }
    if (url.pathname === '/logout') return new Response(null, { status: 303 })
    throw new Error('Unexpected fixture route')
  })
  const login = new MuseBrowserLogin({ baseUrl, sessionFile, requestTimeoutMs: 1000, fetcher })
  onTestFinished(() => login.dispose())
  return { login, id, secret, attempt, sessionFile, baseUrl, fetcher, approve: () => { approved = true } }
}

it('exposes only approval fields and saves a verified independent session before reporting success', async () => {
  const f = await fixture(), attempt = await f.login.start()
  expect(JSON.stringify(attempt)).not.toContain(f.secret)
  expect(await f.login.start()).toEqual(attempt)
  expect(f.fetcher).toHaveBeenCalledTimes(1)
  expect(await f.login.check(f.id)).toEqual({ state: 'pending' })
  expect(await readMuseSession(f.sessionFile, f.baseUrl)).toBeNull()
  f.approve()
  expect(await f.login.check(f.id)).toEqual({ state: 'signed-in', status: { state: 'signed-in', username: 'writer', verified: true } })
  expect(await readMuseSession(f.sessionFile, f.baseUrl)).toMatchObject({ cookie: '__Host-muse=local-token', username: 'writer' })
  expect(await readFile(f.sessionFile, 'utf8')).not.toContain(f.secret)
  expect(await f.login.check(f.id)).toEqual({ state: 'expired' })
})

it('does not redeem another attempt and cancellation prevents later local persistence', async () => {
  const f = await fixture()
  await f.login.start()
  expect(await f.login.check('b'.repeat(43) as MuseBrowserLoginId)).toEqual({ state: 'expired' })
  await f.login.cancel('b'.repeat(43) as MuseBrowserLoginId)
  expect(f.fetcher).toHaveBeenCalledTimes(1)
  await f.login.cancel(f.id)
  f.approve()
  expect(await f.login.check(f.id)).toEqual({ state: 'expired' })
  expect(await readMuseSession(f.sessionFile, f.baseUrl)).toBeNull()
})

it('serializes concurrent redemption and collects a pending request before disposal finishes', async () => {
  const f = await fixture()
  await f.login.start()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const ready = new Promise<void>((resolve) => { entered = resolve })
  f.fetcher.mockImplementationOnce(async () => { entered(); await gate; return Response.json({ state: 'pending' }) })
  const first = f.login.check(f.id)
  await ready
  const stopped = vi.fn()
  const dispose = f.login.dispose().then(stopped)
  await Promise.resolve()
  expect(stopped).not.toHaveBeenCalled()
  release()
  expect(await first).toEqual({ state: 'pending' })
  await dispose
  expect(await f.login.check(f.id)).toEqual({ state: 'expired' })
  await expect(f.login.start()).rejects.toMatchObject({ code: 'gateway-unavailable' })
})

it.each(['https://evil.test/desktop-login', 'https://muse.test/elsewhere', 'http://muse.test/desktop-login'])('rejects an approval link outside the exact configured route: %s', async (authorizeUrl) => {
  const f = await fixture()
  f.fetcher.mockResolvedValueOnce(Response.json({ ...f.attempt, authorizeUrl }))
  await expect(f.login.start()).rejects.toMatchObject({ code: 'gateway-rejected' })
  expect(await readMuseSession(f.sessionFile, f.baseUrl)).toBeNull()
})

it('returns fixed network failures and expiry without forwarding private response text', async () => {
  const f = await fixture()
  f.fetcher.mockRejectedValueOnce(new Error('private server body'))
  await expect(f.login.start()).rejects.toMatchObject({ code: 'gateway-unavailable', message: 'MUSE account gateway: gateway-unavailable' })
  await f.login.start()
  f.fetcher.mockResolvedValueOnce(Response.json({ state: 'expired' }, { status: 410 }))
  expect(await f.login.check(f.id)).toEqual({ state: 'expired' })
})

it('uses the platform fetch implementation when no adapter is supplied', async () => {
  const f = await fixture()
  vi.stubGlobal('fetch', f.fetcher)
  onTestFinished(() => { vi.unstubAllGlobals() })
  const login = new MuseBrowserLogin({ baseUrl: f.baseUrl, sessionFile: f.sessionFile, requestTimeoutMs: 1000 })
  onTestFinished(() => login.dispose())
  expect((await login.start()).id).toBe(f.id)
  await login.cancel()
})

it.each([429, 403])('bounds an unsuccessful gateway response: %s', async (status) => {
  const f = await fixture()
  f.fetcher.mockResolvedValueOnce(new Response('private error', { status }))
  await expect(f.login.start()).rejects.toMatchObject({ code: status === 429 ? 'rate-limited' : 'gateway-rejected' })
})

it('rejects invalid JSON while starting or checking an approval', async () => {
  const f = await fixture()
  f.fetcher.mockResolvedValueOnce(new Response('not json'))
  await expect(f.login.start()).rejects.toMatchObject({ code: 'gateway-rejected' })
  await f.login.start()
  f.fetcher.mockResolvedValueOnce(new Response('not json'))
  await expect(f.login.check(f.id)).rejects.toMatchObject({ code: 'gateway-rejected' })
})

it.each([null, { state: 'unknown' }, { state: 'signed-in' }])('rejects an invalid redemption response without saving it: %j', async (value) => {
  const f = await fixture()
  await f.login.start()
  f.fetcher.mockResolvedValueOnce(Response.json(value))
  await expect(f.login.check(f.id)).rejects.toMatchObject({ code: 'gateway-rejected' })
  expect(await readMuseSession(f.sessionFile, f.baseUrl)).toBeNull()
})

it('reports browser denial and forgets the private attempt', async () => {
  const f = await fixture()
  await f.login.start()
  f.fetcher.mockResolvedValueOnce(Response.json({ state: 'cancelled' }))
  expect(await f.login.check(f.id)).toEqual({ state: 'cancelled' })
  expect(await f.login.check(f.id)).toEqual({ state: 'expired' })
})

it('revokes an issued credential after a local save failure even when revocation is unavailable', async () => {
  const f = await fixture(), obstruction = f.sessionFile + '.blocked'
  await writeFile(obstruction, 'not a directory')
  const login = new MuseBrowserLogin({ baseUrl: f.baseUrl, sessionFile: join(obstruction, 'session.json'), requestTimeoutMs: 1000, fetcher: f.fetcher })
  onTestFinished(() => login.dispose())
  await login.start()
  f.approve()
  const original = f.fetcher.getMockImplementation()!
  f.fetcher.mockImplementation(async (input, init) => {
    if (new URL(input instanceof Request ? input.url : input).pathname === '/logout') throw new Error('revocation unavailable')
    return await original(input, init)
  })
  await expect(login.check(f.id)).rejects.toThrow()
  expect(f.fetcher.mock.calls.some(([input]) => new URL(input instanceof Request ? input.url : input).pathname === '/logout')).toBe(true)
})
