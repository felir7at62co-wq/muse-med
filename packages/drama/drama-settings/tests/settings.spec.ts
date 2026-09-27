/**
 * The Host half: the durable `drama-settings` section as the settings service
 * resolves it.
 *
 * The bench is the real settings service over a real profile patch, because that
 * is where this row can disappear: the service builds one namespace per composed
 * entry and skips an entry whose schema declares no volatile field, so a section
 * without them leaves the Settings page without a namespace, refuses every write,
 * and silently blinds the per-series ceiling and the pinned image route. The
 * defaults asserted here are the ones a client reads, and the rejections are the
 * ones a write really reports.
 */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import {
  DEFAULT_BGM_DIR, DEFAULT_DELIVERY_SPEC, DEFAULT_JIANYING_DRAFT_DIR, DRAMA_SETTINGS_DEFAULTS,
  DRAMA_SETTINGS_NAMESPACE, DramaSettingsSchema, apply,
} from '../src/index.ts'
import { DRAMA_SETTINGS_FIELDS } from '../src/settings.ts'

/** The real profile composition with this row mounted under the id every reader addresses. */
function bench() {
  return configurationFixture({
    rows: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: DRAMA_SETTINGS_NAMESPACE, name: 'cordis:drama' },
    ],
    builtins: { drama: { Config: DramaSettingsSchema, apply } },
  })
}

/** The section the settings service resolves for this row, or undefined while it serves none. */
function section(ctx: Context): Record<string, unknown> | undefined {
  const row = ctx.settings.describe().find(candidate => candidate.ns === DRAMA_SETTINGS_NAMESPACE)
  return row?.value as Record<string, unknown> | undefined
}

/** The form fields the Settings page and the transport receive. */
function formFields(ctx: Context): string[] {
  const row = ctx.settings.describe().find(candidate => candidate.ns === DRAMA_SETTINGS_NAMESPACE)
  // A serialized schema is a root uid plus the flat reference table it points into.
  const document = row?.schema as { uid?: number; refs?: Record<string, { dict?: Record<string, unknown> }> } | undefined
  const root = document?.uid === undefined ? undefined : document.refs?.[String(document.uid)]
  return Object.keys(root?.dict ?? {})
}

it('serves the drama section as a live namespace carrying every editable field', async () => {
  const { ctx } = await bench()
  const row = ctx.settings.describe().find(candidate => candidate.ns === DRAMA_SETTINGS_NAMESPACE)
  expect(row).toBeDefined()
  expect(row?.applies).toBe('live')
  // This row renders its own page, so the generated form must stay off.
  expect(row?.autoGenerate).toBe(false)
  expect(formFields(ctx)).toEqual([...DRAMA_SETTINGS_FIELDS])
})

it('does not assume the author’s Jianying root on another machine', async () => {
  const { ctx } = await bench()
  expect(section(ctx)).toMatchObject({ jianyingDraftDir: '' })
})

it('resolves every field to its documented default while the document holds no section', async () => {
  const { ctx } = await bench()
  expect(section(ctx)).toEqual({
    deliveryDir: '',
    jianyingDraftDir: DEFAULT_JIANYING_DRAFT_DIR,
    deliverySpec: { width: 1440, height: 2560, fps: 60, minBitrateMbps: 4.6 },
    bgmDir: DEFAULT_BGM_DIR,
    seriesBudgetCents: 400000,
  })
  // The volatile delivery spec is one live reference over the shared default
  // object, so reading it out must leave that object itself untouched.
  expect(DRAMA_SETTINGS_DEFAULTS.deliverySpec).toBe(DEFAULT_DELIVERY_SPEC)
  expect(plainConfig(DramaSettingsSchema({}))).toEqual(DRAMA_SETTINGS_DEFAULTS)
})

it('accepts a partial section and keeps the defaults under the fields it omits', async () => {
  const { ctx } = await bench()
  await ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, {
    deliveryDir: 'D:\\deliveries',
    deliverySpec: { fps: 30 },
  })
  expect(section(ctx)).toEqual({
    deliveryDir: 'D:\\deliveries',
    jianyingDraftDir: DEFAULT_JIANYING_DRAFT_DIR,
    deliverySpec: { width: 1440, height: 2560, fps: 30, minBitrateMbps: 4.6 },
    bgmDir: DEFAULT_BGM_DIR,
    seriesBudgetCents: 400000,
  })
})

it('carries the pinned image-route row, and refuses a value that is not a row id', async () => {
  const { ctx } = await bench()
  expect(section(ctx)).not.toHaveProperty('imageStandardId', expect.anything())
  await ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { imageStandardId: 66 })
  expect(section(ctx)).toMatchObject({ imageStandardId: 66 })
  await expect(ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { imageStandardId: 0 })).rejects.toThrow()
  await expect(ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { imageStandardId: 6.5 })).rejects.toThrow()
  await ctx.settings.replace(DRAMA_SETTINGS_NAMESPACE, {})
  expect(section(ctx)).toEqual(DRAMA_SETTINGS_DEFAULTS)
})

it('accepts a zero budget and refuses unsafe, negative and fractional cents', async () => {
  const { ctx } = await bench()
  await ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { seriesBudgetCents: 0 })
  expect(section(ctx)).toMatchObject({ seriesBudgetCents: 0 })
  await ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { seriesBudgetCents: Number.MAX_SAFE_INTEGER })
  expect(section(ctx)).toMatchObject({ seriesBudgetCents: Number.MAX_SAFE_INTEGER })
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { seriesBudgetCents: value })).rejects.toThrow()
  }
  await ctx.settings.replace(DRAMA_SETTINGS_NAMESPACE, {})
  expect(section(ctx)).toMatchObject({ seriesBudgetCents: 400000 })
})

it('refuses a fractional frame count and a zero bitrate floor', async () => {
  const { ctx } = await bench()
  await expect(ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { deliverySpec: { fps: 29.97 } })).rejects.toThrow()
  await expect(ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { deliverySpec: { minBitrateMbps: 0 } })).rejects.toThrow()
})

it('clears a field back to its default through the settings reset path', async () => {
  const { ctx } = await bench()
  await ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { bgmDir: 'D:\\bgm' })
  expect(section(ctx)).toMatchObject({ bgmDir: 'D:\\bgm' })
  await ctx.settings.replace(DRAMA_SETTINGS_NAMESPACE, {})
  expect(section(ctx)).toEqual(DRAMA_SETTINGS_DEFAULTS)
})

it('removes the namespace with its fiber and mounts nothing without a settings provider', async () => {
  const { ctx } = await bench()
  const entry = ctx.configEditor.entries().find(row => row.options.id === DRAMA_SETTINGS_NAMESPACE)
  expect(entry).toBeDefined()
  await entry?.fiber?.dispose()
  expect(ctx.settings.describe().map(row => row.ns)).not.toContain(DRAMA_SETTINGS_NAMESPACE)

  const bare = new Context()
  await bare.plugin({ Config: DramaSettingsSchema, apply }).await()
  expect(bare.get('settings')).toBeUndefined()
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(
  ctx => ctx.plugin({ Config: DramaSettingsSchema, apply }),
))
