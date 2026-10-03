/** Check retained manifests against the reviewed Host without changing source files. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { qualifyCommunityManifest, reviewedHostPackageVersion, reviewedHostVersion, reviewedVendorVersions } from './host-runtime.mjs'

const plugins = join(import.meta.dirname, '..')
const pins = JSON.parse(readFileSync(join(plugins, 'sources.json'), 'utf8'))

for (const name of Object.keys(pins)) {
  test(`qualifies ${name} without retaining removed Host packages or changing source`, () => {
    const manifestPath = join(plugins, name, 'package.json')
    const bytes = readFileSync(manifestPath)
    const original = JSON.parse(bytes.toString('utf8'))
    const retained = structuredClone(original)
    const manifest = qualifyCommunityManifest(original)
    assert.deepEqual(original, retained)
    assert.deepEqual(readFileSync(manifestPath), bytes)
    for (const section of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies']) {
      assert.equal(manifest[section]?.['@deepseek-ai/dsh-invariants'], undefined)
    }
    for (const [dependency, range] of Object.entries(manifest.peerDependencies ?? {})) {
      const version = reviewedHostPackageVersion(dependency)
      if (version) assert.ok(range.split(' || ').includes(version), `${dependency} must admit its tested prerelease`)
    }
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const [dependency, version] of Object.entries(manifest[section] ?? {})) {
        const expected = reviewedHostPackageVersion(dependency)
        if (expected) assert.equal(version, expected)
      }
    }
    if (name === 'dsh-ponytail') {
      assert.equal(manifest.exports['./invariant'], undefined)
      assert.ok(!manifest.files.includes('lib/invariant.js'))
      assert.deepEqual(manifest.exports['.'], original.exports['.'])
      assert.equal(manifest.dsh.bundle.patch, original.dsh.bundle.patch)
    } else {
      assert.deepEqual(manifest.exports, original.exports)
    }
  })
}

test('preserves unrelated packages and admits vendor prereleases alongside existing stable peers', () => {
  const manifest = qualifyCommunityManifest({ name: 'fixture', dependencies: { ws: '8.21.3' },
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.1', react: '^18.3.1', '@deepseek-ai/dsh-tools': reviewedHostVersion } })
  assert.equal(manifest.dependencies.ws, '8.21.3')
  assert.equal(manifest.peerDependencies.react, '^18.3.1')
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], `^4.0.1 || ${reviewedVendorVersions['@deepseek-ai/cordis']}`)
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], reviewedHostVersion)
  assert.equal(reviewedHostPackageVersion('@deepseek-ai/dsh-invariants'), undefined)
  assert.equal(reviewedHostPackageVersion('ws'), undefined)
})
