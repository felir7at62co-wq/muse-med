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
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { StaticRemoteAccess, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { RemoteError, type RemoteResult, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConnectionGeneration } from '@deepseek-ai/dsh-client-connection/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ResourceRegistry } from '@deepseek-ai/dsh-client-resources/src/client/resources.ts'
import type { VideoArtifactSha256, VideoRecoveryDigest, VideoRecoveryReview, VideoRecoveryStatus } from '../src/types.ts'
import type { RecoveryClient } from '../src/client/recovery-directory.ts'
import type { RecoveryToastInjected } from '../src/client/VideoRecoverySection.tsx'
import { JubianTokenSection } from '../src/client/JubianTokenSection.tsx'
import type { JubianTokenInjected } from '../src/client/JubianTokenSection.tsx'
import { inject, mountJubianTokenSettings, NS } from '../src/client/mount.ts'
import { episodeClientFixture, input, original, unadmitted } from './fixtures/episode-client.client.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

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
    get jubianVideoRecovery(): unknown { const value: unknown = ctx.get('remote.jubianVideoRecovery'); return value },
    get jubianEpisodeDelivery(): unknown { const value: unknown = ctx.get('remote.jubianEpisodeDelivery'); return value },
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
    children: { 'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

/** The face one registration handed its component. */
function injectedOf(slots: SlotRegistry): JubianTokenInjected {
  return slots.entries('settings.section')[0]!.inject!() as JubianTokenInjected & Record<string, unknown>
}

describe('tool-jubian browser plugin', () => {
  it('declares the slot registry, the locale, and the Remote service it mounts into', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote'])
  })

  it('mounts the generated namespace and registers the page with localized nav copy', async () => {
    const b = await bench()
    declare(b.slots)
    const dispose = await mountJubianTokenSettings(b.ctx, REMOTE, 1000)

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
    await mountJubianTokenSettings(b.ctx, REMOTE, 1000)

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
    const pending = mountJubianTokenSettings(late.ctx, REMOTE, 1000)
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
    await expect(mountJubianTokenSettings(failing.ctx, REMOTE, 1000)).rejects.toThrow('slot registration failed')
    expect(failing.mount).toHaveBeenCalledOnce()
    expect(failing.disposeMount).toHaveBeenCalledOnce()
    await failing.ctx.fiber.dispose()
  })
})

const recoveryReport: VideoRecoveryReview = { idempotencyKey: 'original-key', taskId: 42, status: 'awaiting_review',
  digest: brandString<VideoRecoveryDigest>('a'.repeat(64)), decision: null,
  mediaChecks: [{ sha256: 'sha256:' + 'b'.repeat(64), video: true, audio: true }],
  source: { kind: 'provider', state: 'verified', path: 'video_tasks/review/original.mp4',
    sha256: brandString<VideoArtifactSha256>('b'.repeat(64)) } }
const recoveryStatus: VideoRecoveryStatus = { enabled: false, configurable: true, decoderAvailable: true,
  projectDir: '/project', reports: [recoveryReport] }
function ok<T>(value: T): RemoteResult<T> { return { ok: true, value } }
function recoveryClient(): RecoveryClient {
  return { status: vi.fn(async () => ok(recoveryStatus)),
    configure: vi.fn(async () => ok({ ...recoveryStatus, enabled: true })),
    review: vi.fn(async () => ok<VideoRecoveryReview>({ ...recoveryReport, decision: 'approve' })),
    adopt: vi.fn(async () => ok(recoveryReport)),
    deliverApprovedMp4: vi.fn(async () => ok(recoveryReport)) }
}

describe('recovery registration ownership', () => {
  it('binds only ready generations, retains rows on loss and retires namespace callbacks before reconnecting', async () => {
    const b = await bench(), generation = createSnapshotStore<ConnectionGeneration | undefined>(undefined)
    onTestFinished(() => b.ctx.fiber.dispose())
    declare(b.slots)
    b.ctx.provide('connection', { generation })
    const api = recoveryClient()
    let withdraw = b.ctx.provide('remote.jubianVideoRecovery', api)
    const unsubscribe = vi.spyOn(generation, 'subscribe')
    const dispose = await mountJubianTokenSettings(b.ctx, REMOTE, 1000)
    const face = injectedOf(b.slots)
    expect(face.hooks.recoveryState.getSnapshot().connected).toBe(false)
    expect(api.status).not.toHaveBeenCalled()
    generation.set({ id: 1, host: { home: '/home' } })
    await vi.waitFor(() => { expect(face.hooks.recoveryState.getSnapshot().status).toEqual(recoveryStatus) })
    expect(api.status).toHaveBeenCalledOnce()
    generation.set(undefined)
    expect(face.hooks.recoveryState.getSnapshot()).toMatchObject({ connected: false, status: { reports: [recoveryReport] } })
    generation.set({ id: 2, host: { home: '/home' } })
    await vi.waitFor(() => { expect(api.status).toHaveBeenCalledTimes(2) })
    const pending = Promise.withResolvers<RemoteResult<VideoRecoveryStatus>>()
    vi.mocked(api.status).mockImplementationOnce(() => pending.promise)
    await vi.waitFor(() => { expect(face.hooks.recoveryState.getSnapshot().busy).toBe(false) })
    const read = face.refreshRecovery()
    withdraw()
    await vi.waitFor(() => { expect(face.hooks.recoveryState.getSnapshot().connected).toBe(false) })
    const replacement = recoveryClient()
    vi.mocked(replacement.status).mockResolvedValue(ok({ ...recoveryStatus, enabled: true }))
    withdraw = b.ctx.provide('remote.jubianVideoRecovery', replacement)
    await vi.waitFor(() => { expect(face.hooks.recoveryState.getSnapshot().status?.enabled).toBe(true) })
    pending.resolve(ok({ ...recoveryStatus, projectDir: '/stale' }))
    await read
    expect(face.hooks.recoveryState.getSnapshot().status?.projectDir).toBe('/project')
    await dispose()
    const state = face.hooks.recoveryState.getSnapshot()
    generation.set({ id: 3, host: { home: '/retired' } })
    expect(face.hooks.recoveryState.getSnapshot()).toBe(state)
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    withdraw()
  })

  it('routes all five calls and leaves shell feedback mounted after the Settings slot disappears', async () => {
    const b = await bench(), api = recoveryClient()
    onTestFinished(() => b.ctx.fiber.dispose())
    b.slots.register({ name: 'root', children: { 'test.settings': { kind: 'single', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' } } } as never, () => null)
    const hideSettings = b.slots.register({ name: 'test.settings', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
    const generation = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: '/home' } })
    b.ctx.provide('connection', { generation })
    b.ctx.provide('remote.jubianVideoRecovery', api)
    await mountJubianTokenSettings(b.ctx, REMOTE, 1000)
    const face = injectedOf(b.slots)
    await vi.waitFor(() => { expect(face.hooks.recoveryState.getSnapshot().busy).toBe(false) })
    face.setRecoveryProjectDir('/project')
    face.openRecoveryAction('approve', recoveryReport)
    face.closeRecoveryDialog()
    expect(face.hooks.recoveryState.getSnapshot().dialog).toBeNull()
    await face.configureRecovery(true)
    expect(api.configure).toHaveBeenCalledWith({ enabled: true, projectDir: '/project' })
    face.openRecoveryAction('adopt', recoveryReport)
    await face.confirmRecoveryDialog(face.hooks.recoveryState.getSnapshot().dialog!.id, 'video_tasks/edit.mp4')
    expect(api.adopt).toHaveBeenCalledWith({ idempotencyKey: recoveryReport.idempotencyKey,
      digest: recoveryReport.digest, path: 'video_tasks/edit.mp4' })
    face.openRecoveryAction('approve', recoveryReport)
    await face.confirmRecoveryDialog(face.hooks.recoveryState.getSnapshot().dialog!.id, '')
    expect(api.review).toHaveBeenCalledWith({ idempotencyKey: recoveryReport.idempotencyKey,
      digest: recoveryReport.digest, action: 'approve' })
    const pending = Promise.withResolvers<RemoteResult<VideoRecoveryReview>>()
    vi.mocked(api.deliverApprovedMp4).mockImplementationOnce(() => pending.promise)
    const delivery = face.deliverRecovery(recoveryReport)
    hideSettings()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    const toast = b.slots.entries('shell.overlay')[0]!.inject!() as RecoveryToastInjected & Record<string, unknown>
    pending.resolve(ok(recoveryReport))
    await delivery
    expect(api.deliverApprovedMp4).toHaveBeenCalledWith({ idempotencyKey: recoveryReport.idempotencyKey, digest: recoveryReport.digest })
    expect(toast.hooks.recoveryNotice.getSnapshot().kind).toBe('delivered')
    toast.dismissRecoveryNotice(toast.hooks.recoveryNotice.getSnapshot().sequence)
    expect(toast.hooks.recoveryNotice.getSnapshot().kind).toBeNull()
  })

  it('withdraws an authorized picker and retains its rejection diagnostic without accepting an old selection', async () => {
    const b = await bench()
    onTestFinished(() => b.ctx.fiber.dispose())
    declare(b.slots)
    const generation = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: '/home' } })
    b.ctx.provide('connection', { generation })
    b.ctx.provide('remote.jubianVideoRecovery', recoveryClient())
    const pending = Promise.withResolvers<string | null>()
    const pick = vi.fn(() => pending.promise)
    vi.stubGlobal('__DSH_DIRECTORY_PICKER__', { pick })
    const access = b.ctx.plugin({ name: 'test-picker-access', apply(scope: Context) { new StaticRemoteAccess(scope) } })
    await access.await()
    await mountJubianTokenSettings(b.ctx, REMOTE, 1000)
    const face = injectedOf(b.slots)
    await vi.waitFor(() => { expect(face.hooks.recoveryState.getSnapshot().busy).toBe(false) })
    expect(face.hooks.recoveryState.getSnapshot().pickerAvailable).toBe(true)
    const choosing = face.chooseRecoveryProject()
    await access.dispose()
    expect(face.hooks.recoveryState.getSnapshot().pickerAvailable).toBe(false)
    pending.resolve('/old-picker')
    await choosing
    expect(face.hooks.recoveryState.getSnapshot().projectDir).toBe('/project')
    const denied = new Error('Picker access was revoked')
    vi.mocked(pick).mockRejectedValueOnce(denied)
    await b.ctx.plugin({ name: 'test-picker-restored', apply(scope: Context) { new StaticRemoteAccess(scope) } }).await()
    await face.chooseRecoveryProject()
    const toast = b.slots.entries('shell.overlay')[0]!.inject!() as RecoveryToastInjected & Record<string, unknown>
    expect(toast.hooks.recoveryNotice.getSnapshot()).toMatchObject({ kind: 'failed', reason: denied.message })
  })
})


it.each(['absent', 'unauthorized'] as const)('does not offer a native folder chooser when the Desktop bridge is %s', async (kind) => {
  const b = await bench(), pick = vi.fn(async () => '/picked-project')
  onTestFinished(() => b.ctx.fiber.dispose())
  declare(b.slots)
  if (kind === 'unauthorized') vi.stubGlobal('__DSH_DIRECTORY_PICKER__', { pick })
  await b.ctx.plugin({ name: 'test-picker-policy', apply(scope: Context) {
    new StaticRemoteAccess(scope, () => kind === 'absent')
  } }).await()
  b.ctx.provide('connection', { generation: createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: '/home' } }) })
  b.ctx.provide('remote.jubianVideoRecovery', recoveryClient())
  await mountJubianTokenSettings(b.ctx, REMOTE, 1000)
  const face = injectedOf(b.slots)
  await vi.waitFor(() => { expect(face.hooks.recoveryState.getSnapshot().busy).toBe(false) })
  expect(face.hooks.recoveryState.getSnapshot().pickerAvailable).toBe(false)
  await face.chooseRecoveryProject()
  expect(pick).not.toHaveBeenCalled()
})

