/** Actual gateway approval, Host redemption, local persistence and restart recovery. */
import type { Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { MuseBrowserLogin } from '../src/browser-login.ts'
import { MuseAccountController } from '../src/account.ts'
import { createMuseAccountGateway } from '../src/gateway.ts'
import { readMuseSession } from '../src/session.ts'

const modules = new URL('../../../../services/muse-accounts/', import.meta.url)
const { openStore } = await import(new URL('store.mjs', modules).href) as {
  openStore: (file: string) => Promise<{ create(username: string, password: string): Promise<object> }>
}
const { createAccountServer } = await import(new URL('gateway.mjs', modules).href) as {
  createAccountServer: (options: Record<string, unknown>) => Server
}

it('uses a real web login to authorize a separately stored Desktop login that survives Host restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-browser-wire-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const store = await openStore(join(home, 'accounts.json'))
  await store.create('writer', 'password')
  const origin = 'https://muse.test', server = createAccountServer({ store, publicOrigin: origin })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Gateway did not bind a TCP port')
  const local = `http://127.0.0.1:${address.port}`
  const fetcher: typeof fetch = (input, init) => fetch(new URL(new URL(input instanceof Request ? input.url : input).pathname, local), init)
  const sessionFile = join(home, 'desktop', 'session.json')
  const browser = new MuseBrowserLogin({ baseUrl: origin, sessionFile, requestTimeoutMs: 1000, fetcher })
  onTestFinished(() => browser.dispose())
  const attempt = await browser.start()
  expect(await browser.check(attempt.id)).toEqual({ state: 'pending' })
  const signIn = await fetch(local + '/login', { method: 'POST', redirect: 'manual', headers: { origin },
    body: new URLSearchParams({ username: 'writer', password: 'password', desktop_login: attempt.id }) })
  expect(signIn.headers.get('location')).toBe('/desktop-login?attempt=' + attempt.id)
  const browserCookie = signIn.headers.getSetCookie()[0]?.split(';', 1)[0]
  if (browserCookie === undefined) throw new Error('Web login did not return a cookie')
  const approved = await fetch(local + '/desktop-login', { method: 'POST', headers: { origin, cookie: browserCookie },
    body: new URLSearchParams({ attempt: attempt.id, decision: 'approve' }) })
  expect(approved.status).toBe(200)
  expect(await browser.check(attempt.id)).toMatchObject({ state: 'signed-in', status: { username: 'writer', verified: true } })
  const saved = await readMuseSession(sessionFile, origin)
  expect(saved?.cookie).not.toBe(browserCookie)
  const recovered = new MuseAccountController({ baseUrl: origin, sessionFile, gateway: createMuseAccountGateway(origin, 1000, fetcher) })
  expect(await recovered.status({ verify: true })).toMatchObject({ state: 'signed-in', username: 'writer', verified: true })
  await recovered.logout()
  expect(await readMuseSession(sessionFile, origin)).toBeNull()
  expect((await fetch(local + '/api/muse.account', { headers: { cookie: browserCookie }, redirect: 'manual' })).status).toBe(200)
})
