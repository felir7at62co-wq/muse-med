import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const harness = process.env.DSH_HARNESS
const web = createRequire(join(harness, 'packages/bundle/web-app/package.json'))
const base = createRequire(join(harness, 'packages/bundle/base/package.json'))

test('vendor peers resolve to the packages consumed by the real Web profile bundles', () => {
  for (const [consumer, specifier] of [
    [web, '@deepseek-ai/dsh-session-reference'],
    [web, '@deepseek-ai/dsh-client-modules/client'],
    [base, '@deepseek-ai/dsh-llm'],
  ]) assert.equal(import.meta.resolve(specifier), pathToFileURL(consumer.resolve(specifier)).href)
  assert.throws(() => import.meta.resolve('@deepseek-ai/dsh-missing-test-peer'), { code: 'ERR_MODULE_NOT_FOUND' })
})

test('a vendored checkout discovers its own harness without an environment override', () => {
  const env = { ...process.env }
  delete env.DSH_HARNESS
  const result = spawnSync(process.execPath, [
    '--import', join(import.meta.dirname, 'harness-resolve.mjs'),
    '--input-type=module', '-e', 'process.stdout.write(process.env.DSH_HARNESS)',
  ], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, harness)
})
