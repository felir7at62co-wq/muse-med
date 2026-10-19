/** Native IM integration against Muse's actual Host gateway, Session log and Agent loop. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import WorkspaceController from '@deepseek-ai/dsh-api-workspace-controller'
import { TYPERT as SESSION_TYPES } from '@deepseek-ai/dsh-api-session-controller/typert'
import { TYPERT as WORKSPACE_TYPES } from '@deepseek-ai/dsh-api-workspace-controller/typert'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Workspaces from '@deepseek-ai/dsh-workspace'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import FileSystem from '@deepseek-ai/dsh-fs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

const source = resolve(process.env.DSH_IM_TEST_SOURCE ?? process.cwd())
const native = (path) => import(pathToFileURL(join(source, path)).href)
const { harnessConnection } = await native('plugin-src/host/harness-connection.mjs')
const { HarnessClient } = await native('src/channels/shared/harness-client.mjs')
const { createHarnessSessionExecutors } = await native('plugin-src/host/harness-session-coordinator.mjs')
const { FeishuHarnessBridge } = await native('src/channels/feishu/bridge.mjs')
const { VerifiedFeishuChannel } = await native('src/channels/feishu/feishu-channel.mjs')
const { StateStore } = await native('src/channels/feishu/state-store.mjs')
const { BotWorkspaceStore, createBotWorkspaceScope } = await native('src/channels/shared/bot-workspace-store.mjs')
// The builder always exercises its published entry; source diagnostics opt out explicitly.
const inspectWrapper = process.env.DSH_IM_TEST_SOURCE === undefined

async function until(condition, label) {
  const signal = AbortSignal.timeout(10_000)
  while (!condition()) {
    if (signal.aborted) throw new Error(`Native IM check timed out: ${label}`, { cause: signal.reason })
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(condition(), label)
}

async function eventsFor(ctx, sessionId) {
  const observation = await ctx.sessionQuery.observeSession(sessionId)
  try { return [...observation.events] }
  finally { observation[Symbol.dispose]() }
}

test('IM uses the native gateway and preserves existing Muse Sessions across channel restarts', { timeout: 30_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-im-host-')))
  let ctx
  const lifetimes = []
  let networkCalls = 0
  const network = { fetch: globalThis.fetch, http: http.request, https: https.request }
  const denyNetwork = () => { networkCalls++; throw new Error('Native IM check attempted a real network request') }
  globalThis.fetch = denyNetwork
  http.request = denyNetwork
  https.request = denyNetwork
  t.after(async () => {
    try {
      for (const lifetime of lifetimes) lifetime.abort()
      for (const agent of ctx?.get('agents')?.list() ?? []) agent.cancel({ kind: 'user' })
      await ctx?.fiber.dispose()
    } finally {
      globalThis.fetch = network.fetch
      http.request = network.http
      https.request = network.https
      await rm(root, { recursive: true, force: true })
    }
  })
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const fixture = join(root, 'persona.mjs')
  await writeFile(fixture, `export const inject=['systemPrompt']; export function apply(ctx) {
ctx.effect(()=>ctx.systemPrompt.section({name:'im-muse-persona',order:1,text:'Muse short drama test persona'})); }
`)
  const configPath = join(root, 'cordis.json')
  await writeFile(configPath, JSON.stringify([
    { id: 'im-native-audit', name: 'cordis:imAudit' },
    ...(inspectWrapper ? [{ id: 'feishu-channel', name: pathToFileURL(join(source, 'lib/index.js')).href,
      config: { enabled: false, dshHome: join(root, 'home'), feishuDataDir: join(root, 'native-feishu'), defaultCwd: workspace } }] : []),
  ]))
  const modelCalls = []
  const routes = []
  let credentialReads = 0
  let questionOnNext = false
  let questionAnswer
  let holdOnNext = false
  let heldStarted = false
  class OfflineModel extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      modelCalls.push(options)
      if (questionOnNext) {
        questionOnNext = false
        questionAnswer = await ctx.waterfall('user-questions/request', {
          agent: ctx.agents.list().find(agent => agent.status === 'running'),
          questions: [{ id: 'style', question: 'Choose the Muse style', options: [{ label: '3D' }, { label: 'Live action' }] }],
          signal: options.signal,
        }, () => new Promise(() => {}))
      }
      if (holdOnNext) {
        holdOnNext = false
        heldStarted = true
        await new Promise(resolve => {
          if (options.signal.aborted) resolve()
          else options.signal.addEventListener('abort', resolve, { once: true })
        })
        options.signal.throwIfAborted()
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Muse native IM result' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Muse native IM result' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  let owner
  const createHost = () => boot('muse-im-host-check', configPath, [], async host => {
    await mountAgentLoopTestDependencies(host)
    await host.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' })
    await host.plugin(AgentLoop, { agents: [] })
    await host.plugin(AgentPresets, { default: 'short-drama', selectablePresets: ['short-drama'] })
    await host.plugin({ inject: ['agentPresets'], async *apply(scope) {
      yield await scope.agentPresets.register({ id: 'short-drama', plugins: [{ name: pathToFileURL(fixture).href }] })
    } })
    host.effect(() => host.llm.registerAdapter(['offline'], new OfflineModel()))
    host.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'offline', model: 'fixture' }) })
    await host.plugin(Typert)
    host.effect(() => host.typert.register(SESSION_TYPES))
    host.effect(() => host.typert.register(WORKSPACE_TYPES))
    await host.plugin(Gateway, Gateway.Config({}))
    await host.plugin(Storage)
    await host.plugin(StorageJson, { root: join(root, 'storage') })
    await host.plugin(StorageDomain, { backend: 'json' })
    await host.plugin(Workspaces)
    await host.plugin(SessionQuery)
    await host.plugin(FileSystem)
    await host.plugin(AttachmentLocal, { dshHome: join(root, 'home') })
    // No uploaded receipts are used by this test; authoritative Session routing remains real.
    host.provide('fileUploads', {
      registerAgentResolver: () => () => {}, resolve: () => undefined,
      bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }), retirePrompt() {},
    })
    await host.plugin(SessionController, { nativeOpen: false })
    await host.plugin(WorkspaceController, { documentsDirectory: root })
    host.provide('connection', {
      rpc: { intercept: () => () => {} },
      fetch: { register: route => host.effect(() => {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      }) },
    })
    host.provide('credentials', { resolve: async () => { credentialReads++; throw new Error('Unconfigured bot attempted credential access') } })
    host.loader.builtins.imAudit = { inject: ['typertGateway', 'connection'], apply(scope) { owner = scope } }
  })
  ctx = await createHost()
  assert.ok(owner, 'Loader activated the owned channel scope')
  if (inspectWrapper) {
    const route = routes.find(route => route.path === '/api/dsh-im/feishu')
    assert.ok(route, 'the built entry exposes native Feishu management even before a bot is configured')
    const { FEISHU_ENDPOINTS } = await native('plugin-src/host/channels/feishu/rpc.mjs')
    const response = await route.fetch(new Request('http://localhost/api/dsh-im/feishu', {
      method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'native-status', method: 'dsh-im/feishu',
        payload: { method: FEISHU_ENDPOINTS.status, payload: {} } }),
    }))
    const payload = await response.json()
    assert.equal(payload.result.ok, true, JSON.stringify(payload))
    assert.equal(payload.result.value.configured, false)
    assert.equal(payload.result.value.connected, false)
    assert.equal(credentialReads, 0)
    assert.deepEqual(await ctx.get('dshIm').listBots(), [])
    const update = routes.find(route => route.path === '/api/dsh-im/dsh-im')
    assert.ok(update, 'the native settings expose the Muse-owned update policy')
    const updateRpc = async (method, payload) => {
      const response = await update.fetch(new Request('http://localhost/api/dsh-im/dsh-im', {
        method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' },
        body: JSON.stringify({ type: 'client-request', rpcId: method, method: 'dsh-im/dsh-im', payload: { method, payload } }),
      }))
      return (await response.json()).result
    }
    const updateStatus = await updateRpc('update.status', {})
    assert.equal(updateStatus.ok, true)
    assert.equal(updateStatus.value.canInstall, false)
    assert.equal(updateStatus.value.blockedReason, 'unsupported-runtime')
    assert.equal((await updateRpc('update.check', {})).error.code, 'unsupported-runtime')
    assert.equal((await updateRpc('update.install', { checkId: 'synthetic', requestId: 'synthetic' })).error.code, 'unsupported-runtime')
    const wrongId = await ctx.loader.create({ name: pathToFileURL(join(source, 'lib/index.js')).href,
      config: { enabled: false, dshHome: join(root, 'wrong-row-home') } })
    const wrongEntry = ctx.loader.resolve(wrongId)
    await assert.rejects(wrongEntry.fiber.await(), /must be mounted as feishu-channel/u)
    await ctx.loader.remove(wrongId)
  }
  const { workspace: registered } = await ctx.workspaceController.create({ path: workspace })
  const created = await ctx.sessionController.create({ workspaceId: registered.workspaceId, agentPreset: 'short-drama' })
  const sessionId = created.sessionId
  await ctx.sessionController.prompt({ sessionId, requestId: 'gui-first', content: [{ type: 'text', text: 'GUI original prompt' }] }, new AbortController().signal)
  await until(() => modelCalls.length === 1 && ctx.agents.get(sessionId)?.status === 'idle', 'initial GUI turn')
  const before = await eventsFor(ctx, sessionId)
  const client = new HarnessClient({ ...harnessConnection(owner), workspace, autostart: false,
    ...createHarnessSessionExecutors(owner) })
  const adopted = await client.adoptWorkspaceSession(sessionId)
  assert.equal(adopted.sessionId, sessionId)
  assert.equal(adopted.workspace, workspace)
  assert.equal(ctx.agents.get(sessionId).session.header.agentPreset, 'short-drama')
  assert.deepEqual(await eventsFor(ctx, sessionId), before, 'adoption does not create or rewrite the Session')
  const listed = await client.listWorkspaceSessions(workspace)
  assert.ok(listed.sessions.some(item => item.sessionId === sessionId))
  const history = await client.rpc('session.history', { sessionId, maxMessages: 50 })
  assert.ok(history.events.some(({ event }) => event.type === 'user/message' && JSON.stringify(event.data).includes('GUI original prompt')))
  const answer = await client.ask(sessionId, 'Continue the same Muse project', { timeoutMs: 10_000 })
  assert.match(typeof answer === 'string' ? answer : JSON.stringify(answer), /Muse native IM result/u)
  assert.equal(modelCalls.length, 2)
  assert.equal(ctx.agents.list().length, 1)
  assert.equal(ctx.agents.get(sessionId).session.header.agentPreset, 'short-drama')

  const statePath = join(root, 'im-state.json')
  const sent = []
  const send = async (request) => {
    const messageId = request.data?.msg_type ? `out-${sent.length + 1}` : request.path.message_id
    sent.push({ messageId, data: request.data, content: request.data?.content ? JSON.parse(request.data.content) : undefined })
    return { code: 0, data: { message_id: messageId } }
  }
  const wire = { im: { v1: { message: { create: send, reply: send, patch: send, delete: async () => ({ code: 0 }) } } } }
  const bridgeLifetime = new AbortController()
  lifetimes.push(bridgeLifetime)
  const state = await new StateStore(statePath).load()
  const workspaceStorePath = join(root, 'bot-workspaces.json')
  let botWorkspaces = await new BotWorkspaceStore(workspaceStorePath, { defaultWorkspace: workspace }).load()
  await botWorkspaces.ensure('fixture-bot', { defaultAgentPreset: 'short-drama' })
  await state.setSession('p2p:ou_owner', sessionId)
  await state.setSession('group:oc_group', sessionId)
  const makeBridge = (store, signal, harness) => {
    const scoped = createBotWorkspaceScope(harness, { botId: 'fixture-bot', workspaces: botWorkspaces, state: store })
    return new FeishuHarnessBridge({
      client: wire, channel: new VerifiedFeishuChannel({ client: wire, initialText: 'Starting Muse' }),
      harness: scoped.harness, state: scoped.state, signal,
      status: { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 },
      allowedSenderOpenIds: new Set(['ou_owner', 'ou_second']),
      botOpenId: 'ou_bot', groupResponseMode: 'mention', mentionTopicReply: false,
      stepPush: true, stepPushMode: 'streaming_card', logger: { warn() {}, error() {}, info() {} },
    })
  }
  const bridge = makeBridge(state, bridgeLifetime.signal, client)
  const message = (id, text, extra = {}) => ({
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' }, ...extra.sender },
    message: { message_id: id, message_type: 'text', chat_type: 'p2p', chat_id: 'oc_private',
      content: JSON.stringify({ text }), ...extra.message },
  })
  await bridge.accept(message('unallowed-owner', 'forbidden', { sender: { sender_id: { open_id: 'ou_other' } } }))
  await bridge.accept(message('no-at', 'group no mention', { message: { chat_type: 'group', chat_id: 'oc_group' } }))
  await bridge.accept(message('wrong-at', '@other not this bot', { message: { chat_type: 'group', chat_id: 'oc_group',
    mentions: [{ key: '@other', id: { open_id: 'ou_other_bot' } }] } }))
  await bridge.waitForIdle()
  assert.equal(modelCalls.length, 2, 'unauthorized DM and unrelated group messages must not enter Muse')
  await bridge.accept(message('correct-at', '@bot group accepted', { message: { chat_type: 'group', chat_id: 'oc_group',
    mentions: [{ key: '@bot', id: { open_id: 'ou_bot' } }] } }))
  await bridge.waitForIdle()
  assert.equal(modelCalls.length, 3)
  assert.equal(ctx.agents.list().length, 1)
  assert.ok(sent.some(item => JSON.stringify(item).includes('Muse native IM result')))
  const finalCard = sent.findLast(item => item.content?.schema === '2.0'
    && item.content.body?.elements?.some(element => element.content === '_已完成_'))
  assert.ok(finalCard, 'the native process card is sealed with its real final answer')
  const transcript = {
    continuedMessages: modelCalls[1].messages.map(({ role, content }) => ({ role, content })),
    nativeFinalCard: finalCard.content,
  }
  const expectedTranscript = JSON.parse(await readFile(new URL('./expected/im-host-transcript.json', import.meta.url), 'utf8'))
  assert.deepEqual(transcript, { continuedMessages: expectedTranscript.continuedMessages, nativeFinalCard: expectedTranscript.nativeFinalCard })

  questionOnNext = true
  const pendingQuestionTurn = bridge.accept(message('ask-style', 'Ask me for the style'))
  await until(() => sent.some(item => JSON.stringify(item.content).includes('answer:')), 'native question card')
  const questionCard = sent.find(item => JSON.stringify(item.content).includes('answer:'))
  const cardJson = JSON.stringify(questionCard.content)
  const action = [...cardJson.matchAll(/"action":"(answer:[^"]+)"/gu)].map(match => match[1]).find(value => value.endsWith(':3D'))
  assert.ok(action, 'question options carry the actual callback identity')
  const callback = operator => ({ operator: { open_id: operator }, action: { value: { action } },
    context: { open_message_id: questionCard.messageId, open_chat_id: 'oc_private' } })
  await bridge.onCardAction(callback('ou_second'))
  assert.equal(questionAnswer, undefined, 'another allowed account cannot answer the initiating user question')
  await bridge.onCardAction(callback('ou_owner'))
  await pendingQuestionTurn
  await bridge.waitForIdle()
  assert.deepEqual(questionAnswer, { answers: [{ id: 'style', selected: ['3D'] }] })

  holdOnNext = true
  const heldTurn = bridge.accept(message('hold-turn', 'Work until I stop you'))
  await until(() => heldStarted, 'active native turn')
  const unrelatedBridge = makeBridge(state, bridgeLifetime.signal, client)
  await unrelatedBridge.accept(message('unrelated-stop', '/stop'))
  await unrelatedBridge.waitForIdle()
  assert.equal(ctx.agents.get(sessionId).status, 'running', 'a different channel consumer cannot cancel this turn')
  const duringHeldCalls = modelCalls.length
  await bridge.accept(message('steer-turn', '/steer Keep the heroine identity'))
  assert.ok(ctx.agents.get(sessionId).inbox.nextStep.some(item => JSON.stringify(item).includes('Keep the heroine identity')))
  assert.ok((await eventsFor(ctx, sessionId)).some(event => event.type === 'agent/inbox/spliced' && JSON.stringify(event.data).includes('Keep the heroine identity')))
  assert.equal(modelCalls.length, duringHeldCalls, 'steering does not start a competing model request')
  await bridge.accept(message('stop-turn', '/stop'))
  await heldTurn
  await bridge.waitForIdle()
  assert.equal(ctx.agents.get(sessionId).status, 'idle')
  assert.ok((await eventsFor(ctx, sessionId)).some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'))
  bridgeLifetime.abort()
  await bridge.waitForIdle()
  const afterStopCalls = modelCalls.length
  await bridge.accept(message('after-abort', 'must not run'))
  assert.equal(modelCalls.length, afterStopCalls)
  const persisted = await ctx.sessionPersistence.open(sessionId, 'read')
  try {
    const log = await persisted.read()
    assert.ok(log.events.some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('Continue the same Muse project')))
  } finally { await persisted.close() }
  await ctx.fiber.dispose()
  assert.equal(routes.length, 0, 'Host disposal releases its registered native routes')
  ctx = await createHost()
  const restoredClient = new HarnessClient({ ...harnessConnection(owner), workspace, autostart: false,
    ...createHarnessSessionExecutors(owner) })
  const restoredState = await new StateStore(statePath).load()
  botWorkspaces = await new BotWorkspaceStore(workspaceStorePath, { defaultWorkspace: workspace }).load()
  assert.equal(restoredState.sessionFor('p2p:ou_owner'), sessionId)
  const restored = await restoredClient.adoptWorkspaceSession(sessionId)
  assert.equal(restored.sessionId, sessionId)
  const restoredLifetime = new AbortController()
  lifetimes.push(restoredLifetime)
  const restoredBridge = makeBridge(restoredState, restoredLifetime.signal, restoredClient)
  t.after(async () => { restoredLifetime.abort(); await restoredBridge.waitForIdle() })
  await restoredBridge.accept(message('cold-continued', 'Continue after the cold Host restart'))
  await restoredBridge.waitForIdle()
  assert.equal(ctx.agents.get(sessionId).session.header.agentPreset, 'short-drama')
  assert.ok((await eventsFor(ctx, sessionId)).some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('GUI original prompt')))
  const beforeDuplicate = modelCalls.length
  await restoredBridge.accept(message('cold-continued', 'same provider retry'))
  await restoredBridge.waitForIdle()
  assert.equal(modelCalls.length, beforeDuplicate, 'persisted inbound deduplication survives channel restart')
  restoredLifetime.abort()
  await restoredBridge.waitForIdle()
  let newChatSessions = false
  if (inspectWrapper) {
    const { createMuseImWorkspaceScope } = await native('lib/muse-im-workspace.mjs')
    const { createMuseImAdmission } = await native('lib/muse-im-admission.mjs')
    const { createAccessPolicy, createAccessPolicyScope } = await native('src/channels/shared/access-policy.mjs')
    const { accessPolicyProvider } = await native('plugin-src/host/channels/shared/access-policy-production.mjs')
    const { inject: wrapperInject } = await native('lib/index.js')
    const { inject: feishuInject } = await native('plugin-src/host/channels/feishu/index.mjs')
    for (const [entry, inject] of [['Muse wrapper', wrapperInject], ['native Feishu Host', feishuInject]]) {
      assert.ok(inject.includes('sessions'), `${entry} must declare live Session reads`)
      assert.ok(inject.includes('sessionPersistence'), `${entry} must declare cold Session metadata reads`)
    }
    const restrictedOwner = async (inject, name) => {
      let scoped
      const lifetime = ctx.plugin({ name, inject, apply(scope) { scoped = scope } })
      await lifetime.await()
      assert.ok(scoped)
      return scoped
    }
    const sessionWorkspace = scoped => async id => scoped.sessions.get(id)?.header.cwd
      ?? (await scoped.sessionPersistence.stat(id))?.header.cwd
    const freshStatePath = join(root, 'fresh-chat-state.json')
    const freshState = await new StateStore(freshStatePath).load()
    await botWorkspaces.ensure('fresh-bot', { workspace, defaultAgentPreset: 'short-drama' })
    const openScope = createAccessPolicyScope({ mode: 'open',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] }, allowlist: { users: [] } })
    await botWorkspaces.setAccessPolicy('fresh-bot', createAccessPolicy({ direct: openScope, group: openScope }))
    const savedPolicy = (await new BotWorkspaceStore(workspaceStorePath, { defaultWorkspace: workspace }).load()).accessPolicyFor('fresh-bot')
    assert.equal(savedPolicy.direct.mode, 'open')
    assert.equal(savedPolicy.group.mode, 'open')
    assert.equal(savedPolicy.group.open.defaultCanExecuteCommands, false)
    const oldOwner = await restrictedOwner(feishuInject.filter(name => !['sessions', 'sessionPersistence'].includes(name)), 'old-im-session-inject')
    const oldClient = new HarnessClient({ ...harnessConnection(oldOwner), workspace, autostart: false,
      ...createHarnessSessionExecutors(oldOwner) })
    const oldScope = await createMuseImWorkspaceScope(oldClient, {
      botId: 'fresh-bot', workspaces: botWorkspaces, state: freshState, readSessionWorkspace: sessionWorkspace(oldOwner),
    })
    const beforeFailure = modelCalls.length
    await assert.rejects(oldScope.harness.createSession({ conversationKey: 'p2p:ou_owner' }),
      /cannot get property "sessions" without inject/u)
    assert.equal(modelCalls.length, beforeFailure, 'undeclared metadata access fails before a model prompt')
    assert.equal(freshState.sessionFor('p2p:ou_owner'), null)

    const freshOwner = await restrictedOwner(feishuInject, 'native-im-new-session-inject')
    const freshClient = new HarnessClient({ ...harnessConnection(freshOwner), workspace, autostart: false,
      ...createHarnessSessionExecutors(freshOwner) })
    const freshScope = await createMuseImWorkspaceScope(freshClient, {
      botId: 'fresh-bot', workspaces: botWorkspaces, state: freshState, readSessionWorkspace: sessionWorkspace(freshOwner),
    })
    const freshLifetime = new AbortController()
    lifetimes.push(freshLifetime)
    const freshErrors = []
    const freshAdmission = createMuseImAdmission({ dshHome: join(root, 'home'),
      inboundClaimRetentionMs: 24 * 60 * 60 * 1000, inboundClaimMaxEntries: 1000,
    }, { botId: 'fresh-bot', botOpenId: 'ou_bot', ownerOpenIds: ['ou_owner'],
      allowedChatIds: ['oc_previous_group'], allowedDirectIds: ['ou_owner'],
      legacyMessageIds: [], claimsPath: join(root, 'fresh-inbound-claims.json'),
    }).forBot('fresh-bot', botWorkspaces)
    const freshAccessPolicy = accessPolicyProvider(botWorkspaces, 'fresh-bot', {
      channel: 'feishu', config: { ownerOpenIds: ['ou_owner'] },
    })
    assert.equal(freshAccessPolicy.isPrivileged('ou_member', 'direct'), false)
    assert.equal(freshAccessPolicy.isPrivileged('ou_member', 'group'), false)
    const freshBridge = new FeishuHarnessBridge({
      client: wire, channel: new VerifiedFeishuChannel({ client: wire, initialText: 'Starting Muse' }),
      harness: freshScope.harness, state: freshScope.state, signal: freshLifetime.signal,
      museAdmission: freshAdmission, accessPolicy: freshAccessPolicy,
      status: { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 },
      allowedSenderOpenIds: new Set(['ou_owner']), botOpenId: 'ou_bot',
      groupResponseMode: 'mention', mentionTopicReply: false, stepPush: true, stepPushMode: 'streaming_card',
      logger: { warn() {}, error: (...args) => freshErrors.push(args), info() {} },
    })
    t.after(async () => { freshLifetime.abort(); await freshBridge.waitForIdle() })
    const sentBefore = sent.length
    const freshRequestStart = modelCalls.length
    await freshBridge.accept(message('new-direct-message', 'private fresh greeting', {
      sender: { sender_id: { open_id: 'ou_member' } }, message: { chat_id: 'oc_member_private' },
    }))
    await freshBridge.waitForIdle()
    const directId = freshState.sessionFor('p2p:ou_member')
    assert.ok(directId, 'an ordinary nonowner creates a real private gateway Session under the saved open policy')
    const finalCardAfter = start => sent.slice(start).findLast(item => item.content?.schema === '2.0'
      && item.content.body?.elements?.some(element => element.content === '_已完成_'))?.content
    const directFinalCard = finalCardAfter(sentBefore)
    assert.ok(directFinalCard)
    const groupSentBefore = sent.length
    await freshBridge.accept(message('new-group-message', '@bot group fresh greeting', {
      sender: { sender_id: { open_id: 'ou_member' } }, message: {
      chat_type: 'group', chat_id: 'oc_fresh_group', mentions: [{ key: '@bot', id: { open_id: 'ou_bot' } }],
    } }))
    await freshBridge.waitForIdle()
    const groupId = freshState.sessionFor('group:oc_fresh_group')
    assert.ok(groupId, 'an ordinary member in a new group creates a real gateway Session under the saved open policy')
    assert.notEqual(directId, groupId)
    assert.notEqual(directId, sessionId)
    assert.notEqual(groupId, sessionId)
    assert.equal(modelCalls.length, beforeFailure + 2)
    assert.deepEqual(freshErrors, [])
    assert.equal(sent.slice(sentBefore).filter(item => JSON.stringify(item.content).includes('Muse native IM result')).length >= 2, true)
    const directEvents = await eventsFor(ctx, directId)
    const groupEvents = await eventsFor(ctx, groupId)
    const userText = events => events.filter(event => event.type === 'user/message').map(event => JSON.stringify(event.data.content)).join('\n')
    assert.match(userText(directEvents), /private fresh greeting/u)
    assert.doesNotMatch(userText(directEvents), /group fresh greeting/u)
    assert.match(userText(groupEvents), /group fresh greeting/u)
    assert.doesNotMatch(userText(groupEvents), /private fresh greeting/u)
    const recordedChat = (events, requestIndex, finalCard) => ({
      requestMessages: modelCalls[requestIndex].messages.map(({ role, content }) => ({ role, content })),
      sessionMessages: events.filter(event => ['user/message', 'assistant/message'].includes(event.type))
        .map(event => ({ type: event.type, content: event.type === 'assistant/message' ? event.data.message.content : event.data.content })),
      finalCard,
    })
    const groupFinalCard = finalCardAfter(groupSentBefore)
    assert.ok(groupFinalCard)
    assert.deepEqual({
      direct: recordedChat(directEvents, freshRequestStart, directFinalCard),
      group: recordedChat(groupEvents, freshRequestStart + 1, groupFinalCard),
    }, expectedTranscript.freshPolicyChats)
    const restoredFreshState = await new StateStore(freshStatePath).load()
    for (const [key, id] of [['p2p:ou_member', directId], ['group:oc_fresh_group', groupId]]) {
      assert.equal(restoredFreshState.sessionFor(key), id)
      assert.equal(freshOwner.sessions.get(id).header.cwd, workspace)
      assert.equal(freshOwner.sessions.get(id).header.agentPreset, 'short-drama')
      const persisted = await freshOwner.sessionPersistence.stat(id)
      assert.equal(persisted.header.cwd, workspace)
    }
    freshLifetime.abort()
    await freshBridge.waitForIdle()
    newChatSessions = true
  }
  await ctx.fiber.dispose()
  assert.equal(routes.length, 0)
  assert.equal(networkCalls, 0)
  console.log(JSON.stringify({ nativeGatewayExistingSession: true, inheritedMusePreset: true,
    continuedDurableLog: true, groupMentionAdmission: true, callbackOwner: true,
    nativeStop: true, nativeSteeringLogged: true, unrelatedControlRejected: true,
    coldResume: true, durableInboundDeduplication: true,
    nativeRestrictedNewPrivateAndGroupSessions: newChatSessions,
    nativeOpenPolicyNonownerPrivateAndGroupSessions: newChatSessions,
    channelAbortQuiescent: true, networkCalls, paidProviderCalls: 0 }))
})

test('the built Runtime contains admission failures and drains replies when socket close fails', { skip: !inspectWrapper, timeout: 10_000 }, async (t) => {
  const { FeishuRuntime } = await native('src/channels/feishu/feishu-runtime.mjs')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-im-runtime-')))
  const state = await new StateStore(join(root, 'state.json')).load()
  const socket = Object.assign(new EventEmitter(), { readyState: 1 })
  let dispatcher
  let replyStarted = false
  let closeAttempted = false
  const errors = []
  const unhandled = []
  const onUnhandled = error => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))
  const reply = Promise.withResolvers()
  const send = async () => {
    replyStarted = true
    await reply.promise
    return { code: 0, data: { message_id: 'delayed-native-reply' } }
  }
  const lark = {
    Domain: { Feishu: 'feishu', Lark: 'lark' }, LoggerLevel: { info: 'info' },
    Client: class { im = { v1: { message: { create: send, reply: send } } } },
    EventDispatcher: class { register(handlers) { dispatcher = handlers; return this } },
    WSClient: class {
      constructor(options) { this.options = options }
      wsConfig = { getWSInstance: () => socket }
      start() { this.options.onReady() }
      getConnectionStatus() { return { state: 'connected' } }
      close() { closeAttempted = true; throw new Error('synthetic SDK close failure') }
    },
  }
  const runtime = new FeishuRuntime({ lark, appId: 'cli_synthetic', appSecret: 'synthetic-only',
    ownerOpenIds: ['ou_owner'], botOpenId: 'ou_bot', state, slashCommands: false,
    museAdmission: { message: async event => {
      if (event.message.message_id === 'invalid-admission') throw new Error('synthetic admission failure')
      return true
    } },
    harness: { ensureRunning: async () => {} }, logger: { warn() {}, error: (...args) => errors.push(args), info() {} } })
  t.after(async () => {
    reply.resolve()
    // The injected socket failure is asserted below; cleanup must still release the private files.
    await Promise.allSettled([runtime.stop()])
    await rm(root, { recursive: true, force: true })
  })
  await runtime.start()
  dispatcher['im.message.receive_v1']({
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
    message: { message_id: 'invalid-admission', message_type: 'text', chat_type: 'p2p',
      chat_id: 'oc_private', content: JSON.stringify({ text: 'test admission failure' }) },
  })
  await until(() => errors.some(entry => entry.some(value => value?.message === 'synthetic admission failure')), 'admission rejection is reported locally')
  assert.equal(runtime.status.ready, true)
  assert.equal(unhandled.length, 0)
  dispatcher['im.message.receive_v1']({
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
    message: { message_id: 'native-version', message_type: 'text', chat_type: 'p2p',
      chat_id: 'oc_private', content: JSON.stringify({ text: '/version' }) },
  })
  await until(() => replyStarted, 'admitted reply entered the fake wire')
  let stopped = false
  const stopping = runtime.stop().then(() => { stopped = true; return undefined }, error => { stopped = true; return error })
  await until(() => closeAttempted, 'Runtime attempted socket shutdown')
  assert.equal(stopped, false, 'a close failure cannot skip draining an already admitted reply')
  assert.equal(socket.listenerCount('close'), 0)
  assert.equal(socket.listenerCount('error'), 0)
  reply.resolve()
  const failure = await stopping
  assert.ok(failure instanceof AggregateError)
  assert.ok(failure.errors.some(error => error.message === 'synthetic SDK close failure'))
  assert.equal(runtime.status.ready, false)
  assert.equal(state.hasSeen('native-version'), true)
  assert.equal(unhandled.length, 0)
})

test('Runtime stop drains pending admission before returning and prevents late dispatch', { skip: !inspectWrapper, timeout: 10_000 }, async (t) => {
  const { FeishuRuntime } = await native('src/channels/feishu/feishu-runtime.mjs')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-im-admission-stop-')))
  const state = await new StateStore(join(root, 'state.json')).load()
  const socket = Object.assign(new EventEmitter(), { readyState: 1 })
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const closed = Promise.withResolvers()
  const writes = []
  const errors = []
  const unhandled = []
  let dispatcher
  let requests = 0
  const onUnhandled = error => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))
  const send = async options => { writes.push(options); return { code: 0, data: { message_id: 'unexpected-late-message' } } }
  const lark = {
    Domain: { Feishu: 'feishu', Lark: 'lark' }, LoggerLevel: { info: 'info' },
    Client: class {
      im = { v1: { message: { create: send, reply: send }, messageReaction: { create: send, delete: send } } }
    },
    EventDispatcher: class { register(handlers) { dispatcher = handlers; return this } },
    WSClient: class {
      constructor(options) { this.options = options }
      wsConfig = { getWSInstance: () => socket }
      start() { this.options.onReady() }
      getConnectionStatus() { return { state: 'connected' } }
      close() { socket.readyState = 3; socket.emit('close'); closed.resolve() }
    },
  }
  const request = async () => { requests++; throw new Error('No Session or turn may start after stopping') }
  const runtime = new FeishuRuntime({ lark, appId: 'cli_synthetic', appSecret: 'synthetic-only',
    ownerOpenIds: ['ou_owner'], botOpenId: 'ou_bot', state, slashCommands: false,
    museAdmission: { message: async () => { entered.resolve(); await release.promise; return true } },
    harness: { ensureRunning: async () => {}, createSession: request, ask: request, rpc: request },
    logger: { warn() {}, error: (...args) => errors.push(args), info() {} } })
  t.after(async () => {
    release.resolve()
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  await runtime.start()
  const before = state.snapshot()
  dispatcher['im.message.receive_v1']({
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
    message: { message_id: 'held-admission', message_type: 'text', chat_type: 'p2p',
      chat_id: 'oc_private', content: JSON.stringify({ text: 'start a task' }) },
  })
  await entered.promise
  let stopped = false
  const stopping = runtime.stop().then(() => { stopped = true })
  await closed.promise
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, false, 'shutdown waits for admission rather than abandoning its pending work')
  release.resolve()
  await stopping
  assert.equal(stopped, true)
  assert.deepEqual(state.snapshot(), before)
  assert.equal(state.hasSeen('held-admission'), false)
  assert.equal(requests, 0)
  assert.deepEqual(writes, [], 'no reaction or reply starts after the delayed admission returns')
  assert.deepEqual(errors, [])
  assert.deepEqual(unhandled, [])
  assert.equal(socket.listenerCount('close'), 0)
  assert.equal(socket.listenerCount('error'), 0)
})
