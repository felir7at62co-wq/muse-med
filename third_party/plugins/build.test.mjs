import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { hostRuntimeCompatibility, reviewedHostPackageVersion, reviewedHostVersion } from './compatibility/host-runtime.mjs'

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
    assert.equal(tarballs.length, Object.keys(pins).length)
    for (const tarball of tarballs) assertSameBytes(readFileSync(join(second, tarball)), readFileSync(join(first, tarball)), `${tarball} must reproduce from clean source`)
    for (const tarball of tarballs) {
      const list = spawnSync('tar', ['-tzf', join(first, tarball)], { encoding: 'utf8' })
      assert.equal(list.status, 0)
      assert.match(list.stdout, /package\/LICENSE/)
      assert.match(list.stdout, /package\/SOURCE.json/)
      const packedManifest = spawnSync('tar', ['-xOzf', join(first, tarball), 'package/package.json'], { encoding: 'utf8' })
      assert.equal(packedManifest.status, 0)
      const manifest = JSON.parse(packedManifest.stdout)
      assert.ok(list.stdout.split(/\r?\n/).includes(`package/${manifest.main.replace(/^\.\//u, '')}`))
      const original = originals.get(manifest.name)
      assert.ok(original)
      assert.deepEqual(manifest.scripts, {})
      if (manifest.name === 'muse-hongguo-search') {
        assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], reviewedHostVersion)
        assert.match(list.stdout, /package\/src\/index.js/)
        assert.doesNotMatch(list.stdout, /node_modules|\.env|\.git\//)
      }
      if (manifest.name === 'dsh-skill-mcp-panel') {
        assert.equal(manifest.bin, undefined)
        assert.match(list.stdout, /package\/lib\/client.js/)
      }
      for (const [dependency, range] of Object.entries(original.peerDependencies ?? {})) {
        if (dependency === '@deepseek-ai/dsh-invariants') {
          assert.equal(manifest.peerDependencies[dependency], undefined)
          continue
        }
        const version = reviewedHostPackageVersion(dependency)
        const expected = dependency === '@earendil-works/pi-ai' ? '0.87.1'
          : version && !range.split(' || ').includes(version) ? `${range} || ${version}` : range
        assert.equal(manifest.peerDependencies[dependency], expected)
      }
      for (const section of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies']) {
        assert.equal(manifest[section]?.['@deepseek-ai/dsh-invariants'], undefined)
      }
      if (manifest.name === '@mengyuly/dsh-ponytail') {
        assert.equal(manifest.exports['./invariant'], undefined)
        assert.doesNotMatch(list.stdout, /package\/lib\/(?:types\/)?invariant\.(?:js|d\.ts)/u)
      }
      const sourceMetadata = spawnSync('tar', ['-xOzf', join(first, tarball), 'package/SOURCE.json'], { encoding: 'utf8' })
      assert.equal(sourceMetadata.status, 0)
      assert.deepEqual(JSON.parse(sourceMetadata.stdout).hostRuntimeCompatibility, hostRuntimeCompatibility)
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
        assert.ok(runtime.stdout.includes(reviewedHostVersion))
        assert.doesNotMatch(runtime.stdout, /0\.1\.5-rc\.3/)
        assert.match(runtime.stdout, /codexFilesystemPath/)
        const metadata = spawnSync('tar', ['-xOzf', join(first, tarball), 'package/SOURCE.json'], { encoding: 'utf8' })
        assert.equal(metadata.status, 0)
        assert.deepEqual(JSON.parse(metadata.stdout).compatibilityOverlay, {
          subagentRuntimeVersion: reviewedHostVersion, piAiVersion: '0.87.1', piAiCatalogFixtures: true, codexCliVersion: '0.153.4', codexAsarUnpack: true, authenticatedModelList: true, opaqueModelMenus: true, viewportAnchoredModelMenus: true,
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

test('builds opaque Codex picker surfaces and records their reviewed overlay in the tarball', () => {
  const output = mkdtempSync(join(tmpdir(), 'muse-codex-menu-build-'))
  const retainedStylesPath = join(import.meta.dirname, 'dsh-codex-subscription/src/client-styles.js')
  const retainedStyles = readFileSync(retainedStylesPath, 'utf8')
  try {
    const result = spawnSync(process.execPath,
      [join(import.meta.dirname, 'build.mjs'), '--only', 'dsh-codex-subscription', '--out', output],
      { cwd: root, stdio: 'inherit' })
    assert.equal(result.signal, null, 'Codex staging build finishes without a signal')
    assert.equal(result.status, 0, 'Codex staging build succeeds')
    const tarball = join(output, readdirSync(output).find(file => file.endsWith('.tgz')))
    const client = spawnSync('tar', ['-xOzf', tarball, 'package/lib/client.js'], { encoding: 'utf8' })
    assert.equal(client.signal, null)
    assert.equal(client.status, 0)
    for (const selector of ['.codexModelSelectMenu,.codexModelSelectSubmenu', '.codexModelSelectGroupTitle']) {
      const start = client.stdout.indexOf(`${selector}{`)
      assert.ok(start >= 0, 'built picker selector exists: ' + selector)
      const rule = client.stdout.slice(start).split('}')[0]
      assert.match(rule, /background:var\(--dsw-alias-bg-base\);/)
      assert.doesNotMatch(rule, /--dsw-specific-menu|backdrop-filter/)
    }
    const metadata = spawnSync('tar', ['-xOzf', tarball, 'package/SOURCE.json'], { encoding: 'utf8' })
    assert.equal(metadata.signal, null)
    assert.equal(metadata.status, 0)
    assert.equal(JSON.parse(metadata.stdout).compatibilityOverlay.opaqueModelMenus, true)
    assert.equal(JSON.parse(metadata.stdout).compatibilityOverlay.viewportAnchoredModelMenus, true)
    assert.match(client.stdout, /\.codexModelSelectSubmenu\{position:static;/)
    assert.match(client.stdout, /useAnchoredPosition/)
    assert.match(client.stdout, /modelBack/)
    assert.equal(readFileSync(retainedStylesPath, 'utf8'), retainedStyles)
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})
