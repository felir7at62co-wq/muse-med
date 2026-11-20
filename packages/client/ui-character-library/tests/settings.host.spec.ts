/** Loader-owned live settings stay readable without exposing a generated editor. */
import { expect, it } from 'vitest'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as CharacterLibrary from '../src/index.ts'

it('projects the Host interval and removes its presentation policy across disable and reload', async () => {
  const { ctx } = await configurationFixture({ hmr: false, rows: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'ui-character-library', name: 'cordis:character-library', config: { syncIntervalMs: 1000 } },
  ], builtins: { 'character-library': CharacterLibrary } })
  await ctx.loader.await()
  const read = () => ctx.settings.describe().find(view => view.ns === 'ui-character-library')
  expect(read()).toMatchObject({ value: { syncIntervalMs: 1000 }, autoGenerate: false, applies: 'live' })
  await ctx.settings.update('ui-character-library', { syncIntervalMs: 2000 })
  expect(read()).toMatchObject({ value: { syncIntervalMs: 2000 }, autoGenerate: false })
  const entry = ctx.configEditor.entries().find(value => value.options.id === 'ui-character-library')!
  await entry.update({ disabled: true })
  expect(read()).toBeUndefined()
  await entry.update({ disabled: false })
  await ctx.loader.await()
  expect(read()).toMatchObject({ value: { syncIntervalMs: 2000 }, autoGenerate: false })
})
