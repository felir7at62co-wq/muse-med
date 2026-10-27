import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime, resolveMuseConfig } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const MODEL = { provider: 'muse', model: 'glm-flashx', reasoningEffort: 'high' }
const team = () => ({
  version: 1, revision: 1, whaleStored: true, mainBotIds: ['chief'],
  bots: { chief: { id: 'chief', name: 'My editor', role: 'Editor', instructions: '', model: 'muse/glm-flashx', effort: 'high', permission: 'read-only', createdAt: 1, capabilities: [] } },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {},
})

function start(t, { config = {}, initial = team(), presets = [{ id: 'short-drama' }, { id: 'standard' }], services = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'muse-bot-host-'))
  if (initial !== null) writeFileSync(join(home, 'state.json'), JSON.stringify(initial))
  const selected = []
  const permissions = []
  const created = []
  const sent = []
  const hidden = []
  const warnings = []
  const workspace = { id: 'workspace', path: join(home, 'workspace') }
  const defaults = {
    currentSelection: () => ({ ...MODEL }),
    saveSelection: async value => { assert.deepEqual(value, MODEL) },
  }
  const ctx = fakeContext({ services: {
    agentPresets: { list: async () => presets, serviceFor: () => services.compaction },
    agentDefaultModel: defaults,
    permissionPresets: {
      catalog: () => ({ defaultPreset: 'workspace-write', options: [{ value: 'workspace-write' }, { value: 'read-only' }] }),
      set: (session, value) => permissions.push([session.id, value]),
      resolve: value => value,
    },
    goals: { get: () => undefined },
    ...services,
  } })
  ctx.logger.warn = (...args) => warnings.push(args)
  const agents = new Map()
  const agentOf = id => {
    if (!agents.has(id)) agents.set(id, {
      id, status: 'idle', session: { id, header: {}, deriveMessages: () => [] },
      ctx: {
        tools: { restrict: ({ deny }) => { hidden.push([id, deny]); return () => {} } },
        effect: (execute, label) => ctx.effect(execute, label),
      },
      followup: message => sent.push({ id, message }),
    })
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: MODEL.provider }],
      listModels: async () => [{ id: MODEL.model }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }, { id: 'low' }] }, context: { contextWindow: 10_000 } }),
    },
    workspaceRegistry: {
      get: id => id === workspace.id ? workspace : undefined,
      resolveByPath: async () => workspace,
      create: async () => workspace,
      archiveSession: async () => {},
    },
    sessionController: {
      create: async request => { created.push(request); return { sessionId: `bot-${created.length}` } },
      resolveAgent: async id => ({ agent: agentOf(id) }),
      selectModel: async request => { selected.push(request); return { selected: MODEL } },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [] },
  })
  ctx.tools.schemas = () => ['read', 'ask_user_question', 'create_goal', 'update_goal', 'get_goal'].map(name => ({ name }))
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home, diagnosticsFile: false, ...config })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const call = async (endpoint, payload = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  return { ctx, rt, call, home, agentOf, created, selected, sent, hidden, permissions, warnings }
}

test('Muse defaults retain native goals and context management and reject incompatible settings', () => {
  assert.deepEqual(resolveMuseConfig(), { agentPreset: 'short-drama', contextManagement: 'host', goals: 'host', github: false, updateCheck: false, memoryReview: false, autoSessionBots: true, sessionBotSyncIntervalMs: 30000 })
  for (const input of [null, [], { agentPreset: '../editing' }, { contextManagement: 'unknown' }, { goals: true }, { contextManagement: 'bot' }, { updateCheck: true }, { autoSessionBots: 'yes' }, { sessionBotSyncIntervalMs: 0 }, { sessionBotSyncIntervalMs: 1.5 }]) {
    assert.throws(() => resolveMuseConfig(input), TypeError)
  }
  assert.equal(resolveMuseConfig({ contextManagement: 'bot', goals: 'disabled' }).contextManagement, 'bot')
  assert.equal(resolveMuseConfig({ autoSessionBots: false, sessionBotSyncIntervalMs: 1000 }).autoSessionBots, false)
})

