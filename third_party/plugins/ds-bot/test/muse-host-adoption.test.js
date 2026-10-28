import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createRuntime } from '../index.js'
import { install as installTeam } from '../src/host/muse-team.js'
import { TEAM_TOOLS } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

const MODEL = { provider: 'muse', model: 'native-choice', reasoningEffort: 'high' }

function start(t, { plain = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'muse-bot-adopt-'))
  const state = {
    version: 1, revision: 1, whaleStored: true, mainBotIds: ['chief'],
    bots: { chief: { id: 'chief', name: 'Chief', model: 'muse/native-choice', effort: 'high', appliedModel: 'muse/native-choice', appliedEffort: 'high', capabilities: [], createdAt: 1 } },
    rooms: {}, agents: plain ? { plain: { id: 'plain', name: 'Agent', sessions: ['source'], createdAt: 1 } } : {},
    capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, questions: {},
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const selected = [], created = [], archived = [], sent = [], renamed = [], restrictions = [], released = []
  const projections = new Map()
  const agents = new Map()
  const sessions = new Map()
  const workspace = { id: 'original-workspace', path: join(home, 'original'), sessionIds: ['source', 'next', 'third', 'child'] }
  const defaults = { currentSelection: () => ({ provider: 'muse', model: 'default', reasoningEffort: 'low' }), saveSelection: async () => {} }
  const ctx = fakeContext({ services: {
    agentDefaultModel: defaults,
    agentPresets: { list: async () => [{ id: 'short-drama' }, { id: 'standard' }] },
    sessionProjections: { stateOf: (session, key) => key === 'modelSelection' ? projections.get(session.id) : key === 'agentPreset' ? 'standard' : undefined },
    goals: { get: agent => agent.goal },
  } })
  ctx.tools.schemas = () => [...TEAM_TOOLS, 'ask_user_question', 'read', 'create_goal', 'update_goal', 'get_goal'].map(name => ({ name }))
  const agentOf = (id) => {
    if (!agents.has(id)) {
      const session = {
        id, header: { id, cwd: join(workspace.path, id), origin: id === 'child' ? 'subagent' : 'root' },
        requestHeader: () => ({ config: { provider: 'muse', model: 'previous', reasoningEffort: 'low' } }),
        deriveMessages: () => [], snapshotEvents: () => [],
      }
      sessions.set(id, session)
      projections.set(id, { pending: { ...MODEL }, lastUsed: { provider: 'muse', model: 'previous', reasoningEffort: 'low' } })
      const agent = {
        id, status: 'running', session,
        goal: { id: `goal-${id}`, phase: 'active', revision: 3, activation: 'armed' },
        inbox: { nextStep: [{ id: 'existing-inbox' }], nextTurn: [] }, jobs: [{ id: 'existing-job' }],
        ctx: {
          tools: { restrict: ({ deny }) => {
            const entry = { id, deny }
            restrictions.push(entry)
            return () => released.push(entry)
          } },
          effect: (execute, label) => ctx.effect(execute, label),
        },
        followup: message => sent.push({ id, message }),
        cancel: () => { throw new Error('Registration must not cancel a Session') },
      }
      agents.set(id, agent)
    }
    return agents.get(id)
  }
  Object.assign(ctx, {
    agents: { get: id => agents.get(id) },
    sessions: { get: id => sessions.get(id), flush: async () => {}, messageProjections: [] },
    sessionTitle: { get: session => ({ title: session.id === 'source' ? 'Original project' : `Project ${session.id}` }), rename: async (...args) => renamed.push(args) },
    workspaceRegistry: {
      list: () => [workspace], get: id => id === workspace.id ? workspace : undefined,
      resolveByPath: async () => workspace, create: async () => { throw new Error('Must not create a workspace') },
      archiveSession: async id => archived.push(id),
    },
    sessionController: {
      create: async request => { created.push(request); throw new Error('Must not create a Session') },
      resolveAgent: async (id) => id === 'missing' ? { error: { code: 'session/not-found', message: 'Session missing' } }
        : id === 'owned-child' ? { error: { code: 'session/agent-busy', message: 'Subagent owns this Session' } } : { agent: agentOf(id) },
      selectModel: async request => { selected.push(request); return { selected: request } },
    },
    llm: {
      listProviders: () => [{ id: 'muse' }],
      listModels: async () => ['native-choice', 'new-choice', 'previous', 'default'].map(id => ({ id })),
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }, { id: 'low' }] } }),
    },
  })
  let route
  const register = ctx.connection.fetch.register.bind(ctx.connection.fetch)
  ctx.connection.fetch.register = options => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home, diagnosticsFile: false, ensureMuseSpecialist: false })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const call = async (endpoint, payload = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  return { rt, ctx, home, call, agentOf, agents, projections, workspace, selected, created, archived, sent, renamed, restrictions, released }
}

