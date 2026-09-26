import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

const patchPath = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))

it('keeps the harness identity line out of every product agent prompt', () => {
  // The model repeats its own system prompt to the team, so the product must not
  // tell it that it is powered by the upstream harness.
  const patch = loadOverlayPatches('muse-med', patchPath).find(row => row.id === 'system-prompt')
  expect(patch?.config).toMatchObject({ includeHarnessIdentity: false })
  // A patch replaces the whole config, so the base bundle's own persona prefix has
  // to be restated rather than silently dropped.
  expect(patch?.config).toHaveProperty('personaPrefix')
})