test('new Bot Sessions use short-drama and never fall back to a different preset', async (t) => {
  const { rt, created } = start(t)
  await rt.load()
  await rt.createSession('New editor')
  assert.deepEqual(created, [{ workspaceId: 'workspace', agentPreset: 'short-drama' }])
  for (const presets of [[], [{ id: 'standard' }], [{ id: 'short-drama', broken: 'unavailable' }]]) {
    const candidate = start(t, { presets })
    await candidate.rt.load()
    await assert.rejects(candidate.rt.createSession('New editor'), /short-drama.*unavailable/)
    assert.equal(candidate.created.length, 0)
  }
})

test('new Bot parts join an existing workspace for their working folder', async (t) => {
  const { rt, ctx, home, created } = start(t)
  const registered = join(home, 'registered')
  const unregistered = join(home, 'unregistered')
  mkdirSync(registered)
  mkdirSync(unregistered)
  ctx.workspaceRegistry.resolveByPath = async path => path === registered ? { id: 'existing', path } : undefined
  await rt.load()
  await rt.createSession('Registered folder', { dir: registered })
  await rt.createSession('Unregistered folder', { dir: unregistered })
  assert.deepEqual(created, [
    { workspaceId: 'existing', agentPreset: 'short-drama' },
    { cwd: unregistered, agentPreset: 'short-drama' },
  ])
})

test('classic view attaches only the current Bot part to its matching workspace', async (t) => {
  const { rt, ctx, home, agentOf, call } = start(t)
  const folder = join(home, 'project')
  const otherFolder = join(home, 'other')
  mkdirSync(folder)
  mkdirSync(otherFolder)
  const agent = agentOf('chief')
  agent.session.header.cwd = folder
  ctx.sessions.get = id => id === 'chief' ? agent.session : undefined
  let currentFolder = folder
  ctx.get = ((get) => name => name === 'workingDirectory' ? { get: () => currentFolder } : get(name))(ctx.get.bind(ctx))
  const attached = []
  const workspace = { id: 'project', path: folder, sessionIds: [], attachSession: async id => { attached.push(id); workspace.sessionIds.push(id) } }
  ctx.workspaceRegistry.list = () => [workspace]
  ctx.workspaceRegistry.resolveByPath = async path => path === folder ? workspace : undefined
  await rt.load()
  assert.equal((await call('attach-current-workspace', { botId: 'chief', sessionId: 'old-part' })).value.attached, false)
  currentFolder = otherFolder
  assert.equal((await call('attach-current-workspace', { botId: 'chief', sessionId: 'chief' })).value.attached, false)
  currentFolder = folder
  ctx.workspaceRegistry.resolveByPath = async () => undefined
  assert.equal((await call('attach-current-workspace', { botId: 'chief', sessionId: 'chief' })).value.attached, false)
  ctx.workspaceRegistry.resolveByPath = async () => workspace
  assert.equal((await call('attach-current-workspace', { botId: 'chief', sessionId: 'chief' })).value.attached, true)
  assert.equal((await call('attach-current-workspace', { botId: 'chief', sessionId: 'chief' })).value.attached, false)
  assert.deepEqual(attached, ['chief'])
  assert.equal(agent.session.header.cwd, folder)
})

test('an explicitly configured Muse preset is selected without changing global defaults', async (t) => {
  const { rt, created } = start(t, { config: { agentPreset: 'standard' } })
  await rt.load()
  await rt.createSession('Researcher')
  assert.equal(created[0].agentPreset, 'standard')
})

test('the first Muse Bot inherits the current model and effort and uses the Muse IP', async (t) => {
  const { call, rt, selected } = start(t, { initial: null })
  const result = await call('state')
  assert.equal(result.ok, true, JSON.stringify(result))
  const bot = result.value.bots[0]
  assert.deepEqual([bot.name, bot.role, bot.model, bot.effort, bot.color, bot.avatar.shape], ['Muse Bot', '主理人', 'muse/glm-flashx', 'high', 'violet', 'muse-spider'])
  await rt.applyModel(rt.botOf(bot.id), { force: true })
  assert.ok(selected.some(entry => entry.sessionId === bot.id && entry.reasoningEffort === 'high'))
})

test('a fresh Muse profile without a configured model opens the model card without failing', async (t) => {
  const { call, ctx, selected, created } = start(t, { initial: null })
  ctx.llm.listProviders = () => []
  const result = await call('state')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.bots[0].waiting, true)
  assert.equal(result.value.bots[0].model, undefined)
  assert.equal(created.length, 1)
  assert.equal(selected.length, 0)
})

