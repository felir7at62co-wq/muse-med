import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MuseTeamService, install } from '../src/host/muse-team.js'
import { nameProblem } from '../src/shared/mentions.js'

const row = (sessionId, title = `Project ${sessionId}`, extra = {}) => ({
  sessionId, cwd: `/projects/${sessionId}`, blank: false,
  projections: { values: { title, modelSelection: { next: { provider: 'muse', model: 'chosen', reasoningEffort: 'high' } } } },
  ...extra,
})
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function start(t) {
  let now = 100, readOnly
  const items = [], live = new Map(), saved = [], warnings = [], held = new Set(), events = new Map()
  const workspace = { id: 'project-workspace', sessionIds: [] }
  const calls = { list: 0, resolve: 0, save: 0, index: 0 }
  const state = { revision: 1, bots: {}, rooms: {}, agents: {}, mainBotIds: [] }
  const ctx = {
    sessionController: {
      list: async () => { calls.list++; return { items: structuredClone(items) } },
      resolveAgent: async () => { calls.resolve++; throw new Error('Synchronization must never restore an Agent') },
    },
    sessions: { get: id => live.get(id) },
    sessionTitle: { get: session => ({ title: session.title }) },
    workspaceRegistry: { list: () => [workspace], archivedSessionIds: [] },
    provide() {}, effect() {}, on: (event, callback) => events.set(event, callback),
  }
  const rt = {
    ctx, state, config: { autoSessionBots: true, sessionBotSyncIntervalMs: 30_000 },
    load: async () => {}, readOnly: () => readOnly,
    warn: (...args) => warnings.push(args), indexSessions: () => { calls.index++ },
    chatOf: id => state.bots[id]?.sessionId ?? id,
    sessionFolder: session => session.header.cwd,
    sessionSelection: session => session.selection,
    freshBotName: base => {
      const taken = name => held.has(name.toLowerCase()) || Object.values(state.bots).some(bot => bot.name.toLowerCase() === name.toLowerCase())
      let name = base, suffix = 2
      while (taken(name)) name = `${base.slice(0, 34)} ${suffix++}`
      return name
    },
    holdBotName: async (name, work) => {
      assert.equal(held.has(name.toLowerCase()), false)
      held.add(name.toLowerCase())
      try { return await work() } finally { held.delete(name.toLowerCase()) }
    },
    save: async () => { calls.save++; state.revision++; rt.indexSessions(); saved.push(structuredClone(state)) },
  }
  const service = new MuseTeamService(rt, () => now)
  t.after(() => service.dispose())
  return { service, rt, ctx, state, calls, items, live, workspace, saved, warnings, events,
    advance: milliseconds => { now += milliseconds }, setReadOnly: reason => { readOnly = reason } }
}

test('cold Sessions become ordinary Bots from cached metadata without restoring or changing their histories', async t => {
  const f = start(t)
  f.items.push(row('cold', 'Continuity editor'), row('fork', 'Episode 3 branch', { parentSessionId: 'cold' }))
  f.workspace.sessionIds.push('cold', 'fork')
  const original = structuredClone(f.items)
  assert.deepEqual(await f.service.syncSessionsAsBots(), { created: ['cold', 'fork'], failures: [] })
  assert.deepEqual(f.items, original)
  const bot = f.state.bots.cold
  assert.deepEqual([bot.id, bot.sessionId, bot.name, bot.workDir, bot.workspaceId, bot.model, bot.effort,
    bot.modelSource, bot.interactionSource, bot.autoSessionBot],
  ['cold', 'cold', 'Continuity editor', '/projects/cold', 'project-workspace', 'muse/chosen', 'high', 'session', 'session', true])
  assert.deepEqual(f.state.mainBotIds, [])
  assert.equal(f.live.size, 0)
  assert.equal(f.calls.resolve, 0)
  assert.equal(f.saved.length, 1)
  await f.service.syncSessionsAsBots()
  assert.equal(f.calls.list, 1)
  f.advance(29_999)
  await f.service.syncSessionsAsBots()
  assert.equal(f.calls.list, 1)
  f.advance(1)
  await f.service.syncSessionsAsBots()
  assert.equal(f.calls.list, 2)
  assert.equal(f.saved.length, 1)
})

test('live metadata stays authoritative without touching pending work, model, preset or workspace', async t => {
  const f = start(t)
  const session = { id: 'live', header: { id: 'live', cwd: '/original', createdAt: 12, agentPreset: 'short-drama' },
    title: 'Original live title', selection: { provider: 'native', model: 'pending', reasoningEffort: 'low' },
    goal: { phase: 'active' }, inbox: [{ id: 'waiting' }], jobs: [{ id: 'job' }] }
  f.live.set('live', session)
  f.items.push(row('live', 'Stale cached title'))
  const original = structuredClone(session)
  await f.service.syncSessionsAsBots()
  assert.deepEqual(session, original)
  assert.deepEqual([f.state.bots.live.name, f.state.bots.live.workDir, f.state.bots.live.model, f.state.bots.live.effort],
    ['Original live title', '/original', 'native/pending', 'low'])
  assert.equal(f.calls.resolve, 0)
})

