/** Require the retained panel check to inspect the current built primitive exports. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

test('resolves panel primitives against the current built Client exports', () => {
  assert.ok(process.env.DSH_UI_PRIMITIVES, 'the current Client primitive directory is required')
  assert.ok(existsSync(join(process.env.DSH_UI_PRIMITIVES, 'lib/index.js')), 'build the current Client primitives before reviewing the panel')
  const result = spawnSync(process.execPath, ['test-host-icons.mjs'], { encoding: 'utf8', timeout: 10_000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, /^SKIP\s/mu, result.stdout)
  assert.match(result.stdout, /ALL HOST ICON CONTRACT TESTS PASSED/u)
})