test('a Bot created by another Bot inherits its model effort and explicit permissions', async (t) => {
  const { rt, permissions } = start(t)
  await rt.load()
  const bot = await rt.createBot({ name: 'Continuity', createdBy: 'chief' })
  assert.deepEqual([bot.model, bot.effort, bot.permission], ['muse/glm-flashx', 'high', 'read-only'])
  assert.ok(permissions.some(([id, permission]) => id === bot.id && permission === 'read-only'))
})

test('native goal tools stay visible and an active Muse goal is not blocked', async (t) => {
  const blocked = []
  const goal = { id: 'goal', phase: 'active', revision: 1 }
  const { ctx, rt, agentOf, hidden } = start(t, { services: { goals: { get: () => goal, block: (...args) => blocked.push(args) } } })
  await rt.load()
  const agent = agentOf('chief')
  for (const listener of ctx.listeners.get('agent/created') ?? []) await listener({ agent })
  for (const listener of ctx.listeners.get('session/event') ?? []) listener(agent.session, { type: 'goal/change', data: { goal } })
  await setImmediate()
  assert.ok(hidden.some(([id, deny]) => id === 'chief' && deny.includes('ask_user_question')))
  assert.equal(hidden.some(([, deny]) => deny.some(name => name.includes('goal'))), false)
  assert.deepEqual(blocked, [])
})

test('Muse compaction and overflow recovery remain owned by the Host', async (t) => {
  const compaction = {
    compactIfNeeded: async () => 'host-compacted', compactNow: async () => 'host-manual',
    compactRegion: async () => 'host-region', summarize: async () => 'host-summary',
  }
  const originals = { ...compaction }
  let measures = 0
  const { ctx, rt, agentOf } = start(t, { services: { compaction, tokenMeter: { measure: () => { measures++; return { totalTokens: 1_000_000 } } } } })
  await rt.load()
  const agent = agentOf('chief')
  for (const listener of ctx.listeners.get('agent/created') ?? []) await listener({ agent })
  for (const [key, value] of Object.entries(originals)) assert.equal(compaction[key], value)
  for (const code of ['CONTEXT_WINDOW_EXCEEDED', 'INVALID_REQUEST', 'IMAGE_OFFLOAD_REQUIRED']) {
    for (const listener of ctx.listeners.get('agent/request-error') ?? []) {
      let passed = 0
      const result = await listener({ agent, failure: { code } }, async () => { passed++; return 'host-recovery' })
      assert.equal(passed, 1)
      assert.equal(result, 'host-recovery')
    }
  }
  ctx.emit('agent/status', { agent, status: 'idle' })
  await setImmediate()
  assert.equal(measures, 0)
})

test('disabled upstream update and GitHub metadata endpoints perform no outbound requests', async (t) => {
  const { rt, call } = start(t)
  let outbound = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { outbound++; throw new Error('unexpected network request') }
  t.after(() => { globalThis.fetch = originalFetch })
  await rt.load()
  assert.equal(rt.updateView().enabled, false)
  await rt.updateCheck({ force: true })
  await rt.dshUpdateCheck({ force: true })
  assert.throws(() => rt.updateStart(), /updates with Muse/)
  assert.throws(() => rt.dshUpdateStart(), /desktop updater/)
  assert.equal(await rt.repoStars(), null)
  const update = await call('update-install')
  assert.equal(update.ok, false)
  assert.match(update.error.message, /updates with Muse/)
  assert.equal((await call('repo-stars')).value, null)
  assert.equal(outbound, 0)
})

test('opening an existing team preserves its name, avatar and selected settings', async (t) => {
  const initial = team()
  initial.bots.chief.avatar = { shape: 'kitty' }
  const { call, home, created } = start(t, { initial })
  const result = await call('state')
  assert.equal(result.ok, true)
  assert.equal(created.length, 0)
  const bot = result.value.bots[0]
  assert.deepEqual([bot.name, bot.avatar.shape, bot.model, bot.effort, bot.permission], ['My editor', 'kitty', 'muse/glm-flashx', 'high', 'read-only'])
  const stored = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(stored.bots.chief.name, 'My editor')
})

