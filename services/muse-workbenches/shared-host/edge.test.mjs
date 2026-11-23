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
  let nativeRefuses = false
  let tickets = 0
  let identityChecks = 0
  const local = { secret: 'private', nativeLogin: 'http://native.test/session', bindings }
  const edge = createEdge({ origin, gateway: 'http://muse.test', cookieName: 'muse', apps: { jingliu: local, 'script-workshop': local } }, async (url, request) => {
    if (url === 'http://muse.test/api/muse/identity') {
      identityChecks++
      assert.equal(request.headers.cookie, 'muse=current')
      return signedIn ? Response.json({ accountId: 'author', username: 'Author' }) : new Response(null, { status: 401 })
    }
    assert.equal(url, local.nativeLogin)
    assert.equal(request.headers.authorization, 'Bearer private')
    assert.equal(request.headers.cookie, undefined)
    assert.deepEqual(JSON.parse(request.body), { sub: 'author', username: 'Author' })
    tickets++
    if (nativeRefuses) return new Response(null, { status: 403 })
    return Response.json({ token: 'studio-token', access_token: 'workshop-token', user: { id: nativeOwner } })
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
  nativeOwner = 29
  assert.equal((await fetch(base + '/check/jubengongfang', { headers })).status, 503)
  signedIn = false
  assert.equal((await fetch(base + '/check/jingliu', { headers })).status, 401)
  signedIn = true
  // Outside the bindings file the workbench decides: Workshop refuses, Jingliu opens an account.
  await writeFile(bindings, JSON.stringify({ issuer: origin, users: {} }))
  nativeRefuses = true
  assert.equal((await fetch(base + '/check/jubengongfang', { headers })).status, 403)
  nativeRefuses = false
  nativeOwner = 1000001
  const opened = await fetch(base + '/check/jingliu', { headers })
  assert.equal(opened.status, 204)
  assert.equal(opened.headers.get('x-workbench-authorization'), 'Bearer studio-token')
  nativeOwner = 0
  assert.equal((await fetch(base + '/check/jubengongfang', { headers })).status, 503)
  await writeFile(bindings, JSON.stringify({ issuer: 'https://other.example', users: {} }))
  assert.equal((await fetch(base + '/check/jingliu', { headers })).status, 403)
})

test('archiving the Workshop web keeps native APIs open to the linked editor', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-wb-archive-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const origin = 'https://muse.example'
  const bindings = join(dir, 'bindings.json')
  await writeFile(bindings, JSON.stringify({ issuer: origin, users: { editor: 27, admin: 28 } }))
  const local = { secret: 'private', nativeLogin: 'http://native.test/session', bindings }
  let admin = true
  const edge = createEdge({
    origin, gateway: 'http://muse.test', cookieName: 'muse', archiveWorkshopWeb: true,
    apps: { 'script-workshop': local, jingliu: local },
  }, async (url, request) => {
    if (url === local.nativeLogin) {
      const { sub } = JSON.parse(request.body)
      return Response.json({ access_token: sub + '-token', token: sub + '-studio', user: { id: sub === 'admin' ? 28 : 27 } })
    }
    const accountId = request.headers.cookie === 'muse=admin' ? 'admin' : 'editor'
    if (url.endsWith('/api/muse/identity')) return Response.json({ accountId })
    assert.equal(url, 'http://muse.test/api/muse.account')
    assert.equal(request.redirect, 'manual')
    if (request.headers.cookie === 'muse=expired') return new Response(null, { status: 303, headers: { location: '/login' } })
    return Response.json({ accountId, admin: admin && accountId === 'admin' })
  })
  edge.listen(0, '127.0.0.1')
  await once(edge, 'listening')
  t.after(() => new Promise(resolve => edge.close(resolve)))
  const base = 'http://127.0.0.1:' + edge.address().port
  function request(path, role, method = 'GET', originalPath = '') {
    return fetch(base + path, {
      method, headers: {
        origin, 'x-workbench-method': 'GET', 'x-workbench-path': originalPath,
        ...(role && { cookie: 'muse=' + role }),
      },
    })
  }
  assert.equal((await request('/archive/jubengongfang')).status, 401)
  assert.equal((await request('/archive/jubengongfang', 'expired')).status, 401)
  for (const path of ['/enter/jubengongfang', '/archive/jubengongfang', '/check-web/jubengongfang']) {
    assert.equal((await request(path, 'editor')).status, 403)
  }
  assert.equal((await request('/session/jubengongfang', 'editor', 'POST')).status, 403)
  for (const path of ['/jubengongfang/v2', '/jubengongfang/v1/../v2', '/jubengongfang/v1/%2e%2e/v2']) {
    assert.equal((await request('/check/jubengongfang', 'editor', 'GET', path)).status, 403)
  }
  const api = '/jubengongfang/v1/script-editor/drafts?offset=0'
  const editor = await request('/check/jubengongfang', 'editor', 'GET', api)
  assert.equal(editor.status, 204)
  assert.equal(editor.headers.get('x-workbench-authorization'), 'Bearer editor-token')
  assert.equal((await request('/check/jingliu', 'editor')).status, 204)
  const recovery = await request('/archive/jubengongfang', 'admin')
  assert.equal(recovery.status, 200)
  assert.match(await recovery.text(), /旧版剧本工坊/)
  assert.equal((await request('/session/jubengongfang', 'admin', 'POST')).status, 200)
  assert.equal((await request('/check-web/jubengongfang', 'admin')).status, 204)
  admin = false
  assert.equal((await request('/check-web/jubengongfang', 'admin')).status, 403)
  assert.equal((await request('/check/jubengongfang', 'admin', 'GET', api)).status, 204)
})
