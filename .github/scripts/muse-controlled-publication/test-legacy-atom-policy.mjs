/** Offline controls for genuine app discovery across stable and compatibility aliases. */
import assert from 'node:assert/strict'
import { validateLegacyAtomAppRelease } from './legacy_atom_policy.mjs'

const source = 'f'.repeat(40)
const inventory = { sourceCommit: source, files: Array.from({ length: 11 }, (_, index) => ({
  filename: `synthetic-file-${index}`, size: index + 1, sha256: 'a'.repeat(64),
})) }
const object = { type: 'commit', sha: source }
const release = tag => ({ tag_name: tag, draft: false, prerelease: tag !== 'v1.0.3',
  assets: inventory.files.map(file => ({ name: file.filename, size: file.size,
    state: 'uploaded', digest: `sha256:${file.sha256}` })),
})
const url = tag => `https://github.com/felir7at62co-wq/muse-med/releases/tag/${tag}`
for (const tag of ['v1.0.3', 'v1.0.3-rc.muse-stable']) {
  assert.equal(validateLegacyAtomAppRelease(url(tag), release(tag), object, inventory), tag)
}
for (const tag of ['hongguo-source-runtime-9869b8571b45', 'v1.0.1', 'v1.0.4', 'unknown']) {
  assert.throws(() => validateLegacyAtomAppRelease(url(tag), release(tag), object, inventory))
}
for (const mutate of [
  value => { value.tag_name = 'v1.0.1' },
  value => { value.draft = true },
  value => { value.prerelease = true },
  value => { value.assets.pop() },
  value => { value.assets.push(value.assets[0]) },
  value => { value.assets[0] = value.assets[1] },
  value => { value.assets[0].size += 1 },
  value => { value.assets[0].state = 'starter' },
  value => { value.assets[0].digest = `sha256:${'b'.repeat(64)}` },
]) {
  const data = release('v1.0.3'); mutate(data)
  assert.throws(() => validateLegacyAtomAppRelease(url('v1.0.3'), data, object, inventory))
}
assert.throws(() => validateLegacyAtomAppRelease(url('v1.0.3'), release('v1.0.3'), { ...object, sha: 'e'.repeat(40) }, inventory))
assert.throws(() => validateLegacyAtomAppRelease(url('v1.0.3'), release('v1.0.3'), { ...object, type: 'tag' }, inventory))
console.log(JSON.stringify({ tests: 17, stableAndRcAccepted: true, runtimeUnknownWrongBytesAndSourceRejected: true }))
