/** Native Feishu routing uses one named Muse Bot per chat and no real provider or platform. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMuseImTeamScope } from './lib/muse-im-team.mjs'
import { createMuseImWorkspaceScope } from './lib/muse-im-workspace.mjs'
import { StateStore } from './src/channels/feishu/state-store.mjs'
import { BotWorkspaceStore } from './src/channels/shared/bot-workspace-store.mjs'
import { FeishuHarnessBridge } from './src/channels/feishu/bridge.mjs'
import { VerifiedFeishuChannel } from './src/channels/feishu/feishu-channel.mjs'
import { askInWorkspaceSession } from './src/channels/shared/workspace-session.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-im-team-')))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const lifetimes = []
  t.after(async () => { for (const cleanup of lifetimes.reverse()) await cleanup(); await rm(root, { recursive: true, force: true }) })
  const statePath = join(root, 'state.json')
  const workspacePath = join(root, 'workspaces.json')
  const sessions = new Map()
  const created = [], asked = [], registered = [], switched = [], nameHints = [], lookups = []
  const bots = new Map()
  const service = {
    async registerSessionAsBot(id, options = {}) {
      assert.ok(sessions.has(id))
      if (!bots.has(id)) { bots.set(id, { sessionId: id }); registered.push(id) }
      if (options.nameHint !== undefined) { nameHints.push({ id, nameHint: options.nameHint }); bots.get(id).channelName = options.nameHint }
      return { botId: id, sessionId: bots.get(id).sessionId }
    },
    async resolveCurrentSession(id) {
      const bot = bots.get(id)
      if (!bot) throw new Error('Unknown Muse Bot')
      return { botId: id, sessionId: bot.sessionId }
    },
    async switchCurrentSession(id, sessionId) {
      assert.ok(sessions.has(sessionId))
      const bot = bots.get(id)
      assert.ok(bot)
      switched.push([id, bot.sessionId, sessionId])
      bot.sessionId = sessionId
      return { botId: id, sessionId }
    },
  }
  const harness = {
    async createSession({ workspace: cwd }) {
      const id = `native-${created.length + 1}`
      sessions.set(id, { cwd, model: 'unchanged-model', effort: 'max', goal: 'native-goal', preset: 'short-drama' })
      created.push(id)
      return id
    },
    async sessionExists(id) { return sessions.has(id) },
    async adoptWorkspaceSession(id) { return { sessionId: id, workspace: sessions.get(id)?.cwd } },
    async ask(id, text, options) { asked.push({ id, text, options }); return 'Native Muse answer' },
  }
  const make = async ({ imBotId = 'registered_bot', appId = 'cli_synthetic', legacyAdmission, getTeam = () => service, chatLookup, messageLookup } = {}) => {
    const state = await new StateStore(statePath).load()
    const workspaces = await new BotWorkspaceStore(workspacePath, { defaultWorkspace: workspace }).load()
    await workspaces.ensure(imBotId)
    const native = await createMuseImWorkspaceScope(harness, { botId: imBotId, workspaces, state,
      readSessionWorkspace: async id => sessions.get(id)?.cwd })
    const scope = createMuseImTeamScope(native, { imBotId, appId, dshHome: root, getTeam,
      retentionMs: 24 * 60 * 60 * 1000, maxEntries: 1000, legacyAdmission })
    const sent = []
    const send = async request => {
      sent.push(request)
      return { code: 0, data: { message_id: request.path?.message_id ?? `reply-${sent.length}` } }
    }
    const client = { im: { v1: {
      message: { create: send, reply: send, patch: send, delete: async () => ({ code: 0 }),
        ...(messageLookup ? { get: async request => { lookups.push({ appId, type: 'message', request }); return messageLookup(request) } } : {}) },
      ...(chatLookup ? { chat: { get: async request => { lookups.push({ appId, type: 'chat', request }); return chatLookup(request) } } } : {}),
      messageReaction: { create: async () => ({ code: 0, data: { reaction_id: 'reaction' } }), delete: async () => ({ code: 0 }) },
    } } }
    const lifetime = new AbortController()
    const bridge = new FeishuHarnessBridge({ client, channel: new VerifiedFeishuChannel({ client, initialText: 'Starting native test' }),
      harness: scope.harness, state: scope.state, museAdmission: scope.admission, signal: lifetime.signal,
      status: { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 },
      allowedSenderOpenIds: new Set(['ou_owner']), botOpenId: 'ou_bot', groupResponseMode: 'mention', mentionTopicReply: false,
      logger: { error() {}, warn() {}, info() {} },
    })
    lifetimes.push(async () => { lifetime.abort(); await bridge.waitForIdle() })
    return { scope, state, workspaces, bridge, sent, stop: async () => { lifetime.abort(); await bridge.waitForIdle() } }
  }
  return { root, workspace, statePath, sessions, created, asked, registered, switched, nameHints, lookups, bots, service, make }
}

function message(id, { chat = 'oc_group', thread, text = 'hello Muse', mentions = [{ id: { open_id: 'ou_bot' } }] } = {}) {
  return { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: {
    message_id: id, chat_id: chat, chat_type: 'group', message_type: 'text', content: JSON.stringify({ text }), mentions,
    ...(thread ? { thread_id: thread, root_id: 'om_root' } : {}),
  } }
}

function direct(id, { peer = 'ou_owner', name, text = 'hello privately', chat = 'oc_private' } = {}) {
  return { sender: { sender_type: 'user', sender_id: { open_id: peer }, ...(name ? { sender_name: name } : {}) }, message: {
    message_id: id, chat_id: chat, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }),
  } }
}

async function accept(instance, event) { await instance.bridge.accept(event); await instance.bridge.waitForIdle() }
const json = async file => JSON.parse(await readFile(file, 'utf8'))

test('an existing group registers its exact Session without creating or changing model, effort, goal or preset', async t => {
  const f = await fixture(t)
  const n = await f.make()
  const original = { cwd: f.workspace, model: 'original-model', effort: 'high', goal: 'original-goal', preset: 'original-preset' }
  f.sessions.set('original-session', original)
  await n.state.setSession('group:oc_group', 'original-session')
  await accept(n, message('om_original'))
  assert.deepEqual(f.created, [])
  assert.deepEqual(f.registered, ['original-session'])
  assert.equal(f.asked[0].id, 'original-session')
  assert.deepEqual(f.sessions.get('original-session'), original)
  const ledger = await json(n.scope.bindingPath)
  assert.equal(ledger.bindings.oc_group.originalSessionId, 'original-session')
})

test('new groups get independent Bots; thread replies reuse the same Bot and keep reply_in_thread', async t => {
  const f = await fixture(t)
  const n = await f.make()
  await accept(n, message('om_first'))
  await accept(n, message('om_thread_a', { thread: 'omt_a' }))
  await accept(n, message('om_thread_b', { thread: 'omt_b' }))
  await accept(n, message('om_second_group', { chat: 'oc_second' }))
  assert.deepEqual(f.created, ['native-1', 'native-2'])
  assert.deepEqual(f.registered, ['native-1', 'native-2'])
  assert.deepEqual(f.asked.map(row => row.id), ['native-1', 'native-1', 'native-1', 'native-2'])
  assert.equal(n.state.sessionFor('group:oc_group:thread:omt_a'), null)
  assert.ok(n.sent.some(row => row.path?.message_id === 'om_thread_a' && row.data?.reply_in_thread === true))
})

test('restart and duplicate platform delivery do not create another Bot or dispatch the message twice', async t => {
  const f = await fixture(t)
  const first = await f.make()
  await accept(first, message('om_repeated', { thread: 'omt_a' }))
  await first.stop()
  const restarted = await f.make()
  assert.equal(restarted.scope.admission.replyInThreadFor('om_repeated'), true)
  await accept(restarted, message('om_repeated', { thread: 'omt_b' }))
  await accept(restarted, message('om_after_restart', { thread: 'omt_b' }))
  assert.equal(f.created.length, 1)
  assert.equal(f.registered.length, 1)
  assert.equal(f.asked.length, 2)
  assert.equal(f.asked[1].id, f.asked[0].id)
})

test('a Bot current Session change resolves back into the existing group before dispatch', async t => {
  const f = await fixture(t)
  const n = await f.make()
  await accept(n, message('om_first'))
  f.sessions.set('next-session', { cwd: f.workspace, model: 'new-model', goal: 'new-goal' })
  f.bots.get('native-1').sessionId = 'next-session'
  await accept(n, message('om_after_move'))
  assert.equal(f.asked[1].id, 'next-session')
  assert.equal(n.state.sessionFor('group:oc_group'), 'next-session')
  assert.equal(f.registered.length, 1)
})

test('explicit new and use keep one Bot identity while Native IM retains Session creation and binding', async t => {
  const f = await fixture(t)
  const n = await f.make()
  await accept(n, message('om_initial'))
  await accept(n, message('om_new_command', { text: '/new' }))
  assert.equal(n.state.sessionFor('group:oc_group'), null)
  await n.stop()
  const restarted = await f.make()
  await accept(restarted, message('om_new_after_restart'))
  assert.equal(f.registered.length, 1)
  assert.deepEqual(f.switched[0], ['native-1', 'native-1', 'native-2'])
  f.sessions.set('user-selected-session', { cwd: f.workspace, model: 'selected-model', goal: 'selected-goal' })
  await restarted.scope.harness.bindWorkspaceSession('group:oc_group', 'user-selected-session')
  await accept(restarted, message('om_after_use'))
  assert.equal(f.asked.at(-1).id, 'user-selected-session')
  assert.equal((await json(restarted.scope.bindingPath)).bindings.oc_group.botId, 'native-1')
  assert.equal(f.registered.length, 1)
  assert.equal(f.sessions.get('native-1').goal, 'native-goal')
})

test('native denial precedes claims and team registration; distinct app identities keep separate routes', async t => {
  const f = await fixture(t)
  const n = await f.make()
  await accept(n, message('om_not_addressed', { mentions: [] }))
  assert.equal(f.asked.length, 0)
  assert.equal(f.registered.length, 0)
  await accept(n, message('om_app_message'))
  await n.stop()
  const other = await f.make({ imBotId: 'other_registered_bot', appId: 'cli_other' })
  assert.notEqual(other.scope.bindingPath, n.scope.bindingPath)
  assert.equal(await other.scope.admission.message(message('om_app_message'), other.scope.state), true)
})

test('unavailable Muse Bot and foreign current workspaces never create a replacement or send a prompt', async t => {
  const f = await fixture(t)
  const n = await f.make()
  await accept(n, message('om_original'))
  f.sessions.set('foreign-session', { cwd: join(f.root, 'foreign') })
  f.bots.get('native-1').sessionId = 'foreign-session'
  await assert.rejects(() => n.scope.admission.message(message('om_foreign'), n.scope.state), /workspace|Session/u)
  assert.equal(f.asked.length, 1)
  assert.equal(f.created.length, 1)
  const missing = await f.make({ getTeam: () => undefined })
  await assert.rejects(() => missing.scope.admission.message(message('om_missing'), missing.scope.state), /not available/u)
  assert.equal(f.created.length, 1)
})


test('a native workspace change retains the original Session and switches the same group Bot on next use', async t => {
  const f = await fixture(t)
  const n = await f.make()
  await accept(n, message('om_original_workspace'))
  const nextWorkspace = join(f.root, 'next-workspace')
  await mkdir(nextWorkspace)
  await n.workspaces.setWorkspace('registered_bot', nextWorkspace)
  await accept(n, message('om_after_workspace'))
  assert.equal(f.created.length, 2)
  assert.equal(f.registered.length, 1)
  assert.equal(f.asked.at(-1).id, 'native-2')
  assert.equal(f.sessions.get('native-1').cwd, f.workspace)
  assert.equal(f.sessions.get('native-2').cwd, nextWorkspace)
  assert.equal((await json(n.scope.bindingPath)).bindings.oc_group.botId, 'native-1')
})

test('retained old topic bindings remain separate receipts while new thread messages follow the group Bot', async t => {
  const f = await fixture(t)
  const n = await f.make()
  f.sessions.set('old-topic-session', { cwd: f.workspace, model: 'original-topic-model', goal: 'old-topic-goal' })
  await n.state.setSession('group:oc_group:thread:omt_historical', 'old-topic-session')
  await accept(n, message('om_group_first'))
  await accept(n, message('om_new_thread', { thread: 'omt_historical' }))
  assert.equal(f.asked[0].id, f.asked[1].id)
  assert.equal(n.scope.state.sessionFor('group:oc_group:thread:omt_historical'), 'old-topic-session')
  assert.equal(f.sessions.get('old-topic-session').goal, 'old-topic-goal')
})


test('a definite pre-dispatch routing failure does not consume the message receipt before a safe retry', async t => {
  const f = await fixture(t)
  const n = await f.make()
  await accept(n, message('om_first'))
  f.sessions.set('foreign-current', { cwd: join(f.root, 'foreign') })
  f.bots.get('native-1').sessionId = 'foreign-current'
  await assert.rejects(() => n.scope.admission.message(message('om_retry_same_id'), n.scope.state), /workspace|Session/u)
  await n.stop()
  f.bots.get('native-1').sessionId = 'native-1'
  const restored = await f.make()
  await accept(restored, message('om_retry_same_id'))
  assert.equal(f.asked.length, 2)
  await accept(restored, message('om_retry_same_id'))
  assert.equal(f.asked.length, 2)
})

test('group names come from the authenticated chat API once and stay cached across threads and restart', async t => {
  const f = await fixture(t)
  const chatLookup = async () => ({ code: 0, data: { name: '编剧组' } })
  const first = await f.make({ chatLookup })
  await accept(first, message('om_named_group'))
  await accept(first, message('om_named_thread', { thread: 'omt_named' }))
  await accept(first, message('om_other_named_group', { chat: 'oc_other' }))
  assert.deepEqual(f.nameHints, [{ id: 'native-1', nameHint: '编剧组' }, { id: 'native-2', nameHint: '编剧组' }])
  assert.equal(f.registered.length, 2, 'matching labels never merge different chat identities')
  assert.deepEqual(f.lookups.map(row => row.request), [{ path: { chat_id: 'oc_group' } }, { path: { chat_id: 'oc_other' } }])
  await first.stop()
  const restarted = await f.make({ chatLookup: async () => { throw new Error('cached names must not trigger another read') } })
  await accept(restarted, message('om_named_after_restart'))
  assert.equal(f.lookups.length, 2)
  assert.equal(f.nameHints.length, 2)
  assert.equal((await json(restarted.scope.bindingPath)).chats.oc_group.name, '编剧组')
})

test('a named private chat registers its original Session and keeps one Bot through new and use', async t => {
  const f = await fixture(t)
  const n = await f.make({ messageLookup: async () => { throw new Error('an event name needs no message lookup') } })
  const original = { cwd: f.workspace, model: 'private-model', effort: 'high', goal: 'private-goal', preset: 'original-preset' }
  f.sessions.set('private-original', original)
  await n.state.setSession('p2p:ou_owner', 'private-original')
  await accept(n, direct('om_named_private', { name: '小林' }))
  assert.deepEqual(f.created, [])
  assert.deepEqual(f.nameHints, [{ id: 'private-original', nameHint: '小林' }])
  assert.deepEqual(f.sessions.get('private-original'), original)
  assert.equal(f.lookups.length, 0)
  await accept(n, direct('om_private_new', { text: '/new' }))
  await accept(n, direct('om_private_next'))
  assert.equal(f.registered.length, 1)
  assert.deepEqual(f.switched[0], ['private-original', 'private-original', 'native-1'])
  f.sessions.set('private-selected', { cwd: f.workspace, goal: 'selected-goal' })
  await n.scope.harness.bindWorkspaceSession('p2p:ou_owner', 'private-selected')
  await accept(n, direct('om_private_selected'))
  assert.equal(f.asked.at(-1).id, 'private-selected')
  const ledger = await json(n.scope.bindingPath)
  assert.equal(ledger.bindings.oc_private.botId, 'private-original')
  assert.equal(ledger.chats.oc_private.key, 'p2p:ou_owner')
  assert.equal(f.sessions.get('private-original').goal, 'private-goal')
})

test('private name lookup verifies the exact original message, chat and sender without directory APIs', async t => {
  const f = await fixture(t)
  const n = await f.make({ messageLookup: async request => ({ code: 0, data: { items: [{
    message_id: request.path.message_id, chat_id: 'oc_private',
    sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_owner', sender_name: '王编辑' },
  }] } }) })
  await accept(n, direct('om_private_lookup'))
  await accept(n, direct('om_private_cached'))
  assert.deepEqual(f.nameHints, [{ id: 'native-1', nameHint: '王编辑' }])
  assert.equal(f.lookups.length, 1)
  assert.deepEqual(f.lookups[0].request, { path: { message_id: 'om_private_lookup' }, params: { with_sender_name: true } })
  await accept(n, direct('om_invalid_private_name', { chat: 'oc_foreign', peer: 'ou_foreign' }))
  assert.equal(f.nameHints.length, 1, 'a mismatched source cannot name another private chat')
})

test('unavailable metadata keeps the Session title, retries only after restart and accepts later event names', async t => {
  const f = await fixture(t)
  const n = await f.make({ chatLookup: async () => ({ code: 99991672 }), messageLookup: async () => { throw new Error('synthetic permission denial') } })
  await accept(n, message('om_metadata_denied', { mentions: [] }))
  assert.equal(f.lookups.length, 0, 'native access runs before optional metadata reads')
  await accept(n, message('om_metadata_first'))
  await accept(n, message('om_metadata_no_repeat'))
  await accept(n, direct('om_private_missing_name'))
  await accept(n, direct('om_private_later_name', { name: '李老师' }))
  assert.equal(f.lookups.filter(row => row.type === 'chat').length, 1)
  assert.equal(f.lookups.filter(row => row.type === 'message').length, 1)
  assert.deepEqual(f.nameHints, [{ id: 'native-2', nameHint: '李老师' }])
  assert.equal(f.asked.length, 4)
  await n.stop()
  const restarted = await f.make({ chatLookup: async () => ({ code: 0, data: { name: '恢复可读的群名' } }) })
  await accept(restarted, message('om_metadata_retry'))
  assert.equal(f.lookups.filter(row => row.type === 'chat').length, 2)
  assert.deepEqual(f.nameHints.at(-1), { id: 'native-1', nameHint: '恢复可读的群名' })
  assert.equal(f.registered.length, 2, 'metadata recovery never creates a replacement Bot')
})

test('existing version-one group bindings without chat metadata are extended in place after restart', async t => {
  const f = await fixture(t)
  const n = await f.make()
  await accept(n, message('om_before_metadata_upgrade'))
  const old = await json(n.scope.bindingPath)
  delete old.chats
  await writeFile(n.scope.bindingPath, `${JSON.stringify(old)}\n`)
  await n.stop()
  const restarted = await f.make({ chatLookup: async () => ({ code: 0, data: { name: '原群名称' } }) })
  await accept(restarted, message('om_after_metadata_upgrade'))
  const upgraded = await json(restarted.scope.bindingPath)
  assert.equal(upgraded.version, 1)
  assert.deepEqual(upgraded.bindings, old.bindings)
  assert.deepEqual(upgraded.replies.om_before_metadata_upgrade, old.replies.om_before_metadata_upgrade)
  assert.equal(upgraded.chats.oc_group.key, 'group:oc_group')
  assert.equal(f.created.length, 1)
  assert.equal(f.registered.length, 1)
  assert.deepEqual(f.nameHints, [{ id: 'native-1', nameHint: '原群名称' }])
})

test('an old private Session prepares before claims so a failed restore can retry the same message', async t => {
  const f = await fixture(t)
  let restoreReady = false
  f.sessions.set('imported-private', { cwd: f.workspace, model: 'original-model', goal: 'original-goal' })
  const n = await f.make({ legacyAdmission: {
    allowed: () => true,
    async prepare(event, state) {
      if (!restoreReady) throw new Error('synthetic original Session temporarily unavailable')
      await state.setSession('p2p:ou_owner', 'imported-private')
    },
    message: async () => true,
  } })
  const event = direct('om_restore_then_claim', { name: '原编辑' })
  await assert.rejects(() => n.scope.admission.message(event, n.scope.state), /temporarily unavailable/u)
  assert.equal(f.registered.length, 0)
  assert.equal(n.state.hasSeen(event.message.message_id), false)
  restoreReady = true
  await accept(n, event)
  await accept(n, event)
  assert.deepEqual(f.created, [])
  assert.deepEqual(f.registered, ['imported-private'])
  assert.equal(f.asked.length, 1)
  assert.equal(f.asked[0].id, 'imported-private')
  assert.equal(f.sessions.get('imported-private').goal, 'original-goal')
})
