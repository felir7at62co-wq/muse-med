import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install, RESUME_DELAY_MS } from '../src/host/resume.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { MuseTeamService } from '../src/host/muse-team.js'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const request = { kind: SOURCE_KIND, role: 'request', exchangeId: 'original-exchange', senderSessionId: 'chief' }

function start(t, { owner, turns = {}, queued = {}, bots = {}, groups = new Map(), expectedDeliveries = 0,
  archived = [], missing = [], deferListing = false } = {}) {
  if (owner === undefined) {
    owner = { home: mkdtempSync(join(tmpdir(), 'muse-native-resume-')), stops: [] }
    const { home } = owner
    writeFileSync(join(home, 'inflight.json'), JSON.stringify({ turns, queued }))
    t.after(async () => {
      for (const stop of owner.stops.toReversed()) await stop()
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    })
  }
  const { home } = owner
  const listeners = new Map(), cleanups = [], live = new Map(), resolved = [], deliveries = [], posts = []
  const resumed = deferred(), listing = deferred(), releaseListing = deferred()
  const listReads = []
  for (const [id, bot] of Object.entries(bots)) { bot.id ??= id; bot.sessionId ??= id }
  const rt = {
    home, live, groupOwners: groups, chatOwners: new Map(Object.keys(bots).map(id => [id, id])),
    state: { revision: 0, bots, rooms: {}, agents: {} }, config: { autoSessionBots: true, sessionBotSyncIntervalMs: 30_000 },
    ctx: {
      on: (event, listener) => listeners.set(event, listener),
      effect: execute => cleanups.push(execute()),
      sessions: { get: () => undefined },
      workspaceRegistry: { list: () => [], archivedSessionIds: archived },
      sessionController: { list: async () => {
        listReads.push('metadata')
        listing.resolve()
        if (deferListing) await releaseListing.promise
        return { items: Object.keys(bots).filter(id => !missing.includes(id)).map(sessionId => ({ sessionId, cwd: home, blank: false })) }
      } },
    },
    readOnly: () => undefined,
    load: async () => {},
    warn: (...args) => assert.fail(`Unexpected resume warning: ${args.join(' ')}`),
    botOf: id => bots[id],
    roomOf: id => id === 'room' ? { id: 'room', name: 'Room', members: ['native'], sessions: { native: 'member' } } : undefined,
    chatOf: id => id,
    isBotSession: id => Object.hasOwn(bots, id) || groups.has(id),
    save: async () => { rt.state.revision++ },
    indexSessions() {},
    resolveAgent: async id => { resolved.push(id); return { status: 'idle' } },
    postToRoom: async (...args) => posts.push(args),
    deliver: async args => {
      deliveries.push(args)
      if (deliveries.length === expectedDeliveries) resumed.resolve()
    },
  }
  rt.museTeam = new MuseTeamService(rt)
  cleanups.push(() => rt.museTeam.dispose())
  install(rt)
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    releaseListing.resolve()
    for (const cleanup of cleanups.toReversed()) await cleanup?.()
  }
  owner.stops.push(stop)
  const emit = (id, type, data = {}) => listeners.get('session/event')({ id }, { type, data, time: 123 })
  const notes = () => existsSync(join(home, 'inflight.json')) ? JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8')) : { turns: {}, queued: {} }
  return { owner, rt, emit, notes, stop, resolved, deliveries, posts, listReads,
    listing: listing.promise, releaseListing: releaseListing.resolve, resumed: resumed.promise }
}

test('native user and goal turns leave no Bot restart note, including discarded approval state', async t => {
  const f = start(t, { bots: { automatic: { autoSessionBot: true }, adopted: { interactionSource: 'session' } } })
  for (const id of ['automatic', 'adopted']) {
    for (const source of [{ kind: 'user' }, { kind: 'goal' }]) {
      f.emit(id, 'turn/start', { turn: 1 })
      f.emit(id, 'user/message', { source })
      f.rt.noteApproval(id, { tool: 'paid_generation' })
      f.emit(id, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
    }
  }
  await f.stop()
  assert.deepEqual(f.notes().turns, {})
  assert.deepEqual(f.resolved, [])
})

test('a native conversation records and resumes an admitted Bot request under its original exchange', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bots = { native: { id: 'native', autoSessionBot: true, interactionSource: 'session' }, chief: { id: 'chief' } }
  const first = start(t, { bots })
  first.emit('native', 'turn/start', { turn: 1 })
  first.rt.live.set('native', { info: request })
  first.emit('native', 'user/message', { source: request })
  first.emit('native', 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  await first.stop()
  assert.deepEqual(first.notes().turns.native, { botId: 'native', since: 123, trigger: {
    role: 'request', exchangeId: 'original-exchange', senderSessionId: 'chief',
  } })

  const second = start(t, { owner: first.owner, bots, expectedDeliveries: 1 })
  t.mock.timers.tick(RESUME_DELAY_MS)
  await second.resumed
  await second.stop()
  assert.deepEqual(second.resolved, ['native'])
  assert.deepEqual(second.deliveries.map(({ toId, fromId, role, exchangeId, resumed }) => ({ toId, fromId, role, exchangeId, resumed })),
    [{ toId: 'native', fromId: 'chief', role: 'request', exchangeId: 'original-exchange', resumed: true }])
})

test('old native notes without a Bot trigger are dropped before resolving cold Sessions while group work still resumes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = start(t, {
    bots: { automatic: { autoSessionBot: true }, adopted: { interactionSource: 'session' }, native: { id: 'native', autoSessionBot: true } },
    groups: new Map([['member', { botId: 'native', roomId: 'room' }]]), expectedDeliveries: 1,
    turns: { automatic: { botId: 'automatic', since: 1 }, adopted: { botId: 'adopted', since: 1 },
      member: { botId: 'native', roomId: 'room', since: 1 } },
  })
  t.mock.timers.tick(RESUME_DELAY_MS)
  await f.resumed
  await f.stop()
  assert.deepEqual(f.resolved, ['member'])
  assert.equal(f.posts.length, 1)
  assert.deepEqual(f.deliveries.map(({ sessionId, role, roomId, resumed }) => ({ sessionId, role, roomId, resumed })),
    [{ sessionId: 'member', role: 'room', roomId: 'room', resumed: true }])
  assert.deepEqual(f.notes().turns, {})
})

