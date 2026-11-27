/** The shipped Desktop profile enables MediaKit through the Muse account gateway. */
import { join } from 'node:path'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

it('enables MediaKit post-processing on the Desktop Jubian tool', () => {
  const patches = loadOverlayPatches('muse-med', join(import.meta.dirname, '../config/desktop.cordis.patch.yml'))
  const rows = composeEntries([patches])
  expect(rows.filter(row => row.id === 'tool-jubian')).toEqual([
    expect.objectContaining({
      name: '@deepseek-ai/dsh-tool-jubian', config: expect.objectContaining({ mediaKitPostprocess: true }),
    }),
  ])
  const account = rows.find(row => row.id === 'muse-account')
  expect(account).toMatchObject({
    name: '@deepseek-ai/dsh-muse-account', config: { baseUrl: expect.anything() },
  })
  expect(account?.disabled).not.toBe(true)
})
