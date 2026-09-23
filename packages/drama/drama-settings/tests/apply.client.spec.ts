/**
 * The browser half's registration and write path over the real settings
 * transport: the production `SlotRegistry`, a real `LocaleRuntime`, and the
 * real settings-domain base (`ui-settings`) bound to a scripted
 * `remote.settings`.
 *
 * What this asserts is the behavior a booting client gets: one scope for the page,
 * a write that reaches the Host as path operations, a refused write that is
 * reported instead of thrown, and the entry leaving with the fiber.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { DramaSettingsSchema, DRAMA_SETTINGS_DEFAULTS, DRAMA_SETTINGS_NAMESPACE, type DramaSettings } from '../src/settings.ts'
import { DramaSettingsSection } from '../src/client/DramaSettingsSection.tsx'
import { DRAMA_COMPONENTS } from '../src/client/components.ts'
import { apply, inject, NS } from '../src/client/index.ts'
import { draftOf } from '../src/client/section.ts'

const SECTION_SLOT = 'settings.section'

/** Resolve the scripted user layer through the real schema, exactly as the Host does. */
function resolve(user: Record<string, unknown>): DramaSettings {
  // The scripted layer is a partial section; the schema fills the rest in.
  return DramaSettingsSchema(user as unknown as DramaSettings)
}

/** One namespace view over the scripted user layer, resolved through the real schema. */
function viewOf(user: Record<string, unknown>, revision: number) {
  return {
    ns: DRAMA_SETTINGS_NAMESPACE,
    schema: DramaSettingsSchema.toJSON(),
    value: resolve(user),
    user: { ...user },
    applies: 'live' as const,
    secrets: [],
    revision,
  }
}

/** The describe answer: every registered namespace plus the deployment facts around them. */
function documentOf(user: Record<string, unknown>, revision: number) {
  return { writable: true, hasDocument: true, namespaces: [viewOf(user, revision)] }
}

/**
 * One live client root: the real slot registry, locale, and settings scope
 * service over a scripted `remote.settings`.
 *
 * The wire contracts differ per method — `describe` answers the whole document
 * while a write answers the one namespace view it committed — and the scripted
 * faces keep that distinction, because the mirror folds a write answer without
 * re-reading.
 * @returns the booted bench and the scripted user layer it writes into.
 */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const user = new Map<string, JsonValue>()
  let revision = 0
  const describe = vi.fn(async () => ({ ok: true as const, value: documentOf(Object.fromEntries(user), revision) }))
  const mutate = vi.fn(async (_ns: string, ops: readonly SettingsPathOpView[]) => {
    revision += 1
    for (const op of ops) {
      const field = op.path[0]!
      if (op.op === 'set') user.set(field, op.value)
      else user.delete(field)
    }
    return { ok: true as const, value: viewOf(Object.fromEntries(user), revision) }
  })
  new TestRemote(ctx, { settings: { describe, mutate } })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, describe, mutate, user, revision: () => revision }
}

