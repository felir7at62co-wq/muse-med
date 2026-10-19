/** Verify migrated chat admission with real upstream state, workspace and migration files. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMuseImAdmission } from './lib/muse-im-admission.mjs'
import { migrateMuseIm } from './lib/muse-im-migration.mjs'
import { StateStore } from './src/channels/feishu/state-store.mjs'
import { BotWorkspaceStore } from './src/channels/shared/bot-workspace-store.mjs'
import { PluginConfigStore } from './src/channels/feishu/plugin-config-store.mjs'
import { FeishuHarnessBridge } from './src/channels/feishu/bridge.mjs'
import { VerifiedFeishuChannel } from './src/channels/feishu/feishu-channel.mjs'
import { createAccessPolicy, createAccessPolicyScope } from './src/channels/shared/access-policy.mjs'
import { accessPolicyProvider } from './plugin-src/host/channels/shared/access-policy-production.mjs'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'muse-im-admission-'))
  const cleanups = []
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup() }
    finally { await rm(home, { recursive: true, force: true }) }
  })
  const config = { enabled: true, dshHome: home, appId: 'cli_synthetic', appSecret: 'synthetic-secret',
    registeredBy: 'ou_owner', allowFrom: ['ou_owner', 'oc_allowed'], defaultCwd: join(home, 'workspace'),
    inboundClaimRetentionMs: 24 * 60 * 60 * 1000, inboundClaimMaxEntries: 2000 }
  const identity = createHash('sha256').update(JSON.stringify([config.appId, config.registeredBy])).digest('hex')
  const legacy = join(home, 'feishu', 'accounts', identity)
  const directCwd = join(home, 'old-direct-workspace')
  await Promise.all([mkdir(legacy, { recursive: true }), mkdir(directCwd), mkdir(config.defaultCwd)])
  await writeFile(join(legacy, 'session-map.json'), JSON.stringify({ version: 2,
    entries: { oc_allowed: 'original-group', oc_direct: 'original-direct' }, cwds: { oc_direct: directCwd } }))
  const oldIds = Array.from({ length: 1007 }, (_, index) => `om_legacy_${index}`)
  await writeFile(join(legacy, 'inbound-claims.json'), JSON.stringify({ version: 1, entries: oldIds.map(id => [id, 1]) }))
  const values = new Map()
  const ctx = { credentials: { resolve: async ref => values.has(ref) ? { value: values.get(ref) } : undefined,
    set: async (ref, value) => { values.set(ref, value) } } }
  const migration = await migrateMuseIm(ctx, config, { verifyApp: async () => ({ openId: 'ou_bot', name: 'Synthetic bot' }) })
  const nativeRoot = join(home, 'integrations', 'dsh-feishu')
  const statePath = join(nativeRoot, 'bots', migration.botId, 'state.json')
  const state = await new StateStore(statePath).load()
  const workspaces = await new BotWorkspaceStore(join(nativeRoot, 'workspaces.json')).load()
  const admission = createMuseImAdmission(config, migration).forBot(migration.botId, workspaces)
  return { config, migration, state, statePath, workspaces, admission, oldIds, legacy, directCwd,
    cleanup: fn => cleanups.push(fn) }
}

function message(id, { chatId = 'oc_allowed', sender = 'ou_member', type = 'group', mentions = [{ id: { open_id: 'ou_bot' } }], text = 'hello' } = {}) {
  return { sender: { sender_id: { open_id: sender }, sender_type: 'user' },
    message: { message_id: id, chat_id: chatId, chat_type: type, mentions, message_type: 'text', content: JSON.stringify({ text }) } }
}

const json = async path => JSON.parse(await readFile(path, 'utf8'))

test('members of an old allowed group still require the exact bot mention and durably claim the id', async t => {
  const f = await fixture(t)
  const stateBefore = f.state.snapshot()
  const claimsBefore = await readFile(f.migration.claimsPath, 'utf8')
  const rejected = [
    message('om_no_at', { mentions: [] }),
    message('om_wrong_at', { mentions: [{ id: { open_id: 'ou_other_bot' } }] }),
    message('om_invalid_group', { chatId: 'not-a-chat' }),
    message('om_unknown_type', { type: 'unknown' }),
    message('om_missing_sender', { sender: undefined }),
  ]
  delete rejected.at(-1).sender.sender_id.open_id
  for (const event of rejected) assert.equal(await f.admission.message(event, f.state), false)
  assert.deepEqual(f.state.snapshot(), stateBefore)
  assert.equal(await readFile(f.migration.claimsPath, 'utf8'), claimsBefore, 'denied messages cannot claim or trigger private binding')
  assert.equal(await f.admission.message(message('om_valid_member'), f.state), true)
  assert.equal(f.state.sessionFor('group:oc_allowed'), 'original-group')
  assert.ok((await json(f.migration.claimsPath)).entries.some(([id]) => id === 'om_valid_member'))
  assert.equal(await f.admission.message(message('om_valid_member'), f.state), false)
  assert.equal(await f.admission.message(message('om_top_level_mention', { mentions: [{ open_id: 'ou_bot' }] }), f.state), true)
})

test('post-authorization admission accepts new group members without changing the legacy policy', async t => {
  const f = await fixture(t)
  const markerBefore = await readFile(f.migration.markerPath)
  const stateBefore = f.state.snapshot()
  for (const [id, sender] of [['om_new_member', 'ou_member'], ['om_new_other', 'ou_other']]) {
    assert.equal(await f.admission.message(message(id, { chatId: 'oc_new_group', sender }), f.state), true)
    assert.equal(await f.admission.message(message(id, { chatId: 'oc_new_group', sender }), f.state), false)
  }
  assert.deepEqual(await readFile(f.migration.markerPath), markerBefore)
  assert.deepEqual(f.migration.allowedChatIds, ['oc_allowed'])
  assert.deepEqual(f.state.snapshot(), stateBefore, 'the post-policy guard does not create group Session bindings')
})

test('an unknown bot identity cannot fall back to any non-empty mention list', async t => {
  const f = await fixture(t)
  const admission = createMuseImAdmission(f.config, { ...f.migration, botOpenId: undefined }).forBot(f.migration.botId, f.workspaces)
  const before = await readFile(f.migration.claimsPath, 'utf8')
  assert.equal(await admission.message(message('om_unknown_bot'), f.state), false)
  assert.equal(await admission.message(message('om_unknown_bot_new_group', { chatId: 'oc_new_one', sender: 'ou_owner' }), f.state), false)
  assert.equal(await readFile(f.migration.claimsPath, 'utf8'), before)
})

test('post-authorization DMs ignore legacy senders but restore only the owner binding in the selected workspace', async t => {
  const f = await fixture(t)
  const oldFiles = ['session-map.json', 'inbound-claims.json'].map(name => join(f.legacy, name))
  const originals = await Promise.all(oldFiles.map(path => readFile(path)))
  const before = await readFile(f.migration.claimsPath, 'utf8')
  assert.equal(await f.admission.message(message('om_stranger', { type: 'p2p', chatId: 'oc_direct', sender: 'ou_stranger', mentions: [] }), f.state), true)
  assert.notEqual(await readFile(f.migration.claimsPath, 'utf8'), before)
  assert.equal(f.state.sessionFor('p2p:ou_stranger'), null)
  assert.equal(f.state.sessionFor('p2p:ou_owner'), null)
  assert.equal(await f.admission.message(message('om_owner_direct', { type: 'p2p', chatId: 'oc_direct', sender: 'ou_owner', mentions: [] }), f.state), true)
  assert.equal(f.state.sessionFor('p2p:ou_owner'), null, 'admission must not revive an old Session in another workspace')
  assert.equal(f.workspaces.workspaceFor(f.migration.botId), f.config.defaultCwd)
  assert.equal(f.workspaces.conversationWorkspaceFor(f.migration.botId, 'p2p:ou_owner'), f.config.defaultCwd)
  assert.equal(f.workspaces.hasConversationWorkspaceOverride(f.migration.botId, 'p2p:ou_owner'), false)
  assert.equal((await new StateStore(f.statePath).load()).sessionFor('p2p:ou_owner'), null)
  await f.workspaces.setWorkspace(f.migration.botId, f.directCwd)
  assert.equal(await f.admission.message(message('om_owner_same_workspace', {
    type: 'p2p', chatId: 'oc_direct', sender: 'ou_owner', mentions: [],
  }), f.state), true)
  assert.equal(f.state.sessionFor('p2p:ou_owner'), 'original-direct')
  assert.equal(f.workspaces.workspaceFor(f.migration.botId), f.directCwd)
  assert.equal(f.workspaces.conversationWorkspaceFor(f.migration.botId, 'p2p:ou_owner'), f.directCwd)
  assert.equal(f.workspaces.hasConversationWorkspaceOverride(f.migration.botId, 'p2p:ou_owner'), false)
  assert.equal((await new StateStore(f.statePath).load()).sessionFor('p2p:ou_owner'), 'original-direct')
  assert.deepEqual(await Promise.all(oldFiles.map(path => readFile(path))), originals)
})

test('all imported ids remain blocked beyond the native recent-1000 limit and claim retention', async t => {
  const f = await fixture(t)
  assert.equal(f.migration.legacyMessageIds.length, 1007)
  assert.equal(f.state.hasSeen(f.oldIds[0]), false, 'the native recent-id buffer cannot by itself reject this id')
  assert.equal(await f.admission.message(message('om_new_after_migration'), f.state), true)
  assert.equal((await json(f.migration.claimsPath)).entries.length, 1, 'expired ledger entries were pruned')
  for (const id of [f.oldIds[0], f.oldIds[6], f.oldIds.at(-1)]) {
    assert.equal(await f.admission.message(message(id), f.state), false)
  }
  const restored = await migrateMuseIm({ credentials: { resolve: async () => undefined } }, f.config)
  const restarted = createMuseImAdmission(f.config, restored).forBot(restored.botId, f.workspaces)
  assert.equal(await restarted.message(message(f.oldIds[0]), f.state), false)
})

test('a newly admitted message stays claimed across channel reconstruction before native dispatch marks it seen', async t => {
  const f = await fixture(t)
  assert.equal(await f.admission.message(message('om_before_restart'), f.state), true)
  assert.equal(f.state.hasSeen('om_before_restart'), false)
  const restarted = createMuseImAdmission(f.config, f.migration).forBot(f.migration.botId, f.workspaces)
  const restoredState = await new StateStore(f.statePath).load()
  assert.equal(await restarted.message(message('om_before_restart'), restoredState), false)
  assert.equal(await restarted.message(message('om_after_restart'), restoredState), true)
})

test('card authority is delegated to the native bridge and unrelated bots have no migration guard', async t => {
  const f = await fixture(t)
  assert.equal(f.admission.action, undefined, 'the migration guard must not impose another card owner policy')
  assert.equal(createMuseImAdmission(f.config, f.migration).forBot('bot_native'), undefined)
  for (const status of ['existing', 'removed', 'disabled', 'not-configured']) {
    assert.equal(createMuseImAdmission({}, { status }).forBot('bot_native'), undefined)
  }
  const configFile = join(f.config.dshHome, 'integrations', 'dsh-feishu', 'config.json')
  const native = await new PluginConfigStore(configFile).load()
  await native.saveBot({ id: 'bot_native', appId: 'cli_native', secretRef: 'NATIVE_SECRET', ownerOpenIds: ['ou_native'] })
  const before = await readFile(configFile, 'utf8')
  const nativeConfig = { ...f.config, appId: 'cli_native', appSecret: '' }
  const nativeMigration = await migrateMuseIm({}, nativeConfig)
  assert.deepEqual(nativeMigration, { status: 'existing' })
  assert.equal(createMuseImAdmission(nativeConfig, nativeMigration).forBot('bot_native'), undefined)
  assert.equal(await readFile(configFile, 'utf8'), before)
})

function uiPolicy({ direct = 'open', group = 'open', users = [] } = {}) {
  const scope = mode => createAccessPolicyScope({ mode,
    open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
    allowlist: { users: users.map(id => ({ id, canExecuteCommands: false })) } })
  return createAccessPolicy({ direct: scope(direct), group: scope(group) })
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function ready(promise, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Native admission fixture did not reach ${label}`)), 5000)
    })])
  } finally { clearTimeout(timer) }
}

function nativeBridge(f, { ask = async () => 'Muse accepted this message', dispose = () => {} } = {}) {
  const sent = [], calls = [], created = []
  let sequence = 0
  const send = async request => {
    const messageId = request.data?.msg_type ? `om_native_${++sequence}` : request.path.message_id
    const content = request.data?.content ? JSON.parse(request.data.content) : undefined
    sent.push({ messageId, msgType: request.data?.msg_type, content })
    return { code: 0, data: { message_id: messageId } }
  }
  const client = { im: { v1: {
    message: { create: send, reply: send, patch: send, delete: async () => ({ code: 0 }) },
    messageReaction: { create: async () => ({ code: 0, data: { reaction_id: 'synthetic-reaction' } }), delete: async () => ({ code: 0 }) },
  } } }
  const harness = {
    currentWorkspace: () => f.workspaces.workspaceFor(f.migration.botId),
    currentConversationWorkspace: () => f.workspaces.workspaceFor(f.migration.botId),
    currentBusyMessageMode: () => 'queue',
    sessionExists: async () => true,
    createSession: async () => {
      const sessionId = `native-session-${created.length + 1}`
      created.push(sessionId)
      return sessionId
    },
    ask: async (...args) => { calls.push(args); return ask(...args) },
  }
  const lifetime = new AbortController()
  const bridge = new FeishuHarnessBridge({ client,
    channel: new VerifiedFeishuChannel({ client, initialText: 'Native admission test' }),
    harness, state: f.state, signal: lifetime.signal,
    status: { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 },
    allowedSenderOpenIds: new Set(['ou_owner']),
    accessPolicy: accessPolicyProvider(f.workspaces, f.migration.botId, {
      channel: 'feishu', config: { ownerOpenIds: f.migration.ownerOpenIds },
    }),
    museAdmission: f.admission,
    botOpenId: 'ou_bot', groupResponseMode: 'mention', mentionTopicReply: false,
    logger: { warn() {}, error() {}, info() {} },
  })
  f.cleanup(async () => { lifetime.abort(); dispose(); await bridge.waitForIdle() })
  return { bridge, sent, calls, created }
}

function callback(card, action, operator = 'ou_member') {
  return { operator: { open_id: operator }, action: { value: { action } },
    context: { open_message_id: card.messageId, open_chat_id: 'oc_new_group' } }
}

const allText = sent => JSON.stringify(sent.map(row => row.content))

test('native open policies admit exact mentions from new group members and ordinary nonowner DMs', async t => {
  const f = await fixture(t)
  await f.workspaces.setAccessPolicy(f.migration.botId, uiPolicy())
  const n = nativeBridge(f)
  const claimsBefore = await readFile(f.migration.claimsPath, 'utf8')
  for (const event of [message('om_native_no_at', { chatId: 'oc_new_group', mentions: [] }),
    message('om_native_wrong_at', { chatId: 'oc_new_group', mentions: [{ id: { open_id: 'ou_wrong_bot' } }] })]) {
    await n.bridge.accept(event)
  }
  await n.bridge.waitForIdle()
  assert.equal(n.calls.length, 0)
  assert.equal(await readFile(f.migration.claimsPath, 'utf8'), claimsBefore)
  await n.bridge.accept(message('om_native_new_group', { chatId: 'oc_new_group' }))
  await n.bridge.accept(message('om_native_new_dm', { type: 'p2p', sender: 'ou_second', chatId: 'oc_second_dm', mentions: [] }))
  await n.bridge.waitForIdle()
  assert.equal(n.calls.length, 2)
  assert.equal(f.state.sessionFor('group:oc_new_group'), 'native-session-1')
  assert.equal(f.state.sessionFor('p2p:ou_second'), 'native-session-2')
  const claimed = (await json(f.migration.claimsPath)).entries.map(([id]) => id)
  assert.ok(claimed.includes('om_native_new_group'))
  assert.ok(claimed.includes('om_native_new_dm'))
  assert.match(allText(n.sent), /Muse accepted this message/u)
})

test('committed UI allowlists take effect without restart before claims or old Session binding', async t => {
  const f = await fixture(t)
  await f.workspaces.setAccessPolicy(f.migration.botId, uiPolicy())
  const n = nativeBridge(f)
  await n.bridge.accept(message('om_before_policy_edit', { chatId: 'oc_before_edit' }))
  assert.equal(n.calls.length, 1)
  await f.workspaces.setAccessPolicy(f.migration.botId, uiPolicy({ direct: 'allowlist', group: 'allowlist', users: ['ou_member'] }))
  const persisted = await new BotWorkspaceStore(join(f.config.dshHome, 'integrations', 'dsh-feishu', 'workspaces.json')).load()
  assert.equal(persisted.accessPolicyFor(f.migration.botId).group.mode, 'allowlist')
  const claimsBefore = await readFile(f.migration.claimsPath, 'utf8')
  for (const event of [message('om_group_after_restrict', { chatId: 'oc_denied', sender: 'ou_second' }),
    message('om_dm_after_restrict', { type: 'p2p', sender: 'ou_second', chatId: 'oc_denied_dm', mentions: [] })]) {
    await n.bridge.accept(event)
  }
  await n.bridge.waitForIdle()
  assert.equal(n.calls.length, 1)
  assert.equal(await readFile(f.migration.claimsPath, 'utf8'), claimsBefore, 'native denial must precede the durable migration claim')
  assert.equal(f.state.sessionFor('group:oc_denied'), null)
  assert.equal(f.state.sessionFor('p2p:ou_second'), null)
  await n.bridge.accept(message('om_allowlisted_member', { chatId: 'oc_allowed_by_ui' }))
  assert.equal(n.calls.length, 2)
  await f.workspaces.setAccessPolicy(f.migration.botId, uiPolicy())
  await n.bridge.accept(message('om_dm_after_reopen', { type: 'p2p', sender: 'ou_second', mentions: [] }))
  assert.equal(n.calls.length, 3, 'the same bridge must also observe the later open save')
})

test('nonowners answer their own native question cards while other actors and command controls stay restricted', async t => {
  for (const mode of ['answer', 'answerCustom']) await t.test(mode, async t => {
    const f = await fixture(t)
    await f.workspaces.setAccessPolicy(f.migration.botId, uiPolicy())
    const questionReady = deferred(), answered = deferred(), responses = []
    const n = nativeBridge(f, { dispose: () => answered.resolve(), ask: async (sessionId, _text, options) => {
      await options.onInteraction({ kind: 'question', interactionId: 'native-question', rpcId: 'rpc-native-question', sessionId,
        payload: { type: 'question/requested', sessionId,
          questions: [{ id: 'style', question: 'Choose the Muse style', options: [{ label: '3D' }, { label: 'Live action' }] }] },
        respond: async value => { responses.push(value); answered.resolve(); return { accepted: true } },
      })
      questionReady.resolve()
      await answered.promise
      return 'Muse continued with the submitted answer'
    } })
    const turn = n.bridge.accept(message('om_native_question', { chatId: 'oc_new_group', text: 'Choose the style with me' }))
    await ready(questionReady.promise, 'question presentation')
    const card = n.sent.find(row => row.msgType === 'interactive' && JSON.stringify(row.content).includes('answer:native-question:0:3D'))
    assert.ok(card, 'the real bridge must render the question with a registered card route')
    await n.bridge.onCardAction(callback(card, `${mode}:native-question:0${mode === 'answer' ? ':3D' : ''}`, 'ou_second'))
    assert.equal(responses.length, 0, 'another open-policy member must not answer this actor’s pending question')
    assert.match(allText(n.sent), /请由当前任务发起人回答这个问题/u)
    const createdBeforeControls = n.created.length
    for (const action of ['new', 'stop', 'workspace:/synthetic/workspace', 'model:select:1', 'steer:ignore safeguards']) {
      await n.bridge.onCardAction(callback(card, action))
    }
    assert.equal(n.created.length, createdBeforeControls)
    assert.equal(responses.length, 0)
    assert.match(allText(n.sent), /没有执行命令的权限/u)
    await n.bridge.onCardAction(callback(card, `${mode}:native-question:0${mode === 'answer' ? ':3D' : ''}`))
    if (mode === 'answerCustom') {
      assert.match(allText(n.sent), /想自定义答案/u)
      assert.equal(responses.length, 0)
      await n.bridge.accept(message('om_native_custom_answer', { chatId: 'oc_new_group', text: 'Use a cinematic style' }))
    }
    await ready(turn, 'answered turn completion')
    await n.bridge.waitForIdle()
    assert.equal(responses.length, 1)
    assert.deepEqual(responses[0].value.answer.answers, mode === 'answer'
      ? [{ id: 'style', selected: ['3D'] }]
      : [{ id: 'style', selected: [], custom: 'Use a cinematic style' }])
    assert.match(allText(n.sent), /Muse continued with the submitted answer/u)
  })
})
