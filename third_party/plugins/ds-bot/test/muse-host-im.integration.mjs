// Run with node --import tsx/esm --import ./test/harness-resolve.mjs --test this file.
// Native Sessions, Agent resolution, goals, jobs, Cordis and Feishu dispatch are real;
// the model transport and Feishu network return local deterministic responses.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import GoalService from '@deepseek-ai/dsh-goal'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { ApiSessionAgentController } from '../../../../packages/api/session-controller/src/agent.ts'
import { installModelSelectionProjection } from '../../../../packages/api/session-controller/src/model-selection-projection.ts'
import { applyImDesktopCompatibility } from '../../compatibility/im-desktop.mjs'
import { install as installStore } from '../src/host/store.js'
import { install as installModels } from '../src/host/models.js'
import { install as installFolders } from '../src/host/folders.js'
import { install as installRoster } from '../src/host/roster.js'
import { install as installAgents } from '../src/host/agents.js'
import { install as installTeam } from '../src/host/muse-team.js'

const plugins = resolve(import.meta.dirname, '../..')
const stage = mkdtempSync(join(tmpdir(), 'muse-native-im-combined-'))
cpSync(join(plugins, 'dsh-im'), stage, { recursive: true, filter: path => !/(?:^|[/\\])(?:node_modules|lib|\.git)(?:[/\\]|$)/u.test(path) })
applyImDesktopCompatibility(stage)
symlinkSync(join(plugins, 'toolchain/node_modules'), join(stage, 'node_modules'), 'dir')
after(() => rmSync(stage, { recursive: true, force: true }))
const fromStage = path => import(pathToFileURL(join(stage, path)).href)
const [{ createMuseImTeamScope }, { createMuseImWorkspaceScope }, { StateStore }, { BotWorkspaceStore }, { FeishuHarnessBridge }, { VerifiedFeishuChannel }] = await Promise.all([
  fromStage('lib/muse-im-team.mjs'), fromStage('lib/muse-im-workspace.mjs'),
  fromStage('src/channels/feishu/state-store.mjs'), fromStage('src/channels/shared/bot-workspace-store.mjs'),
  fromStage('src/channels/feishu/bridge.mjs'), fromStage('src/channels/feishu/feishu-channel.mjs'),
])

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-team-')))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const ctx = new Context()
  const closeBridges = []
  t.after(async () => {
    for (const close of closeBridges) await close()
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  await ctx.plugin(LocalJobRegistry, {})
  ctx.jobs.attachController('combined-native-test')
  const inert = () => () => {}
  ctx.provide('typert', { lookups: { configure: inert, register: inert }, contexts: { configureHost: inert, registerHost: inert } })
  installModelSelectionProjection(ctx)
  const nativeResolver = new ApiSessionAgentController(ctx)
  const selected = [], created = [], asked = [], cancelled = [], followups = [], registered = []
  const rows = []
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'offline', model: 'default', reasoningEffort: 'low' }), saveSelection: async () => {} })
  ctx.provide('workspaceRegistry', {
    list: () => [{ id: 'native-workspace', path: workspace, sessionIds: rows }], get: () => undefined,
    archiveSession: () => { throw new Error('Team adoption must not archive a Session') },
  })
  ctx.provide('tools', { schemas: () => [], restrict: () => () => {} })
  ctx.provide('llm', { listProviders: () => [{ id: 'offline' }], listModels: async () => [{ id: 'native-model' }, { id: 'default' }] })
  ctx.provide('sessionTitle', { get: () => ({ title: '已有项目' }), rename: () => { throw new Error('Must not rename during adoption') } })
  ctx.provide('sessionController', {
    resolveAgent: id => nativeResolver.resolveAgent(id),
    create: () => { throw new Error('Team adoption must not create a Session') },
    selectModel: request => { selected.push(request); throw new Error('Team adoption must not select a model') },
  })
  const addSession = async (name = `native-${created.length + 1}`) => {
    const id = SessionId(name)
    const session = ctx.sessions.create(id, { meta: { cwd: workspace, agentPreset: 'standard' } })
    session.append('model/selection', { provider: 'offline', model: 'native-model', reasoningEffort: 'high' })
    const agent = {
      id, session, ctx, options: {}, status: 'running', inbox: { nextStep: [], nextTurn: [] },
      followup: value => followups.push([id, value]), send() {}, inject() {}, steer() {},
      cancel: value => cancelled.push([id, value]), runMaintenance: task => task(new AbortController().signal), whenIdle: async () => {},
    }
    await ctx.agents.register(agent)
    rows.push(id)
    registered.push(agent)
    return agent
  }
  let runtime, owner
  const mountTeam = async () => {
    owner = await ctx.plugin(inner => {
      runtime = { ctx: inner, home: join(home, 'team'), dshHome: home, statePath: join(home, 'team/state.json'), config: { contextManagement: 'host', goals: 'host', agentPreset: 'short-drama' }, warn() {} }
      for (const install of [installStore, installModels, installFolders, installRoster, installAgents, installTeam]) install(runtime)
      runtime.resolveAgent = async id => {
        const result = await nativeResolver.resolveAgent(id)
        if ('error' in result) throw result.error
        return result.agent
      }
    })
    await runtime.load()
  }
  await mountTeam()
  const restartTeam = async () => { await owner.dispose(); await mountTeam() }
  const make = async ({ imBotId = 'registered_bot', appId = 'cli_synthetic', getTeam = () => ctx.get('museTeam'), chatName } = {}) => {
    const data = join(home, imBotId)
    const state = await new StateStore(join(data, 'state.json')).load()
    const workspaces = await new BotWorkspaceStore(join(data, 'workspaces.json'), { defaultWorkspace: workspace }).load()
    await workspaces.ensure(imBotId)
    const rawHarness = {
      async createSession() { const agent = await addSession(); created.push(agent.id); return agent.id },
      async sessionExists(id) { return ctx.sessions.get(id) !== undefined },
      async adoptWorkspaceSession(id) { return { sessionId: id, workspace: ctx.sessions.get(id)?.header.cwd } },
      async ask(id, text, options) { assert.equal((await nativeResolver.resolveAgent(id)).agent, ctx.agents.get(id)); asked.push({ id, text, options }); return 'Offline native answer' },
    }
    const native = await createMuseImWorkspaceScope(rawHarness, { botId: imBotId, workspaces, state, readSessionWorkspace: async id => ctx.sessions.get(id)?.header.cwd })
    const scope = createMuseImTeamScope(native, { imBotId, appId, dshHome: home, getTeam, retentionMs: 86_400_000, maxEntries: 1000 })
    const sent = []
    const send = async request => { sent.push(request); return { code: 0, data: { message_id: request.path?.message_id ?? `reply-${sent.length}` } } }
    const client = { im: { v1: {
      ...(chatName === undefined ? {} : { chat: { get: async () => ({ code: 0, data: { name: chatName } }) } }),
      message: { create: send, reply: send, patch: send, delete: async () => ({ code: 0 }) },
      messageReaction: { create: async () => ({ code: 0, data: { reaction_id: 'reaction' } }), delete: async () => ({ code: 0 }) },
    } } }
    const lifetime = new AbortController()
    const bridge = new FeishuHarnessBridge({ client, channel: new VerifiedFeishuChannel({ client, initialText: 'Offline start' }), harness: scope.harness,
      state: scope.state, museAdmission: scope.admission, signal: lifetime.signal, status: { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 },
      allowedSenderOpenIds: new Set(['ou_owner']), botOpenId: 'ou_bot', groupResponseMode: 'mention', mentionTopicReply: false,
      logger: { error() {}, warn() {}, info() {} } })
    const stop = async () => { lifetime.abort(); await bridge.waitForIdle() }
    closeBridges.push(stop)
    return { scope, state, bridge, sent, stop }
  }
  return { ctx, home, workspace, created, selected, asked, cancelled, followups, registered, addSession, restartTeam, make, runtime: () => runtime }
}