it('binds explicit episode actions to the current connection and releases their resource providers on unload', async () => {
  const b = await bench(), f = episodeClientFixture()
  onTestFinished(() => b.ctx.fiber.dispose())
  declare(b.slots)
  const generation = createSnapshotStore<ConnectionGeneration | undefined>(undefined)
  const resources = new ResourceRegistry(b.ctx)
  b.ctx.provide('connection', { generation })
  b.ctx.provide('resources', resources)
  b.ctx.provide('remote.jubianEpisodeDelivery', f.api)
  vi.mocked(f.api.episodeStatus).mockResolvedValue({ ok: true, value: { ...original, canResume: true } })
    .mockResolvedValueOnce({ ok: true, value: unadmitted })
  const dispose = await mountJubianTokenSettings(b.ctx, REMOTE, 1000)
  const face = injectedOf(b.slots)
  expect(face.hooks.episodeState.getSnapshot().connected).toBe(false)
  generation.set({ id: 1, host: { home: '/home' } })
  await vi.waitFor(() => { expect(face.hooks.episodeState.getSnapshot().connected).toBe(true) })
  expect(f.api.episodeReadiness).not.toHaveBeenCalled()
  face.setEpisodeText('1')
  face.checkEpisode(input)
  await vi.waitFor(() => { expect(face.hooks.episodeState.getSnapshot().displayedStatus?.state).toBe('not-admitted') })
  await face.admitEpisode()
  expect(f.api.admitEpisode).toHaveBeenCalledExactlyOnceWith(input)
  await vi.waitFor(() => { expect(face.hooks.episodeState.getSnapshot().displayedStatus?.canResume).toBe(true) })
  vi.mocked(f.api.admitEpisode).mockResolvedValueOnce({ ok: false,
    error: new RemoteError('jubian-video-recovery/rejected', 'Original task cannot resume', {}) })
  await vi.waitFor(() => {
    expect(resources.source(face.hooks.episodeState.getSnapshot().statusAddress).getSnapshot().status).toBe('live')
  })
  await face.admitEpisode(true)
  expect(f.api.admitEpisode).toHaveBeenCalledTimes(2)
  expect(f.api.admitEpisode).toHaveBeenLastCalledWith({ ...input, resume: true })
  const toast = b.slots.entries('shell.overlay')[0]!.inject!() as RecoveryToastInjected & Record<string, unknown>
  expect(toast.hooks.recoveryNotice.getSnapshot()).toMatchObject({ kind: 'failed', reason: 'Original task cannot resume' })
  face.loadEpisodeHistory(input)
  await vi.waitFor(() => { expect(face.hooks.episodeState.getSnapshot().displayedHistory?.entries).toHaveLength(1) })
  face.selectEpisodeOriginal(input, face.hooks.episodeState.getSnapshot().historyAddress)
  await vi.waitFor(() => { expect(f.api.episodeStatus).toHaveBeenCalledTimes(4) })
  face.refreshEpisode()
  await vi.waitFor(() => { expect(f.api.episodeStatus).toHaveBeenCalledTimes(5) })
  generation.set(undefined)
  expect(face.hooks.episodeState.getSnapshot()).toMatchObject({ connected: false, target: input })
  generation.set({ id: 2, host: { home: '/home' } })
  await vi.waitFor(() => { expect(f.api.episodeStatus).toHaveBeenCalledTimes(6) })
  await dispose()
  expect(b.slots.entries('settings.section')).toHaveLength(0)
  const state = face.hooks.episodeState.getSnapshot()
  generation.set({ id: 3, host: { home: '/retired' } })
  face.checkEpisode(input); face.refreshEpisode()
  expect(face.hooks.episodeState.getSnapshot()).toBe(state)
  expect(f.api.episodeStatus).toHaveBeenCalledTimes(6)
  const release = resources.register({ protocol: 'jubian-episode-readiness', async *open() {} })
  release()
})
