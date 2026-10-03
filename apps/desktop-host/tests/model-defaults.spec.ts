/** Desktop model defaults keep the native provider available for explicit user configuration. */
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches, composeEntries } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'
import LlmRuntime from '../../../packages/llm/llm/src/index.ts'
import * as DeepSeekApiKey from '../../../packages/llm/llm-deepseek-api-key/src/index.ts'
import { credentialRef } from '../../../packages/credentials/credentials/src/index.ts'
import { MemoryCredentials } from '../../../packages/credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../packages/settings/settings/tests/configuration-fixture.ts'

async function fixture() {
  const defaults = loadOverlayPatches('muse-default-models', fileURLToPath(new URL(
    '../config/defaults.cordis.patch.yml', import.meta.url,
  ))).filter(patch => patch.id === 'llm-deepseek')
  const rows = composeEntries([[{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'credentials', name: 'cordis:credentials' },
    { id: 'llm', name: 'cordis:llm' },
    { id: 'llm-deepseek', name: 'cordis:deepseek' },
  ] }], defaults])
  return await configurationFixture({ hmr: false, rows,
    builtins: { llm: LlmRuntime, credentials: MemoryCredentials, deepseek: DeepSeekApiKey } })
}

it('offers no unconfigured native DeepSeek model in a fresh Muse profile', async () => {
  const { ctx } = await fixture()
  expect(await ctx.llm.listModels('deepseek-official')).toEqual([])
  expect(ctx.llm.listConfigurableProviders()).toContainEqual({
    provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [],
  })
  expect(await ctx.credentials.describe(credentialRef('DEEPSEEK_API_KEY'))).toMatchObject({ configured: false })
})

it('lets users configure their own native model and credential and keeps the model after restart', async () => {
  const { ctx, start } = await fixture()
  const defaultModels = await ctx.llm.listModels('deepseek-official')
  expect(defaultModels).toEqual([])
  const model = { id: 'user-deepseek-model', name: 'Personal DeepSeek' }
  await ctx.settings.mutate('llm-deepseek', [
    { op: 'set', path: ['models'], value: [model] },
    { op: 'set', path: ['apiKeyEnv'], value: 'OWN_DEEPSEEK_KEY' },
  ])
  await ctx.credentials.set(credentialRef('OWN_DEEPSEEK_KEY'), 'synthetic-personal-key')
  expect(await ctx.credentials.describe(credentialRef('OWN_DEEPSEEK_KEY'))).toMatchObject({ configured: true })
  expect(await ctx.credentials.describe(credentialRef('DEEPSEEK_API_KEY'))).toMatchObject({ configured: false })
  const catalog = await ctx.llm.listModels('deepseek-official')
  expect(catalog).toHaveLength(1)
  expect(catalog[0]).toMatchObject({ ...model, provider: 'deepseek-official' })
  await expect(`${JSON.stringify({ defaultModels, customModels: catalog }, null, 2)}\n`)
    .toMatchFileSnapshot(fileURLToPath(new URL('./expected/model-defaults.json', import.meta.url)))
  expect(ctx.settings.describe().find(view => view.ns === 'llm-deepseek')?.value)
    .toMatchObject({ models: [expect.objectContaining(model)], apiKeyEnv: 'OWN_DEEPSEEK_KEY' })
  await ctx.fiber.dispose()
  const restored = await start()
  expect(await restored.llm.listModels('deepseek-official')).toEqual(catalog)
})
