import assert from 'node:assert/strict'
import test from 'node:test'
import { centralMembersHandler } from '../src/host/central-members.js'

const origin = 'https://muse.example'
const web = 'http://100.123.97.104:19490'
const loopback = 'http://127.0.0.1:19490'
const session = { baseUrl: origin, username: 'owner', revision: 'current', cookie: '__Host-muse=session-fixture' }
const member = { id: '0123456789abcdef', username: 'editor', revision: 7, disabled: false, groups: [], feishuIdentities: ['private'] }

function command(input, from = web) {
  return new Request('http://dsh.internal/api/bot/central-members', { method: 'POST', headers: { origin: from }, body: JSON.stringify(input) })
}

function fixture(status = 200, target = member, webOrigins = [web]) {
  const calls = []
  return { calls, handle: centralMembersHandler({ origin, webOrigins, getSession: async () => session,
    requestGateway: async (url, options) => {
      assert.equal(url.origin, origin)
      calls.push({ path: url.pathname, ...options })
      if (url.pathname === '/api/admin/accounts') return Response.json({ items: [target] }, { status })
      return new Response(null, { status: 303, headers: { location: '/admin' } })
    },
  }) }
}

test('the Central roster omits upstream user details and requires the administrator session', async () => {
  const clean = fixture()
  const response = await clean.handle(command({ action: 'list' }))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.deepEqual(payload.members, [{ id: member.id, name: 'editor', revision: 7, disabled: false, groups: [], own: false, admin: false }])
  assert.equal(clean.calls[0].headers.cookie, session.cookie)
  const denied = fixture(403)
  assert.equal((await denied.handle(command({ action: 'list' }))).status, 403)
  assert.equal((await clean.handle(command({ action: 'list' }, 'https://other.example'))).status, 403)
  assert.equal(clean.calls.length, 1)
})

test('the local tunnel accepts only its configured origin', async () => {
  const input = { action: 'list' }
  const primaryOnly = fixture()
  assert.equal((await primaryOnly.handle(command(input, loopback))).status, 403)
  assert.equal(primaryOnly.calls.length, 0)
  const withTunnel = fixture(200, member, [web, loopback])
  assert.equal((await withTunnel.handle(command(input, loopback))).status, 200)
  assert.equal((await withTunnel.handle(command(input, 'http://127.0.0.1:19491'))).status, 403)
  assert.equal((await withTunnel.handle(command(input, 'http://localhost:19490'))).status, 403)
  assert.equal((await withTunnel.handle(command(input, web))).status, 200)
  assert.equal(withTunnel.calls.length, 2)
})

test('right-click actions use the account gateway and refuse stale edits or the current administrator', async () => {
  const { calls, handle } = fixture()
  assert.equal((await handle(command({ action: 'disabled', id: member.id, revision: 6, disabled: true }))).status, 409)
  assert.equal(calls.length, 1)
  assert.equal((await handle(command({ action: 'disabled', id: member.id, revision: 7, disabled: true }))).status, 200)
  assert.equal(calls[2].path, '/admin/disable')
  assert.equal(calls[2].body.get('disabled'), 'true')
  const saved = await handle(command({ action: 'groups', id: member.id, revision: 7, groups: [{ name: 'editors', description: 'review' }] }))
  assert.equal(saved.status, 200)
  assert.equal(calls[4].path, '/admin/groups')
  assert.deepEqual(calls[4].body.getAll('groupName'), ['editors'])
  const own = fixture(200, { ...member, username: session.username })
  assert.equal((await own.handle(command({ action: 'disabled', id: member.id, revision: 7, disabled: true }))).status, 403)
  assert.equal(own.calls.length, 1)
})
