/** Inspect an owned staging tree only; no package or installer is produced. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyNativeResources, nativeResources } from '../scripts/native-resources.mjs'

test('owned native resources exactly cover boot imports without credentials, proof, caches or binaries', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url)), staging = await mkdtemp(join(tmpdir(), 'lvpaopao-resources-'))
  t.after(() => rm(staging, { recursive: true, force: true }))
  const boot = await readFile(join(root, 'native', 'boot.py'), 'utf8')
  const names = [...boot.match(/RUNTIME_FILES=\(([^)]+)\)/)[1].matchAll(/'([^']+)'/g)].map(match => match[1])
  assert.deepEqual([...nativeResources].sort(), ['boot.py', 'requirements-windows-25560.lock', 'requirements-macos-arm64-269602.lock', ...names].sort())
  const hashes = copyNativeResources(root, staging), manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const shipped = manifest.files.filter(file => file.startsWith('native/')).sort()
  assert.deepEqual(Object.keys(hashes).sort(), shipped)
  for (const file of shipped) {
    assert.equal(createHash('sha256').update(await readFile(join(staging, file))).digest('hex'), hashes[file])
    assert.doesNotMatch(file, /\.exe$|\.dll$|proof|attestation|\.dpapi|connection\.json|test_|\.spec\./)
  }
  assert.deepEqual(await readdir(staging), ['native'])
})
