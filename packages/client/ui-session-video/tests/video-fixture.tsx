/** Declarative Session and native-slot ownership shared by the video journey tests. */
import { onTestFinished, vi } from 'vitest'
import { SlotTestRuntime, chatSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionVideoAnalysis, SessionVideoInventory, SessionVideoSource, SessionVideoSourceId, SessionVideoShotId } from '@deepseek-ai/dsh-session-video/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createVideoStore } from '../src/client/store.ts'
import { VideoHeader } from '../src/client/VideoHeader.tsx'
import { DeliveredVideoCard, GeneratedVideoCards } from '../src/client/InlineVideoCard.tsx'
import type { VideoInjected } from '../src/client/face.ts'
import { NS, en, zh } from '../src/client/locales.ts'
import type { OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'test.video.delivered': { kind: 'list'; scope: 'session'; owner: OwnerOf<'deliverables.video'> }
  }
}

/** Build one authorized local source.
 * @param id - Stable fixture source identity.
 * @returns Recorded source coordinates.
 */
export function source(id = 'original'): SessionVideoSource {
  return { id: brandString<SessionVideoSourceId>(id), label: `Video ${id}`, origin: 'generated', path: `/work/${id}.mp4`,
    eventSeq: 4, presentedIndex: null, callId: 'generated-call', status: 'local', version: 'v1',
    playbackUrl: `/api/session-video?id=${id}`, remoteUrl: null, issue: null }
}
/** Build source-bound detected ranges.
 * @param item - Source owning the detection.
 * @returns One complete four-second shot.
 */
export function analysis(item: SessionVideoSource): SessionVideoAnalysis {
  return { sourceId: item.id, sourceVersion: 'v1', state: 'ready', durationSeconds: 4, width: 320, height: 180,
    method: 'ffmpeg-scene', threshold: 0.3, issue: null,
    shots: [{ id: brandString<SessionVideoShotId>(`${item.id}-shot`), index: 1, startSeconds: 0, endSeconds: 4, thumbnail: null }] }
}

/** Build a complete Host inventory reply.
 * @param sources - Authorized source rows.
 * @param issues - Read failures that keep the inventory incomplete.
 * @returns Inventory for the retained fixture Session.
 */
export function inventory(sources: SessionVideoSource[], issues: string[] = []): SessionVideoInventory {
  return { sessionId: brandString<SessionId>('video-shelf'), complete: issues.length === 0, sources, issues }
}

/** Mount real Session bindings, shared store and video slots; teardown releases all owners.
 * @param items - Initial Host inventory.
 * @returns Mounted views, typed Host-operation spies and the renderer-owned store.
 */
export async function fixture(items: SessionVideoSource[] = [source()]) {
  const runtime = await SlotTestRuntime.create()
  const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  const retained: { reference?: SessionReference } = {}
  onTestFinished(async () => {
    retained.reference?.release()
    await runtime.dispose()
    vi.restoreAllMocks(); vi.unstubAllGlobals()
    if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations)
    else Reflect.deleteProperty(Element.prototype, 'getAnimations')
  })
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.effect(() => locale.register(NS, { en, zh }))
  locale.setLocale('en')
  const input = createSnapshotStore<InputState>({ draft: 'Existing draft', draftRev: 7, attachmentIds: [],
    phase: 'plain', occurrences: [], queue: [] })
  const chat = createSnapshotStore(chatSnapshot())
  const unused = () => { throw Error('Unexpected input operation outside source regeneration') }
  const inputActions = { insertText: vi.fn<InputActions['insertText']>().mockReturnValue(true), persistDraft: vi.fn<InputActions['persistDraft']>(),
    insertQuote: unused, captureInsertion: unused, setDraft: unused, addAttachments: unused,
    removeAttachment: unused, pruneAttachments: unused, submit: unused } satisfies InputActions
  runtime.ctx.uiSession.provide({ hooks: ['input', 'chat'], props: ['inputActions'],
    resolve: () => ({ hooks: { input, chat }, props: { inputActions } }) })
  const id = await runtime.sessions.add({ id: 'video-shelf' })
  const reference = runtime.sessions.retain(id)
  retained.reference = reference
  await reference.ready
  const detectShots = vi.fn<VideoInjected['detectShots']>().mockImplementation(async (_session, id) => {
    const item = items.find(item => item.id === id)
    if (!item) throw Error('Unknown source in the detected inventory')
    return analysis(item)
  })
  const store = createVideoStore()
  const resource = createSnapshotStore<ResourceSnapshot<SessionVideoInventory>>({ status: 'live', value: inventory(items), failure: undefined })
  runtime.slots.provideRoot({ keyedHooks: { resource: () => resource } })
  const openWorkspace = vi.fn(), refreshVideos = vi.fn(), addTargetReference = vi.fn().mockReturnValue(true),
    removeTargetReference = vi.fn().mockReturnValue(true)
  const injected = { detectShots, pixelsPerSecond: 48, openWorkspace, refreshVideos, addTargetReference, removeTargetReference,
    setReviewMode: vi.fn().mockReturnValue(true) }
  await runtime.declare({ 'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    'test.video.delivered': { kind: 'list', scope: 'session' }, 'conversation.chat.turnTail': { kind: 'list', scope: 'session' } })
  await runtime.mount({ inject: ['slots'], apply(ctx) {
    ctx.slots.register({ name: 'test.video.delivered', id: 'owner',
      children: { 'deliverables.video': { kind: 'chain', scope: 'session' } } },
    ({ renderSlotChain, sourceUrl, label, path, seq, index }) => renderSlotChain('deliverables.video', { sourceUrl, label, path, seq, index }))
    ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'video', store, locale: NS,
      inject: () => injected }, VideoHeader)
    ctx.slots.register({ name: 'deliverables.video', store, locale: NS, select: () => true,
      inject: () => injected }, DeliveredVideoCard)
    ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'generated', store, locale: NS,
      inject: () => injected }, GeneratedVideoCards)
  } })
  const panel = runtime.renderSlot('conversation.session.header.utilities', { activeView: null, selectView: vi.fn() }, { session: reference })
  const instance = runtime.storeOf('conversation.session.header.utilities', reference) as ReturnType<typeof store.create>
  return { runtime, panel, reference, instance, detectShots, inputActions, input, openWorkspace, resource }
}
