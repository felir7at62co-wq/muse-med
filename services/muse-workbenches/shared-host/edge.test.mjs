import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createEdge } from './edge.mjs'

test('a live Muse session and an app-specific native owner are required for every protected request', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-wb-edge-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const origin = 'https://muse.example'
  const bindings = join(dir, 'bindings.json')
  await writeFile(bindings, JSON.stringify({ issuer: origin, users: { author: 27 } }))
  let signedIn = true
  let nativeOwner = 27
  let tickets = 0
  let identityChecks = 0
  const local = { secret: 'private', nativeLogin: 'http://native.test/session', bindings }
  const edge = createEdge({ origin, gateway: 'http://muse.test', cookieName: 'muse', apps: { jingliu: local } }, async (url, request) => {
    if (url === 'http://muse.test/api/muse/identity') {
      identityChecks++
      assert.equal(request.headers.cookie, 'muse=current')
      return signedIn ? Response.json({ accountId: 'author' }) : new Response(null, { status: 401 })
    }
    assert.equal(url, local.nativeLogin)
    assert.equal(request.headers.authorization, 'Bearer private')
    assert.equal(request.headers.cookie, undefined)
    assert.deepEqual(JSON.parse(request.body), { sub: 'author' })
    tickets++
    return Response.json({ token: 'studio-token', user: { id: nativeOwner } })
  })
  edge.listen(0, '127.0.0.1')
  await once(edge, 'listening')
  t.after(() => new Promise(resolve => edge.close(resolve)))
  const base = 'http://127.0.0.1:' + edge.address().port
  const headers = { cookie: 'other=unused; muse=current', 'x-workbench-method': 'GET' }
  assert.equal((await fetch(base + '/check/jingliu', { headers: {} })).status, 403)
  assert.equal((await fetch(base + '/check/jingliu', { headers: { 'x-workbench-method': 'GET' } })).status, 401)
  assert.equal((await fetch(base + '/check/jingliu', { headers: { ...headers, 'x-workbench-method': 'PATCH', 'x-workbench-origin': 'https://other.test' } })).status, 403)
  assert.equal((await fetch(base + '/session/jingliu', { method: 'POST', headers })).status, 403)
  const res = await fetch(base + '/check/jingliu', { headers })
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('x-workbench-authorization'), 'Bearer studio-token')
  const session = await fetch(base + '/session/jingliu', { method: 'POST', headers: { ...headers, origin } })
  assert.equal(session.status, 200)
  assert.equal(tickets, 1)
  assert.equal(identityChecks, 2)
  assert.equal((await fetch(base + '/check/other', { headers })).status, 404)
  await fetch(base + '/check/jingliu', { headers: { ...headers, 'x-workbench-method': 'POST', 'x-workbench-origin': origin, 'x-workbench-path': '/jingliu/fwp/v2/auth/logout' } })
  nativeOwner = 29
  assert.equal((await fetch(base + '/check/jingliu', { headers })).status, 503)
  signedIn = false
  assert.equal((await fetch(base + '/check/jingliu', { headers })).status, 401)
  signedIn = true
  await writeFile(bindings, JSON.stringify({ issuer: origin, users: {} }))
  assert.equal((await fetch(base + '/check/jingliu', { headers })).status, 403)
})
