/** Run the cross-process registry regressions through the normal Host unit lane. */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
it('retains valid ownership and recovers an exited registry reclaimer', async () => {
  const result = await execute(process.execPath, ['--import', 'tsx/esm', '--test', '--test-reporter=tap',
    'third_party/plugins/muse-douyin-download/tests/registry-lock.test.js'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  })
  expect(result.stdout).toContain('recovers when a real dead-owner reclaimer exits')
  expect(result.stdout).toContain('does not reclaim a live primary writer or live reclaimer')
  expect(result.stdout).toContain('retains a persisted primary with missing token')
  expect(result.stdout).toMatch(/# fail 0(?:\r?\n|$)/u)
  expect(result.stdout).toMatch(/# cancelled 0(?:\r?\n|$)/u)
  expect(result.stdout).toMatch(/# skipped 0(?:\r?\n|$)/u)
}, 130_000)
