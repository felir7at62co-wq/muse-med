/** Offline resource graph checks reject wrong deployment bases before publication. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

test('studio artifacts reject missing, escaped and incorrectly prefixed resources', () => {
  const require = createRequire(import.meta.url)
  const parser = createRequire(require.resolve('vite/package.json')).resolve('rollup/parseAst')
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  const result = spawnSync(python, [fileURLToPath(new URL('./web-build.test.py', import.meta.url)), parser],
    { encoding: 'utf8', timeout: 30000 })
  assert.ifError(result.error)
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /Ran 14 tests/)
})
