/** Python receives real native files in development and Electron installations. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { nativeResourcesDirectory } from '../src/resources.ts'

test('native resources use unpacked Electron paths and preserve ordinary directory names', () => {
  for (const root of ['development', 'app.asar', 'app.asar.unpacked', 'other.asar']) {
    const packageRoot = join(tmpdir(), root, 'node_modules', 'muse-lvpaopao')
    const result = nativeResourcesDirectory(pathToFileURL(join(packageRoot, 'lib', 'bridge.js')).href)
    assert.equal(result, join(tmpdir(), root === 'app.asar' ? 'app.asar.unpacked' : root, 'node_modules', 'muse-lvpaopao', 'native') + (process.platform === 'win32' ? '\\' : '/'))
  }
})
