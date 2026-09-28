import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

/** Offset of the first differing byte, or the shared length when one buffer is a prefix of the other. */
function firstDifference(actual, expected) {
  const shared = Math.min(actual.length, expected.length)
  for (let offset = 0; offset < shared; offset += 1) if (actual[offset] !== expected[offset]) return offset
  return shared
}

/**
 * Create the two output directories one reproducible-build comparison needs.
 *
 * Both outputs must sit at the SAME directory depth: `build.mjs` stages every build in a
 * `.source-build-*` directory inside `--out` and links the toolchain into it with junctions, and
 * rolldown records every module it inlines in a `//#region` comment naming the file. Those paths
 * leave the staging tree for the checkout, so they are written relative to the emitted file (or
 * absolute when output and checkout sit on different Windows drives, which is why this only
 * reproduces with both on one drive). One extra `--out` level adds one `../` to each of the four
 * bundled `@heroicons/react` comments in the Codex client bundle, and the two tarballs then differ
 * in `lib/client.js` alone. Two `mkdtempSync` siblings under the OS temp root keep the depth equal;
 * nesting the second output inside the first cannot.
 *
 * @param {string} label Prefix naming the fixtures the two directories belong to.
 * @returns {[string, string]} The first and second output directories.
 */
function sameDepthOutputs(label) {
  return [
    mkdtempSync(join(tmpdir(), `${label}-first-`)),
    mkdtempSync(join(tmpdir(), `${label}-second-`)),
  ]
}

/**
 * Assert that two builds produced byte-identical bytes, by length and then SHA-256.
 *
 * The digests are compared before anything renders the buffers: `assert.deepEqual` on two
 * multi-hundred-kilobyte Buffers builds a full diff when they differ, and that allocation is what
 * fails first (`RangeError: Array buffer allocation failed` for the plugin tarballs), so the
 * reported error hides the byte difference the assertion exists to show. Equal length plus equal
 * SHA-256 is the byte-identical criterion this file needs, and the offset is reported on a digest
 * mismatch so the differing byte can be read without a diff of the whole archive.
 *
 * @param {Buffer} actual Bytes of the second build.
 * @param {Buffer} expected Bytes of the first build.
 * @param {string} message Failure label naming the tarball and the property under test.
 */
function assertSameBytes(actual, expected, message) {
  const actualDigest = sha256(actual)
  const expectedDigest = sha256(expected)
  assert.equal(actual.length, expected.length, `${message}: length ${actual.length} != ${expected.length} (sha256 ${actualDigest} != ${expectedDigest})`)
  assert.equal(actualDigest, expectedDigest, `${message}: sha256 ${actualDigest} != ${expectedDigest} (length ${actual.length}, first difference at offset ${firstDifference(actual, expected)})`)
}

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
  const [first, second] = sameDepthOutputs('muse-all-plugins')
  try {
    const result = spawnSync(process.execPath, [join(root, 'third_party/plugins/build.mjs'), '--out', first], { cwd: root, stdio: 'inherit' })
    assert.equal(result.status, 0)
    const repeated = spawnSync(process.execPath, [join(root, 'third_party/plugins/build.mjs'), '--out', second], { cwd: root, stdio: 'inherit' })
    assert.equal(repeated.status, 0)
    const tarballs = readdirSync(first).filter(file => file.endsWith('.tgz'))
    assert.equal(tarballs.length, 5)
    for (const tarball of tarballs) assertSameBytes(readFileSync(join(second, tarball)), readFileSync(join(first, tarball)), `${tarball} must reproduce from clean source`)
    for (const tarball of tarballs) {
      const list = spawnSync('tar', ['-tzf', join(first, tarball)], { encoding: 'utf8' })
      assert.equal(list.status, 0)
      assert.match(list.stdout, /package\/LICENSE/)
      assert.match(list.stdout, /package\/SOURCE.json/)
      assert.match(list.stdout, /package\/lib\/index.js/)
      const packedManifest = spawnSync('tar', ['-xOzf', join(first, tarball), 'package/package.json'], { encoding: 'utf8' })
      assert.equal(packedManifest.status, 0)
      const manifest = JSON.parse(packedManifest.stdout)
      const original = originals.get(manifest.name)
      assert.ok(original)
      assert.deepEqual(manifest.scripts, {})
      for (const [dependency, range] of Object.entries(original.peerDependencies ?? {})) {
        const expected = dependency.startsWith('@deepseek-ai/dsh-') && !range.split(' || ').includes('0.1.7-rc.1')
          ? `${range} || 0.1.7-rc.1` : range
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
        const runtime = spawnSync('tar', ['-xOzf', join(first, tarball), 'package/lib/index.js'], { encoding: 'utf8' })
        assert.equal(runtime.status, 0)
        assert.match(runtime.stdout, /0\.1\.7-rc\.1/)
        assert.doesNotMatch(runtime.stdout, /0\.1\.5-rc\.3/)
        assert.match(runtime.stdout, /codexFilesystemPath/)
        const metadata = spawnSync('tar', ['-xOzf', join(first, tarball), 'package/SOURCE.json'], { encoding: 'utf8' })
        assert.equal(metadata.status, 0)
        assert.deepEqual(JSON.parse(metadata.stdout).compatibilityOverlay, {
          subagentRuntimeVersion: '0.1.7-rc.1', codexCliVersion: '0.153.4', codexAsarUnpack: true,
        })
      }
    }
  } finally {
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})

test('builds ffmpeg twice from source into identical licensed tarballs', () => {
  const [first, second] = sameDepthOutputs('muse-plugin-build-test')
  try {
    for (const output of [first, second]) {
      const result = spawnSync(process.execPath, [join(root, 'third_party/plugins/build.mjs'), '--only', 'dsh-ffmpeg', '--out', output], { cwd: root, stdio: 'inherit' })
      assert.equal(result.status, 0, 'source build must succeed')
    }
    const files = [first, second].map(output => join(output, readdirSync(output).find(file => file.endsWith('.tgz'))))
    assertSameBytes(readFileSync(files[1]), readFileSync(files[0]), 'dsh-ffmpeg must reproduce from clean source')
    const list = spawnSync('tar', ['-tzf', files[0]], { encoding: 'utf8' })
    assert.equal(list.status, 0)
    assert.match(list.stdout, /package\/lib\/index.js/)
    assert.match(list.stdout, /package\/LICENSE/)
    assert.match(list.stdout, /package\/cordis.patch.yml/)
    assert.doesNotMatch(list.stdout, /node_modules|\.env|\.git\//)
  } finally {
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})