test('registering a running ordinary Session preserves its native Agent, pending model, goal and workspace', async t => {
  const fixture = start(t)
  const { rt, ctx, agentOf, workspace, home } = fixture
  const agent = agentOf('source')
  const before = structuredClone({ header: agent.session.header, goal: agent.goal, inbox: agent.inbox, jobs: agent.jobs, workspace })
  const registered = await ctx.get('museTeam').registerSessionAsBot('source')
  assert.deepEqual(registered, { botId: 'source', sessionId: 'source', created: true })
  assert.equal(agentOf('source'), agent)
  assert.deepEqual({ header: agent.session.header, goal: agent.goal, inbox: agent.inbox, jobs: agent.jobs, workspace }, before)
  const bot = rt.botOf('source')
  assert.deepEqual([bot.name, bot.modelSource, bot.interactionSource, bot.model, bot.effort, bot.workspaceId, bot.workDir],
    ['Original project', 'session', 'session', 'muse/native-choice', 'high', workspace.id, agent.session.header.cwd])
  assert.equal(rt.isMain('source'), false)
  assert.equal(rt.selfOf('source'), 'source')
  assert.deepEqual(await rt.museTeam.resolveCurrentSession('source'), { botId: 'source', sessionId: 'source' })
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).bots.source.sessionId, 'source')
  for (const key of ['selected', 'created', 'archived', 'sent', 'renamed']) assert.deepEqual(fixture[key], [])
})

test('concurrent registration is idempotent and never promotes a member implicitly', async t => {
  const { rt } = start(t)
  const results = await Promise.all(Array.from({ length: 5 }, () => rt.museTeam.registerSessionAsBot('source', { name: 'Editor' })))
  assert.equal(results.filter(result => result.created).length, 1)
  assert.equal(Object.keys(rt.state.bots).filter(id => id === 'source').length, 1)
  await rt.museTeam.registerSessionAsBot('source', { name: 'Ignored duplicate', main: true })
  assert.equal(rt.botOf('source').name, 'Editor')
  assert.deepEqual(rt.state.mainBotIds, ['chief'])
  await rt.museTeam.registerSessionAsBot('next', { name: 'Explicit lead', main: true })
  assert.deepEqual(rt.state.mainBotIds, ['chief', 'next'])
})

test('external chat-name hints preserve ordinary names and disambiguate equal names without changing explicit-name semantics', async t => {
  const { rt, sent, selected, renamed } = start(t)
  const name = '编剧共创项目讨论组'.repeat(3).slice(0, 38)
  await rt.museTeam.registerSessionAsBot('source', { nameHint: name })
  await rt.museTeam.registerSessionAsBot('next', { nameHint: name })
  const first = rt.botOf('source'), second = rt.botOf('next')
  assert.equal(first.name, name)
  assert.equal(first.channelName, name)
  assert.equal(first.nameSource, 'channel')
  assert.equal(first.autoName, name)
  assert.notEqual(second.name, first.name)
  assert.match(second.name, / 2$/)
  assert.equal(second.channelName, name)
  await assert.rejects(rt.museTeam.registerSessionAsBot('third', { name }), /already exists/)
  assert.deepEqual([sent, selected, renamed], [[], [], []])
})

