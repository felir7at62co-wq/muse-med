import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

const patchPath = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))

it('keeps the bundled Feishu bridge inert until this product configures credentials', () => {
  // The bridge defaults to auto-registering an app over QR and to cross-instance
  // sync in its own package; the product row must override both, and a patch
  // replaces the whole config, so credentials stay out of it on purpose.
  const patch = loadOverlayPatches('dsh desktop', patchPath).find(row => row.id === 'feishu-channel')
  expect(patch?.config).toMatchObject({
    enabled: false,
    autoRegistration: false,
    crossInstanceSync: false,
    requireMention: true,
  })
  // Credentials are entered in this product's own settings namespace; inheriting
  // a host environment variable would silently reuse another deployment's app.
  expect(patch?.config).not.toHaveProperty('appId')
  expect(patch?.config).not.toHaveProperty('appSecret')
})
