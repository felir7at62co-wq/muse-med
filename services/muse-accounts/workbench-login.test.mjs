import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAccountServer } from './gateway.mjs'
import { openStore } from './store.mjs'
import { loadWorkbenchClients } from './workbench-login.mjs'

const token = () => randomBytes(32).toString('base64url')
const origin = 'https://muse.test'
const audience = 'script-workshop'
const client = { callbackUri: 'https://writer.test/api/auth/muse/callback', serverSecret: token() }
const jingliu = { callbackUri: 'https://jingliu.test/api/auth/muse/callback', serverSecret: token() }
const workbenchClients = { [audience]: client, jingliu }
const verifier = token()
const challenge = createHash('sha256').update(verifier).digest('base64url')
const accountCookie = response => response.headers.get('set-cookie').split(';')[0]

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'muse-workbench-login-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await openStore(join(dir, 'accounts.json'))
  const user = await store.create('writer', 'password', { admin: true })
  const server = createAccountServer({ store, publicOrigin: origin, workbenchClients, workspaceMode: 'desktop', ...options })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = 'http://127.0.0.1:' + server.address().port
  const req = (path, { headers, ...rest } = {}) => fetch(base + path, { redirect: 'manual', headers, ...rest })
  const form = (path, fields, cookie, requestOrigin = origin) => req(path, {
    method: 'POST', body: new URLSearchParams(fields), headers: { origin: requestOrigin, ...(cookie ? { cookie } : {}) },
  })
  const api = (operation, fields, headers = {}) => req('/api/workbench-login/' + operation, {
    method: 'POST', body: JSON.stringify(fields), headers: { 'content-type': 'application/json', ...headers },
  })
  const login = async () => {
    const r = await form('/login', { username: user.username, password: 'password' })
    assert.equal(r.status, 303)
    return accountCookie(r)
  }
  const start = async (state = token()) => {
    const r = await api('start', { audience, state, challenge }, { authorization: 'Bearer ' + client.serverSecret })
    assert.equal(r.status, 200)
    const url = new URL((await r.json()).authorizeUrl)
    assert.equal(url.origin, origin)
    return { state, path: url.pathname + url.search, attempt: url.searchParams.get('attempt') }
  }
  const grant = async cookie => {
    const r = await api('grant', { audience, challenge }, { cookie, origin })
    assert.equal(r.status, 200)
    const receipt = await r.json()
    assert.equal(receipt.expiresIn, 60)
    return receipt.code
  }
  const redeem = (code, v = verifier, service = audience, secret = client.serverSecret) => api('redeem', {
    audience: service, verifier: v, code,
  }, { authorization: 'Bearer ' + secret })
  const confirm = async (pending, cookie) => {
    const page = await req(pending.path, { headers: { cookie } })
    assert.equal(page.status, 200)
    assert.equal(page.headers.get('cache-control'), 'no-store')
    assert.equal(page.headers.get('referrer-policy'), 'same-origin')
    const html = await page.text()
    assert.match(html, /writer/)
    return { attempt: pending.attempt, nonce: html.match(/name="nonce" value="([^"]+)"/)[1], decision: 'approve' }
  }
  return { store, user, req, api, form, grant, start, confirm, redeem, login }
}

test('both services exchange only their bound grant for stable Muse identity', async t => {
  const f = await fixture(t)
  const cookie = await f.login()
  const code = await f.grant(cookie)
  assert.equal((await f.redeem(code, verifier, 'jingliu', jingliu.serverSecret)).status, 410)
  assert.equal((await f.redeem(code, verifier, audience, jingliu.serverSecret)).status, 401)
  assert.equal((await f.redeem(code, token())).status, 410)
  const responses = await Promise.all([f.redeem(code), f.redeem(code)])
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 410])
  const success = responses.find(r => r.ok)
  assert.equal(success.headers.get('set-cookie'), null)
  assert.deepEqual(await success.json(), { issuer: origin, sub: f.user.id, username: f.user.username })
  const other = await f.api('grant', { audience: 'jingliu', challenge }, { cookie, origin })
  assert.equal((await f.redeem((await other.json()).code, verifier, 'jingliu', jingliu.serverSecret)).status, 200)
})

test('browser consent resumes password login, and returns state only to the configured callback', async t => {
  const f = await fixture(t)
  const pending = await f.start()
  const start = await f.req(pending.path)
  assert.match(await start.text(), /signin=1/)
  const cont = await f.req(pending.path + '&signin=1')
  assert.equal(cont.headers.get('location'), '/login')
  const returnCookie = accountCookie(cont)
  const signedIn = await f.form('/login', { username: 'writer', password: 'password' }, returnCookie)
  const cookie = accountCookie(signedIn)
  const home = await f.req(signedIn.headers.get('location'), { headers: { cookie: cookie + '; ' + returnCookie } })
  assert.equal(home.headers.get('location'), pending.path)
  assert.match(home.headers.get('set-cookie'), /Max-Age=0/)
  const fields = await f.confirm(pending, cookie)
  const callback = await f.form('/workbench-login', fields, cookie)
  assert.equal(callback.status, 200)
  assert.equal(callback.headers.get('referrer-policy'), 'no-referrer')
  const url = new URL((await callback.text()).match(/<a href="([^"]+)"/)[1].replaceAll('&amp;', '&'))
  assert.equal(url.origin + url.pathname, client.callbackUri)
  assert.equal(url.searchParams.get('state'), pending.state)
  const identity = await f.redeem(url.searchParams.get('code'))
  assert.deepEqual(await identity.json(), { issuer: origin, sub: f.user.id, username: 'writer' })
  assert.equal((await f.form('/workbench-login', fields, cookie)).status, 410)
})

