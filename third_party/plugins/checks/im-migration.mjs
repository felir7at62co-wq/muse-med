/** Exercise the packaged migration against real upstream stores and an isolated credential provider. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { migrateMuseIm, bindMuseImDirectSession, reconcileMuseImWorkspaces } from './lib/muse-im-migration.mjs'
import { PluginConfigStore } from './src/channels/feishu/plugin-config-store.mjs'
import { StateStore } from './src/channels/feishu/state-store.mjs'
import { BotWorkspaceStore } from './src/channels/shared/bot-workspace-store.mjs'
import { evaluateAccessPolicy } from './src/channels/shared/access-policy.mjs'

async function fixture(t, overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'muse-im-migration-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const config = { dshHome: home, appId: 'cli_synthetic', appSecret: 'synthetic-secret',
    registeredBy: 'ou_owner', allowFrom: ['ou_owner', 'oc_allowed'], defaultCwd: join(home, 'workspace'), ...overrides }
  const identity = createHash('sha256').update(JSON.stringify([config.appId, config.registeredBy])).digest('hex')
  const legacy = join(config.dataDir ?? join(home, 'feishu'), 'accounts', identity)
  const root = join(home, 'integrations', 'dsh-feishu')
  await mkdir(legacy, { recursive: true })
  const groupCwd = join(home, 'group-workspace')
  const directCwd = join(home, 'direct-workspace')
  await Promise.all([mkdir(groupCwd), mkdir(directCwd), mkdir(join(home, 'workspace'))])
  const map = { version: 2, entries: { oc_allowed: 'session-group', oc_direct: 'session-direct', oc_ambiguous: 'session-unknown' },
    cwds: { oc_allowed: groupCwd, oc_direct: directCwd } }
  const claims = { version: 1, entries: Array.from({ length: 1005 }, (_, index) => [`om_old_${index}`, 1700000000000 + index]) }
  await writeFile(join(legacy, 'session-map.json'), JSON.stringify(map))
  await writeFile(join(legacy, 'inbound-claims.json'), JSON.stringify(claims))
  const values = new Map()
  const sessionHeaders = new Map()
  let writes = 0
  let fail = false
  const ctx = { sessionPersistence: { stat: async id => sessionHeaders.has(id) ? { header: sessionHeaders.get(id) } : undefined },
    credentials: { resolve: async ref => values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined,
    set: async (ref, value) => { if (fail) throw new Error('synthetic credential storage unavailable'); writes++; values.set(ref, value) } } }
  const ports = { verifyApp: async () => ({ openId: 'ou_bot', name: 'Muse migrated bot' }) }
  return { home, root, config, legacy, map, claims, ctx, ports, values, writes: () => writes,
    fail: value => { fail = value }, groupCwd, directCwd, sessionHeaders }
}

const loadJson = async path => JSON.parse(await readFile(path, 'utf8'))

test('imports the same account, authorized groups, bot workspace and every durable claim', async t => {
  const f = await fixture(t, { registeredBy: '' })
  const originals = await Promise.all(['session-map.json', 'inbound-claims.json'].map(name => readFile(join(f.legacy, name), 'utf8')))
  const result = await migrateMuseIm(f.ctx, f.config, f.ports)
  assert.equal(result.status, 'migrated')
  assert.deepEqual(result.ownerOpenIds, ['ou_owner'])
  assert.deepEqual(result.allowedDirectIds, ['ou_owner'])
  assert.deepEqual(result.allowedChatIds, ['oc_allowed'])
  assert.equal(result.legacyMessageIds.length, 1005)
  assert.equal((await loadJson(result.claimsPath)).entries.length, 1005)
  const bot = (await new PluginConfigStore(join(f.root, 'config.json')).load()).getBot(result.botId)
  assert.equal(bot.appId, f.config.appId)
  assert.equal(bot.botOpenId, 'ou_bot')
  assert.equal(bot.botName, 'Muse migrated bot')
  assert.equal(bot.groupResponseMode, 'mention')
  assert.equal(bot.mentionTopicReply, false)
  assert.equal(bot.stepPush, true)
  assert.equal(bot.stepPushMode, 'streaming_card')
  assert.equal(f.values.get(bot.secretRef), f.config.appSecret)
  assert.doesNotMatch(await readFile(join(f.root, 'config.json'), 'utf8'), /synthetic-secret/)
  const state = await new StateStore(join(f.root, 'bots', result.botId, 'state.json')).load()
  assert.equal(state.sessionFor('group:oc_allowed'), 'session-group')
  assert.equal(state.sessionFor('p2p:ou_owner'), null, 'old oc_ alone cannot identify a DM peer')
  assert.equal(state.sessionFor('group:oc_ambiguous'), null)
  const workspace = await new BotWorkspaceStore(join(f.root, 'workspaces.json')).load()
  assert.equal(workspace.agentPresetFor(result.botId), 'short-drama')
  assert.equal(workspace.busyMessageModeFor(result.botId), 'steer')
  assert.equal(workspace.conversationWorkspaceFor(result.botId, 'group:oc_allowed'), f.config.defaultCwd)
  assert.equal(workspace.hasConversationWorkspaceOverride(result.botId, 'group:oc_allowed'), false)
  const policy = workspace.accessPolicyFor(result.botId)
  assert.equal(evaluateAccessPolicy(policy, { conversationType: 'group', senderIds: 'ou_member' }).allowed, true)
  assert.equal(evaluateAccessPolicy(policy, { conversationType: 'group', senderIds: 'ou_member', isCommand: true }).allowed, false)
  assert.equal(evaluateAccessPolicy(policy, { conversationType: 'group', senderIds: 'ou_owner', isCommand: true }).allowed, true)
  assert.equal(evaluateAccessPolicy(policy, { conversationType: 'direct', senderIds: 'ou_stranger' }).allowed, false)
  for (const file of [join(f.root, 'config.json'), join(f.root, 'workspaces.json'), result.claimsPath, result.markerPath]) {
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  }
  if (process.platform !== 'win32') assert.equal((await stat(f.root)).mode & 0o777, 0o700)
  assert.deepEqual(await Promise.all(['session-map.json', 'inbound-claims.json'].map(name => readFile(join(f.legacy, name), 'utf8'))), originals)
})

test('binds a proven private peer into active stores without replacing a different session', async t => {
  const f = await fixture(t)
  const result = await migrateMuseIm(f.ctx, f.config, f.ports)
  const state = await new StateStore(join(f.root, 'bots', result.botId, 'state.json')).load()
  const workspace = await new BotWorkspaceStore(join(f.root, 'workspaces.json')).load()
  assert.equal(await bindMuseImDirectSession(f.config, { chatId: 'oc_direct', senderOpenId: 'ou_owner' }, state, workspace), false,
    'a legacy private Session in another workspace must not override the selected bot workspace')
  assert.equal(state.sessionFor('p2p:ou_owner'), null)
  await workspace.setWorkspace(result.botId, f.directCwd)
  assert.equal(await bindMuseImDirectSession(f.config, { chatId: 'oc_direct', senderOpenId: 'ou_stranger' }, state, workspace), false)
  assert.equal(await bindMuseImDirectSession(f.config, { chatId: 'oc_absent', senderOpenId: 'ou_owner' }, state, workspace), false)
  assert.equal(await bindMuseImDirectSession(f.config, { chatId: 'oc_direct', senderOpenId: 'ou_owner' }, state, workspace), true)
  assert.equal(state.sessionFor('p2p:ou_owner'), 'session-direct')
  assert.equal(workspace.conversationWorkspaceFor(result.botId, 'p2p:ou_owner'), f.directCwd)
  assert.equal(workspace.hasConversationWorkspaceOverride(result.botId, 'p2p:ou_owner'), false)
  assert.equal((await new StateStore(join(f.root, 'bots', result.botId, 'state.json')).load()).sessionFor('p2p:ou_owner'), 'session-direct')
  assert.equal(await bindMuseImDirectSession(f.config, { chatId: 'oc_ambiguous', senderOpenId: 'ou_owner' }, state, workspace), false)
  assert.equal(state.sessionFor('p2p:ou_owner'), 'session-direct')
})

test('marked imports and native Feishu bots follow their selected workspace without deleting separate histories', async t => {
  const f = await fixture(t)
  const imported = await migrateMuseIm(f.ctx, f.config, f.ports)
  const configStore = await new PluginConfigStore(join(f.root, 'config.json')).load()
  await configStore.saveBot({ id: 'bot_native', appId: 'cli_native', secretRef: 'NATIVE_SECRET', ownerOpenIds: ['ou_native'] })
  const workspacePath = join(f.root, 'workspaces.json')
  const workspaces = await loadJson(workspacePath)
  workspaces.workspaces[imported.botId] = f.groupCwd
  workspaces.workspaces.bot_native = f.directCwd
  workspaces.workspaces.bot_other_channel = f.config.defaultCwd
  workspaces.conversationWorkspaces = {
    [imported.botId]: { 'p2p:ou_owner': f.config.defaultCwd, 'group:oc_allowed': f.groupCwd,
      'group:oc_orphan': f.directCwd, 'qq:unrelated': f.directCwd },
    bot_native: { 'p2p:ou_native': f.config.defaultCwd, 'group:oc_native_orphan': f.groupCwd },
    bot_other_channel: { 'p2p:unrelated': f.groupCwd },
  }
  await writeFile(workspacePath, JSON.stringify(workspaces, null, 4) + '\n')
  const statePath = join(f.root, 'bots', imported.botId, 'state.json')
  const state = await loadJson(statePath)
  state.sessions = { 'p2p:ou_owner': 'private-new-session', 'group:oc_allowed': 'group-new-session',
    'group:oc_unknown': 'unknown-new-session', 'group:oc_wrong_identity': 'wrong-id-session', 'qq:unrelated': 'other-channel-session' }
  state.watches = { 'p2p:ou_owner': [{ sessionId: 'private-new-session', chatId: 'oc_direct' }] }
  state.topics = { retained: 'topic-history' }
  state.mirrors = { 'private-new-session': { retained: true } }
  await writeFile(statePath, JSON.stringify(state, null, 4) + '\n')
  f.sessionHeaders.set('private-new-session', { id: 'private-new-session', cwd: f.config.defaultCwd })
  f.sessionHeaders.set('group-new-session', { id: 'group-new-session', cwd: f.groupCwd })
  f.sessionHeaders.set('wrong-id-session', { id: 'different-session', cwd: f.config.defaultCwd })
  const logDir = join(f.home, 'sessions')
  await mkdir(logDir)
  await writeFile(join(logDir, 'private-new-session.jsonl'), 'private history stays separate\n')
  await writeFile(join(logDir, 'group-new-session.jsonl'), 'group history stays separate\n')
  const originals = await Promise.all([workspacePath, statePath, imported.markerPath,
    join(f.root, 'config.json'), join(logDir, 'private-new-session.jsonl'), join(logDir, 'group-new-session.jsonl')].map(path => readFile(path)))
  const [first, second] = await Promise.all([
    reconcileMuseImWorkspaces(f.ctx, { dshHome: f.home }), reconcileMuseImWorkspaces(f.ctx, { dshHome: f.home }),
  ])
  assert.deepEqual(first.find(row => row.botId === imported.botId).removedOverrides,
    ['p2p:ou_owner', 'group:oc_allowed', 'group:oc_orphan'])
  assert.deepEqual(first.find(row => row.botId === imported.botId).detachedSessions, ['p2p:ou_owner'])
  assert.deepEqual(first.find(row => row.botId === 'bot_native').removedOverrides, ['p2p:ou_native', 'group:oc_native_orphan'])
  assert.equal(first.flatMap(row => row.backups).length, 3)
  assert.equal(second.flatMap(row => row.backups).length, 0)
  const afterWorkspace = await loadJson(workspacePath)
  const afterState = await loadJson(statePath)
  const expectedWorkspace = structuredClone(workspaces)
  expectedWorkspace.conversationWorkspaces[imported.botId] = { 'qq:unrelated': f.directCwd }
  delete expectedWorkspace.conversationWorkspaces.bot_native
  const expectedState = structuredClone(state)
  delete expectedState.sessions['p2p:ou_owner']
  assert.deepEqual(afterWorkspace, expectedWorkspace)
  assert.deepEqual(afterState, expectedState)
  const changed = first.find(row => row.botId === imported.botId)
  assert.deepEqual(await readFile(changed.backups[0]), originals[0])
  assert.deepEqual(await readFile(changed.backups[1]), originals[1])
  for (const path of first.flatMap(row => row.backups)) {
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
  }
  assert.deepEqual(await Promise.all([imported.markerPath, join(f.root, 'config.json'),
    join(logDir, 'private-new-session.jsonl'), join(logDir, 'group-new-session.jsonl')].map(path => readFile(path))), originals.slice(2))
  assert.equal((await migrateMuseIm(f.ctx, { ...f.config, appSecret: '' }, f.ports)).status, 'migrated')
})

test('workspace cleanup leaves routing untouched when Session metadata cannot be read', async t => {
  const f = await fixture(t)
  const imported = await migrateMuseIm(f.ctx, f.config, f.ports)
  const workspacePath = join(f.root, 'workspaces.json')
  const document = await loadJson(workspacePath)
  document.conversationWorkspaces = { [imported.botId]: { 'group:oc_allowed': f.groupCwd } }
  await writeFile(workspacePath, JSON.stringify(document) + '\n')
  const statePath = join(f.root, 'bots', imported.botId, 'state.json')
  const originals = await Promise.all([workspacePath, statePath].map(path => readFile(path)))
  f.ctx.sessionPersistence.stat = async () => { throw new Error('synthetic metadata read failure') }
  await assert.rejects(reconcileMuseImWorkspaces(f.ctx, { dshHome: f.home }), /metadata read failure/)
  assert.deepEqual(await Promise.all([workspacePath, statePath].map(path => readFile(path))), originals)
  assert.equal((await readdir(f.root)).some(name => name.includes('.muse-bot-workspace.')), false)
  assert.equal((await readdir(join(f.root, 'bots', imported.botId))).some(name => name.includes('.muse-bot-workspace.')), false)
})

test('concurrent and repeated migration does not overwrite native settings or resurrect a removed bot', async t => {
  const f = await fixture(t)
  const [first, second] = await Promise.all([migrateMuseIm(f.ctx, f.config, f.ports), migrateMuseIm(f.ctx, f.config, f.ports)])
  assert.equal(first.botId, second.botId)
  assert.equal(f.writes(), 1)
  const configStore = await new PluginConfigStore(join(f.root, 'config.json')).load()
  const bot = configStore.getBot(first.botId)
  await configStore.saveBot({ ...bot, stepPush: false, botName: 'User choice' })
  const before = await readFile(join(f.root, 'config.json'), 'utf8')
  await migrateMuseIm(f.ctx, f.config, f.ports)
  assert.equal(await readFile(join(f.root, 'config.json'), 'utf8'), before)
  await configStore.removeBot(first.botId)
  assert.equal((await migrateMuseIm(f.ctx, f.config, f.ports)).status, 'removed')
  assert.equal((await new PluginConfigStore(join(f.root, 'config.json')).load()).list().length, 0)
})

test('a pre-existing native bot is left untouched, including its credential and workspace', async t => {
  const f = await fixture(t)
  const store = await new PluginConfigStore(join(f.root, 'config.json')).load()
  await store.saveBot({ id: 'bot_native', appId: f.config.appId, secretRef: 'NATIVE_SECRET', ownerOpenIds: ['ou_native'], stepPush: false })
  f.values.set('NATIVE_SECRET', 'native-value')
  const before = await readFile(join(f.root, 'config.json'), 'utf8')
  assert.deepEqual(await migrateMuseIm(f.ctx, { ...f.config, appSecret: '' }, f.ports), { status: 'existing' })
  assert.equal(f.writes(), 0)
  assert.equal(await readFile(join(f.root, 'config.json'), 'utf8'), before)
  assert.equal(f.values.get('NATIVE_SECRET'), 'native-value')
})

test('missing owners, damaged source data, and unverified bot identity never activate a new bot', async t => {
  for (const failure of ['owner', 'map', 'duplicate-session', 'claims', 'verification', 'empty-bot-id', 'relative-path']) {
    const f = await fixture(t, failure === 'owner' ? { registeredBy: '', allowFrom: ['oc_allowed'] }
      : failure === 'relative-path' ? { defaultCwd: 'relative-workspace' } : {})
    if (failure === 'map') await writeFile(join(f.legacy, 'session-map.json'), '{bad json with secret')
    if (failure === 'duplicate-session') await writeFile(join(f.legacy, 'session-map.json'), JSON.stringify({ version: 2, entries: { oc_one: 'same-session', oc_two: 'same-session' } }))
    if (failure === 'claims') await writeFile(join(f.legacy, 'inbound-claims.json'), JSON.stringify({ version: 1, entries: [['duplicate', 1], ['duplicate', 2]] }))
    const ports = failure === 'verification' ? { verifyApp: async () => { throw new Error('synthetic-secret') } }
      : failure === 'empty-bot-id' ? { verifyApp: async () => ({ openId: null }) } : f.ports
    await assert.rejects(migrateMuseIm(f.ctx, f.config, ports), error => !error.message.includes('synthetic-secret'))
    assert.equal(f.writes(), 0)
    assert.equal((await new PluginConfigStore(join(f.root, 'config.json')).load()).list().length, 0)
  }
})

test('credential failure leaves a recoverable closed migration and retries without changing old files', async t => {
  const f = await fixture(t)
  f.fail(true)
  await assert.rejects(migrateMuseIm(f.ctx, f.config, f.ports), /credential storage/)
  assert.equal((await new PluginConfigStore(join(f.root, 'config.json')).load()).list().length, 0)
  f.fail(false)
  const result = await migrateMuseIm(f.ctx, f.config, f.ports)
  assert.equal(result.status, 'migrated')
  assert.equal((await loadJson(result.markerPath)).phase, 'complete')
  assert.equal(f.writes(), 1)
})

test('a conflicting existing credential is never overwritten or activated', async t => {
  const f = await fixture(t)
  const identity = createHash('sha256').update(JSON.stringify([f.config.appId, f.config.registeredBy])).digest('hex')
  const ref = `MUSE_IM_FEISHU_APP_SECRET_${identity.toUpperCase()}`
  f.values.set(ref, 'different-existing-value')
  await assert.rejects(migrateMuseIm(f.ctx, f.config, f.ports), /will not replace/)
  assert.equal(f.values.get(ref), 'different-existing-value')
  assert.equal(f.writes(), 0)
  assert.equal((await new PluginConfigStore(join(f.root, 'config.json')).load()).list().length, 0)
})

test('a partial destination write remains closed and resumes without a second credential write', async t => {
  const f = await fixture(t)
  const ports = { verifyApp: async () => {
    await mkdir(f.root, { recursive: true })
    await writeFile(join(f.root, 'bots'), 'synthetic destination failure')
    return { openId: 'ou_bot' }
  } }
  await assert.rejects(migrateMuseIm(f.ctx, f.config, ports))
  assert.equal(f.writes(), 1)
  assert.equal((await new PluginConfigStore(join(f.root, 'config.json')).load()).list().length, 0)
  await rm(join(f.root, 'bots'))
  const result = await migrateMuseIm(f.ctx, f.config, f.ports)
  assert.equal(result.status, 'migrated')
  assert.equal(f.writes(), 1)
  assert.equal((await loadJson(result.claimsPath)).entries.length, 1005)
})

test('revoking a group during an incomplete migration never reuses its previous admission policy', async t => {
  const f = await fixture(t)
  f.fail(true)
  await assert.rejects(migrateMuseIm(f.ctx, f.config, f.ports))
  f.fail(false)
  await assert.rejects(migrateMuseIm(f.ctx, { ...f.config, allowFrom: ['ou_owner'] }, f.ports), /access changed/)
  assert.equal(f.writes(), 0)
  assert.equal((await new PluginConfigStore(join(f.root, 'config.json')).load()).list().length, 0)
})

test('the old disabled toggle skips initial import but does not discard a completed native migration', async t => {
  const f = await fixture(t)
  assert.deepEqual(await migrateMuseIm(f.ctx, { ...f.config, enabled: false, appSecret: '' }, f.ports), { status: 'disabled' })
  assert.equal(f.writes(), 0)
  assert.equal((await new PluginConfigStore(join(f.root, 'config.json')).load()).list().length, 0)
  const imported = await migrateMuseIm(f.ctx, { ...f.config, enabled: true }, f.ports)
  const restored = await migrateMuseIm(f.ctx, { ...f.config, enabled: false, appSecret: '' }, f.ports)
  assert.equal(restored.status, 'migrated')
  assert.equal(restored.botId, imported.botId)
  assert.deepEqual(restored.allowedChatIds, ['oc_allowed'])
  assert.equal(restored.legacyMessageIds.length, 1005)
})
