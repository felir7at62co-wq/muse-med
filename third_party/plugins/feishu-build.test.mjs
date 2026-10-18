/** Explicitly build the retained Feishu source without activating it as the Desktop provider. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const source = join(import.meta.dirname, 'dsh-feishu')
const pin = JSON.parse(readFileSync(join(import.meta.dirname, 'sources.json'), 'utf8'))['dsh-feishu']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function fingerprint(directory, prefix = '') {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    assert.equal(entry.isSymbolicLink(), false, 'retained source cannot contain generated dependency links')
    return entry.isDirectory() ? fingerprint(directory, path) : [[path, sha256(readFileSync(join(directory, path)))]]
  })
}

function readMember(archive, name) {
  const result = spawnSync('tar', ['-xOzf', archive, `package/${name}`], { encoding: 'utf8' })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test('explicitly packs the retired Feishu source with its retained cards and no standalone launcher', { timeout: 180_000 }, () => {
  assert.equal(pin.desktop, false, 'the retired source must remain outside the default Desktop package set')
  const before = fingerprint(source)
  const outputs = [mkdtempSync(join(tmpdir(), 'muse-feishu-first-')), mkdtempSync(join(tmpdir(), 'muse-feishu-second-'))]
  try {
    const archives = outputs.map(output => {
      const result = spawnSync(process.execPath, [join(import.meta.dirname, 'build.mjs'), '--only', 'dsh-feishu', '--out', output], {
        cwd: root,
        env: { ...process.env, npm_execpath: join(root, 'node_modules/pnpm/bin/pnpm.cjs') },
        encoding: 'utf8',
        timeout: 80_000,
        maxBuffer: 8 * 1024 * 1024,
      })
      assert.equal(result.error, undefined)
      assert.equal(result.signal, null)
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
      const files = readdirSync(output).filter(file => file.endsWith('.tgz'))
      assert.deepEqual(files, ['dsh-feishu-dsh-feishu-0.3.6.tgz'])
      return join(output, files[0])
    })
    assert.equal(sha256(readFileSync(archives[0])), sha256(readFileSync(archives[1])))
    const manifest = JSON.parse(readMember(archives[0], 'package.json'))
    assert.equal(manifest.name, '@dsh-feishu/dsh-feishu')
    assert.equal(manifest.version, '0.3.6')
    assert.equal(manifest.main, 'lib/index.js')
    assert.equal(manifest.license, 'MIT')
    assert.equal(manifest.bin, undefined)
    assert.deepEqual(manifest.scripts, {})
    assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-invariants'], undefined)
    assert.match(manifest.peerDependencies['@deepseek-ai/dsh-agent'], /0\.2\.1-alpha\.1/u)
    assert.equal(readMember(archives[0], 'cordis.patch.yml').trim(), '[]')
    for (const path of ['lib/index.js', 'lib/muse-feishu-runtime.mjs', 'lib/muse-feishu-reliability.mjs', 'lib/muse-feishu-migration.mjs', 'lib/upstream/index.js', 'lib/upstream/cards/StreamingCardController.js', 'lib/upstream/cards/InteractionCardController.js', 'LICENSE']) {
      assert.ok(readMember(archives[0], path).trim(), `missing packaged ${path}`)
    }
    const metadata = JSON.parse(readMember(archives[0], 'SOURCE.json'))
    assert.deepEqual(metadata.upstream, pin)
    assert.equal(metadata.upstream.repository, 'https://github.com/PGZXB/dsh-feishu')
    assert.equal(metadata.upstream.commit, 'f10ef5f6efb5beb5bd5d10e3e31a8f68f48b6e75')
    assert.equal(metadata.hostVersion, '0.2.1-alpha.1')
    const listed = spawnSync('tar', ['-tzf', archives[0]], { encoding: 'utf8' })
    assert.equal(listed.status, 0)
    assert.doesNotMatch(listed.stdout, /(?:^|\n)package\/(?:node_modules|\.env|\.git)(?:\/|$)/u)
    assert.deepEqual(fingerprint(source), before)
  } finally {
    for (const output of outputs) rmSync(output, { recursive: true, force: true })
  }
})