/** Stand in for the settings shell that declares the section slot. */
function declareSlots(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { [SECTION_SLOT]: { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

/** The page section registered by this plugin, or undefined. */
function sectionEntry(slots: SlotRegistry) {
  return slots.entries(SECTION_SLOT).find(entry => entry.component === DramaSettingsSection)
}

afterEach(() => { vi.restoreAllMocks() })

describe('drama-settings browser plugin', () => {
  it('declares the slot registry, the locale, and the settings scope service', () => {
    expect(inject).toEqual(['slots', 'locale', 'settingsScope'])
    expect(NS).toBe('settings.drama')
  })

  it('registers the page with localized copy and follows a late declaration', async () => {
    const late = await bench()
    const fiber = late.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(late.slots.entries(SECTION_SLOT)).toHaveLength(0)

    declareSlots(late.slots)
    await vi.waitFor(() => { expect(sectionEntry(late.slots)).toBeDefined() })
    const section = sectionEntry(late.slots)!
    expect(section.options).toMatchObject({ id: 'drama', order: 17 })
    expect(section.locale).toBe(NS)
    expect(resolveSlotLabel(section.options.label)).toBe('短剧')
    late.locale.setLocale('en')
    expect(resolveSlotLabel(sectionEntry(late.slots)!.options.label)).toBe('Short drama')

    await fiber.dispose()
    expect(late.slots.entries(SECTION_SLOT)).toHaveLength(0)
    // The dictionary disposer ran with the registration: the seat is free again.
    expect(() => late.locale.register(NS, 'zh', {})).not.toThrow()
    await late.ctx.fiber.dispose()
  })

  it('hands the page a namespace scope that is already resolved', async () => {
    const b = await bench()
    declareSlots(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const section = (sectionEntry(b.slots)!.inject as unknown as () => {
      hooks: { drama: { getSnapshot(): { value: unknown } } }
    })()
    expect(section.hooks.drama.getSnapshot().value).toEqual(DRAMA_SETTINGS_DEFAULTS)
  })

  it('writes only the fields the draft changed, and clears one that returns to its default', async () => {
    const b = await bench()
    declareSlots(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (sectionEntry(b.slots)!.inject as unknown as () => {
      write: (draft: ReturnType<typeof draftOf>) => Promise<string>
    })()

    const outcome = await face.write({
      ...draftOf(DRAMA_SETTINGS_DEFAULTS),
      deliveryDir: 'D:\\out',
      bgmDir: 'D:\\bgm',
    })

    expect(outcome).toBe('saved')
    expect(b.mutate).toHaveBeenCalledWith(DRAMA_SETTINGS_NAMESPACE, [
      { op: 'set', path: ['deliveryDir'], value: 'D:\\out' },
      { op: 'set', path: ['bgmDir'], value: 'D:\\bgm' },
    ], expect.anything())
    expect(Object.fromEntries(b.user)).toEqual({ deliveryDir: 'D:\\out', bgmDir: 'D:\\bgm' })

    const cleared = await face.write(draftOf(DRAMA_SETTINGS_DEFAULTS))
    expect(cleared).toBe('saved')
    expect(b.mutate).toHaveBeenLastCalledWith(DRAMA_SETTINGS_NAMESPACE, [
      { op: 'unset', path: ['deliveryDir'] },
      { op: 'unset', path: ['bgmDir'] },
    ], expect.anything())
    expect(Object.fromEntries(b.user)).toEqual({})
    await b.ctx.fiber.dispose()
  })

  it('sends nothing for a spec box that holds no number', async () => {
    const b = await bench()
    declareSlots(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (sectionEntry(b.slots)!.inject as unknown as () => {
      write: (draft: ReturnType<typeof draftOf>) => Promise<string>
    })()

    expect(await face.write({ ...draftOf(DRAMA_SETTINGS_DEFAULTS), fps: 'fast' })).toBe('invalid')
    expect(b.mutate).not.toHaveBeenCalled()
    expect(await face.write({ ...draftOf(DRAMA_SETTINGS_DEFAULTS), seriesBudgetYuan: '' })).toBe('invalid')
    expect(b.mutate).not.toHaveBeenCalled()
  })

  it('restores every field to its default in one write', async () => {
    const b = await bench()
    declareSlots(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (sectionEntry(b.slots)!.inject as unknown as () => {
      restoreDefaults: () => Promise<string>
    })()

    expect(await face.restoreDefaults()).toBe('saved')
    expect(b.mutate).toHaveBeenCalledWith(DRAMA_SETTINGS_NAMESPACE, [
      { op: 'unset', path: ['deliveryDir'] },
      { op: 'unset', path: ['jianyingDraftDir'] },
      { op: 'unset', path: ['deliverySpec'] },
      { op: 'unset', path: ['bgmDir'] },
      { op: 'unset', path: ['imageStandardId'] },
      { op: 'unset', path: ['seriesBudgetCents'] },
    ], expect.anything())
    await b.ctx.fiber.dispose()
  })

  it('pins the chosen image-route row as its own write and clears it again', async () => {
    const b = await bench()
    declareSlots(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (sectionEntry(b.slots)!.inject as unknown as () => {
      write: (draft: ReturnType<typeof draftOf>) => Promise<string>
    })()

    expect(await face.write({ ...draftOf(DRAMA_SETTINGS_DEFAULTS), imageStandardId: '66' })).toBe('saved')
    expect(b.mutate).toHaveBeenCalledWith(DRAMA_SETTINGS_NAMESPACE, [
      { op: 'set', path: ['imageStandardId'], value: 66 },
    ], expect.anything())
    expect(Object.fromEntries(b.user)).toEqual({ imageStandardId: 66 })

    expect(await face.write(draftOf(DRAMA_SETTINGS_DEFAULTS))).toBe('saved')
    expect(b.mutate).toHaveBeenLastCalledWith(DRAMA_SETTINGS_NAMESPACE, [
      { op: 'unset', path: ['imageStandardId'] },
    ], expect.anything())
    expect(Object.fromEntries(b.user)).toEqual({})
    await b.ctx.fiber.dispose()
  })

  it('reports a refused write instead of throwing it', async () => {
    const b = await bench()
    declareSlots(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (sectionEntry(b.slots)!.inject as unknown as () => {
      write: (draft: ReturnType<typeof draftOf>) => Promise<string>
    })()
    b.mutate.mockResolvedValueOnce({
      ok: false as const,
      error: { code: 'settings/rejected', message: 'denied', details: {} },
    } as never)
    const outcome = await face.write({ ...draftOf(DRAMA_SETTINGS_DEFAULTS), bgmDir: 'D:\\bgm' })
    expect(outcome).toBe('rejected')
    // The refused write left the document alone, which is why the page says so.
    expect(Object.fromEntries(b.user)).toEqual({})
    await b.ctx.fiber.dispose()
  })

  it('reports every composed package as unqueryable while no plugin inventory is composed', async () => {
    const b = await bench()
    declareSlots(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (sectionEntry(b.slots)!.inject as unknown as () => {
      components: () => Promise<readonly { status: string }[]>
    })()

    const states = await face.components()
    expect(states).toHaveLength(DRAMA_COMPONENTS.length)
    expect(states.every(state => state.status === 'unknown')).toBe(true)
    await b.ctx.fiber.dispose()
  })

  it('reads the composed packages’ state from the optional inventory namespace', async () => {
    const b = await bench()
    declareSlots(b.slots)
    const list = vi.fn(async () => ({
      ok: true as const,
      value: {
        entries: [
          { entryId: '@deepseek-ai/dsh-perception-bgm', moduleName: '@deepseek-ai/dsh-perception-bgm', enabled: true, fiberPhase: 'active' as const },
        ],
        agentPresets: [{
          id: 'short-drama',
          trust: 'system' as const,
          isDefault: false,
          rows: [
            { entryId: 'drama-gate', moduleName: '@deepseek-ai/dsh-guard-drama', enabled: true, fiberPhase: 'active' as const },
            { entryId: 'tool-shot-script', moduleName: '@deepseek-ai/dsh-tool-shot-script', enabled: false, fiberPhase: 'active' as const },
          ],
        }],
      },
    }))
    b.ctx.provide('remote.pluginInventory', { list })
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (sectionEntry(b.slots)!.inject as unknown as () => {
      components: () => Promise<readonly { component: { pkg: string }; status: string }[]>
    })()

    const states = await face.components()
    const statusOf = (pkg: string): string | undefined =>
      states.find(state => state.component.pkg === pkg)?.status
    expect(list).toHaveBeenCalledOnce()
    expect(statusOf('@deepseek-ai/dsh-guard-drama')).toBe('loaded')
    expect(statusOf('@deepseek-ai/dsh-tool-shot-script')).toBe('inactive')
    expect(statusOf('@deepseek-ai/dsh-perception-bgm')).toBe('loaded')
    expect(statusOf('@deepseek-ai/dsh-tool-episode-render')).toBe('absent')
    await b.ctx.fiber.dispose()
  })

  it('treats a refused and a throwing inventory read as unqueryable', async () => {
    const refused = await bench()
    declareSlots(refused.slots)
    refused.ctx.provide('remote.pluginInventory', {
      list: async () => ({ ok: false as const, error: { code: 'gateway/unavailable', message: 'no' } }),
    })
    await refused.ctx.plugin({ inject: [...inject], apply }).await()
    const refusedFace = (sectionEntry(refused.slots)!.inject as unknown as () => {
      components: () => Promise<readonly { status: string }[]>
    })()
    expect((await refusedFace.components()).every(state => state.status === 'unknown')).toBe(true)
    await refused.ctx.fiber.dispose()

    const broken = await bench()
    declareSlots(broken.slots)
    broken.ctx.provide('remote.pluginInventory', {
      list: async () => { throw new Error('the inventory carrier died') },
    })
    await broken.ctx.plugin({ inject: [...inject], apply }).await()
    const brokenFace = (sectionEntry(broken.slots)!.inject as unknown as () => {
      components: () => Promise<readonly { status: string }[]>
    })()
    expect((await brokenFace.components()).every(state => state.status === 'unknown')).toBe(true)
    await broken.ctx.fiber.dispose()
  })

  it('reports the image route as unavailable while no Jubian namespace is composed', async () => {
    const b = await bench()
    declareSlots(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (sectionEntry(b.slots)!.inject as unknown as () => {
      imageRoutes: () => Promise<{ status: string }>
    })()

    await expect(face.imageRoutes()).resolves.toEqual({ status: 'unavailable' })
    await b.ctx.fiber.dispose()
  })

  it('reads the payable rows from the optional Jubian image-route namespace', async () => {
    const b = await bench()
    declareSlots(b.slots)
    const routes = vi.fn(async () => ({ ok: true as const, value: { candidates: [
      { standardId: 66, platformId: 'KU_AI', unitPrice: 0.12, unit: '元/条' },
    ] } }))
    // Provided after the page mounts, which is how a bundled neighbour may arrive.
    b.ctx.provide('remote.jubianImage', { routes })
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (sectionEntry(b.slots)!.inject as unknown as () => {
      imageRoutes: () => Promise<{ status: string; routes?: readonly { standardId: number }[] }>
    })()

    await expect(face.imageRoutes()).resolves.toEqual({ status: 'ok', routes: [
      { standardId: 66, platformId: 'KU_AI', unitPrice: 0.12, unit: '元/条' },
    ] })
    expect(routes).toHaveBeenCalledOnce()
    await b.ctx.fiber.dispose()
  })

  it('reports a refused and a throwing image-route read with their own reason', async () => {
    const refused = await bench()
    declareSlots(refused.slots)
    refused.ctx.provide('remote.jubianImage', {
      routes: async () => ({ ok: false as const,
        error: { code: 'jubian-image/catalogue-unreadable', message: 'no token' } }),
    })
    await refused.ctx.plugin({ inject: [...inject], apply }).await()
    const refusedFace = (sectionEntry(refused.slots)!.inject as unknown as () => {
      imageRoutes: () => Promise<{ status: string; message?: string }>
    })()
    await expect(refusedFace.imageRoutes()).resolves.toEqual({
      status: 'failed', message: 'jubian-image/catalogue-unreadable: no token' })
    await refused.ctx.fiber.dispose()

    const broken = await bench()
    declareSlots(broken.slots)
    broken.ctx.provide('remote.jubianImage', {
      routes: async () => { throw new Error('the Remote carrier died') },
    })
    await broken.ctx.plugin({ inject: [...inject], apply }).await()
    const brokenFace = (sectionEntry(broken.slots)!.inject as unknown as () => {
      imageRoutes: () => Promise<{ status: string; message?: string }>
    })()
    await expect(brokenFace.imageRoutes()).resolves.toEqual({
      status: 'failed', message: 'the Remote carrier died' })
    await broken.ctx.fiber.dispose()
  })
})
