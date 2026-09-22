/**
 * The Host half: the durable `drama` section as the settings service resolves it.
 *
 * The bench is the real settings service over an in-memory provider, so the
 * defaults asserted here are the ones a client reads, and the rejections are the
 * ones a write really reports.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_BGM_DIR, DEFAULT_DELIVERY_SPEC, DEFAULT_JIANYING_DRAFT_DIR, DRAMA_SETTINGS_DEFAULTS,
  DRAMA_SETTINGS_NAMESPACE, apply,
} from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

/** The Host plugin fiber over a real settings provider. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(MemorySettings).await()
  const fiber = ctx.plugin({ apply })
  await fiber.await()
  return { ctx, fiber }
}

describe('drama-settings host', () => {
  it('resolves every field to its documented default while the document holds no section', async () => {
    const { ctx } = await bench()
    expect(ctx.settings.get(DRAMA_SETTINGS_NAMESPACE)).toEqual({
      deliveryDir: '',
      jianyingDraftDir: DEFAULT_JIANYING_DRAFT_DIR,
      deliverySpec: { width: 1440, height: 2560, fps: 60, minBitrateMbps: 4.6 },
      bgmDir: DEFAULT_BGM_DIR,
    })
    expect(DRAMA_SETTINGS_DEFAULTS.deliverySpec).toBe(DEFAULT_DELIVERY_SPEC)
  })

  it('accepts a partial section and keeps the defaults under the fields it omits', async () => {
    const { ctx } = await bench()
    await ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, {
      deliveryDir: 'D:\\deliveries',
      deliverySpec: { fps: 30 },
    })
    expect(ctx.settings.get(DRAMA_SETTINGS_NAMESPACE)).toEqual({
      deliveryDir: 'D:\\deliveries',
      jianyingDraftDir: DEFAULT_JIANYING_DRAFT_DIR,
      deliverySpec: { width: 1440, height: 2560, fps: 30, minBitrateMbps: 4.6 },
      bgmDir: DEFAULT_BGM_DIR,
    })
  })

  it('carries the pinned image-route row, and refuses a value that is not a row id', async () => {
    const { ctx } = await bench()
    expect(ctx.settings.get(DRAMA_SETTINGS_NAMESPACE)).not.toHaveProperty('imageStandardId', expect.anything())
    await ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { imageStandardId: 66 })
    expect(ctx.settings.get(DRAMA_SETTINGS_NAMESPACE)).toMatchObject({ imageStandardId: 66 })
    await expect(ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { imageStandardId: 0 })).rejects.toThrow()
    await expect(ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { imageStandardId: 6.5 })).rejects.toThrow()
    await ctx.settings.replace(DRAMA_SETTINGS_NAMESPACE, {})
    expect(ctx.settings.get(DRAMA_SETTINGS_NAMESPACE)).toEqual(DRAMA_SETTINGS_DEFAULTS)
  })

  it('refuses a fractional frame count and a zero bitrate floor', async () => {
    const { ctx } = await bench()
    await expect(ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { deliverySpec: { fps: 29.97 } })).rejects.toThrow()
    await expect(ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { deliverySpec: { minBitrateMbps: 0 } })).rejects.toThrow()
  })

  it('clears a field back to its default through the settings reset path', async () => {
    const { ctx } = await bench()
    await ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { bgmDir: 'D:\\bgm' })
    expect(ctx.settings.get(DRAMA_SETTINGS_NAMESPACE)).toMatchObject({ bgmDir: 'D:\\bgm' })
    await ctx.settings.replace(DRAMA_SETTINGS_NAMESPACE, {})
    expect(ctx.settings.get(DRAMA_SETTINGS_NAMESPACE)).toEqual(DRAMA_SETTINGS_DEFAULTS)
  })

  it('removes the namespace with its fiber and mounts nothing without a settings provider', async () => {
    const { ctx, fiber } = await bench()
    expect(ctx.settings.describe().map(entry => entry.ns)).toContain(DRAMA_SETTINGS_NAMESPACE)
    await fiber.dispose()
    expect(ctx.settings.describe().map(entry => entry.ns)).not.toContain(DRAMA_SETTINGS_NAMESPACE)

    const bare = new Context()
    await bare.plugin({ apply }).await()
    expect(bare.get('settings')).toBeUndefined()
  })
})