test('changing a Bot folder cannot detach running work or an unfinished goal', async (t) => {
  for (const phase of ['active', 'paused', 'blocked']) {
    const initial = team()
    initial.bots.chief.workDir = '/previous-project'
    const { rt } = start(t, { initial, services: { goals: { get: () => ({ phase }) } } })
    await rt.load()
    await assert.rejects(rt.updateBot('chief', { workDir: '', name: 'Changed' }), /任务仍在当前会话/)
    assert.equal(rt.botOf('chief').workDir, '/previous-project')
    assert.equal(rt.botOf('chief').name, 'My editor')
  }
  const { rt, agentOf } = start(t)
  await rt.load()
  agentOf('chief').status = 'running'
  await assert.rejects(rt.assertFolderChangeAllowed(['chief']), /任务仍在当前会话/)
})

test('a completed idle Session can move, but an unavailable goal service is reported explicitly', async (t) => {
  const completed = start(t, { services: { goals: { get: () => ({ phase: 'complete' }) } } })
  await completed.rt.load()
  await completed.rt.assertFolderChangeAllowed(['chief'])
  const unsupported = start(t, { services: { goals: undefined } })
  await unsupported.rt.load()
  await assert.rejects(unsupported.rt.assertFolderChangeAllowed(['chief']), /暂不支持修改已有 Bot/)
  const newBot = await unsupported.rt.createBot({ name: 'New editor' })
  assert.equal(newBot.name, 'New editor')
})

test('a missing source folder does not create a new Session or detach its native goal', async (t) => {
  const missing = mkdtempSync(join(tmpdir(), 'muse-bot-missing-source-'))
  rmSync(missing, { recursive: true })
  const goal = { id: 'native-goal', phase: 'active', revision: 1 }
  const { ctx, rt, agentOf, created } = start(t, { services: { goals: { get: () => goal }, sessionProjections: { stateOf: () => ({}) } } })
  await rt.load()
  const agent = agentOf('chief')
  agent.session.header.cwd = missing
  agent.status = 'running'
  let archived = 0
  let newWorkspace = 0
  ctx.workspaceRegistry.archiveSession = async () => { archived++ }
  ctx.workspaceRegistry.create = async () => { newWorkspace++; throw new Error('a missing folder must not create a workspace') }
  const payload = { agent, step: 1, messages: [], signal: AbortSignal.timeout(2_000) }
  const listeners = [...ctx.listeners.get('agent/pre-step')].reverse()
  const dispatch = index => index === listeners.length ? Promise.resolve({ kind: 'enter', messages: [] }) : listeners[index](payload, () => dispatch(index + 1))
  assert.deepEqual(await dispatch(0), { kind: 'enter', messages: [] })
  for (const listener of ctx.listeners.get('system-prompt/assemble') ?? []) {
    let delegated = 0
    await listener({}, { agent, signal: payload.signal }, async () => { delegated++ })
    assert.equal(delegated, 1)
  }
  assert.equal(rt.chatOf('chief'), 'chief')
  assert.equal(goal.phase, 'active')
  assert.equal(created.length, 0)
  assert.equal(archived, 0)
  assert.equal(newWorkspace, 0)
  assert.equal([...rt.switchJobs()].length, 0)
})

test('restored folder settings cannot automatically move a live native goal into a different part', async (t) => {
  const current = mkdtempSync(join(tmpdir(), 'muse-bot-source-current-'))
  const changed = mkdtempSync(join(tmpdir(), 'muse-bot-source-changed-'))
  t.after(() => { rmSync(current, { recursive: true }); rmSync(changed, { recursive: true }) })
  const goal = { id: 'native-goal', phase: 'paused', revision: 2 }
  const initial = team()
  initial.bots.chief.workDir = changed
  const { ctx, rt, agentOf, created } = start(t, { initial, services: { goals: { get: () => goal }, sessionProjections: { stateOf: () => ({}) } } })
  await rt.load()
  const agent = agentOf('chief')
  agent.session.header.cwd = current
  const payload = { agent, step: 2, messages: [], signal: AbortSignal.timeout(2_000) }
  const listeners = [...ctx.listeners.get('agent/pre-step')].reverse()
  const dispatch = index => index === listeners.length ? Promise.resolve({ kind: 'enter', messages: [] }) : listeners[index](payload, () => dispatch(index + 1))
  assert.deepEqual(await dispatch(0), { kind: 'enter', messages: [] })
  assert.equal(rt.chatOf('chief'), 'chief')
  assert.equal(goal.phase, 'paused')
  assert.equal(created.length, 0)
  assert.equal([...rt.switchJobs()].length, 0)
})