const event = (id, { chat = 'oc_group', text = '继续任务', thread } = {}) => ({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: {
  message_id: id, chat_id: chat, chat_type: 'group', message_type: 'text', content: JSON.stringify({ text }), mentions: [{ id: { open_id: 'ou_bot' } }],
  ...(thread ? { thread_id: thread, root_id: 'om_root' } : {}),
} })
async function accept(instance, message) { await instance.bridge.accept(message); await instance.bridge.waitForIdle() }

test('real Native Feishu binding retains an existing live Agent, armed goal, running job, preset and pending model', async t => {
  const f = await fixture(t)
  const agent = await f.addSession('original-session')
  const goal = f.ctx.goals.create(agent, { objective: '继续原视频转写任务' })
  let settle
  const done = new Promise(resolve => { settle = resolve })
  const job = f.ctx.jobs.start({ kind: 'bash', label: 'offline ongoing job', owner: agent.id, run: () => ({ done, cancel: () => settle({ status: 'killed' }) }) })
  const before = agent.session.snapshotEvents()
  const n = await f.make()
  await n.state.setSession('group:oc_group', agent.id)
  await accept(n, event('om_existing'))
  assert.equal(f.ctx.agents.get(agent.id), agent)
  assert.deepEqual(f.ctx.goals.get(agent), goal)
  assert.equal(f.ctx.jobs.get(job, agent.id).status, 'running')
  assert.deepEqual(agent.session.snapshotEvents(), before)
  assert.equal(f.runtime().botOf(agent.id).model, 'offline/native-model')
  assert.equal(f.runtime().botOf(agent.id).effort, 'high')
  assert.equal(f.runtime().botOf(agent.id).workDir, f.workspace)
  assert.deepEqual(f.asked.map(row => row.id), [agent.id])
  assert.deepEqual([f.created, f.selected, f.cancelled, f.followups], [[], [], [], []])
  settle({ status: 'completed' })
})

