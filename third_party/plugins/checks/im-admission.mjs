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

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'muse-im-admission-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const config = { enabled: true, dshHome: home, appId: 'cli_synthetic', appSecret: 'synthetic-secret',
    registeredBy: 'ou_owner', allowFrom: ['ou_owner', 'oc_allowed'], defaultCwd: join(home, 'workspace'),
    inboundClaimRetentionMs: 24 * 60 * 60 * 1000, inboundClaimMaxEntries: 2000 }
  const identity = createHash('sha256').update(JSON.stringify([config.appId, config.registeredBy])).digest('hex')
  const legacy = join(home, 'feishu', 'accounts', identity)
  const directCwd = join(home, 'old-direct-workspace')
  await Promise.all([mkdir(legacy, { recursive: true }), mkdir(directCwd)])
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
  return { config, migration, state, statePath, workspaces, admission, oldIds, legacy, directCwd }
}

function message(id, { chatId = 'oc_allowed', sender = 'ou_member', type = 'group', mentions = [{ id: { open_id: 'ou_bot' } }] } = {}) {
  return { sender: { sender_id: { open_id: sender }, sender_type: 'user' },
    message: { message_id: id, chat_id: chatId, chat_type: type, mentions, message_type: 'text', content: '{"text":"hello"}' } }
}

const json = async path => JSON.parse(await readFile(path, 'utf8'))

test('members of an old allowed group still require the exact bot mention and durably claim the id', async t => {
  const f = await fixture(t)
  const stateBefore = f.state.snapshot()
  const claimsBefore = await readFile(f.migration.claimsPath, 'utf8')
  const rejected = [
    message('om_no_at', { mentions: [] }),
    message('om_wrong_at', { mentions: [{ id: { open_id: 'ou_other_bot' } }] }),
    message('om_unknown_group', { chatId: 'oc_unlisted' }),
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

test('only a registered owner with the exact bot mention may enter a new group without extending its stored allowlist', async t => {
  const f = await fixture(t)
  const stateBefore = f.state.snapshot()
  const markerBefore = await readFile(f.migration.markerPath)
  const claimsBefore = await readFile(f.migration.claimsPath)
  const rejected = [
    message('om_stranger_new_group', { chatId: 'oc_new_one', sender: 'ou_stranger' }),
    message('om_old_group_member_new_group', { chatId: 'oc_new_two', sender: 'ou_member' }),
    message('om_owner_new_group_no_at', { chatId: 'oc_new_one', sender: 'ou_owner', mentions: [] }),
    message('om_owner_new_group_wrong_at', { chatId: 'oc_new_one', sender: 'ou_owner', mentions: [{ id: { open_id: 'ou_other_bot' } }] }),
    ...['', 'oc_', 'not-a-chat', undefined].map((chatId, index) => message(`om_owner_invalid_chat_${index}`, { chatId, sender: 'ou_owner' })),
  ]
  delete rejected.at(-1).message.chat_id
  for (const event of rejected) assert.equal(await f.admission.message(event, f.state), false)
  assert.deepEqual(await readFile(f.migration.claimsPath), claimsBefore, 'rejected new-group messages never enter the durable ledger')
  assert.deepEqual(f.state.snapshot(), stateBefore)
  const one = message('om_owner_new_one', { chatId: 'oc_new_one', sender: 'ou_owner' })
  const two = message('om_owner_new_two', { chatId: 'oc_new_two', sender: 'ou_owner', mentions: [{ open_id: 'ou_bot' }] })
  assert.equal(await f.admission.message(one, f.state), true)
  assert.equal(await f.admission.message(two, f.state), true)
  const accepted = (await json(f.migration.claimsPath)).entries.map(([id]) => id)
  assert.ok(accepted.includes('om_owner_new_one'))
  assert.ok(accepted.includes('om_owner_new_two'))
  assert.equal(await f.admission.message(one, f.state), false)
  assert.equal(await f.admission.message(two, f.state), false)
  assert.deepEqual(await readFile(f.migration.markerPath), markerBefore)
  assert.deepEqual(f.migration.allowedChatIds, ['oc_allowed'])
  assert.equal(f.workspaces.workspaceFor(f.migration.botId), f.config.defaultCwd)
  assert.deepEqual(f.state.snapshot(), stateBefore, 'admission never shares or creates chat Session bindings')
})

test('an unknown bot identity cannot fall back to any non-empty mention list', async t => {
  const f = await fixture(t)
  const admission = createMuseImAdmission(f.config, { ...f.migration, botOpenId: undefined }).forBot(f.migration.botId, f.workspaces)
  const before = await readFile(f.migration.claimsPath, 'utf8')
  assert.equal(await admission.message(message('om_unknown_bot'), f.state), false)
  assert.equal(await admission.message(message('om_unknown_bot_new_group', { chatId: 'oc_new_one', sender: 'ou_owner' }), f.state), false)
  assert.equal(await readFile(f.migration.claimsPath, 'utf8'), before)
})

test('authorized DMs are admitted but restore an old binding only in the selected bot workspace', async t => {
  const f = await fixture(t)
  const oldFiles = ['session-map.json', 'inbound-claims.json'].map(name => join(f.legacy, name))
  const originals = await Promise.all(oldFiles.map(path => readFile(path)))
  const before = await readFile(f.migration.claimsPath, 'utf8')
  assert.equal(await f.admission.message(message('om_stranger', { type: 'p2p', chatId: 'oc_direct', sender: 'ou_stranger', mentions: [] }), f.state), false)
  assert.equal(await readFile(f.migration.claimsPath, 'utf8'), before)
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

test('only the owner may operate cards, and native or unrelated bots have no migration guard', async t => {
  const f = await fixture(t)
  for (const event of [{}, { operator: { open_id: 'ou_member' } }, { operator: { user_id: 'ou_owner' } }, { open_id: 'ou_stranger' }]) {
    assert.equal(f.admission.action(event), false)
  }
  assert.equal(f.admission.action({ operator: { open_id: 'ou_owner' } }), true)
  assert.equal(f.admission.action({ operator: { operator_id: { open_id: 'ou_owner' } } }), true)
  assert.equal(f.admission.action({ open_id: 'ou_owner' }), true)
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
