/** Inspect the subscription artifact and compare two isolated builds through the maintained builder. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import test from 'node:test'
import { resolvePnpmEntrypoint } from '../../scripts/pnpm-entrypoint.mjs'
import { hostRuntimeCompatibility, reviewedHostVersion } from './compatibility/host-runtime.mjs'
import { subscriptionsDesktopCompatibility } from './compatibility/subscriptions-desktop.mjs'

const repository = resolve(import.meta.dirname, '../..')
const pin = JSON.parse(readFileSync(join(import.meta.dirname, 'sources.json'), 'utf8'))['dsh-plugin-subscriptions']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function member(archive, path) {
  const result = spawnSync('tar', ['-xOzf', archive, `package/${path}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function assertRuntimeExports(manifest, entries) {
  assert.equal(Object.hasOwn(manifest, 'types'), false, 'the runtime manifest must not advertise missing declarations')
  const visit = value => {
    if (typeof value === 'string') {
      assert.match(value, /^\.\//u)
      assert.doesNotMatch(value, /\.d\.[cm]?ts$/u)
      assert.ok(entries.has(`package/${value.slice(2)}`), `artifact omits exported ${value}`)
      return
    }
    assert.ok(value !== null && typeof value === 'object')
    assert.equal(Object.hasOwn(value, 'types'), false, 'runtime export conditions must not advertise declarations')
    for (const entry of Object.values(value)) visit(entry)
  }
  visit(manifest.exports)
  assert.ok(entries.has(`package/${manifest.main.replace(/^\.\//u, '')}`), 'artifact includes its main entry')
}

test('packs subscriptions twice with complete runtime exports, recoverable credentials and identical licensed bytes', t => {
  const outputs = []
  t.after(() => { for (const output of outputs) rmSync(output, { recursive: true, force: true }) })
  // Sibling temporary roots keep relative bundled module paths at the same depth.
  for (const label of ['first', 'second']) outputs.push(mkdtempSync(join(tmpdir(), `muse-subscriptions-${label}-`)))
  const archives = outputs.map(output => {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_TEST_|^NODE_PATH$/iu.test(key)))
    Reflect.deleteProperty(environment, 'MUSE_HOME')
    Reflect.deleteProperty(environment, 'MUSE_MED_HOME')
    environment.DSH_HOME = join(output, 'test-home')
    environment.CODEX_HOME = join(output, 'codex-home')
    environment.npm_execpath = resolvePnpmEntrypoint(join(repository, 'node_modules/pnpm/package.json'))
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'build.mjs'), '--only', 'dsh-plugin-subscriptions', '--out', output], {
      cwd: repository, env: environment, stdio: 'inherit',
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null, 'the maintained builder must finish before its files are inspected or removed')
    assert.equal(result.status, 0, 'the subscription build must pass its upstream, owned, Host and Client checks')
    const files = readdirSync(output).filter(file => file.endsWith('.tgz'))
    assert.deepEqual(files, [`dsh-plugin-subscriptions-${pin.version}.tgz`], 'only the replacement subscription artifact is delivered')
    return join(output, files[0])
  })
  const bytes = archives.map(archive => readFileSync(archive))
  assert.equal(bytes[1].length, bytes[0].length, 'clean subscription builds have equal archive lengths')
  assert.equal(sha256(bytes[1]), sha256(bytes[0]), 'clean subscription builds reproduce byte-identical archives')

  const listing = spawnSync('tar', ['-tzf', archives[0]], { encoding: 'utf8' })
  assert.equal(listing.error, undefined)
  assert.equal(listing.signal, null)
  assert.equal(listing.status, 0, listing.stderr)
  const entries = new Set(listing.stdout.trim().split(/\r?\n/u))
  assert.doesNotMatch(listing.stdout, /(?:^|\n)package\/(?:node_modules|\.env|\.git|dsh-codex-subscription)(?:\/|$)/u)
  const read = path => member(archives[0], path)
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.name, 'dsh-plugin-subscriptions')
  assert.equal(manifest.version, '0.9.12')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.bin, undefined)
  assert.deepEqual(manifest.scripts, {})
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-credentials'], reviewedHostVersion)
  assert.equal(manifest.dependencies.undici, JSON.parse(readFileSync(join(import.meta.dirname, 'toolchain/package.json'), 'utf8')).dependencies.undici)
  assertRuntimeExports(manifest, entries)
  assert.throws(() => assertRuntimeExports({ ...manifest, exports: { '.': './lib/missing.js' } }, entries), /omits exported/u)
  assert.throws(() => assertRuntimeExports({ ...manifest, types: './lib/index.d.ts' }, entries), /must not advertise/u)
  assert.ok([...entries].every(path => !/\.d\.[cm]?ts$/u.test(path)), 'the runtime archive contains no declaration files')
  assert.equal(manifest.exports['.'].default, './lib/index.js')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  for (const path of ['lib/index.js', 'lib/upstream.js', 'lib/client.js', 'lib/muse-migration.mjs', 'lib/muse-recovery.mjs', 'lib/muse-accounts.js', 'lib/muse-image-tool.js', 'cordis.patch.yml']) {
    assert.ok(entries.has(`package/${path}`), `artifact includes ${path}`)
    assert.ok(read(path).trim(), `artifact includes nonempty ${path}`)
  }
  for (const path of entries) {
    if (!path.startsWith('package/lib/') || path === 'package/lib/client.js' || !/\.[cm]?js$/u.test(path)) continue
    for (const [, reference] of read(path.slice('package/'.length)).matchAll(/\b(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/gu)) {
      assert.ok(entries.has(posix.normalize(posix.join(posix.dirname(path), reference))), `${path} omits imported ${reference}`)
    }
  }
  const wrapper = read('lib/index.js')
  for (const path of ['./upstream.js', './muse-migration.mjs', './muse-recovery.mjs']) assert.ok(wrapper.includes(`from '${path}'`), `wrapper resolves packaged ${path}`)
  assert.match(wrapper, /recoverSubscriptionsMigration\(ctx\.credentials, migrateSubscriptionsCredentials, disableLegacyImport\)/u)
  assert.match(wrapper, /upstream\.apply\(ctx, config, migrationIssue\)/u)
  for (const name of ['migration', 'recovery']) {
    assert.equal(read(`lib/muse-${name}.mjs`), readFileSync(join(import.meta.dirname, `compatibility/subscriptions-${name}.mjs`), 'utf8'))
  }
  assert.equal(read('LICENSE'), readFileSync(join(import.meta.dirname, 'dsh-plugin-subscriptions/LICENSE'), 'utf8'))
  assert.match(read('cordis.patch.yml'), /id: llm-subscriptions\s+name: dsh-plugin-subscriptions/u)
  const metadata = JSON.parse(read('SOURCE.json'))
  assert.deepEqual(metadata.upstream, pin)
  assert.equal(metadata.upstream.commit, 'b8023110864494acefc6f5963c2a197d85dda20c')
  assert.equal(metadata.hostVersion, '0.2.2-rc.1')
  assert.deepEqual(metadata.hostRuntimeCompatibility, hostRuntimeCompatibility)
  assert.deepEqual(metadata.compatibilityOverlay, subscriptionsDesktopCompatibility)
})