test('new native group creation, real service restart and duplicate message keep one identity', async t => {
  const f = await fixture(t)
  const n = await f.make()
  await accept(n, event('om_new'))
  assert.deepEqual(f.created, ['native-1'])
  assert.equal(f.runtime().selfOf('native-1'), 'native-1')
  await n.stop()
  await f.restartTeam()
  const restarted = await f.make()
  await accept(restarted, event('om_new'))
  await accept(restarted, event('om_later', { thread: 'omt_thread' }))
  assert.deepEqual(f.created, ['native-1'])
  assert.deepEqual(f.asked.map(row => row.id), ['native-1', 'native-1'])
  assert.deepEqual(await f.ctx.get('museTeam').resolveCurrentSession('native-1'), { botId: 'native-1', sessionId: 'native-1' })
  assert.ok(restarted.sent.some(request => request.path?.message_id === 'om_later' && request.data?.reply_in_thread === true))
})

test('native new and use keep a stable real Bot while old native work stays in its original Session', async t => {
  const f = await fixture(t)
  const n = await f.make()
  await accept(n, event('om_first'))
  const original = f.ctx.agents.get(SessionId('native-1'))
  const goal = f.ctx.goals.create(original, { objective: '原任务继续' })
  await n.scope.state.clearSession('group:oc_group')
  await accept(n, event('om_new'))
  await f.addSession('chosen-session')
  await n.scope.harness.bindWorkspaceSession('group:oc_group', 'chosen-session')
  await accept(n, event('om_selected'))
  assert.deepEqual(f.created, ['native-1', 'native-2'])
  assert.deepEqual(f.asked.map(row => row.id), ['native-1', 'native-2', 'chosen-session'])
  assert.deepEqual(await f.ctx.get('museTeam').resolveCurrentSession('native-1'), { botId: 'native-1', sessionId: 'chosen-session' })
  assert.equal(Object.keys(f.runtime().state.bots).length, 1)
  assert.deepEqual(f.ctx.goals.get(original), goal)
  assert.deepEqual(f.runtime().botOf('native-1').segments.map(row => row.sessionId), ['native-1', 'native-2'])
  assert.deepEqual([f.selected, f.cancelled, f.followups], [[], [], []])
})

test('different registered apps in the same Feishu group adopt distinct real Sessions without a name collision', async t => {
  const f = await fixture(t)
  const one = await f.make()
  await accept(one, event('om_app1'))
  const two = await f.make({ imBotId: 'other_bot', appId: 'cli_other' })
  await accept(two, event('om_app2'))
  assert.deepEqual(f.created, ['native-1', 'native-2'])
  assert.deepEqual(f.asked.map(row => row.id), ['native-1', 'native-2'])
  assert.equal(Object.keys(f.runtime().state.bots).length, 2)
})

test('a definite pre-dispatch routing failure can recover after restart without discarding the platform message', async t => {
  const f = await fixture(t)
  const n = await f.make()
  await accept(n, event('om_initial'))
  const service = f.ctx.get('museTeam')
  const resolveCurrent = service.resolveCurrentSession.bind(service)
  service.resolveCurrentSession = async () => { throw new Error('temporary routing read failure') }
  await accept(n, event('om_retryable'))
  assert.deepEqual(f.asked.map(row => row.id), ['native-1'])
  await n.stop()
  service.resolveCurrentSession = resolveCurrent
  const restarted = await f.make()
  await accept(restarted, event('om_retryable'))
  assert.deepEqual(f.asked.map(row => row.id), ['native-1', 'native-1'])
  assert.equal(f.created.length, 1)
})

test('native group metadata and a private sender name reach the real Host service without replacing an existing private goal', async t => {
  const f = await fixture(t)
  const original = await f.addSession('original-private')
  const goal = f.ctx.goals.create(original, { objective: '继续私聊中的原任务' })
  const before = original.session.snapshotEvents()
  const n = await f.make({ chatName: '短剧编剧讨论组' })
  await n.state.setSession('p2p:ou_owner', original.id)
  await accept(n, event('om_named_group'))
  assert.equal(f.runtime().botOf('native-1').name, '短剧编剧讨论组')
  assert.equal(f.runtime().botOf('native-1').channelName, '短剧编剧讨论组')
  const direct = {
    sender: { sender_type: 'user', sender_name: '小林', sender_id: { open_id: 'ou_owner' } },
    message: { message_id: 'om_named_private', chat_id: 'oc_private', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '继续原任务' }) },
  }
  await accept(n, direct)
  const bot = f.runtime().botOf(original.id)
  assert.ok(bot)
  assert.equal(bot.name, '小林')
  assert.equal(bot.channelName, '小林')
  assert.equal(bot.nameSource, 'channel')
  assert.equal(n.state.sessionFor('p2p:ou_owner'), original.id)
  assert.deepEqual(f.ctx.goals.get(original), goal)
  assert.deepEqual(original.session.snapshotEvents(), before)
  assert.deepEqual(f.created, ['native-1'])
  assert.deepEqual(f.asked.map(row => row.id), ['native-1', original.id])
  assert.deepEqual([f.selected, f.cancelled, f.followups], [[], [], []])
})
