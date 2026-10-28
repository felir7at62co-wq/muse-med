import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

async function start(t, { known = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'muse-archived-group-'))
  const state = {
    version: 1, revision: 0, mainBotIds: ['chief'],
    bots: {
      chief: { id: 'chief', sessionId: 'chief', name: 'Chief', createdAt: 1 },
      source: { id: 'source', sessionId: 'source', name: 'Writer', createdAt: 1, autoSessionBot: true,
        modelSource: 'session', interactionSource: 'session', workDir: home },
    },
    rooms: { room: { id: 'room', name: 'Room', named: true, members: ['chief', 'source'], admin: 'source', mode: 'admin',
      sessions: known ? { source: 'member' } : {}, log: [], seq: 0, seen: {} } },
    agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext({ services: { agentPresets: { list: async () => [{ id: 'short-drama' }] } } })
  const archived = [], items = [{ sessionId: 'source', cwd: home, blank: false, projections: { values: {} } }]
  const calls = { list: 0, create: 0, resolve: [], followup: [] }
  let rt
  Object.assign(ctx, {
    workspaceRegistry: { list: () => [], archivedSessionIds: archived },
    sessionController: {
      list: async () => { calls.list++; return { items: structuredClone(items) } },
      create: async () => { calls.create++; throw new Error('Unexpected member Session creation') },
      resolveAgent: async id => {
        calls.resolve.push(id)
        return { agent: { session: { id }, followup: message => {
          calls.followup.push(message)
          rt.roomWaiters.get(message.source.exchangeId)?.resolve('done')
        } } }
      },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { get: () => undefined, flush: async () => {} },
  })
  rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  await rt.museTeam.syncSessionsAsBots()
  const relay = async () => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      await listener({ id: 'room' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '@Writer Check continuity' }] } })
    }
    return JSON.parse(await ctx.registeredTools.get('group_relay').execute({}, {
      agent: { id: 'room' }, callId: 'relay', signal: new AbortController().signal,
    }))
  }
  return { rt, calls, archived, items, relay }
}

for (const known of [false, true]) {
  test(`archiving an automatic Bot source blocks ${known ? 'its existing' : 'a new'} member Session before group delivery`, async t => {
    const f = await start(t, { known })
    f.archived.push('source')
    const result = await f.relay()
    assert.equal(f.calls.list, 2, 'The archive change invalidates the metadata cache inside the group call')
    assert.deepEqual(result.replies.map(({ kind, name, text }) => ({ kind, name, text })),
      [{ kind: 'failed', name: 'Writer', text: 'Writer\'s source conversation is archived or unavailable.' }])
    assert.equal(f.calls.create, 0)
    assert.deepEqual(f.calls.resolve, [])
    assert.deepEqual(f.calls.followup, [])
  })
}

test('a missing automatic Bot source blocks a group call before creating its member Session', async t => {
  const f = await start(t)
  f.items.length = 0
  f.rt.museTeam.invalidateSessionBots()
  const result = await f.relay()
  assert.match(result.replies[0].text, /source conversation is archived or unavailable/)
  assert.equal(f.calls.create, 0)
  assert.deepEqual(f.calls.resolve, [])
  assert.deepEqual(f.calls.followup, [])
})
