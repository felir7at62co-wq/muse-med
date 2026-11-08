/** Ordinary Muse Feishu composition retains native chat Sessions without a Muse Bot service. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import test from 'node:test'

const source = resolve(process.env.DSH_IM_TEST_SOURCE ?? process.cwd())
const native = path => import(pathToFileURL(join(source, path)).href)
const { createProductionController } = await native('plugin-src/host/channels/feishu/production.mjs')
const { PluginConfigStore } = await native('src/channels/feishu/plugin-config-store.mjs')
const { StateStore } = await native('src/channels/feishu/state-store.mjs')
const { BotWorkspaceStore } = await native('src/channels/shared/bot-workspace-store.mjs')
const { FeishuHarnessBridge } = await native('src/channels/feishu/bridge.mjs')
const { VerifiedFeishuChannel } = await native('src/channels/feishu/feishu-channel.mjs')
const { promptContentForMessage } = await native('src/channels/shared/image-prompt.mjs')
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

async function configuredFeishu(ctx, config) {
  const entry = new URL(pathToFileURL(join(source, 'lib/index.js')))
  entry.searchParams.set('native-session-check', randomUUID())
  const capturedUrl = `data:text/javascript,${encodeURIComponent(`export let captured; export function createImHostPlugin() {
    return { async apply(ctx, config) { captured = config; } };
  }`)}`
  const original = process.env.DSH_IM_TEST_ENTRY
    ? await readFile(process.env.DSH_IM_TEST_ENTRY, 'utf8') : undefined
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === entry.href && specifier === './upstream.js') return { url: capturedUrl, shortCircuit: true }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url === entry.href && original !== undefined) return { format: 'module', source: original, shortCircuit: true }
      return next(url, context)
    },
  })
  try {
    const wrapper = await import(entry.href)
    await wrapper.apply(ctx, { ...config, ...Object.fromEntries(['appId', 'appSecret', 'registeredBy', 'allowFrom', 'activeSessionId']
      .map(key => [key, { get: () => config[key] }])) })
    return (await import(capturedUrl)).captured.feishu
  } finally { hook.deregister() }
}

function message(id, { chat = 'oc_group', sender = 'ou_owner', privateChat = false, thread, text = '@bot continue this project', mentions } = {}) {
  return { sender: { sender_type: 'user', sender_id: { open_id: sender } }, message: {
    message_id: id, chat_id: chat, chat_type: privateChat ? 'p2p' : 'group', message_type: 'text',
    content: JSON.stringify({ text }), mentions: mentions ?? [{ key: '@bot', id: { open_id: 'ou_bot' } }],
    ...(thread ? { thread_id: thread, root_id: 'om_root' } : {}),
  } }
}

async function fixture(t) {
  const allocated = await mkdtemp(join(tmpdir(), 'muse-im-native-session-'))
  const asked = [], created = [], sent = [], errors = [], bridges = [], productions = [], effects = [], downloads = []
  t.after(async () => {
    try {
      for (const { lifetime } of bridges) lifetime.abort()
      for (const { bridge } of bridges) await bridge.waitForIdle()
      for (const production of productions.reverse()) await production.close()
      for (const dispose of effects.reverse()) await dispose()
    } finally { await rm(allocated, { recursive: true, force: true }) }
  })
  const root = await realpath(allocated)
  const workspace = join(root, 'project')
  await mkdir(workspace)
  const botId = 'registered_bot', appId = 'cli_synthetic'
  const dataDir = join(root, 'integrations', 'dsh-feishu')
  const statePath = join(dataDir, 'bots', botId, 'state.json')
  const stores = await new PluginConfigStore(join(dataDir, 'config.json')).load()
  const botConfig = await stores.saveBot({ id: botId, appId, secretRef: 'SYNTHETIC_SECRET', botOpenId: 'ou_bot', ownerOpenIds: ['ou_owner'],
    groupResponseMode: 'mention', mentionTopicReply: true, stepPush: false })
  const workspaces = await new BotWorkspaceStore(join(dataDir, 'workspaces.json'), { defaultWorkspace: workspace }).load()
  await workspaces.ensure(botId)
  const sessions = new Map([
    ['original-group-session', { header: { id: 'original-group-session', cwd: workspace, model: { provider: 'offline', model: 'original-model' }, agentPreset: 'original-preset' } }],
    ['original-private-session', { header: { id: 'original-private-session', cwd: workspace, model: { provider: 'offline', model: 'private-model' }, agentPreset: 'private-preset' } }],
  ])
  const initialSessions = structuredClone([...sessions])
  const state = await new StateStore(statePath).load()
  await state.setSession('group:oc_group', 'original-group-session')
  await state.setSession('p2p:ou_owner', 'original-private-session')
  const hash = createHash('sha256').update(JSON.stringify([botId, appId])).digest('hex')
  const teamRoot = join(root, 'integrations', 'muse-team', hash)
  await mkdir(teamRoot, { recursive: true })
  const oldBindings = { version: 1, identity: { imBotId: botId, appId },
    bindings: { oc_group: { botId: 'original-group-session', sessionId: 'original-group-session', originalSessionId: 'original-group-session', workspace } },
    replies: { 'out-before-upgrade': { thread: true, at: Date.now() } }, chats: { oc_group: { key: 'group:oc_group', name: 'Existing project' } } }
  await writeFile(join(teamRoot, 'bindings.json'), JSON.stringify(oldBindings))
  await writeFile(join(teamRoot, 'requests.json'), JSON.stringify({ version: 1, entries: [['om_before_upgrade', Date.now()]] }))
  let factory
  const ctx = { fiber: { entry: { options: { id: 'feishu-channel' } } },
    credentials: { resolve: async () => { throw new Error('The native composition check must not read credentials') } },
    sessions, sessionPersistence: { stat: async id => sessions.get(id) },
    logger: { error: (...args) => errors.push(args), warn() {}, info() {} },
    get: key => ({ sessions, sessionPersistence: { stat: async id => sessions.get(id) } })[key],
    inject() {}, effect: acquire => { const dispose = acquire(); if (typeof dispose === 'function') effects.push(dispose) },
  }
  const supplied = { enabled: false, dshHome: root, feishuDataDir: dataDir, defaultCwd: workspace,
    appId: '', appSecret: '', registeredBy: '', allowFrom: [], activeSessionId: '', agentPreset: 'short-drama',
    inboundClaimRetentionMs: 86400000, inboundClaimMaxEntries: 1000, maxFileBytes: 1024 * 1024 }
  class OfflineHarness {
    stopManagedProcess() {}
    async ensureRunning() {}
    async createSession({ workspace: cwd }) {
      const id = `new-native-${created.length + 1}`
      sessions.set(id, { header: { id, cwd, model: { provider: 'offline', model: 'native-default' } } })
      created.push(id)
      return id
    }
    async sessionExists(id) { return sessions.has(id) }
    async adoptWorkspaceSession(id) { return { sessionId: id, workspace: sessions.get(id)?.header.cwd } }
    async ask(id, text, options) {
      if (options.images?.length) {
        const loaded = await promptContentForMessage({ images: options.images }, { maxImageBytes: 1024 * 1024, signal: options.signal })
        text = [...text, ...loaded.filter(part => part.type === 'image')]
      }
      asked.push({ id, text, options })
      return 'Native Session result'
    }
  }
  const connect = async () => {
    const feishu = await configuredFeishu(ctx, supplied)
    const production = await createProductionController(ctx, { ...feishu, dshHome: root,
      harnessBaseUrl: 'http://localhost', slashCommands: false }, {
      HarnessClient: OfflineHarness,
      Controller: class { constructor(options) { factory = options.createRuntime } async close() {} },
      FeishuRuntime: class { constructor(options) { return options } },
      createConnectionSupervisor: () => ({ start: () => ({ ready: Promise.resolve(), async close() {} }) }),
      commandExecutor: async () => { throw new Error('No commands may run') },
      inboundTtl: { stagingRetention() {}, trackStaged() {} }, groupHistory: {}, proxyEnv: {},
    })
    productions.push(production)
    const options = await factory({ botId, config: botConfig, appSecret: 'synthetic-only' })
    const lifetime = new AbortController()
    const send = async request => { sent.push(request); return { code: 0, data: { message_id: `out-${sent.length}` } } }
    const wire = { im: { v1: {
      message: { create: send, reply: send, patch: send, delete: async () => ({ code: 0 }) },
      messageResource: { get: async request => {
        downloads.push(request)
        return { headers: { 'content-length': String(image.length) }, getReadableStream: () => Readable.from([image]) }
      } },
    } } }
    const bridge = new FeishuHarnessBridge({ ...options, client: wire,
      channel: new VerifiedFeishuChannel({ client: wire, initialText: 'Native composition test' }), signal: lifetime.signal,
      status: { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 } })
    bridges.push({ bridge, lifetime })
    return { bridge, options, stop: async () => { lifetime.abort(); await bridge.waitForIdle() } }
  }
  const accept = async (connected, event) => { await connected.bridge.accept(event); await connected.bridge.waitForIdle() }
  return { root, workspace, sessions, initialSessions, statePath, teamRoot, oldBindings, asked, created, sent, errors, downloads, connect, accept }
}

test('ordinary Feishu composition continues exact native chat Sessions, including thread replies, without a Muse Bot service', async t => {
  const f = await fixture(t)
  const n = await f.connect()
  assert.equal(n.options.museAdmission.replyInThreadFor('out-before-upgrade'), true, 'existing delivered cards retain their thread receipt')
  await f.accept(n, message('om_plain'))
  assert.equal(f.asked[0]?.id, 'original-group-session', JSON.stringify(f.errors))
  await f.accept(n, message('om_thread', { thread: 'omt_existing' }))
  await f.accept(n, message('om_private', { chat: 'oc_private', privateChat: true, mentions: [] }))
  assert.deepEqual(f.asked.map(item => item.id), ['original-group-session', 'original-group-session', 'original-private-session'])
  const incomingImage = message('om_image', { chat: 'oc_private', privateChat: true, mentions: [] })
  incomingImage.message.message_type = 'image'
  incomingImage.message.content = JSON.stringify({ image_key: 'img_synthetic' })
  await f.accept(n, incomingImage)
  await f.accept(n, incomingImage)
  assert.equal(f.asked.at(-1).id, 'original-private-session')
  assert.deepEqual(f.asked.at(-1).text.filter(part => part.type === 'image'), [{ type: 'image', mediaType: 'image/png', data: image.toString('base64') }])
  assert.deepEqual(f.downloads, [{ path: { message_id: 'om_image', file_key: 'img_synthetic' }, params: { type: 'image' } }])
  assert.equal(f.asked.length, 4, 'a retried image cannot create another native prompt or download')
  assert.deepEqual(f.created, [])
  assert.deepEqual([...f.sessions], f.initialSessions, 'existing model, workspace and preset metadata stay untouched')
  assert.deepEqual((await new StateStore(f.statePath).load()).snapshot().sessions, {
    'group:oc_group': 'original-group-session', 'p2p:ou_owner': 'original-private-session',
  })
  assert.ok(f.sent.some(row => row.data?.reply_in_thread === true), 'thread replies retain the native reply route')
  const bound = JSON.parse(await readFile(join(f.teamRoot, 'bindings.json'), 'utf8'))
  assert.deepEqual(bound.bindings, f.oldBindings.bindings, 'retained Bot metadata is not rewritten or revived')
  assert.deepEqual(f.errors, [])
})

test('ordinary Feishu composition preserves durable claims, rejects denied messages and creates only native unbound Sessions', async t => {
  const f = await fixture(t)
  const n = await f.connect()
  await f.accept(n, message('om_before_upgrade'))
  await f.accept(n, message('om_denied', { sender: 'ou_stranger' }))
  await f.accept(n, message('om_wrong_at', { mentions: [{ key: '@bot', id: { open_id: 'ou_other' } }] }))
  assert.equal(f.asked.length, 0)
  await f.accept(n, message('om_once'))
  assert.equal(f.asked.length, 1)
  await f.accept(n, message('om_once'))
  assert.equal(f.asked.length, 1)
  await n.stop()
  const recentState = JSON.parse(await readFile(f.statePath, 'utf8'))
  recentState.seenMessageIds = []
  await writeFile(f.statePath, JSON.stringify(recentState))
  const restored = await f.connect()
  await f.accept(restored, message('om_once'))
  assert.equal(f.asked.length, 1, 'a channel reconstruction retains the app-scoped durable claim')
  await f.accept(restored, message('om_new_chat', { chat: 'oc_new_chat' }))
  assert.deepEqual(f.created, ['new-native-1'])
  assert.equal(f.asked.at(-1).id, 'new-native-1')
  assert.equal(f.sessions.get('new-native-1').header.cwd, f.workspace)
  assert.equal((await new StateStore(f.statePath).load()).sessionFor('group:oc_new_chat'), 'new-native-1')
  assert.deepEqual(f.errors, [])
})
