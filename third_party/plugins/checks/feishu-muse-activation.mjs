/** Native surface activation with production AgentLoop/presets/persistence and an inert Feishu wire. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { WSClient } from '@larksuiteoapi/node-sdk'

const root = mkdtempSync(join(tmpdir(), 'muse-feishu-activation-'))
process.env.MUSE_HOME = join(root, 'home')
process.env.DSH_HOME = process.env.MUSE_HOME
const require = createRequire(import.meta.url)
const artifact = process.cwd()
const { mountMuseFeishu, drainMuseOperations, stopMuseTransport, Config } = await import(pathToFileURL(join(artifact, 'lib/muse-feishu-runtime.mjs')).href)
const upstream = await import(pathToFileURL(join(artifact, 'lib/upstream/index.js')).href)
const { sessionSelectionFor } = await import(pathToFileURL(join(artifact, 'lib/upstream/model-switch.js')).href)
const { SessionMap } = await import(pathToFileURL(join(artifact, 'lib/upstream/session-map.js')).href)
const migration = await import(pathToFileURL(join(artifact, 'lib/muse-feishu-migration.mjs')).href)
const { createInboundClaims } = await import(pathToFileURL(join(artifact, 'lib/muse-feishu-reliability.mjs')).href)
const controller = dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json'))
const { installModelSelectionProjection } = await import(pathToFileURL(join(controller, 'lib/types/model-selection-projection.js')).href)
const sent = []
const pairings = []
const wires = []
let calls = 0
let holdNext = false
let holdStarted = false
let cancelled = false
let networkCalls = 0
const denyNetwork = () => { networkCalls++; throw new Error('native Feishu fixture attempted real network access') }
const network = { fetch: globalThis.fetch, http: http.request, https: https.request }
globalThis.fetch = denyNetwork
http.request = denyNetwork
https.request = denyNetwork
let ctx
class OfflineModel extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } } }
  async *stream(options) {
    calls++
    if (holdNext) {
      holdNext = false
      holdStarted = true
      await new Promise(resolve => {
        if (options.signal.aborted) resolve()
        else options.signal.addEventListener('abort', resolve, { once: true })
      })
      cancelled = true
      options.signal.throwIfAborted()
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Muse native reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Muse native reply' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
function wire() {
  const transport = {
    message: undefined, action: undefined, stopped: false,
    async start() {}, async stop() { this.stopped = true },
    onMessage(handler) { this.message = handler }, onCardAction(handler) { this.action = handler },
    getBotOpenId: () => 'ou_bot',
    async sendText(chatId, text) { sent.push({ kind: 'text', chatId, text }) },
    async sendCard(chatId, card) { const messageId = `card-${sent.length}`; sent.push({ kind: 'card', chatId, card, messageId }); return { messageId } },
    async updateCard(messageId, card) { sent.push({ kind: 'patch', messageId, card }) },
    async sendFile(chatId, name, bytes) { sent.push({ kind: 'file', chatId, name, bytes }) },
    async sendImage(chatId, name, bytes) { sent.push({ kind: 'image', chatId, name, bytes }) },
    async addReaction() { return 'reaction' }, async removeReaction() {},
    async chatStats() { return { userCount: 1, botCount: 1 } },
  }
  wires.push(transport)
  return transport
}
async function until(condition, label) {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`native Feishu activation timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const message = (id, extra = {}) => ({ messageId: id, chatId: 'oc_private', chatType: 'p2p', senderOpenId: 'ou_owner', text: 'hello Muse', mentions: [], attachments: [], createdAt: Date.now(), ...extra })
try {
  const sdk = new WSClient({ appId: 'cli_0000000000000000', appSecret: 'synthetic-only' })
  const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {
    this.readyState = 2
    setImmediate(() => { this.readyState = 3; this.emit('close') })
  } })
  sdk.wsConfig.setWSInstance(socket)
  await stopMuseTransport({ ws: sdk, stop: async () => sdk.close() })
  assert.equal(socket.readyState, 3)
  const malformed = join(root, 'corrupt-map.json')
  for (const invalid of ['{', JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 2, entries: { a: 'same', b: 'same' } }), JSON.stringify({ version: 2, entries: {}, cwds: { a: 42 } })]) {
    writeFileSync(malformed, invalid)
    assert.throws(() => new SessionMap(malformed).load(), /history was preserved/u)
    assert.equal(readFileSync(malformed, 'utf8'), invalid)
  }
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const preset = join(root, 'preset.mjs')
  writeFileSync(preset, `export const inject=['tools','systemPrompt']; export function apply(ctx) {
ctx.effect(()=>ctx.systemPrompt.section({name:'muse-fixture-persona',order:1,text:'Muse short drama fixture'}));
ctx.effect(()=>ctx.tools.register({name:'web_search',description:'fixture',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:()=>[]},execute:()=> 'ok'})); }
`)
  const repository = resolve(dirname(require.resolve('@deepseek-ai/dsh-home-paths/package.json')), '../../..')
  const policy = pathToFileURL(join(repository, 'apps/desktop-host/lib/types/creation-policy.js')).href
  const configPath = join(root, 'cordis.json')
  const config = { enabled: true, appId: 'cli_fixture', appSecret: 'synthetic-only', defaultCwd: workspace,
    dataDir: join(root, 'surface'), allowFrom: ['ou_owner', 'oc_allowed'], requireMention: true }
  writeFileSync(configPath, JSON.stringify([{ id: 'feishu-channel', name: 'cordis:native', config }]))
  ctx = await boot('muse-native-test', configPath, [], async host => {
    await mountAgentLoopTestDependencies(host)
    await host.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' })
    await host.plugin(AgentLoop, { agents: [] })
    await host.plugin(AgentPresets, { default: 'short-drama', selectablePresets: ['short-drama'] })
    await host.plugin({ inject: ['agentPresets'], async *apply(scope) {
      yield await scope.agentPresets.register({ id: 'short-drama', plugins: [{ name: policy }, { name: pathToFileURL(preset).href }] })
    } })
    installModelSelectionProjection(host)
    host.effect(() => host.llm.registerAdapter(['offline'], new OfflineModel()))
    host.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'offline', model: 'fixture', reasoningEffort: 'high' }) })
    host.provide('settings', { update: async (namespace, value) => {
      pairings.push({ namespace, value })
      writeFileSync(join(root, 'saved-pairing.json'), JSON.stringify(value))
    } })
    host.provide('approval', {})
    host.provide('userQuestions', {})
    host.loader.builtins.native = { Config, apply(owner, resolved) {
      mountMuseFeishu(owner, resolved, upstream, { createTransport: wire, selectionFor: sessionSelectionFor, migration, createInboundClaims })
    } }
  })
  await until(() => wires.length === 1 && wires[0].message !== undefined, 'wire registration')
  const first = wires[0]
  first.message(message('unauthorized', { senderOpenId: 'ou_other' }))
  first.message(message('group-no-at', { chatId: 'oc_allowed', chatType: 'group', mentions: [] }))
  first.message(message('group-wrong-at', { chatId: 'oc_allowed', chatType: 'group', mentions: ['ou_other_bot'] }))
  first.message(message('accepted'))
  await until(() => calls === 1 && ctx.agents.list().some(agent => agent.status === 'idle'), 'real Agent turn')
  const agent = ctx.agents.list()[0]
  assert.equal(agent.session.header.agentPreset, 'short-drama')
  assert.ok(ctx.tools.schemas(agent).some(tool => tool.name === 'web_search'))
  assert.equal(agent.session.requestHeader().config.provider, 'offline')
  assert.equal(agent.session.requestHeader().config.reasoningEffort, 'high')
  assert.equal(ctx.agents.list().length, 1)
  assert.ok(ctx.tools.schemas(agent).some(tool => tool.name === 'send_file'))
  const originalId = agent.session.id
  await until(() => sent.some(item => ['card', 'patch', 'text'].includes(item.kind) && JSON.stringify(item).includes('Muse native reply')), 'real final answer delivery')
  assert.equal(await ctx.waterfall('approval/request', { agent: { session: { id: 'gui-session' } } }, () => 'gui-answer'), 'gui-answer')
  assert.deepEqual(await ctx.waterfall('user-questions/request', { agent: { session: { id: 'gui-session' } }, questions: [] }, () => ({ answers: ['gui'] })), { answers: ['gui'] })
  const questionOffset = sent.length
  const question = ctx.waterfall('user-questions/request', { agent,
    questions: [{ id: 'muse-style', question: '选择短剧风格', options: [{ label: '3D' }, { label: '写实' }] }], signal: new AbortController().signal },
  () => { throw new Error('owned question was not handled by Feishu') })
  await until(() => sent.slice(questionOffset).some(item => item.kind === 'card'), 'owned question card')
  const questionCard = sent.slice(questionOffset).find(item => item.kind === 'card')
  first.action({ chatId: 'oc_private', messageId: questionCard.messageId, operatorOpenId: 'ou_other', value: { kind: 'question', id: 'muse-style', answer: '写实' } })
  first.action({ chatId: 'oc_private', messageId: questionCard.messageId, operatorOpenId: 'ou_owner', value: { kind: 'question', id: 'muse-style', answer: '3D' } })
  assert.deepEqual(await question, { answers: [{ id: 'muse-style', selected: ['3D'] }] })
  const panelOffset = sent.length
  first.message(message('panel', { text: '/panel' }))
  await until(() => sent.slice(panelOffset).some(item => item.kind === 'card' || item.kind === 'patch'), 'native panel')
  for (const item of sent.filter(item => item.kind === 'card')) {
    assert.ok(!/"command":"(?:permission|plan)"|"kind":"permission-pick"/u.test(JSON.stringify(item.card)))
  }
  writeFileSync(join(workspace, 'delivery.txt'), 'real delivery')
  agent.session.append('deliverables/presented', { turn: 1, callId: 'present-fixture', files: [{ path: 'delivery.txt' }] })
  await until(() => sent.some(item => item.kind === 'file' && item.name === 'delivery.txt'), 'present delivery')
  assert.equal(new TextDecoder().decode(sent.find(item => item.kind === 'file').bytes), 'real delivery')
  const sentCount = sent.length
  const rejectDelivery = agent.ctx.on('deliverables/validate', () => { throw new Error('managed screenplay validation rejected') })
  const blocked = await ctx.tools.execute({ callId: 'managed-blocked', name: 'send_file', arguments: { path: 'delivery.txt' }, agent, signal: new AbortController().signal })
  rejectDelivery()
  assert.equal(blocked.isError, true)
  assert.match(blocked.error.message, /managed screenplay validation/u)
  assert.equal(sent.length, sentCount)
  const success = await ctx.tools.execute({ callId: 'native-file', name: 'send_file', arguments: { path: 'delivery.txt' }, agent, signal: new AbortController().signal })
  assert.equal(success.isError, false)
  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'private.txt'), 'do not send')
  const escape = join(workspace, 'escape')
  symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir')
  const beforeFiles = sent.filter(item => item.kind === 'file').length
  const rejected = await ctx.tools.execute({ callId: 'outside-file', name: 'send_file', arguments: { path: 'escape/private.txt' }, agent, signal: new AbortController().signal })
  assert.equal(rejected.isError, true)
  assert.match(rejected.error.message, /physical Session workspace/u)
  first.action({ chatId: 'oc_private', messageId: questionCard.messageId, operatorOpenId: 'ou_owner', value: { kind: 'send-produced', path: 'escape/private.txt' } })
  await until(() => sent.some(item => item.kind === 'text' && item.text.includes('文件未发送')), 'produced file rejection')
  agent.session.append('deliverables/presented', { turn: 1, callId: 'outside-present', files: [{ path: 'escape/private.txt' }] })
  await until(() => sent.some(item => item.kind === 'text' && item.text.includes('交付文件未发送')), 'present physical escape rejection')
  assert.equal(sent.filter(item => item.kind === 'file').length, beforeFiles)
  unlinkSync(escape)
  const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'feishu-channel')
  const gui = await ctx.agents.create({ sessionId: 'gui-existing', meta: { cwd: workspace, agentPreset: 'short-drama' },
    agentOptions: { provider: 'offline', model: 'fixture' }, setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'short-drama') } })
  assert.ok(!ctx.tools.schemas(gui.agent).some(tool => tool.name === 'send_file'))
  first.message(message('adopt-gui', { text: '/resume gui-existing' }))
  await until(() => ctx.tools.schemas(gui.agent).some(tool => tool.name === 'send_file'), 'live GUI adoption scoped file tool')
  const mapPath = join(config.dataDir, 'accounts', createHash('sha256').update(JSON.stringify([config.appId, ''])).digest('hex'), 'session-map.json')
  const persisted = new SessionMap(mapPath)
  persisted.load()
  assert.equal(persisted.get('oc_private'), 'gui-existing')
  assert.equal(persisted.cwdFor('oc_private'), workspace)
  first.message(message('back-to-original', { text: `/resume ${originalId}` }))
  await until(() => JSON.parse(readFileSync(mapPath, 'utf8')).entries.oc_private === originalId, 'original binding immediately persisted')
  await row.update({ disabled: true })
  await until(() => first.stopped && ctx.agents.list().length === 1, 'channel quiescence')
  assert.equal(ctx.agents.get('gui-existing'), gui.agent)
  assert.ok(!ctx.tools.schemas(gui.agent).some(tool => tool.name === 'send_file'))
  await gui.dispose()
  assert.equal(ctx.agents.list().length, 0)
  await row.update({ disabled: false })
  await ctx.loader.await()
  await until(() => wires.length === 2, 'channel restart')
  wires[1].message(message('accepted'))
  wires[1].message(message('resume-existing'))
  await until(() => calls === 2 && ctx.agents.list().some(current => current.status === 'idle'), 'persisted resume')
  assert.equal(ctx.agents.list()[0].session.id, originalId)
  assert.equal(calls, 2)
  assert.equal(pairings.length, 0)
  holdNext = true
  wires[1].message(message('long-running-turn'))
  await until(() => holdStarted, 'active turn before unload')
  await row.update({ disabled: true })
  await until(() => cancelled && wires[1].stopped && ctx.agents.list().length === 0, 'active turn cancellation and drain')
  const pairedConfig = { ...config, appId: 'cli_pairing', allowFrom: [] }
  await row.update({ config: pairedConfig })
  await row.update({ disabled: false })
  await ctx.loader.await()
  await until(() => wires.length === 3, 'pairing channel')
  wires[2].message(message('first-owner'))
  wires[2].message(message('unpaired-other', { senderOpenId: 'ou_other' }))
  await until(() => calls === 4 && ctx.agents.list().some(current => current.status === 'idle'), 'first owner paired turn')
  assert.deepEqual(pairings, [{ namespace: 'feishu-channel', value: { allowFrom: ['ou_owner'] } }])
  const pairedId = ctx.agents.list()[0].session.id
  await row.update({ disabled: true })
  await until(() => wires[2].stopped && ctx.agents.list().length === 0, 'paired channel stop')
  const saved = JSON.parse(readFileSync(join(root, 'saved-pairing.json'), 'utf8'))
  await row.update({ config: { ...pairedConfig, ...saved }, disabled: false })
  await ctx.loader.await()
  await until(() => wires.length === 4, 'pairing saved restart')
  wires[3].message(message('still-unauthorized', { senderOpenId: 'ou_other' }))
  wires[3].message(message('first-owner'))
  wires[3].message(message('paired-resume'))
  await until(() => calls === 5 && ctx.agents.list().some(current => current.status === 'idle'), 'paired same Session resume')
  assert.equal(ctx.agents.list()[0].session.id, pairedId)
  assert.equal(pairings.length, 1)
  await row.update({ disabled: true })
  await until(() => wires[3].stopped && ctx.agents.list().length === 0, 'before legacy path defaults')
  const { defaultCwd: _cwd, dataDir: _data, ...oldConfig } = config
  await row.update({ config: { ...oldConfig, appId: 'cli_legacy_defaults' }, disabled: false })
  await ctx.loader.await()
  await until(() => wires.length === 5, 'legacy row without path options')
  wires[4].message(message('legacy-default-paths'))
  await until(() => calls === 6 && ctx.agents.list().some(current => current.status === 'idle'), 'default workspace turn')
  assert.equal(ctx.agents.list()[0].session.header.cwd, join(root, 'home/default-workspace'))
  const closingHandle = await ctx.agents.create({ sessionId: 'shutdown-owned', meta: { cwd: workspace }, agentOptions: { provider: 'offline', model: 'fixture' } })
  const closingMapPath = join(root, 'shutdown-map.json')
  const closingMap = new SessionMap(closingMapPath)
  closingMap.set('oc_shutdown', closingHandle.agent.session.id)
  const transportFailure = new Error('connection closed while stopping')
  await assert.rejects(upstream.finishChannelShutdown(async () => { throw transportFailure },
    () => drainMuseOperations(new Set([closingHandle]), new Set()), () => closingMap.persist()),
  error => error instanceof AggregateError && error.errors.includes(transportFailure))
  assert.equal(ctx.agents.get('shutdown-owned'), undefined)
  const reopenedMap = new SessionMap(closingMapPath)
  reopenedMap.load()
  assert.equal(reopenedMap.get('oc_shutdown'), 'shutdown-owned')
  const persistenceFailure = new Error('mapping persistence failed')
  await assert.rejects(upstream.finishChannelShutdown(async () => { throw transportFailure }, async () => {}, () => { throw persistenceFailure }),
    error => error instanceof AggregateError && error.errors.includes(transportFailure) && error.errors.includes(persistenceFailure))
  assert.equal(networkCalls, 0)
  console.log(JSON.stringify({ nativeMuseActivation: true, actualAgentLoop: true, actualPresetRegistry: true,
    durableSessionResume: true, durableDuplicateIgnored: true, strictMention: true,
    foreignQuestionsDelegate: true, ownedQuestionAnswered: true, presentDelivery: true, physicalFileEscapeRejected: true,
    firstOwnerPairingSaved: true, activeTurnUnload: true, failedTransportStillDrainsAndPersists: true, sdkSocketCloseWait: true, corruptMappingRejected: true, guiToolIsolation: true, explicitResumeImmediatelyPersisted: true, deliveryValidatorPreserved: true, hiddenModeControls: true, legacyDefaultPaths: true, networkCalls, paidCalls: 0 }))
} finally {
  await ctx?.fiber.dispose()
  globalThis.fetch = network.fetch
  http.request = network.http
  https.request = network.https
  rmSync(root, { recursive: true, force: true })
}
