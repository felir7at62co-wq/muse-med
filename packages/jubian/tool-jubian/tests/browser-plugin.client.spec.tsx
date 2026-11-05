// @vitest-environment jsdom
/**
 * The page's registration into the real Settings registry, the generated
 * `jubianToken` namespace this plugin mounts itself, and the injected face it
 * hands its component.
 *
 * The registry is the production `SlotRegistry`, the declaring parent is
 * registered the same way the Settings shell registers it, and the locale is a
 * real `LocaleRuntime` — so what this asserts is the behavior a booting client
 * gets, not a hand-built context. The Remote service is the one substitute: its
 * `$mount` records the contribution and provides the namespace the plugin then
 * declares, which is exactly what the Gateway does.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { JubianTokenSection } from '../src/client/JubianTokenSection.tsx'
import type { JubianTokenInjected } from '../src/client/JubianTokenSection.tsx'
import { inject, mountJubianTokenSettings, NS } from '../src/client/mount.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-tool-jubian', descriptors: [] }

/**
 * One live client root with the real slot registry, locale runtime, and a
 * Remote service standing in for the Gateway.
 * @param face - the namespace methods the injected face calls.
 * @returns the booted bench plus its mount bookkeeping.
 */
async function bench(face: {
  describe?: () => Promise<unknown>
  set?: (value: string) => Promise<unknown>
  unset?: () => Promise<unknown>
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const disposeMount = vi.fn(() => Promise.resolve())
  const mount = vi.fn((_contribution: unknown) => Promise.resolve(disposeMount))
  ctx.provide('remote', {
    $mount: mount,
    get jubianToken(): unknown {
      const namespace: unknown = ctx.get('remote.jubianToken')
      return namespace
    },
  })
  ctx.provide('remote.jubianToken', {
    describe: face.describe ?? (async () => ({ ok: true, value: { configured: false, writable: true } })),
    set: face.set ?? (async () => ({ ok: true, value: { configured: true, source: 'file', writable: true } })),
    unset: face.unset ?? (async () => ({ ok: true, value: { configured: false, writable: true } })),
  })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, mount, disposeMount }
}

/** Stand in for the Settings shell's declaration of the section slot. */
function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

/** The face one registration handed its component. */
function injectedOf(slots: SlotRegistry): JubianTokenInjected {
  return slots.entries('settings.section')[0]!.inject!() as JubianTokenInjected & Record<string, unknown>
}

