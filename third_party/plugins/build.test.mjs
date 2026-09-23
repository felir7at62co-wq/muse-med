import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const pins = JSON.parse(readFileSync(join(import.meta.dirname, 'sources.json'), 'utf8'))
const codexRuntimePath = join(import.meta.dirname, 'dsh-codex-subscription/src/subagent-runtime.js')
const pinnedCodexRuntime = readFileSync(codexRuntimePath, 'utf8')
const originals = new Map(Object.keys(pins).map(directory => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, directory, 'package.json'), 'utf8'))
  return [manifest.name, manifest]
}))

test('rejects an unknown source', () => {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'build.mjs'), '--only', '../unlisted', '--out', 'unused'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /unknown source/)
})

test('builds every pinned plugin with its declared runtime entries and notices', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'muse-all-plugins-test-'))
  try {
    const result = spawnSync(process.execPath, [join(root, 'third_party/plugins/build.mjs'), '--out', temporary], { cwd: root, stdio: 'inherit' })
    assert.equal(result.status, 0)
    const repeated = join(temporary, 'repeat')
    const second = spawnSync(process.execPath, [join(root, 'third_party/plugins/build.mjs'), '--out', repeated], { cwd: root, stdio: 'inherit' })
    assert.equal(second.status, 0)
    const tarballs = readdirSync(temporary).filter(file => file.endsWith('.tgz'))
    assert.equal(tarballs.length, 5)
    for (const tarball of tarballs) assert.deepEqual(readFileSync(join(temporary, tarball)), readFileSync(join(repeated, tarball)), `${tarball} must reproduce from clean source`)
    for (const tarball of tarballs) {
      const list = spawnSync('tar', ['-tzf', join(temporary, tarball)], { encoding: 'utf8' })
      assert.equal(list.status, 0)
      assert.match(list.stdout, /package\/LICENSE/)
      assert.match(list.stdout, /package\/SOURCE.json/)
      assert.match(list.stdout, /package\/lib\/index.js/)
      const packedManifest = spawnSync('tar', ['-xOzf', join(temporary, tarball), 'package/package.json'], { encoding: 'utf8' })
      assert.equal(packedManifest.status, 0)
      const manifest = JSON.parse(packedManifest.stdout)
      const original = originals.get(manifest.name)
      assert.ok(original)
      assert.deepEqual(manifest.scripts, {})
      for (const [dependency, range] of Object.entries(original.peerDependencies ?? {})) {
        const expected = dependency.startsWith('@deepseek-ai/dsh-') && !range.split(' || ').includes('0.1.6-alpha.1')
          ? `${range} || 0.1.6-alpha.1` : range
        assert.equal(manifest.peerDependencies[dependency], expected)
      }
      const entries = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(entries) : []
      for (const entry of entries(manifest.exports).filter(entry => !entry.includes('*'))) {
        assert.ok(list.stdout.split(/\r?\n/).includes(`package/${entry.replace(/^\.\//, '')}`), `${tarball} omits ${entry}`)
      }
      if (tarball.startsWith('dsh-codex-subscription')) {
        assert.match(list.stdout, /package\/lib\/client.js/)
        assert.match(list.stdout, /package\/lib\/sketch-psd-worker.js/)
        assert.match(list.stdout, /package\/THIRD_PARTY_NOTICES.md/)
        assert.equal(readFileSync(codexRuntimePath, 'utf8'), pinnedCodexRuntime)
        assert.match(pinnedCodexRuntime, /SUBAGENT_RUNTIME_VERSION = '0\.1\.5-rc\.3'/)
        const runtime = spawnSync('tar', ['-xOzf', join(temporary, tarball), 'package/lib/index.js'], { encoding: 'utf8' })
        assert.equal(runtime.status, 0)
        assert.match(runtime.stdout, /0\.1\.6-alpha\.1/)
        assert.doesNotMatch(runtime.stdout, /0\.1\.5-rc\.3/)
        assert.match(runtime.stdout, /codexFilesystemPath/)
        const metadata = spawnSync('tar', ['-xOzf', join(temporary, tarball), 'package/SOURCE.json'], { encoding: 'utf8' })
        assert.equal(metadata.status, 0)
        assert.deepEqual(JSON.parse(metadata.stdout).compatibilityOverlay, {
          subagentRuntimeVersion: '0.1.6-alpha.1', codexCliVersion: '0.153.4', codexAsarUnpack: true,
        })
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('builds ffmpeg twice from source into identical licensed tarballs', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'muse-plugin-build-test-'))
  try {
    const outputs = ['first', 'second'].map(name => join(temporary, name))
    for (const output of outputs) {
      const result = spawnSync(process.execPath, [join(root, 'third_party/plugins/build.mjs'), '--only', 'dsh-ffmpeg', '--out', output], { cwd: root, stdio: 'inherit' })
      assert.equal(result.status, 0, 'source build must succeed')
    }
    const files = outputs.map(output => join(output, readdirSync(output).find(file => file.endsWith('.tgz'))))
    assert.deepEqual(readFileSync(files[0]), readFileSync(files[1]))
    const list = spawnSync('tar', ['-tzf', files[0]], { encoding: 'utf8' })
    assert.equal(list.status, 0)
    assert.match(list.stdout, /package\/lib\/index.js/)
    assert.match(list.stdout, /package\/LICENSE/)
    assert.match(list.stdout, /package\/cordis.patch.yml/)
    assert.doesNotMatch(list.stdout, /node_modules|\.env|\.git\//)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
