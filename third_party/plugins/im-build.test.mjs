/** Build the pinned IM source twice and inspect its exact Desktop Host and native client payload. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { imDesktopCompatibility } from './compatibility/im-desktop.mjs'
import { hostRuntimeCompatibility, reviewedHostVersion } from './compatibility/host-runtime.mjs'
import { resolvePnpmEntrypoint } from '../../scripts/pnpm-entrypoint.mjs'

const root = resolve(import.meta.dirname, '../..')
const source = join(import.meta.dirname, 'dsh-im')
const pin = JSON.parse(readFileSync(join(import.meta.dirname, 'sources.json'), 'utf8'))['dsh-im']
const upstream = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function fingerprint(directory, prefix = '') {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    assert.equal(entry.isSymbolicLink(), false, 'retained source cannot contain generated dependency links')
    return entry.isDirectory() ? fingerprint(directory, path) : [[path, sha256(readFileSync(join(directory, path)))]]
  })
}

function tar(archive, args) {
  const result = spawnSync('tar', [...args, archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function member(archive, name) {
  const result = spawnSync('tar', ['-xOzf', archive, `package/${name}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test('packs a reproducible native IM client and Muse migration entry without modifying upstream source', { timeout: 180_000 }, () => {
  const before = fingerprint(source)
  const outputs = [mkdtempSync(join(tmpdir(), 'muse-im-first-')), mkdtempSync(join(tmpdir(), 'muse-im-second-'))]
  try {
    const archives = outputs.map(output => {
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_TEST_/iu.test(key)))
      environment.npm_execpath = resolvePnpmEntrypoint(join(root, 'node_modules/pnpm/package.json'))
      const result = spawnSync(process.execPath, [join(import.meta.dirname, 'build.mjs'), '--only', 'dsh-im', '--out', output], {
        cwd: root,
        env: environment,
        encoding: 'utf8',
        timeout: 80_000,
        maxBuffer: 8 * 1024 * 1024,
      })
      assert.equal(result.error, undefined)
      assert.equal(result.signal, null)
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
      const files = readdirSync(output).filter(file => file.endsWith('.tgz'))
      assert.deepEqual(files, [`xmanrui-dsh-im-${pin.version}.tgz`])
      return join(output, files[0])
    })
    const first = readFileSync(archives[0])
    const second = readFileSync(archives[1])
    assert.equal(second.length, first.length)
    assert.equal(sha256(second), sha256(first))
    const manifest = JSON.parse(member(archives[0], 'package.json'))
    assert.equal(manifest.name, '@xmanrui/dsh-im')
    assert.equal(manifest.version, pin.version)
    assert.equal(manifest.main.replace(/^\.\//u, ''), 'lib/index.js')
    assert.equal(manifest.exports['.'], './lib/index.js')
    assert.equal(manifest.exports['./client'], './lib/client.js')
    assert.equal(manifest.license, 'MIT')
    assert.equal(manifest.bin, undefined)
    assert.deepEqual(manifest.scripts, {})
    assert.deepEqual(manifest.dsh.client, upstream.dsh.client)
    assert.deepEqual(manifest.dsh.bundle, upstream.dsh.bundle)
    assert.equal(member(archives[0], 'cordis.patch.yml').trim(), '[]')
    assert.equal(member(archives[0], 'LICENSE'), readFileSync(join(source, 'LICENSE'), 'utf8'))
    for (const path of ['lib/index.js', 'lib/upstream.js', 'lib/client.js', 'lib/muse-im-migration.mjs', 'lib/muse-im-admission.mjs', 'lib/muse-im-workspace.mjs', 'lib/muse-im-team.mjs']) {
      assert.ok(member(archives[0], path).trim(), `missing packaged ${path}`)
    }
    const entry = member(archives[0], 'lib/index.js')
    assert.match(entry, /from ['"]\.\/upstream\.js['"]/u)
    assert.match(entry, /from ['"]\.\/muse-im-migration\.mjs['"]/u)
    assert.match(entry, /createImHostPlugin\(/u)
    assert.match(entry, /export const inject = \['connection', 'credentials', 'typertGateway', 'sessions', 'sessionPersistence'\]/u)
    assert.match(member(archives[0], 'plugin-src/host/channels/feishu/index.mjs'), /export const inject = \['connection', 'credentials', 'typertGateway', 'sessions', 'sessionPersistence'\]/u)
    const client = member(archives[0], 'lib/client.js')
    assert.match(client, /window\.__ModuleLoader__\.load\(/u)
    assert.match(client, /id: "@xmanrui\/dsh-im"/u)
    assert.match(member(archives[0], 'plugin-src/client/channels/feishu/index.js'), /同一机器人的私聊和群聊共用此工作区，聊天记录各自独立。/u)
    assert.match(member(archives[0], 'plugin-src/client/i18n.js'), /This bot’s direct and group chats share this workspace; each chat keeps its own history\./u)
    const metadata = JSON.parse(member(archives[0], 'SOURCE.json'))
    assert.deepEqual(metadata.upstream, pin)
    assert.equal(metadata.hostVersion, reviewedHostVersion)
    assert.deepEqual(metadata.hostRuntimeCompatibility, hostRuntimeCompatibility)
    assert.deepEqual(metadata.compatibilityOverlay, imDesktopCompatibility)
    assert.equal(metadata.toolchainLockSha256, sha256(readFileSync(join(import.meta.dirname, 'toolchain/pnpm-lock.yaml'))))
    const listed = tar(archives[0], ['-tzf'])
    assert.doesNotMatch(listed, /(?:^|\n)package\/(?:bin|node_modules|\.env|\.git)(?:\/|$)/u)
  } finally {
    try {
      assert.deepEqual(fingerprint(source), before)
    } finally {
      for (const output of outputs) rmSync(output, { recursive: true, force: true })
    }
  }
})
