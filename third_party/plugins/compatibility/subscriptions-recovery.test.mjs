/** Import failures keep the real replacement provider and its sign-in RPC available. */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { applySubscriptionsDesktopCompatibility, finishSubscriptionsDesktopCompatibility } from './subscriptions-desktop.mjs'
import { attachMigrationIssue, recoverSubscriptionsMigration, SUBSCRIPTION_MIGRATION_ISSUE, SUBSCRIPTION_MIGRATION_PERSISTENCE_ISSUE } from './subscriptions-recovery.mjs'

const repository = resolve(import.meta.dirname, '../../..')
const retained = join(repository, 'third_party/plugins/dsh-plugin-subscriptions')

test('recovery issues belong to each controller and do not return after an observed login', async () => {
  let accounts = []
  const controller = attachMigrationIssue({ async status() { return { busy: false, accounts } } }, SUBSCRIPTION_MIGRATION_ISSUE)
  const unrelated = attachMigrationIssue({ async status() { return { busy: false, accounts: [] } } }, undefined)
  assert.equal((await controller.status('codex')).detail, SUBSCRIPTION_MIGRATION_ISSUE)
  assert.equal((await controller.status('claude')).detail, undefined)
  assert.equal((await unrelated.status('codex')).detail, undefined)
  accounts = [{ key: 'fixture-account' }]
  assert.equal((await controller.status('codex')).detail, undefined)
  accounts = []
  assert.equal((await controller.status('codex')).detail, undefined)
  assert.equal(await recoverSubscriptionsMigration({}, async () => { throw new Error('fixture-private-secret') }, async () => ({})), SUBSCRIPTION_MIGRATION_ISSUE)
  const unsaved = await recoverSubscriptionsMigration({}, async () => { throw new Error('fixture-private-secret') }, async () => { throw new Error('fixture-marker-secret') })
  assert.equal(unsaved, SUBSCRIPTION_MIGRATION_PERSISTENCE_ISSUE)
  assert.doesNotMatch(unsaved, /fixture-private-secret|fixture-marker-secret/)
})