test('owned parts, groups, subagents, plain-Agent sessions, archived and unnamed blanks stay out', async t => {
  const f = start(t)
  f.state.bots.bot = { id: 'bot', sessionId: 'current', name: 'Existing', segments: [{ sessionId: 'past' }] }
  f.state.rooms.room = { id: 'room', sessions: { bot: 'member' }, segments: { bot: [{ sessionId: 'past-member' }] } }
  f.state.agents.plain = { id: 'plain', sessions: ['plain-session'] }
  f.ctx.workspaceRegistry.archivedSessionIds.push('archived')
  f.rt.teamSessionIds = new Set(['internal'])
  f.items.push(...['bot', 'current', 'past', 'room', 'member', 'past-member', 'plain-session', 'archived', 'internal'].map(id => row(id)))
  f.items.push(row('child', 'Child', { origin: 'subagent' }), row('depth'), row('no-cwd', 'No directory', { cwd: undefined }),
    row('blank', null, { blank: true }), row('titled-blank', 'Named blank', { blank: true }), row('independent'))
  f.live.set('depth', { header: { cwd: '/depth', delegationDepth: 1 } })
  assert.deepEqual((await f.service.syncSessionsAsBots()).created, ['titled-blank', 'independent'])
  assert.deepEqual(Object.keys(f.state.bots), ['bot', 'titled-blank', 'independent'])
})