test('long and special external titles stay bounded while the Bot name remains addressable', async t => {
  const { rt } = start(t)
  const title = `项目@主创\n\`讨论\` ${'长'.repeat(600)}`
  await rt.museTeam.registerSessionAsBot('source', { nameHint: title })
  const bot = rt.botOf('source')
  assert.equal(bot.channelName, title.slice(0, 512))
  assert.ok(bot.name.length <= 40)
  assert.doesNotMatch(bot.name, /[@`\r\n]/)
  assert.match(bot.name, /^项目＠主创 ｀讨论｀ 长/)
  await rt.museTeam.registerSessionAsBot('next', { nameHint: 'User' })
  assert.equal(rt.botOf('next').name, '飞书 User')
  await rt.museTeam.registerSessionAsBot('third', { nameHint: ' \n ' })
  assert.equal(rt.botOf('third').nameSource, 'session')
  assert.equal(rt.botOf('third').channelName, undefined)
  await assert.rejects(rt.museTeam.registerSessionAsBot('bad-hint', { nameHint: 5 }), /must be text/)
})

test('first late chat metadata can replace an untouched automatic Session name and later titles retain its stable address', async t => {
  const { rt, renamed } = start(t)
  await rt.museTeam.registerSessionAsBot('source')
  const bot = rt.botOf('source')
  assert.equal(bot.nameSource, 'session')
  assert.equal(bot.autoName, 'Original project')
  await rt.updateBot('source', { name: bot.name, role: 'Writer' })
  assert.equal(bot.nameSource, 'session')
  const renamedBeforeHint = renamed.length
  assert.deepEqual(await rt.museTeam.registerSessionAsBot('source', { nameHint: '编剧组' }), { botId: 'source', sessionId: 'source', created: false })
  assert.deepEqual([bot.name, bot.channelName, bot.nameSource, bot.autoName], ['编剧组', '编剧组', 'channel', '编剧组'])
  assert.equal(renamed.length, renamedBeforeHint)
  await rt.museTeam.registerSessionAsBot('source', { nameHint: '编剧组（新群名）' })
  assert.equal(bot.name, '编剧组')
  assert.equal(bot.channelName, '编剧组（新群名）')
})

test('late external titles never replace a manually renamed or unmarked legacy Bot name', async t => {
  const { rt } = start(t)
  await rt.museTeam.registerSessionAsBot('source')
  await rt.updateBot('source', { name: '我的编剧助手' })
  const bot = rt.botOf('source')
  assert.equal(bot.nameSource, 'user')
  assert.equal(bot.autoName, undefined)
  await rt.museTeam.registerSessionAsBot('source', { nameHint: '真实飞书群' })
  assert.equal(bot.name, '我的编剧助手')
  assert.equal(bot.channelName, '真实飞书群')
  await rt.museTeam.registerSessionAsBot('chief', { nameHint: '旧群标题' })
  assert.equal(rt.botOf('chief').name, 'Chief')
  assert.equal(rt.botOf('chief').channelName, '旧群标题')
  assert.equal(rt.botOf('chief').nameSource, undefined)
})

test('registering a Session from the plain Agent container releases only its owned team-tool restriction', async t => {
  const { ctx, rt, agentOf, restrictions, released } = start(t, { plain: true })
  await rt.load()
  const agent = agentOf('source')
  for (const listener of ctx.listeners.get('agent/created') ?? []) await listener({ agent })
  await setImmediate()
  assert.ok(restrictions.some(entry => entry.id === 'source' && entry.deny.includes('message_bot')))
  await rt.museTeam.registerSessionAsBot('source')
  assert.deepEqual(rt.state.agents.plain.sessions, [])
  assert.equal(rt.agentOf('source'), undefined)
  assert.equal(released.length, 1)
  assert.deepEqual(released[0], restrictions.find(entry => entry.id === 'source'))
  rt.hideBotUnusedTools(agent)
  assert.equal(restrictions.some(entry => entry.id === 'source' && entry.deny.includes('ask_user_question')), false)
  for (const guard of ctx.guards) assert.equal(await guard({ name: 'ask_user_question', agent }), undefined)
  const list = ctx.registeredTools.get('list_bots')
  assert.match(await list.execute({}, { agent }), /Original project.*you/)
})

test('native model selection remains authoritative through refresh until a UI or tool explicitly changes it', async t => {
  const { rt, projections, selected, call } = start(t)
  await rt.museTeam.registerSessionAsBot('source')
  projections.get('source').pending = { provider: 'muse', model: 'new-choice', reasoningEffort: 'low' }
  await rt.catalog({ fresh: true })
  await rt.syncModels()
  assert.deepEqual(selected, [])
  const bot = rt.botOf('source')
  assert.equal(await rt.applyModel(bot, { force: true }), 'muse/new-choice')
  assert.deepEqual(selected, [])
  assert.deepEqual(rt.modelView(bot), { model: 'muse/new-choice', effort: 'low', appliedModel: undefined, appliedEffort: undefined })
  const state = await call('state')
  assert.equal(state.ok, true, JSON.stringify(state))
  assert.equal(state.value.bots.find(entry => entry.id === 'source').model, 'muse/new-choice')
  await rt.updateBot('source', { role: 'Continuity' }, 'chief')
  assert.equal(bot.modelSource, 'session')
  await rt.updateBot('source', { effort: 'high' }, 'chief')
  assert.equal(bot.modelSource, 'bot')
  assert.deepEqual(selected, [{ sessionId: 'source', provider: 'muse', model: 'new-choice', reasoningEffort: 'high' }])
})

test('explicit native Session switching preserves stable Bot identity and all old running work', async t => {
  const fixture = start(t, { plain: true })
  const { rt, agentOf, selected, archived, sent, workspace } = fixture
  const original = agentOf('source')
  await rt.museTeam.registerSessionAsBot('source')
  const goal = { ...original.goal }
  const result = await rt.museTeam.switchCurrentSession('source', 'next')
  assert.deepEqual(result, { botId: 'source', sessionId: 'next', previousSessionId: 'source' })
  assert.deepEqual(await rt.museTeam.resolveCurrentSession('source'), { botId: 'source', sessionId: 'next' })
  assert.equal(rt.selfOf('next'), 'source')
  assert.equal(rt.selfOf('source'), 'source')
  assert.equal(rt.botOf('source').segments[0].sessionId, 'source')
  assert.equal(rt.botOf('source').workDir, agentOf('next').session.header.cwd)
  assert.equal(rt.botOf('source').workspaceId, workspace.id)
  assert.deepEqual(original.goal, goal)
  assert.equal(original.status, 'running')
  assert.deepEqual([selected, archived, sent], [[], [], []])
  await rt.museTeam.switchCurrentSession('source', 'source')
  assert.equal(rt.chatOf('source'), 'source')
  assert.deepEqual(rt.botOf('source').segments.map(entry => entry.sessionId), ['next'])
  const repeat = await rt.museTeam.registerSessionAsBot('next')
  assert.deepEqual(repeat, { botId: 'source', sessionId: 'source', created: false })
})

async function automaticTarget(t) {
  const f = start(t)
  await f.rt.museTeam.registerSessionAsBot('source')
  const items = [{ sessionId: 'next', cwd: join(f.workspace.path, 'next'), blank: false,
    projections: { values: { title: 'Existing episode discussion', modelSelection: { next: MODEL } } } }]
  f.ctx.sessionController.list = async () => ({ items })
  assert.equal(f.agents.has('next'), false)
  assert.deepEqual((await f.rt.museTeam.syncSessionsAsBots()).created, ['next'])
  assert.equal(f.agents.has('next'), false)
  return f
}

test('explicit use absorbs an untouched cold-registered entry while retaining the chat Bot and native work', async t => {
  const f = await automaticTarget(t)
  const original = f.agentOf('source'), before = structuredClone({ goal: original.goal, inbox: original.inbox, jobs: original.jobs })
  assert.deepEqual(await f.rt.museTeam.switchCurrentSession('source', 'next'),
    { botId: 'source', sessionId: 'next', previousSessionId: 'source' })
  assert.equal(f.rt.botOf('next'), undefined)
  assert.equal(f.rt.selfOf('next'), 'source')
  assert.equal(f.rt.selfOf('source'), 'source')
  assert.deepEqual([f.rt.botOf('source').model, f.rt.botOf('source').effort], ['muse/native-choice', 'high'])
  assert.deepEqual({ goal: original.goal, inbox: original.inbox, jobs: original.jobs }, before)
  f.rt.museTeam.invalidateSessionBots()
  assert.deepEqual((await f.rt.museTeam.syncSessionsAsBots()).created, [])
  assert.deepEqual([f.selected, f.created, f.archived, f.sent], [[], [], [], []])
})

test('a failed explicit use restores the automatic target identity and both original Session mappings', async t => {
  const f = await automaticTarget(t)
  const automatic = f.rt.botOf('next'), before = structuredClone(f.rt.botOf('source'))
  const save = f.rt.save
  let writes = 0
  f.rt.save = options => ++writes === 1 ? Promise.reject(new Error('disk full')) : save(options)
  await assert.rejects(f.rt.museTeam.switchCurrentSession('source', 'next'), /disk full/)
  assert.equal(f.rt.botOf('next'), automatic)
  assert.deepEqual(f.rt.botOf('source'), before)
  assert.equal(f.rt.selfOf('source'), 'source')
  assert.equal(f.rt.selfOf('next'), 'next')
  const stored = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'))
  assert.deepEqual(stored.bots.next, automatic)
  assert.equal(stored.bots.source.sessionId, 'source')
  assert.deepEqual(f.archived, [])
})

test('a failed explicit use preserves user settings changed while its save was pending', async t => {
  const f = await automaticTarget(t)
  const bot = f.rt.botOf('source'), automatic = f.rt.botOf('next')
  f.agentOf('next')
  f.projections.get('next').pending = { provider: 'muse', model: 'new-choice', reasoningEffort: 'low' }
  const save = f.rt.save
  let entered, release, writes = 0
  const waiting = new Promise(resolve => { entered = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  f.rt.save = async options => {
    if (++writes === 1) { entered(); await blocked; throw new Error('disk full') }
    return save(options)
  }
  const switching = f.rt.museTeam.switchCurrentSession('source', 'next')
  const rejected = assert.rejects(switching, /disk full/)
  await waiting
  await f.rt.updateBot('source', { role: 'Continuity editor', color: 'blue' })
  bot.model = 'muse/user-selection'
  bot.effort = 'user-effort'
  release()
  await rejected
  assert.equal(f.rt.chatOf('source'), 'source')
  assert.equal(f.rt.selfOf('next'), 'next')
  assert.equal(f.rt.botOf('next'), automatic)
  assert.equal(bot.segments, undefined)
  assert.deepEqual([bot.role, bot.color, bot.model, bot.effort], ['Continuity editor', 'blue', 'muse/user-selection', 'user-effort'])
  const stored = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8')).bots.source
  assert.deepEqual([stored.sessionId, stored.role, stored.color, stored.model, stored.effort],
    ['source', 'Continuity editor', 'blue', 'muse/user-selection', 'user-effort'])
})

test('explicit use keeps customized or team-used automatic Bots as independent members', async t => {
  const f = await automaticTarget(t)
  const bot = f.rt.botOf('next')
  for (const patch of [{ role: 'Director' }, { nameSource: 'user' }, { nameSource: 'channel', channelName: 'Group' },
    { instructions: 'Keep my role' }, { capabilities: ['skill'] }, { modelSource: 'bot' }, { permission: 'workspace' },
    { color: 'blue' }, { avatar: { shape: 'star' } }, { segments: [] }]) {
    const original = { ...bot }
    Object.assign(bot, patch)
    await assert.rejects(f.rt.museTeam.switchCurrentSession('source', 'next'), /another team/)
    for (const key of Object.keys(bot)) delete bot[key]
    Object.assign(bot, original)
  }
  f.rt.state.mainBotIds.push('next')
  await assert.rejects(f.rt.museTeam.switchCurrentSession('source', 'next'), /another team/)
  f.rt.state.mainBotIds.pop()
  f.rt.state.rooms.discussion = { id: 'discussion', members: ['next'], sessions: {} }
  await assert.rejects(f.rt.museTeam.switchCurrentSession('source', 'next'), /another team/)
  delete f.rt.state.rooms.discussion
  f.rt.state.exchanges.push({ id: 'used', from: 'chief', to: 'next' })
  await assert.rejects(f.rt.museTeam.switchCurrentSession('source', 'next'), /another team/)
  assert.equal(f.rt.botOf('next'), bot)
  assert.equal(f.agents.has('next'), false)
  assert.equal(f.rt.chatOf('source'), 'source')
})

test('registration refuses invalid, child and team-group identities without creating a replacement Session', async t => {
  const { rt, created, archived } = start(t)
  for (const id of ['', '../source', '__proto__', 'missing', 'owned-child', 'child']) await assert.rejects(rt.museTeam.registerSessionAsBot(id))
  await rt.load()
  rt.state.rooms.room = { id: 'room', name: 'Discussion', members: ['chief'], sessions: { chief: 'group-member' } }
  rt.indexSessions()
  await assert.rejects(rt.museTeam.registerSessionAsBot('room'), /belongs/)
  await assert.rejects(rt.museTeam.registerSessionAsBot('group-member'), /group member/)
  await rt.museTeam.registerSessionAsBot('source')
  await assert.rejects(rt.museTeam.switchCurrentSession('source', 'chief'), /another team/)
  await assert.rejects(rt.museTeam.switchCurrentSession('source', 'group-member'), /another team/)
  assert.deepEqual([created, archived], [[], []])
})

test('an unsuccessful identity write restores the plain-container mapping and leaves its restriction and Session intact', async t => {
  const { rt, ctx, agentOf, archived, released } = start(t, { plain: true })
  await rt.load()
  const agent = agentOf('source')
  for (const listener of ctx.listeners.get('agent/created') ?? []) await listener({ agent })
  await setImmediate()
  const save = rt.save
  let writes = 0
  rt.save = options => ++writes === 1 ? Promise.reject(new Error('disk full')) : save(options)
  await assert.rejects(rt.museTeam.registerSessionAsBot('source'), /disk full/)
  assert.equal(rt.botOf('source'), undefined)
  assert.deepEqual(rt.state.agents.plain.sessions, ['source'])
  assert.equal(rt.selfOf('source'), undefined)
  assert.equal(rt.agentOf('source').id, 'plain')
  assert.deepEqual([released, archived], [[], []])
  assert.equal(agent.goal.activation, 'armed')
})

test('the explicit adopt-session route validates input and does not invoke bootstrap or a greeting', async t => {
  const { call, created, sent, rt } = start(t)
  assert.equal((await call('adopt-session', { sessionId: 'source', main: 'yes' })).ok, false)
  assert.deepEqual((await call('adopt-session', { sessionId: 'source', name: 'From classic' })).value,
    { botId: 'source', sessionId: 'source', created: true })
  assert.equal(rt.botOf('source').name, 'From classic')
  assert.deepEqual([created, sent], [[], []])
})

test('a failed explicit switch restores the current mapping and leaves both native goals unchanged', async t => {
  const { rt, agentOf, archived } = start(t)
  await rt.museTeam.registerSessionAsBot('source')
  const source = agentOf('source'), next = agentOf('next')
  const goals = structuredClone([source.goal, next.goal])
  const save = rt.save
  let writes = 0
  rt.save = options => ++writes === 1 ? Promise.reject(new Error('disk full')) : save(options)
  await assert.rejects(rt.museTeam.switchCurrentSession('source', 'next'), /disk full/)
  assert.deepEqual(await rt.museTeam.resolveCurrentSession('source'), { botId: 'source', sessionId: 'source' })
  assert.equal(rt.selfOf('next'), undefined)
  assert.equal(rt.botOf('source').segments, undefined)
  assert.deepEqual([source.goal, next.goal], goals)
  assert.deepEqual(archived, [])
})

test('unloading during root resolution waits for the pending operation and records no partial Bot identity', async t => {
  const { rt, ctx, agentOf, created, archived } = start(t)
  const agent = agentOf('source')
  let resolveAgent, entered
  const waiting = new Promise(resolve => { entered = resolve })
  ctx.sessionController.resolveAgent = () => { entered(); return new Promise(resolve => { resolveAgent = resolve }) }
  const registration = rt.museTeam.registerSessionAsBot('source')
  const rejection = assert.rejects(registration, /stopped/)
  await waiting
  const stopping = rt.museTeam.dispose()
  resolveAgent({ agent })
  await rejection
  await stopping
  assert.equal(rt.botOf('source'), undefined)
  assert.equal(agent.goal.activation, 'armed')
  assert.deepEqual([created, archived], [[], []])
})

test('an unlisted ordinary caller can make its first message_bot call without opening the Bot roster', async t => {
  const f = start(t)
  const caller = f.agentOf('source')
  const original = structuredClone({ goal: caller.goal, inbox: caller.inbox, jobs: caller.jobs })
  f.ctx.sessionController.list = async () => ({ items: [{ sessionId: 'source', cwd: caller.session.header.cwd, blank: false,
    projections: { values: { title: 'Original project', modelSelection: { next: MODEL } } } }] })
  assert.equal(f.rt.botOf('source'), undefined)
  const reply = await f.ctx.registeredTools.get('message_bot').execute(
    { to: 'Chief', message: 'Review this episode', reply_to: 'user', when: 'queue' }, { agent: caller })
  assert.match(reply, /^Delivered to Chief/)
  assert.equal(f.rt.botOf('source').autoSessionBot, true)
  assert.equal(f.rt.selfOf('source'), 'source')
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].id, 'chief')
  assert.equal(f.sent[0].message.source.senderSessionId, 'source')
  assert.deepEqual({ goal: caller.goal, inbox: caller.inbox, jobs: caller.jobs }, original)
  assert.deepEqual([f.selected, f.created, f.archived], [[], [], []])
})

test('archived automatic members cannot receive a task or be added through group tools', async t => {
  const { rt, ctx, sent, created } = start(t)
  await rt.load()
  rt.state.bots.archived = { id: 'archived', name: 'Archived editor', autoSessionBot: true, sessionArchived: true }
  const exec = { agent: { id: 'chief' } }
  const message = await ctx.registeredTools.get('message_bot').execute({ to: 'Archived editor', message: 'Continue writing' }, exec)
  assert.match(message, /archived or unavailable/)
  const group = ctx.registeredTools.get('create_group')
  assert.match(await group.execute({ members: ['Archived editor'], name: 'Crew' }, exec), /No Bot named/)
  assert.match(await group.execute({ members: [], admin: 'Archived editor', name: 'Crew' }, exec), /No Bot named/)
  assert.deepEqual([sent, created], [[], []])
})

test('museTeam is injectable through Cordis and unavailable after its owning plugin unloads', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  let service
  const owner = await ctx.plugin(inner => {
    const rt = { ctx: inner, load: async () => {}, readOnly: () => undefined, botOf: id => id === 'bot' ? { id } : undefined, chatOf: () => 'original' }
    installTeam(rt)
    service = rt.museTeam
  })
  assert.equal(ctx.get('museTeam'), service)
  assert.deepEqual(await ctx.get('museTeam').resolveCurrentSession('bot'), { botId: 'bot', sessionId: 'original' })
  await owner.dispose()
  assert.equal(ctx.get('museTeam'), undefined)
  await assert.rejects(service.resolveCurrentSession('bot'), /stopped/)
})