for (const failure of ['invalid-legacy', 'credential-read-denied', 'marker-target-unusable']) {
  test(`${failure}: the generated wrapper mounts actual status/login RPC and retains the old source`, async t => {
    const temporary = await mkdtemp(join(tmpdir(), 'muse-subscriptions-recovery-'))
    const stage = join(temporary, 'package')
    const home = join(temporary, 'home')
    await mkdir(stage)
    await mkdir(home)
    const oldEnvironment = { DSH_HOME: process.env.DSH_HOME, MUSE_HOME: process.env.MUSE_HOME }
    const oldFetch = globalThis.fetch
    const disposers = []
    t.after(async () => {
      for (const dispose of disposers.reverse()) await dispose()
      globalThis.fetch = oldFetch
      for (const [name, value] of Object.entries(oldEnvironment)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await rm(temporary, { recursive: true, force: true })
    })
    process.env.DSH_HOME = home
    process.env.MUSE_HOME = home
    globalThis.fetch = () => assert.fail('recovery must not contact a provider')
    await cp(join(retained, 'src'), join(stage, 'src'), { recursive: true })
    await cp(join(retained, 'package.json'), join(stage, 'package.json'))
    await symlink(join(repository, 'node_modules'), join(stage, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    applySubscriptionsDesktopCompatibility(stage)
    await mkdir(join(stage, 'lib'))
    await writeFile(join(stage, 'lib/upstream.js'), "export * from '../src/index.ts'\n")
    finishSubscriptionsDesktopCompatibility(stage)
    const plugin = await import(pathToFileURL(join(stage, 'lib/index.js')).href)
    const { codexFlow } = await import(pathToFileURL(join(stage, 'src/providers/codex.ts')).href)
    codexFlow.listen = { host: '127.0.0.1', ports: [0] }

    const legacyFile = join(home, 'previous-credential.fixture.json')
    const access = failure === 'credential-read-denied'
      ? `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-old-account' } })).toString('base64url')}.signature`
      : 'fixture-private-secret'
    const legacy = JSON.stringify({ kind: 'grant', payload: { version: 1, activeId: 'fixture-active', accounts: [{
      id: 'fixture-active', label: 'Fixture', credential: { type: 'oauth', access, refresh: 'fixture-refresh-secret', expires: 1_900_000_000_000 },
    }] } })
    await writeFile(legacyFile, legacy, { mode: 0o600 })
    const routes = new Map()
    const warnings = []
    const adapters = []
    const connection = { fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path) } } } }
    let readDenied = failure === 'credential-read-denied'
    let legacyReads = 0
    const credentials = {
      async readRecord() {
        legacyReads++
        if (readDenied) throw Object.assign(new Error('fixture-private-secret'), { code: 'EACCES' })
        return JSON.parse(await readFile(legacyFile, 'utf8'))
      },
      resolve: async () => assert.fail('a failed account record must not fall through to raw credentials'),
      modifyRecord: async () => assert.fail('old credentials must be retained'),
      deleteRecord: async () => assert.fail('old credentials must be retained'),
      set: async () => assert.fail('old credentials must be retained'),
      unset: async () => assert.fail('old credentials must be retained'),
    }
    const ctx = {
      credentials,
      logger: { warn: message => warnings.push(message) },
      llm: { registerAdapter(providers, adapter) { adapters.push({ providers, adapter }); return Object.assign(() => {}, { replace() {} }) } },
      get(name) { return name === 'connection' ? connection : name === 'llm' ? this.llm : undefined },
      effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
      inject(names, apply) { if (names.every(name => this.get(name) !== undefined)) apply(this) },
    }
    const config = { providers: ['codex'], codexClientVersion: '0.153.4', models: { codex: [{ id: 'fixture-model' }] }, pool: { enabled: false } }
    const marker = join(home, 'plugins/subscriptions/muse-codex-migration-v1.json')
    const issue = failure === 'marker-target-unusable' ? SUBSCRIPTION_MIGRATION_PERSISTENCE_ISSUE : SUBSCRIPTION_MIGRATION_ISSUE
    if (failure === 'marker-target-unusable') await mkdir(marker, { recursive: true })
    await plugin.apply(ctx, config)
    assert.deepEqual(adapters.flatMap(value => value.providers).sort(), ['codex', 'openai-codex'])
    assert.deepEqual(warnings, [issue])
    if (failure !== 'marker-target-unusable') {
      assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { version: 1, status: 'manual-login-required' })
    }
    assert.ok(routes.has('/api/subscriptions-auth.status'))
    assert.ok(routes.has('/api/subscriptions-auth.login'))
    const rpc = async (endpoint, payload = {}) => {
      const method = `subscriptions-auth.${endpoint}`
      const route = routes.get(`/api/${method}`)
      assert.ok(route)
      const response = await route.fetch(new Request(`http://fixture.invalid/api/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'fixture-rpc', method, payload }),
      }))
      const envelope = await response.json()
      assert.equal(envelope.result.ok, true)
      return envelope.result.value
    }
    const before = await rpc('status')
    assert.equal(before.providers.codex.detail, issue)
    assert.deepEqual(before.providers.codex.accounts, [])
    assert.equal(before.providers.claude.detail, undefined)
    assert.doesNotMatch(JSON.stringify({ warnings, before }), /fixture-private-secret|fixture-refresh-secret/)
    const login = await rpc('login', { provider: 'codex' })
    assert.equal(new URL(login.authorizeUrl).origin, 'https://auth.openai.com')
    assert.ok(Number(new URL(new URL(login.authorizeUrl).searchParams.get('redirect_uri')).port) > 0)
    await rpc('cancel', { provider: 'codex' })

    // Successful OAuth completion persists through this same public account-store operation.
    const store = await import(pathToFileURL(join(stage, 'src/auth/store.ts')).href)
    await store.saveAccountSession('codex', 'fixture-new-account', { accessToken: 'new-fixture-access', refreshToken: 'new-fixture-refresh', expiresAt: 1_900_000_000_000, accountId: 'fixture-new-account' })
    const after = await rpc('status')
    assert.equal(after.providers.codex.accounts.length, 1)
    assert.equal(after.providers.codex.detail, undefined)
    await rpc('logout', { provider: 'codex', account: 'fixture-new-account' })
    assert.equal((await rpc('status')).providers.codex.detail, undefined)
    while (disposers.length > 0) await disposers.pop()()
    readDenied = false
    await plugin.apply({ ...ctx }, config)
    assert.equal(legacyReads, failure === 'marker-target-unusable' ? 0 : 1, 'a fresh provider instance must not read old credentials after logout')
    const restarted = await rpc('status')
    assert.deepEqual(restarted.providers.codex.accounts, [])
    assert.equal(restarted.providers.codex.detail, issue)
    assert.equal(await readFile(legacyFile, 'utf8'), legacy)
  })
}
