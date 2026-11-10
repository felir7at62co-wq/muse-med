/** Admission never combines a manifest revision with another revision's selected audio. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('rejects a manifest replaced after the selected audio paths are read', async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const fixture = fileURLToPath(new URL('./fixtures/guardian-capture-manifest-race.mts', import.meta.url))
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx/esm', fixture], {
    cwd: root, env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)) },
    timeout: 30000,
  })
  expect(JSON.parse(result.stdout)).toMatchObject({ reads: 1, result: 'rejected-mixed-manifest-and-audio' })
}, 40000)