test('native group members keep restart notes but a relay that does not claim a native own-chat turn does not', async t => {
  const f = start(t, { bots: { native: { id: 'native', interactionSource: 'session' } },
    groups: new Map([['member', { botId: 'native', roomId: 'room' }]]) })
  f.emit('native', 'turn/start', { turn: 1 })
  f.emit('native', 'user/message', { source: { kind: 'user' } })
  f.emit('native', 'user/message', { source: request })
  f.emit('member', 'turn/start', { turn: 1 })
  await f.stop()
  assert.deepEqual(f.notes().turns, { member: { botId: 'native', roomId: 'room', since: 123 } })
})

test('a Bot relay already claimed when a native turn starts keeps its recovery trigger', async t => {
  const f = start(t, { bots: { native: { id: 'native', interactionSource: 'session' } } })
  f.rt.live.set('native', { info: { ...request, resumed: true } })
  f.emit('native', 'turn/start', { turn: 1 })
  await f.stop()
  assert.deepEqual(f.notes().turns.native, { botId: 'native', since: 123, resumed: true, trigger: {
    role: 'request', exchangeId: 'original-exchange', senderSessionId: 'chief',
  } })
})

for (const unavailable of ['archived', 'missing']) {
  test(`${unavailable} automatic sources leave interrupted group tasks asleep after cold metadata synchronization`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = start(t, {
      bots: { native: { autoSessionBot: true }, control: {} },
      groups: new Map([['member', { botId: 'native', roomId: 'room' }]]),
      turns: { member: { botId: 'native', roomId: 'room', since: 1 }, control: { botId: 'control', since: 1 } },
      archived: unavailable === 'archived' ? ['native'] : [], missing: unavailable === 'missing' ? ['native'] : [],
      deferListing: true, expectedDeliveries: 1,
    })
    t.mock.timers.tick(RESUME_DELAY_MS)
    await f.listing
    assert.deepEqual(f.resolved, [])
    assert.deepEqual(f.deliveries, [])
    f.releaseListing()
    await f.resumed
    await f.stop()
    assert.deepEqual(f.listReads, ['metadata'])
    assert.deepEqual(f.resolved, ['control'])
    assert.deepEqual(f.deliveries.map(args => args.toId), ['control'])
    assert.deepEqual(f.posts, [])
    assert.deepEqual(f.notes().turns, {})
  })

  test(`${unavailable} automatic sources receive no queued group resend after restart`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const queuedAt = Date.now()
    const f = start(t, {
      bots: { native: { autoSessionBot: true }, control: {} },
      groups: new Map([['member', { botId: 'native', roomId: 'room' }]]),
      queued: {
        member: [{ at: queuedAt, args: { toId: 'native', sessionId: 'member', roomId: 'room', role: 'room', exchangeId: 'group-original', text: 'Old work' } }],
        control: [{ at: queuedAt, args: { toId: 'control', role: 'request', exchangeId: 'control-original', text: 'Visible work' } }],
      },
      archived: unavailable === 'archived' ? ['native'] : [], missing: unavailable === 'missing' ? ['native'] : [],
      expectedDeliveries: 1,
    })
    t.mock.timers.tick(RESUME_DELAY_MS)
    await f.resumed
    await f.stop()
    assert.deepEqual(f.listReads, ['metadata'])
    assert.deepEqual(f.resolved, ['control'])
    assert.deepEqual(f.deliveries.map(({ toId, exchangeId, resent }) => ({ toId, exchangeId, resent })),
      [{ toId: 'control', exchangeId: 'control-original', resent: true }])
    assert.deepEqual(f.posts, [])
    assert.equal(f.notes().queued.member, undefined)
  })
}
