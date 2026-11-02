import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/channel.js'
import { fakeContext } from './fake-ctx.js'

function channel(t, state) {
  const ctx = fakeContext()
  let route
  ctx.connection.fetch.register = value => { route = value; return () => {} }
  const empty = () => ({})
  const rt = {
    ctx, state, refresh: async () => {}, load: async () => {}, bootstrap: async () => {},
    catalog: async () => {}, loadSecrets: async () => {}, readOnly: () => undefined,
    cachedCatalog: () => [], cachedDefault: () => undefined, modelView: empty,
    chatOf: id => state.bots[id]?.sessionId ?? id,
    museTeam: {
      isSessionBotVisible: bot => bot.autoSessionBot !== true || (!bot.sessionMissing && !bot.sessionArchived),
      syncSessionsAsBots: async () => {}, connectedFeishuBots: async () => [],
    },
    archivesView: () => (state.privateArchives ?? []).map(({ id, name }) => ({ id, name })),
    secretsView: () => [], capabilityLibraryView: () => [], memoryNews: empty, memoryReviews: () => [],
    learningView: empty, activityView: empty, workView: empty, roomWorkView: empty,
    approvalsView: () => [], connectorsView: () => [], capabilityStatusesView: empty,
    noteFailure: value => { throw new Error(`unexpected channel failure: ${value.text}`) },
  }
  install(rt)
  t.after(() => ctx.dispose())
  return async (payload = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST', body: JSON.stringify({ endpoint: 'state', payload }),
    }))
    const result = await response.json()
    assert.equal(result.ok, true)
    return result.value
  }
}

const team = () => ({
  revision: 7, mainBotIds: ['visible'], prefs: {}, agents: {}, exchangeTurns: {}, questions: {},
  bots: {
    visible: { id: 'visible', name: 'Editor', sessionId: 'own-current', segments: [{ sessionId: 'own-past' }] },
    hidden: { id: 'hidden', name: 'Hidden', autoSessionBot: true, sessionMissing: true, sessionId: 'hidden-current', segments: [{ sessionId: 'hidden-past' }] },
    archived: { id: 'archived', name: 'Archived', autoSessionBot: true, sessionArchived: true },
  },
  rooms: {
    room: { id: 'room', name: 'Room', members: ['visible'], sessions: { visible: 'group-current' }, segments: { visible: [{ sessionId: 'group-past' }, { sessionId: 'own-past' }] } },
  },
  privateArchives: [{ id: 'private', name: 'Private', sessionIds: ['private-current', 'private-past', 'own-past'] }],
})

test('state exposes all owned Session ids without relying on visible Bot or room maps', async (t) => {
  const state = team()
  const before = structuredClone(state)
  const view = await channel(t, state)()
  assert.deepEqual(view.bots.map(bot => bot.id), ['visible'])
  assert.deepEqual(view.ownedSessionIds, [
    'archived', 'group-current', 'group-past', 'hidden', 'hidden-current', 'hidden-past',
    'own-current', 'own-past', 'private', 'private-current', 'private-past', 'room', 'visible',
  ])
  assert.deepEqual(state, before)
  assert.equal(new Set(view.ownedSessionIds).size, view.ownedSessionIds.length)
})

test('unchanged state retains full-view ownership until a new revision supplies the next set', async (t) => {
  const state = team()
  const call = channel(t, state)
  let client = await call()
  const kept = client.ownedSessionIds
  const unchanged = await call({ since: client.revision, models: client.modelsKey })
  assert.equal(unchanged.unchanged, true)
  assert.equal(unchanged.ownedSessionIds, undefined)
  client = { ...client, ...unchanged }
  assert.equal(client.ownedSessionIds, kept)
  state.bots.visible.segments.push({ sessionId: 'another-past' })
  state.revision++
  const updated = await call({ since: client.revision, models: client.modelsKey })
  assert.equal(updated.unchanged, undefined)
  assert.equal(updated.revision, state.revision)
  assert.equal(updated.ownedSessionIds.includes('another-past'), true)
})
