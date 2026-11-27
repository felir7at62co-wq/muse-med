/** The shipped Desktop profile enables MediaKit through the Muse account gateway. */
import { join } from 'node:path'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

it('enables MediaKit post-processing on the Desktop Jubian tool', () => {
  const patches = loadOverlayPatches('muse-med', join(import.meta.dirname, '../config/desktop.cordis.patch.yml'))
  const rows = composeEntries([patches])
  const jubian = rows.filter(row => row.id === 'tool-jubian')
  expect(jubian).toHaveLength(1)
  expect(jubian[0]).toMatchObject({
    name: '@deepseek-ai/dsh-tool-jubian', config: { mediaKitPostprocess: true },
  })
  const account = rows.find(row => row.id === 'muse-account')
  expect(account?.name).toBe('@deepseek-ai/dsh-muse-account')
  expect(account).toHaveProperty('config.baseUrl')
  expect(account?.disabled).not.toBe(true)
})