test('approval requires the same Muse login, origin, current form nonce and a positive decision', async t => {
  const f = await fixture(t), cookie = await f.login(), otherSession = await f.login()
  const pending = await f.start()
  const fields = await f.confirm(pending, cookie)
  assert.equal((await f.form('/workbench-login', fields, otherSession)).status, 403)
  assert.equal((await f.form('/workbench-login', fields, cookie, 'https://writer.test')).status, 403)
  assert.equal((await f.form('/workbench-login', { ...fields, nonce: token() }, cookie)).status, 403)
  const denied = await f.form('/workbench-login', { ...fields, decision: 'deny' }, cookie)
  const callback = new URL((await denied.text()).match(/<a href="([^"]+)"/)[1].replaceAll('&amp;', '&'))
  assert.deepEqual(Object.fromEntries(callback.searchParams), { state: pending.state, error: 'access_denied' })
  assert.equal((await f.form('/workbench-login', fields, cookie)).status, 410)
})

test('expiry, account revision, disability and original session logout invalidate outstanding codes', async t => {
  let now = Date.now()
  const f = await fixture(t, { now: () => now })
  const cookie = await f.login(), expired = await f.grant(cookie), pending = await f.start()
  now += 60_000
  assert.equal((await f.redeem(expired)).status, 410)
  const abandoned = await f.grant(cookie)
  await f.form('/logout', {}, cookie)
  assert.equal((await f.redeem(abandoned)).status, 410)
  const revised = await f.grant(await f.login())
  await f.store.resetPassword(f.user.id, 'password')
  assert.equal((await f.redeem(revised)).status, 410)
  const disabled = await f.grant(await f.login())
  await f.store.setDisabled(f.user.id, true)
  assert.equal((await f.redeem(disabled)).status, 410)
  now += 540_000
  assert.equal((await f.req(pending.path)).status, 410)
})

test('service endpoints enforce body, client, origin and fixed redirect inputs', async t => {
  const f = await fixture(t), cookie = await f.login()
  assert.equal((await f.api('grant', { audience, challenge }, { origin })).status, 401)
  assert.equal((await f.api('grant', { audience, challenge }, { cookie })).status, 403)
  assert.equal((await f.api('grant', { audience, challenge }, { cookie, origin: 'https://writer.test' })).status, 403)
  const fields = { audience, state: token(), challenge }, authorization = 'Bearer ' + client.serverSecret
  assert.equal((await f.api('start', fields)).status, 401)
  assert.equal((await f.api('start', fields, { authorization, origin })).status, 403)
  assert.equal((await f.api('start', { ...fields, redirect_uri: 'https://writer.test/other' }, { authorization })).status, 400)
  assert.equal((await f.api('start', { ...fields, challenge: 'invalid' }, { authorization })).status, 400)
  assert.equal((await f.req('/api/workbench-login/grant')).status, 405)
  const disabled = await fixture(t, { workbenchClients: undefined })
  assert.equal((await disabled.req('/workbench-login')).status, 404)
  assert.equal((await disabled.api('grant', { audience, challenge })).status, 404)
})

test('client registration requires a private file, distinct secrets and fixed HTTPS or loopback callbacks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-workbench-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'clients.json')
  await writeFile(file, JSON.stringify(workbenchClients), { mode: 0o600 })
  assert.deepEqual(await loadWorkbenchClients(file), workbenchClients)
  await chmod(file, 0o644)
  await assert.rejects(loadWorkbenchClients(file), /owner-only/)
  await chmod(file, 0o600)
  await writeFile(file, client.serverSecret)
  await assert.rejects(loadWorkbenchClients(file), { message: 'Invalid workbench configuration JSON' })
  const { store } = await fixture(t)
  const build = clients => createAccountServer({ store, publicOrigin: origin, workbenchClients: clients })
  assert.throws(() => build({ ...workbenchClients, jingliu: { ...jingliu, serverSecret: client.serverSecret } }), /separate/)
  assert.throws(() => build({ ...workbenchClients, jingliu: { ...jingliu, callbackUri: client.callbackUri } }), /separate/)
  assert.throws(() => build({ [audience]: { ...client, callbackUri: 'http://writer.test/cb' } }), /callback URI/)
  assert.throws(() => build({ [audience]: { ...client, callbackUri: client.callbackUri + '?' } }), /callback URI/)
})
