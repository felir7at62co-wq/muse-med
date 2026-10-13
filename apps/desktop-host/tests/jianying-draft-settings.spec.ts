/** Desktop bundle ownership keeps Jianying settings editable through the real Loader. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { DramaSettingsSchema, DRAMA_SETTINGS_NAMESPACE, apply } from '@deepseek-ai/dsh-drama-settings'
import SettingsController from '../../../packages/api/settings-controller/src/index.ts'
import { configurationFixture } from '../../../packages/settings/settings/tests/configuration-fixture.ts'
import { draftDirectory } from '../../../packages/drama/drama-settings/src/draft-directory.ts'

const defaults = loadOverlayPatches('muse-med', fileURLToPath(new URL('../config/defaults.cordis.patch.yml', import.meta.url)))
const product = loadOverlayPatches('muse-med', fileURLToPath(new URL('../config/desktop.cordis.patch.yml', import.meta.url)))
const dramaRows = defaults.flatMap(patch => patch.insert ?? []).filter(row => row.id === DRAMA_SETTINGS_NAMESPACE)
const dramaOverlays = product.filter(patch => patch.id === DRAMA_SETTINGS_NAMESPACE
  || patch.insert?.some(row => row.id === DRAMA_SETTINGS_NAMESPACE))

/** Mount the shipped settings row with the production settings provider and profile editor. */
async function bench(extraOverlays: PatchOptions[] = []) {
  const fixture = await configurationFixture({ hmr: false, rows: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    ...dramaRows.map(row => ({ ...row, name: 'cordis:drama' })),
  ], builtins: { drama: { Config: DramaSettingsSchema, apply } } })
  await fixture.ctx.fiber.dispose()
  Object.assign(fixture.profile, { overlays: [...dramaOverlays, ...extraOverlays] })
  const ctx = await fixture.start()
  return { ...fixture, ctx, controller: new SettingsController(ctx) }
}

it('declares one drama settings row below profile edits in the shipped Desktop layers', () => {
  expect(dramaRows).toEqual([{ id: DRAMA_SETTINGS_NAMESPACE, name: '@deepseek-ai/dsh-drama-settings' }])
  expect(dramaOverlays).toEqual([])
  const value = String.raw`D:\剪映用户\剪映草稿`
  const warnings: string[] = []
  const rows = composeEntries(
    [defaults, [{ id: DRAMA_SETTINGS_NAMESPACE, config: { jianyingDraftDir: value } }], product],
    message => warnings.push(message),
  )
  expect(rows.filter(row => row.id === DRAMA_SETTINGS_NAMESPACE)).toEqual([
    { id: DRAMA_SETTINGS_NAMESPACE, name: '@deepseek-ai/dsh-drama-settings', config: { jianyingDraftDir: value } },
  ])
  expect(warnings.filter(message => message.includes(DRAMA_SETTINGS_NAMESPACE))).toEqual([])
})

it.each([
  String.raw`C:\Users\mock-user\AppData\Local\JianyingPro\User Data\Projects\com.lveditor.draft`,
  String.raw`D:\剪映用户\剪映草稿`,
  'D:/剪映用户/剪映草稿/',
])('saves the draft path through the real Host and reads it after restart: %s', async (value) => {
  const { ctx, profile, controller, start } = await bench()
  const view = controller.describe().namespaces.find(row => row.ns === DRAMA_SETTINGS_NAMESPACE)!
  const saved = await controller.mutate(view.ns, [{ op: 'set', path: ['jianyingDraftDir'], value }], view.revision)
  expect(saved.value).toMatchObject({ jianyingDraftDir: value })
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('jianyingDraftDir:')
  await ctx.fiber.dispose()
  const restarted = await start()
  expect(restarted.settings.describe().find(row => row.ns === view.ns)?.value).toMatchObject({ jianyingDraftDir: value })
})

it.each(['home', 'overlay'] as const)('preserves an explicit %s override and refuses the profile write', async (layer) => {
  const pinned = { id: DRAMA_SETTINGS_NAMESPACE, config: { jianyingDraftDir: 'D:/pinned-mock-drafts' } }
  const { controller, home, profile } = await bench(layer === 'overlay' ? [pinned] : [])
  if (layer === 'home') writeFileSync(join(home, 'cordis.patch.yml'), JSON.stringify([pinned]))
  const before = readFileSync(profile.patchPath, 'utf8')
  await expect(controller.mutate(DRAMA_SETTINGS_NAMESPACE, [{ op: 'set', path: ['jianyingDraftDir'], value: 'D:/requested-mock-drafts' }], undefined))
    .rejects.toMatchObject({ code: 'settings/rejected', message: 'Configuration for "drama-settings" is overridden by a home patch or command-line overlay' })
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(controller.describe().namespaces.find(row => row.ns === DRAMA_SETTINGS_NAMESPACE)?.value).toMatchObject(pinned.config)
})

it('saves and validates a Chinese mock editor root without changing its existing contents', async () => {
  const { ctx, home, controller } = await bench()
  const root = join(home, '剪映用户', '剪映草稿')
  mkdirSync(root, { recursive: true })
  const sentinel = join(root, 'existing-draft.json')
  writeFileSync(sentinel, '{"keep":"原始草稿"}\n')
  const before = readFileSync(sentinel)
  await controller.mutate(DRAMA_SETTINGS_NAMESPACE, [{ op: 'set', path: ['jianyingDraftDir'], value: root }], undefined)
  expect(await draftDirectory(ctx.settings)).toEqual({ status: 'ready', path: normalize(root) })
  expect(readFileSync(sentinel)).toEqual(before)
  expect(readdirSync(root)).toEqual(['existing-draft.json'])
})

it('keeps relative, missing and file roots out of the validated draft tool setting', async () => {
  const { ctx, home, profile } = await bench()
  const file = join(home, 'not-a-directory')
  writeFileSync(file, 'keep')
  const before = readFileSync(profile.patchPath, 'utf8')
  for (const value of ['relative', join(home, 'missing-剪映草稿'), file]) {
    await expect(draftDirectory(ctx.settings, value)).rejects.toThrow()
    expect(await draftDirectory(ctx.settings)).toEqual({ status: 'unconfigured', path: '' })
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  }
  expect(readFileSync(file, 'utf8')).toBe('keep')
})