describe('tool-jubian browser plugin', () => {

  it.each(['desktop', 'workspace', 'absent'] as const)('forwards project recovery operations with the %s directory chooser', async (chooser) => {
    const b = await bench()
    const report = { idempotencyKey: 'video', taskId: 1, status: 'awaiting_review' as const,
      digest: 'digest', mediaChecks: [], decision: null }
    const status = { enabled: false, configurable: true, decoderAvailable: true, reports: [report] }
    const face = {
      status: vi.fn(async () => ({ ok: true as const, value: status })),
      configure: vi.fn(async () => ({ ok: true as const, value: status })),
      review: vi.fn(async () => ({ ok: true as const, value: report })),
      adopt: vi.fn(async () => ({ ok: true as const, value: report })),
      createDraft: vi.fn(async () => ({ ok: true as const, value: report })),
      verifyExport: vi.fn(async () => ({ ok: true as const, value: report })),
      deliverApprovedClip: vi.fn(async () => ({ ok: true as const, value: report })),
      deliverApprovedMp4: vi.fn(async () => ({ ok: true as const, value: report })),
      deliverApprovedEpisode: vi.fn(async () => ({ ok: true as const, value: {
        episode: 1, approvedShots: 1, totalShots: 1, readiness: 'ready' as const, missing: [],
      } })),
    }
    b.ctx.provide('remote.jubianVideoRecovery', face)
    const desktopPick = vi.fn(async () => '/desktop')
    const workspacePick = vi.fn(async () => '/workspace')
    if (chooser !== 'absent') b.ctx.provide('uiWorkspace', { pickDirectory: workspacePick } as never)
    if (chooser === 'desktop') vi.stubGlobal('__DSH_DIRECTORY_PICKER__', { pick: desktopPick })
    try {
      declare(b.slots)
      await mountJubianTokenSettings(b.ctx, REMOTE)
      const controls = injectedOf(b.slots).recovery!
      expect(injectedOf(b.slots).recovery).toBe(controls)
      await controls.status()
      await controls.configure({ enabled: true, projectDir: '/project' })
      const target = { idempotencyKey: 'video', digest: 'digest' }
      const review = { ...target, action: 'approve' as const, reason: '' }
      const media = { ...target, path: 'exports/video.mp4' }
      await controls.review(review)
      await controls.adopt(media)
      await controls.createDraft(target)
      await controls.verifyExport(media)
      await controls.deliverApprovedClip(target)
      await controls.deliverApprovedMp4(target)
      await controls.deliverApprovedEpisode({ episode: 1, digest: 'episode-digest' })
      expect(face.status).toHaveBeenCalledOnce()
      expect(face.configure).toHaveBeenCalledWith({ enabled: true, projectDir: '/project' })
      expect(face.review).toHaveBeenCalledWith(review)
      expect(face.adopt).toHaveBeenCalledWith(media)
      expect(face.createDraft).toHaveBeenCalledWith(target)
      expect(face.verifyExport).toHaveBeenCalledWith(media)
      expect(face.deliverApprovedClip).toHaveBeenCalledWith(target)
      expect(face.deliverApprovedMp4).toHaveBeenCalledWith(target)
      expect(face.deliverApprovedEpisode).toHaveBeenCalledWith({ episode: 1, digest: 'episode-digest' })
      if (chooser === 'absent') expect(controls.pickDirectory).toBeUndefined()
      else expect(await controls.pickDirectory!()).toBe(chooser === 'desktop' ? '/desktop' : '/workspace')
      expect(workspacePick).toHaveBeenCalledTimes(chooser === 'workspace' ? 1 : 0)
      expect(desktopPick).toHaveBeenCalledTimes(chooser === 'desktop' ? 1 : 0)
    } finally {
      vi.unstubAllGlobals()
      await b.ctx.fiber.dispose()
    }
  })
  it('declares the slot registry, the locale, and the Remote service it mounts into', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote'])
  })

  it('mounts the generated namespace and registers the page with localized nav copy', async () => {
    const b = await bench()
    declare(b.slots)
    const dispose = await mountJubianTokenSettings(b.ctx, REMOTE)

    expect(b.mount).toHaveBeenCalledWith(REMOTE)
    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(JubianTokenSection)
    expect(entry.options).toMatchObject({ id: 'jubian', order: 16 })
    expect(entry.locale).toBe(NS)
    expect(NS).toBe('settings.jubian')
    expect(resolveSlotLabel(entry.options.label)).toBe('剧变')

    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('Jubian')

    await dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(b.disposeMount).toHaveBeenCalledOnce()
    // The dictionary disposer ran with the registration: the (ns, locale) seat is free again.
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })

  it('hands its component the namespace methods, unwrapped into value outcomes', async () => {
    const b = await bench({
      describe: async () => ({ ok: true, value: { configured: true, source: 'user-env', writable: true } }),
      set: async () => ({ ok: true, value: { configured: true, source: 'file', writable: false } }),
      unset: async () => ({ ok: false, error: { code: 'credential/rejected', message: 'shadowed' } }),
    })
    declare(b.slots)
    await mountJubianTokenSettings(b.ctx, REMOTE)

    const injected = injectedOf(b.slots)
    await expect(injected.describe()).resolves.toEqual({
      ok: true,
      status: { configured: true, source: 'user-env', writable: true },
    })
    await expect(injected.set('a-token')).resolves.toEqual({
      ok: true,
      status: { configured: true, source: 'file', writable: false },
    })
    await expect(injected.unset()).resolves.toEqual({
      ok: false,
      code: 'credential/rejected',
      message: 'shadowed',
    })
    await b.ctx.fiber.dispose()
  })

  it('follows a late slot declaration and releases the namespace when registration fails', async () => {
    const late = await bench()
    const pending = mountJubianTokenSettings(late.ctx, REMOTE)
    await Promise.resolve()
    expect(late.slots.entries('settings.section')).toHaveLength(0)

    declare(late.slots)
    const dispose = await pending
    await vi.waitFor(() => { expect(late.slots.entries('settings.section')).toHaveLength(1) })
    await dispose()
    await late.ctx.fiber.dispose()

    const failing = await bench()
    declare(failing.slots)
    vi.spyOn(failing.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot registration failed') })
    await expect(mountJubianTokenSettings(failing.ctx, REMOTE)).rejects.toThrow('slot registration failed')
    expect(failing.mount).toHaveBeenCalledOnce()
    expect(failing.disposeMount).toHaveBeenCalledOnce()
    await failing.ctx.fiber.dispose()
  })
})