test('Session names remain readable, addressable and unique for long, special and equal titles', async t => {
  const f = start(t)
  f.items.push(row('first', '编导@项目\n`讨论` '.repeat(12)), row('second', '编导@项目\n`讨论` '.repeat(12)),
    row('reserved', 'User'), row('untitled', null))
  await f.service.syncSessionsAsBots()
  for (const bot of Object.values(f.state.bots)) {
    assert.ok(bot.name.length <= 40)
    assert.equal(nameProblem(bot.name), undefined)
    assert.doesNotMatch(bot.name, /[@`\r\n]/)
  }
  assert.match(f.state.bots.first.name, /^编导＠项目 ｀讨论｀/)
  assert.equal(f.state.bots.first.sessionTitle, f.items[0].projections.values.title)
  assert.notEqual(f.state.bots.first.name, f.state.bots.second.name)
  assert.equal(f.state.bots.reserved.name, 'Bot User')
  assert.equal(f.state.bots.untitled.name, 'Bot untitled')
  f.service.invalidateSessionBots()
  await f.service.syncSessionsAsBots()
  assert.equal(f.saved.length, 1)
})

test('long Session display titles retain up to 512 characters independently of the addressable name', async t => {
  const f = start(t)
  const title = '《长篇短剧》人物关系与全剧连续性检查'.repeat(40)
  f.items.push(row('long-title', title))
  await f.service.syncSessionsAsBots()
  assert.equal(f.state.bots['long-title'].sessionTitle, title.slice(0, 512))
  assert.ok(f.state.bots['long-title'].name.length <= 40)
  assert.ok(f.state.bots['long-title'].sessionTitle.length > 40)
})

test('automatic names follow title changes while explicit and channel names stay fixed', async t => {
  const f = start(t)
  f.items.push(row('auto'), row('user'), row('channel'))
  await f.service.syncSessionsAsBots()
  f.state.bots.user.name = 'My writer'
  f.state.bots.user.nameSource = 'user'
  f.state.bots.channel.nameSource = 'channel'
  for (const item of f.items) item.projections.values.title = 'New title'
  f.service.invalidateSessionBots()
  await f.service.syncSessionsAsBots()
  assert.equal(f.state.bots.auto.name, 'New title')
  assert.equal(f.state.bots.auto.sessionTitle, 'New title')
  assert.equal(f.state.bots.user.name, 'My writer')
  assert.equal(f.state.bots.user.sessionTitle, 'Project user')
  assert.equal(f.state.bots.channel.name, 'Project channel')
  assert.equal(f.state.bots.channel.sessionTitle, 'Project channel')
})

test('archive and source removal change availability without deleting Bot metadata or the user hidden flag', async t => {
  const f = start(t)
  f.items.push(row('source'))
  await f.service.syncSessionsAsBots()
  const bot = f.state.bots.source
  bot.hidden = true
  f.ctx.workspaceRegistry.archivedSessionIds.push('source')
  await f.service.syncSessionsAsBots()
  assert.equal(bot.sessionArchived, true)
  assert.equal(f.service.isSessionBotVisible(bot), false)
  f.ctx.workspaceRegistry.archivedSessionIds.length = 0
  await f.service.syncSessionsAsBots()
  assert.equal(f.service.isSessionBotVisible(bot), true)
  f.items.length = 0
  f.advance(30_000)
  await f.service.syncSessionsAsBots()
  assert.equal(bot.sessionMissing, true)
  assert.equal(f.service.isSessionBotVisible(bot), false)
  assert.equal(f.state.bots.source, bot)
  assert.equal(bot.hidden, true)
  f.items.push(row('source'))
  f.service.invalidateSessionBots()
  await f.service.syncSessionsAsBots()
  assert.equal(f.service.isSessionBotVisible(bot), true)
  assert.equal(f.calls.resolve, 0)
})

test('a failed batch save restores every staged identity and the next request retries the batch', async t => {
  const f = start(t)
  f.items.push(row('bad'), row('good'))
  const save = f.rt.save
  let writes = 0
  f.rt.save = options => ++writes === 1 ? Promise.reject(new Error('disk full')) : save(options)
  await assert.rejects(f.service.syncSessionsAsBots(), /disk full/)
  assert.equal(f.state.bots.bad, undefined)
  assert.equal(f.state.bots.good, undefined)
  assert.equal(f.saved.at(-1).bots.bad, undefined)
  assert.equal(f.saved.at(-1).bots.good, undefined)
  assert.ok(f.calls.index > 0)
  assert.deepEqual((await f.service.syncSessionsAsBots()).created, ['bad', 'good'])
})

test('a failed batch restores existing automatic metadata as well as new identities', async t => {
  const f = start(t)
  f.items.push(row('source'))
  await f.service.syncSessionsAsBots()
  const bot = f.state.bots.source, before = structuredClone(bot)
  f.items[0].projections.values.title = 'Changed title'
  f.items.push(row('new'))
  const save = f.rt.save
  let writes = 0
  f.rt.save = options => ++writes === 1 ? Promise.reject(new Error('disk full')) : save(options)
  f.service.invalidateSessionBots()
  await assert.rejects(f.service.syncSessionsAsBots(), /disk full/)
  assert.equal(f.state.bots.source, bot)
  assert.deepEqual(bot, before)
  assert.equal(f.state.bots.new, undefined)
  assert.deepEqual(f.saved.at(-1).bots.source, before)
})

test('a failed metadata save preserves concurrent user edits and replacement identities', async t => {
  const f = start(t)
  f.items.push(row('source'))
  await f.service.syncSessionsAsBots()
  const bot = f.state.bots.source, oldName = bot.name
  f.items[0].projections.values.title = 'Automatic new title'
  f.items[0].projections.values.modelSelection.next.reasoningEffort = 'medium'
  f.items.push(row('new'))
  const entered = deferred(), release = deferred(), save = f.rt.save
  let writes = 0
  f.rt.save = async options => {
    if (++writes === 1) { entered.resolve(); await release.promise; throw new Error('disk full') }
    await save(options)
  }
  f.service.invalidateSessionBots()
  const syncing = f.service.syncSessionsAsBots()
  const rejected = assert.rejects(syncing, /disk full/)
  await entered.promise
  bot.role = 'Continuity editor'
  bot.color = 'blue'
  bot.effort = 'user-selected'
  const replacement = { id: 'new', name: 'Explicit replacement', role: 'Director' }
  f.state.bots.new = replacement
  release.resolve()
  await rejected
  assert.equal(bot.name, oldName)
  assert.equal(bot.role, 'Continuity editor')
  assert.equal(bot.color, 'blue')
  assert.equal(bot.effort, 'user-selected')
  assert.equal(f.state.bots.new, replacement)
  assert.deepEqual(f.saved.at(-1).bots.source, bot)
  assert.deepEqual(f.saved.at(-1).bots.new, replacement)
})

test('metadata failures are isolated while listing failures reject and retry on the next request', async t => {
  const f = start(t)
  f.items.push(row('bad'), row('good'))
  f.live.set('bad', { header: { cwd: '/bad' } })
  f.ctx.sessionTitle.get = () => { throw new Error('title unavailable') }
  assert.deepEqual(await f.service.syncSessionsAsBots(), { created: ['good'], failures: [{ sessionId: 'bad', message: 'title unavailable' }] })
  const list = f.ctx.sessionController.list
  f.ctx.sessionController.list = async () => { throw new Error('persistence unavailable') }
  f.service.invalidateSessionBots()
  await assert.rejects(f.service.syncSessionsAsBots(), /persistence unavailable/)
  f.ctx.sessionController.list = list
  const result = await f.service.syncSessionsAsBots()
  assert.equal(result.failures[0].sessionId, 'bad')
})

test('configuration, read-only teams and missing metadata services never register or save', async t => {
  const f = start(t)
  f.items.push(row('source'))
  f.rt.config.autoSessionBots = false
  await f.service.syncSessionsAsBots()
  f.rt.config.autoSessionBots = true
  f.setReadOnly('another Host owns this team')
  await f.service.syncSessionsAsBots()
  assert.deepEqual([f.calls.list, f.calls.save], [0, 0])
  f.setReadOnly(undefined)
  delete f.ctx.sessionController.list
  await f.service.syncSessionsAsBots()
  await f.service.syncSessionsAsBots()
  assert.equal(f.warnings.length, 1)
  assert.deepEqual(f.state.bots, {})
})

test('concurrent requests share a listing and dirty events during it trigger one later reconciliation', async t => {
  const f = start(t)
  const entered = deferred(), release = deferred()
  f.ctx.sessionController.list = async () => { f.calls.list++; entered.resolve(); await release.promise; return { items: [row('source')] } }
  const first = f.service.syncSessionsAsBots(), second = f.service.syncSessionsAsBots()
  assert.equal(first, second)
  await entered.promise
  f.service.invalidateSessionBots()
  release.resolve()
  assert.deepEqual((await first).created, ['source'])
  await f.service.syncSessionsAsBots()
  assert.equal(f.calls.list, 2)
  assert.equal(f.saved.length, 1)
})

test('explicit registration waits for the batch save and reuses its committed identity', async t => {
  const f = start(t)
  f.items.push(row('source'))
  f.rt.selfOf = id => Object.values(f.state.bots).find(bot => bot.sessionId === id)?.id
  f.rt.botOf = id => f.state.bots[id]
  f.rt.groupOwners = new Map()
  f.rt.pastOwners = new Map()
  const entered = deferred(), release = deferred(), save = f.rt.save
  f.rt.save = async options => { entered.resolve(); await release.promise; await save(options) }
  const syncing = f.service.syncSessionsAsBots()
  await entered.promise
  let registered = false
  const registration = f.service.registerSessionAsBot('source').then(result => { registered = true; return result })
  assert.equal(registered, false)
  release.resolve()
  await syncing
  assert.deepEqual(await registration, { botId: 'source', sessionId: 'source', created: false })
  assert.equal(f.saved.length, 1)
  assert.equal(f.calls.resolve, 0)
})

test('internal Session construction defers synchronization and excludes the completed factory identity', async t => {
  const f = start(t)
  f.items.push(row('internal'), row('ordinary'))
  f.rt.pendingTeamSessionCreates = 1
  await f.service.syncSessionsAsBots()
  assert.equal(f.calls.list, 0)
  f.rt.pendingTeamSessionCreates = 0
  f.rt.teamSessionIds = new Set(['internal'])
  assert.deepEqual((await f.service.syncSessionsAsBots()).created, ['ordinary'])
})

test('unload during a metadata read waits for it and prevents a late identity write', async t => {
  const f = start(t)
  const entered = deferred(), release = deferred()
  f.ctx.sessionController.list = async () => { entered.resolve(); await release.promise; return { items: [row('source')] } }
  const syncing = f.service.syncSessionsAsBots()
  const rejected = assert.rejects(syncing, /stopped/)
  await entered.promise
  const stopping = f.service.dispose()
  release.resolve()
  await rejected
  await stopping
  assert.deepEqual(f.state.bots, {})
})

test('cancelling a pending listing prevents late registration and permits the next request to retry', async t => {
  const f = start(t)
  const entered = deferred(), release = deferred(), controller = new AbortController()
  f.ctx.sessionController.list = async () => { entered.resolve(); await release.promise; return { items: [row('source')] } }
  const syncing = f.service.syncSessionsAsBots(controller.signal)
  const rejected = assert.rejects(syncing, /cancelled/)
  await entered.promise
  controller.abort(new Error('cancelled'))
  release.resolve()
  await rejected
  assert.equal(f.calls.save, 0)
  assert.deepEqual((await f.service.syncSessionsAsBots()).created, ['source'])
})

test('Session listeners only invalidate and never register while a factory is creating its Session', async t => {
  const f = start(t)
  install(f.rt)
  t.after(() => f.rt.museTeam.dispose())
  await f.rt.museTeam.syncSessionsAsBots()
  for (const [name, args] of [['session/created', [{}]], ['session/disposed', [{}]],
    ['session/event', [{}, { type: 'session/title' }]], ['session/event', [{}, { type: 'turn/start' }]]]) {
    f.rt.museTeam.sessionBotsDirty = false
    f.events.get(name)(...args)
    assert.equal(f.rt.museTeam.sessionBotsDirty, true)
  }
  assert.deepEqual([f.calls.list, f.calls.save], [1, 0])
})
