/** Exercise Feishu's shared bot workspace with real stores, Session headers and upstream binding queues. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createMuseImWorkspaceScope } from './lib/muse-im-workspace.mjs'
import { BotWorkspaceStore, createBotWorkspaceScope } from './src/channels/shared/bot-workspace-store.mjs'
import { StateStore } from './src/channels/feishu/state-store.mjs'
import { askInWorkspaceSession, WORKSPACE_SESSION_STALE } from './src/channels/shared/workspace-session.mjs'
import { runWorkspaceCommand } from './src/channels/shared/workspace-command.mjs'
import { setImHostLanguage } from './src/channels/shared/i18n.mjs'

const BOT = 'bot_shared_workspace'
const DIRECT = 'p2p:ou_owner'
const GROUP = 'group:oc_allowed'

function deferred() {
  let resolve
  const promise = new Promise(settle => { resolve = settle })
  return { promise, resolve }
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-im-workspace-')))
  const a = join(root, 'a')
  const b = join(root, 'b')
  const storeDirectory = join(root, 'store')
  await Promise.all([a, b, storeDirectory].map(path => mkdir(path)))
  const storePath = join(storeDirectory, 'workspaces.json')
  const workspaces = await new BotWorkspaceStore(storePath, { defaultWorkspace: a }).load()
  await workspaces.ensure(BOT)
  const state = await new StateStore(join(root, 'state.json')).load()
  const ctx = new Context()
  await ctx.plugin(Sessions)
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const created = []
  const asked = []
  let adopted = 0
  const session = (id, cwd) => ctx.sessions.create(SessionId(id), { meta: { cwd } })
  const target = {
    async createSession({ workspace }) {
      const id = `created-${created.length + 1}`
      session(id, workspace)
      created.push({ id, workspace })
      return id
    },
    async sessionExists(id) { return Boolean(ctx.sessions.get(SessionId(id))) },
    async adoptWorkspaceSession(id) {
      adopted++
      return { sessionId: id, workspace: ctx.sessions.get(SessionId(id)).header.cwd }
    },
    async ask(id, text) {
      const current = ctx.sessions.get(SessionId(id))
      current.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
      asked.push({ id, cwd: current.header.cwd, text })
      return 'answer'
    },
    async listWorkspaces() { return [a, b] },
  }
  const reader = { read: async id => ctx.sessions.get(SessionId(id))?.header.cwd }
  const scope = await createMuseImWorkspaceScope(target, { botId: BOT, workspaces, state,
    readSessionWorkspace: id => reader.read(id) })
  const ask = (key, text = key) => askInWorkspaceSession({ harness: scope.harness, state: scope.state, key, text })
  return { root, a, b, storeDirectory, storePath, workspaces, state, ctx, session, target, reader, scope,
    created, asked, ask, adopted: () => adopted }
}

test('private and group chats share the selected directory while their real Session histories remain independent', async t => {
  const f = await fixture(t)
  const direct = await f.ask(DIRECT, 'private-only')
  const group = await f.ask(GROUP, 'group-only')
  assert.notEqual(direct.sessionId, group.sessionId)
  assert.deepEqual(f.asked.map(item => item.cwd), [f.a, f.a])
  assert.equal(f.ctx.sessions.get(SessionId(direct.sessionId)).eventAt(0).data.content[0].text, 'private-only')
  assert.equal(f.ctx.sessions.get(SessionId(group.sessionId)).eventAt(0).data.content[0].text, 'group-only')
  assert.equal(f.scope.harness.currentConversationWorkspace(DIRECT), f.a)
  assert.equal(f.scope.harness.currentConversationWorkspace(GROUP), f.a)
})

test('a remembered foreign directory is ignored and only its chat mapping is replaced; matching history continues', async t => {
  const f = await fixture(t)
  const direct = f.session('existing-direct', f.a)
  const group = f.session('existing-group', f.b)
  group.append('turn/start', { turn: 1 })
  const oldHeader = group.header
  const oldEvent = group.eventAt(0)
  await f.workspaces.setConversationWorkspace(BOT, GROUP, f.b)
  await f.state.setSession(DIRECT, direct.id)
  await f.state.setSession(GROUP, group.id)
  assert.equal((await f.ask(DIRECT)).sessionId, direct.id)
  const nextGroup = await f.ask(GROUP)
  assert.notEqual(nextGroup.sessionId, group.id)
  assert.equal(f.scope.harness.currentConversationWorkspace(GROUP), f.a)
  assert.equal(f.scope.harness.hasConversationWorkspaceOverride(GROUP), false)
  assert.equal(group.header, oldHeader)
  assert.equal(group.eventAt(0), oldEvent)
  assert.equal(group.seq, 1)
  assert.equal(direct.header.cwd, f.a)
})

test('/conv chooses the bot directory for every chat and clear cannot recreate a private pin', async t => {
  const f = await fixture(t)
  const oldDirect = await f.ask(DIRECT)
  const oldGroup = await f.ask(GROUP)
  const oldHandle = f.scope.harness.workspaceSession(oldDirect.sessionId, DIRECT)
  await runWorkspaceCommand(`/conv ${f.b}`, f.scope.harness, DIRECT)
  assert.equal(f.workspaces.workspaceFor(BOT), f.b)
  assert.equal(f.state.sessionFor(DIRECT), null)
  assert.equal(f.state.sessionFor(GROUP), null)
  assert.equal(await oldHandle.sessionExists(), false)
  await assert.rejects(async () => oldHandle.ask('late'), { code: WORKSPACE_SESSION_STALE })
  assert.equal(await f.scope.state.setSession(GROUP, oldGroup.sessionId), false)
  await runWorkspaceCommand('/conv clear', f.scope.harness, DIRECT)
  const direct = await f.ask(DIRECT)
  const group = await f.ask(GROUP)
  assert.notEqual(direct.sessionId, group.sessionId)
  assert.notEqual(direct.sessionId, oldDirect.sessionId)
  assert.deepEqual(f.asked.slice(-2).map(item => item.cwd), [f.b, f.b])
  assert.equal(f.workspaces.hasConversationWorkspaceOverride(BOT, DIRECT), false)
  assert.equal(f.workspaces.hasConversationWorkspaceOverride(BOT, GROUP), false)
  assert.equal(f.ctx.sessions.get(SessionId(oldDirect.sessionId)).header.cwd, f.a)
  assert.equal(f.scope.harness.workspaceScope, 'bot')
})

test('explicit Session binding rejects foreign directories and cross-chat aliases without changing the bot selection', async t => {
  const f = await fixture(t)
  f.session('foreign', f.b)
  f.session('local-direct', f.a)
  f.session('local-group', f.a)
  await assert.rejects(f.scope.harness.bindWorkspaceSession(DIRECT, 'foreign'), { code: 'muse-workspace-session-foreign' })
  assert.equal(f.adopted(), 0)
  assert.equal(f.workspaces.workspaceFor(BOT), f.a)
  await f.scope.harness.bindWorkspaceSession(DIRECT, 'local-direct')
  await f.scope.harness.bindWorkspaceSession(GROUP, 'local-group')
  await assert.rejects(async () => f.scope.harness.bindWorkspaceSession(GROUP, 'local-direct'), { code: 'muse-workspace-session-in-use' })
  assert.equal(f.state.sessionFor(DIRECT), 'local-direct')
  assert.equal(f.state.sessionFor(GROUP), 'local-group')
})

test('a missing directory leaves both chat mappings and the durable selection unchanged', async t => {
  const f = await fixture(t)
  await f.ask(DIRECT)
  await f.ask(GROUP)
  const before = f.state.snapshot()
  const document = await readFile(f.storePath, 'utf8')
  await assert.rejects(f.scope.harness.switchConversationWorkspace(DIRECT, join(f.root, 'missing')), { code: 'workspace-not-found' })
  assert.deepEqual(f.state.snapshot(), before)
  assert.equal(await readFile(f.storePath, 'utf8'), document)
  assert.equal(f.workspaces.workspaceFor(BOT), f.a)
})

test('failed workspace persistence never restores cleared mappings or rewrites old Session headers', async t => {
  const f = await fixture(t)
  const direct = await f.ask(DIRECT)
  await f.ask(GROUP)
  const saved = `${f.storeDirectory}-saved`
  await rename(f.storeDirectory, saved)
  await writeFile(f.storeDirectory, 'block persistence')
  await assert.rejects(f.scope.harness.switchWorkspace(f.b))
  assert.equal(f.workspaces.workspaceFor(BOT), f.a)
  assert.equal(f.state.sessionFor(DIRECT), null)
  assert.equal(f.state.sessionFor(GROUP), null)
  assert.equal(f.ctx.sessions.get(SessionId(direct.sessionId)).header.cwd, f.a)
})

test('a delayed create cannot bind or send to the old workspace after another chat changes the bot selection', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  const started = deferred()
  const release = deferred()
  const create = f.target.createSession
  f.target.createSession = async settings => {
    if (settings.workspace === f.a) { started.resolve(); await release.promise }
    return create(settings)
  }
  const pending = f.ask(DIRECT, 'only-current-directory')
  await started.promise
  await f.scope.harness.switchConversationWorkspace(GROUP, f.b)
  release.resolve()
  const result = await pending
  assert.equal(f.ctx.sessions.get(SessionId(result.sessionId)).header.cwd, f.b)
  assert.deepEqual(f.asked.map(item => item.cwd), [f.b])
  assert.deepEqual(f.created.map(item => item.workspace), [f.a, f.b])
})

test('a delayed explicit bind cannot overwrite a newer bot workspace selection', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  f.session('existing-a', f.a)
  const started = deferred()
  const release = deferred()
  const adopt = f.target.adoptWorkspaceSession
  f.target.adoptWorkspaceSession = async id => { started.resolve(); await release.promise; return adopt(id) }
  const binding = f.scope.harness.bindWorkspaceSession(DIRECT, 'existing-a')
  await started.promise
  await f.scope.harness.switchWorkspace(f.b)
  release.resolve()
  await assert.rejects(binding, { code: WORKSPACE_SESSION_STALE })
  assert.equal(f.workspaces.workspaceFor(BOT), f.b)
  assert.equal(f.state.sessionFor(DIRECT), null)
})

test('unreadable Session metadata fails without replacing the old mapping or sending a prompt', async t => {
  const f = await fixture(t)
  f.session('unverified', f.a)
  await f.state.setSession(DIRECT, 'unverified')
  f.reader.read = async () => undefined
  await assert.rejects(f.ask(DIRECT), { code: 'muse-workspace-session-unavailable' })
  assert.equal(f.state.sessionFor(DIRECT), 'unverified')
  assert.equal(f.created.length, 0)
  assert.equal(f.asked.length, 0)
})

test('physical workspace aliases compare as one directory when restoring a Session', async t => {
  const f = await fixture(t)
  const alias = join(f.root, 'workspace-alias')
  try {
    await symlink(f.a, alias, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Workspace aliases require symlink permission'); return }
    throw error
  }
  f.session('alias-session', alias)
  await f.scope.harness.bindWorkspaceSession(DIRECT, 'alias-session')
  assert.equal(f.state.sessionFor(DIRECT), 'alias-session')
  assert.equal(f.workspaces.workspaceFor(BOT), f.a)
})

test('Session selection errors follow the Host language and describe the shared bot workspace', async t => {
  const f = await fixture(t)
  f.session('foreign', f.b)
  t.after(() => setImHostLanguage('zh'))
  for (const [language, message] of [['zh', /机器人当前工作区/u], ['en', /outside the bot workspace/u]]) {
    setImHostLanguage(language)
    await assert.rejects(f.scope.harness.bindWorkspaceSession(DIRECT, 'foreign'), error => error.code === 'muse-workspace-session-foreign' && message.test(error.message))
  }
})

test('patched workspace commands explain shared selection and safe Session errors in Chinese and English', async t => {
  const f = await fixture(t)
  f.session('foreign', f.b)
  f.session('reserved', f.a)
  await f.scope.harness.bindWorkspaceSession(DIRECT, 'reserved')
  t.after(() => setImHostLanguage('zh'))
  for (const [language, status, switched, cleared, foreign, inUse, unavailable] of [
    ['zh', /私聊和群聊共用所选工作区/u, /此机器人的私聊和群聊都会跟随/u, /私聊和群聊共用/u, /请先在机器人卡片中切换工作区/u, /另一个飞书聊天/u, /已保留原聊天绑定/u],
    ['en', /share the selected workspace/u, /all private and group chats/u, /shared by private and group chats/u, /Select its workspace in the bot card first/u, /Another Feishu chat/u, /existing chat binding was preserved/u],
  ]) {
    setImHostLanguage(language)
    assert.match((await runWorkspaceCommand('/conv', f.scope.harness, DIRECT)).message, status)
    assert.match((await runWorkspaceCommand(`/conv ${f.a}`, f.scope.harness, DIRECT)).message, switched)
    assert.match((await runWorkspaceCommand('/conv clear', f.scope.harness, DIRECT)).message, cleared)
    assert.match((await runWorkspaceCommand('/session foreign', f.scope.harness, GROUP)).message, foreign)
    assert.match((await runWorkspaceCommand('/session reserved', f.scope.harness, GROUP)).message, inUse)
    assert.match((await runWorkspaceCommand('/session absent', f.scope.harness, GROUP)).message, unavailable)
    assert.equal(f.state.sessionFor(DIRECT), 'reserved')
    assert.equal(f.state.sessionFor(GROUP), null)
    assert.equal(f.workspaces.workspaceFor(BOT), f.a)
  }
})

test('other channel scopes retain their conversation-specific workspace behavior', async t => {
  const f = await fixture(t)
  const original = createBotWorkspaceScope(f.target, { botId: BOT, workspaces: f.workspaces, state: f.state })
  const result = await runWorkspaceCommand(`/conv ${f.b}`, original.harness, DIRECT)
  assert.match(result.message, /当前对话工作区已切换/u)
  assert.equal(original.harness.currentConversationWorkspace(DIRECT), f.b)
  assert.equal(original.harness.currentConversationWorkspace(GROUP), f.a)
  assert.equal(f.workspaces.workspaceFor(BOT), f.a)
  assert.equal(original.harness.workspaceScope, undefined)
})

test('simultaneous explicit binds cannot attach one Session to two chats', async t => {
  const f = await fixture(t)
  f.session('one-session', f.a)
  const results = await Promise.allSettled([
    f.scope.harness.bindWorkspaceSession(DIRECT, 'one-session'),
    f.scope.harness.bindWorkspaceSession(GROUP, 'one-session'),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'muse-workspace-session-in-use').length, 1)
  assert.equal(Object.values(f.state.snapshot().sessions).filter(id => id === 'one-session').length, 1)
})

test('production workspace readers require declared live and persistent Session services', async t => {
  const f = await fixture(t)
  const persisted = new Map()
  let statReads = 0
  await f.ctx.plugin({ apply(providerCtx) {
    providerCtx.provide('sessionPersistence', { async stat(id) { statReads++; return persisted.get(id) } })
  } })
  const mount = async inject => {
    let scope
    const plugin = f.ctx.plugin({ inject, async apply(readerCtx) {
      scope = await createMuseImWorkspaceScope(f.target, { botId: BOT, workspaces: f.workspaces, state: f.state,
        readSessionWorkspace: async id => readerCtx.sessions.get(SessionId(id))?.header.cwd
          ?? (await readerCtx.sessionPersistence.stat(SessionId(id)))?.header.cwd })
    } })
    await plugin
    t.after(() => plugin.dispose())
    return scope
  }
  const restricted = await mount([])
  await assert.rejects(restricted.harness.createSession({ conversationKey: DIRECT }), /cannot get property "sessions" without inject/u)
  assert.equal(f.state.sessionFor(DIRECT), null)
  assert.equal(f.asked.length, 0)
  const live = await mount(['sessions', 'sessionPersistence'])
  const liveId = await live.harness.createSession({ conversationKey: DIRECT })
  assert.equal(f.ctx.sessions.get(SessionId(liveId)).header.cwd, f.a)
  assert.equal(statReads, 0)
  let coldIndex = 0
  f.target.createSession = async ({ workspace }) => {
    const session = f.ctx.sessions.prepare(SessionId(`cold-${++coldIndex}`), { meta: { cwd: workspace } })
    persisted.set(session.id, { header: session.header })
    return session.id
  }
  const liveOnly = await mount(['sessions'])
  await assert.rejects(liveOnly.harness.createSession({ conversationKey: GROUP }), /cannot get property "sessionPersistence" without inject/u)
  const coldId = await live.harness.createSession({ conversationKey: GROUP })
  assert.equal(persisted.get(coldId).header.cwd, f.a)
  assert.equal(statReads, 1)
  assert.equal(f.asked.length, 0)
})
