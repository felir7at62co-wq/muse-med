/** Verify account migration with isolated files and fake credentials only. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { disableLegacyImport, migrateSubscriptionsCredentials } from './subscriptions-migration.mjs'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const identifiers = { record: 'codex-subscription/accounts', refs: ['OPENAI_CODEX_SUBSCRIPTION_OAUTH', 'WSL043_OPENAI_CODEX_OAUTH'] }
function credential(overrides = {}, claims = {}) {
  const payload = { client_id: CLIENT_ID, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' }, ...claims }
  return { type: 'oauth', access: `fixture.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`, refresh: 'fixture-refresh-secret', expires: 1_900_000_000_000, accountId: 'fixture-account', ...overrides }
}
function service(value = credential()) {
  const grant = { kind: 'grant', payload: { version: 1, activeId: 'active', accounts: [{ id: 'other', label: 'Other', credential: credential({ refresh: 'other-fixture-secret' }) }, { id: 'active', label: 'Active', credential: value }] } }
  const reads = []
  return {
    grant, reads,
    async readRecord(key) { reads.push(key); assert.equal(key, identifiers.record); return structuredClone(grant) },
    async resolve() { assert.fail('a grant record must take priority over raw refs') },
    async set() { assert.fail('old credentials must not change') },
    async unset() { assert.fail('old credentials must not change') },
    async modifyRecord() { assert.fail('old credentials must not change') },
    async deleteRecord() { assert.fail('old credentials must not change') },
  }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'muse-subscriptions-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { authPath: join(root, 'auth.json'), markerPath: join(root, 'migration.json'), identifiers }
}

test('imports only the active account, preserves other providers and source credentials, and publishes private files', async t => {
  const options = await fixture(t)
  const api = service()
  const original = structuredClone(api.grant)
  const existing = { claude: { default: 'fixture-claude', accounts: { 'fixture-claude': { accessToken: 'claude-fixture', refreshToken: 'claude-refresh', expiresAt: 42 } } } }
  await writeFile(options.authPath, JSON.stringify(existing))
  const network = globalThis.fetch
  globalThis.fetch = () => assert.fail('migration must not use the network')
  t.after(() => { globalThis.fetch = network })
  assert.deepEqual(await migrateSubscriptionsCredentials(api, options), { status: 'imported-active-account', remainingAccounts: 1 })
  const store = JSON.parse(await readFile(options.authPath, 'utf8'))
  assert.deepEqual(store.claude, existing.claude)
  assert.equal(store.codex.default, 'fixture-account')
  assert.deepEqual(store.codex.accounts['fixture-account'], { accessToken: original.payload.accounts[1].credential.access, refreshToken: 'fixture-refresh-secret', expiresAt: 1_900_000_000_000, accountId: 'fixture-account' })
  assert.deepEqual(api.grant, original)
  // Windows does not expose POSIX mode bits; the remaining migration assertions run there.
  if (process.platform !== 'win32') {
    for (const path of [options.authPath, options.markerPath]) assert.equal((await stat(path)).mode & 0o777, 0o600)
  }
  const marker = await readFile(options.markerPath, 'utf8')
  assert.deepEqual(JSON.parse(marker), { version: 1, status: 'imported-active-account', remainingAccounts: 1 })
  assert.doesNotMatch(marker, /fixture-account|fixture-refresh|signature/)
})

test('a marker prevents reimport after the user logs out', async t => {
  const options = await fixture(t)
  const api = service()
  await migrateSubscriptionsCredentials(api, options)
  assert.equal(api.reads.length, 1)
  await writeFile(options.authPath, '{}')
  assert.deepEqual(await migrateSubscriptionsCredentials(api, options), { status: 'already-migrated' })
  assert.equal(await readFile(options.authPath, 'utf8'), '{}')
  assert.equal(api.reads.length, 1)
})

test('manual-login recovery prevents reading old credentials after login, logout and restart', async t => {
  const options = await fixture(t)
  const api = service()
  assert.deepEqual(await disableLegacyImport(options), { status: 'manual-login-required' })
  const original = await readFile(options.markerPath, 'utf8')
  assert.deepEqual(JSON.parse(original), { version: 1, status: 'manual-login-required' })
  if (process.platform !== 'win32') assert.equal((await stat(options.markerPath)).mode & 0o777, 0o600)
  await writeFile(options.authPath, JSON.stringify({ codex: { accounts: { fixture: {} } } }))
  await writeFile(options.authPath, '{}')
  assert.deepEqual(await migrateSubscriptionsCredentials(api, options), { status: 'manual-login-required' })
  assert.deepEqual(api.reads, [])
  assert.equal(await readFile(options.authPath, 'utf8'), '{}')
  await disableLegacyImport(options)
  assert.equal(await readFile(options.markerPath, 'utf8'), original)
})

test('existing Codex data is retained byte for byte without reading old credentials and gets a logout marker', async t => {
  const options = await fixture(t)
  const original = '{"codex":{"accounts":{"new":"fixture"}},"extra":17}\n'
  await writeFile(options.authPath, original)
  const api = { readRecord: () => assert.fail('do not inspect old credentials'), resolve: () => assert.fail('do not inspect old credentials') }
  assert.deepEqual(await migrateSubscriptionsCredentials(api, options), { status: 'existing-codex-account' })
  assert.equal(await readFile(options.authPath, 'utf8'), original)
  assert.deepEqual(JSON.parse(await readFile(options.markerPath, 'utf8')), { version: 1, status: 'existing-codex-account' })
})

for (const legacyIndex of [0, 1]) {
  test(`imports legacy OAuth reference ${legacyIndex + 1} without changing it`, async t => {
    const options = await fixture(t)
    const value = JSON.stringify(credential({}, { email: 'Example@fixture.invalid' }))
    const api = { async readRecord() { return undefined }, async resolve(ref) { return ref === identifiers.refs[legacyIndex] ? { value } : undefined } }
    await migrateSubscriptionsCredentials(api, options)
    const codex = JSON.parse(await readFile(options.authPath, 'utf8')).codex
    assert.equal(codex.default, '["fixture-account","email","example@fixture.invalid"]')
    assert.equal(codex.accounts[codex.default].emailAddress, 'Example@fixture.invalid')
  })
}

test('absent old credentials leave both new files absent', async t => {
  const options = await fixture(t)
  const api = { async readRecord() { return undefined }, async resolve() { return undefined } }
  assert.deepEqual(await migrateSubscriptionsCredentials(api, options), { status: 'no-previous-account' })
  await assert.rejects(stat(options.authPath), { code: 'ENOENT' })
  await assert.rejects(stat(options.markerPath), { code: 'ENOENT' })
})

for (const [name, invalid] of [
  ['missing refresh token', credential({ refresh: '' })],
  ['missing identity', credential({}, { 'https://api.openai.com/auth': {} })],
  ['different account identity', credential({ accountId: 'different' })],
  ['different OAuth client', credential({}, { client_id: 'different-client' })],
  ['different authorized party', credential({}, { azp: 'different-client' })],
  ['non-JWT access token', credential({ access: 'fixture-private-access' })],
]) {
  test(`rejects ${name} without writing files or exposing credentials`, async t => {
    const options = await fixture(t)
    await assert.rejects(migrateSubscriptionsCredentials(service(invalid), options), error => {
      assert.match(error.message, /Muse subscription sign-in migration:.*Sign in again/)
      assert.doesNotMatch(error.stack, /fixture-private-access|fixture-refresh-secret|\.signature/)
      return true
    })
    await assert.rejects(stat(options.authPath), { code: 'ENOENT' })
    await assert.rejects(stat(options.markerPath), { code: 'ENOENT' })
  })
}

test('invalid raw JSON and credential-provider errors disclose no original secret text', async t => {
  const options = await fixture(t)
  for (const api of [
    { async readRecord() { return undefined }, async resolve() { return { value: '{fixture-private-secret' } } },
    { async readRecord() { throw new Error('fixture-private-secret') } },
  ]) {
    await assert.rejects(migrateSubscriptionsCredentials(api, options), error => {
      assert.doesNotMatch(error.stack, /fixture-private-secret/)
      assert.equal(error.cause, undefined)
      return true
    })
  }
})

test('invalid new store JSON remains unchanged and blocks migration before old credentials are read', async t => {
  const options = await fixture(t)
  await writeFile(options.authPath, '{fixture-private-secret')
  const api = { readRecord: () => assert.fail('do not inspect old credentials') }
  await assert.rejects(migrateSubscriptionsCredentials(api, options), error => {
    assert.match(error.message, /subscription account store contains invalid JSON/)
    assert.doesNotMatch(error.stack, /fixture-private-secret/)
    return true
  })
  assert.equal(await readFile(options.authPath, 'utf8'), '{fixture-private-secret')
})
