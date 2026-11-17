/** Exact-work normal-page observations owned by one Host task and one browser guest. */
import type { WebContents } from 'electron'
import type {
  DesktopBrowserLeaseId, DouyinDataCode, DouyinDataSnapshot, DouyinDesktopDataRequest,
  DouyinDesktopDataResult, DouyinVideoId,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { type DouyinGuest, douyinGuestMatches } from './douyin-downloads.ts'
import { ProviderResponses } from './douyin-provider.ts'
import { targetVideoId } from './douyin-policy.ts'
import { creatorData, publicData, publicDataProbe } from './douyin-data-provider.ts'
import { DouyinDataAccumulator } from './douyin-data-aggregation.ts'

const creatorPage = 'https://creator.douyin.com/creator-micro/content/manage'
function isCreatorWorkPage(url: string): boolean { return url === creatorPage }

interface DataTask {
  readonly owner: WebContents
  readonly request: DouyinDesktopDataRequest
  readonly reply: (result: DouyinDesktopDataResult) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly poll: ReturnType<typeof setInterval>
  lease?: DouyinGuest
  target?: DouyinVideoId
  observer?: ProviderResponses
  documentEpoch: number
  observationEpoch: number
  inPagePending: boolean
  inPagePendingUrl?: string
  phase: 'resolving' | 'observing' | 'closing'
  ownList: boolean
  initialization?: Promise<void>
  pageRead?: Promise<void>
  accumulator?: DouyinDataAccumulator
  aggregationEpoch?: number
  settleTimer?: ReturnType<typeof setTimeout>
  outcome?: { code: DouyinDataCode; data?: DouyinDataSnapshot }
  cleanup?: Promise<void>
  navigation?: (event: Electron.Event, url: string, inPlace: boolean, mainFrame: boolean) => void
  inPageNavigation?: (event: Electron.Event, url: string, mainFrame: boolean) => void
}

/** One active data task; session changes and teardown join outstanding response reads before replying. */
export class DesktopDouyinData {
  private task: DataTask | undefined
  private readonly active = new Map<WebContents, string | undefined>()
  private readonly cleanups = new Set<Promise<void>>()

  /**
   * @param open - Existing owning-Session browser opener.
   * @param busy - Whether a download owns the browser transport.
   */
  constructor(
    private readonly open: (owner: WebContents, sessionId: string, url: string) => void,
    private readonly busy: () => boolean,
  ) {}

  /** @returns whether an observation or its joined cleanup owns the transport. */
  get isActive(): boolean { return this.task !== undefined }

  /**
   * @param owner - Authenticated application window.
   * @param sessionId - Selected Session IPC value.
   */
  activeSession(owner: WebContents, sessionId: unknown): void {
    if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > 256)) return
    this.active.set(owner, sessionId)
    const task = this.task
    if (task !== undefined && task.owner === owner && task.request.sessionId !== sessionId) {
      void this.finish(task, 'SESSION_NOT_VISIBLE')
    }
  }

  /**
   * @param owner - Authenticated application window.
   * @param request - Validated Host operation.
   * @returns Sanitized page data or a fixed failure.
   */
  async request(owner: WebContents, request: DouyinDesktopDataRequest): Promise<DouyinDesktopDataResult> {
    const answer = (code: DouyinDataCode): DouyinDesktopDataResult => ({
      type: 'douyin-browser-data-result', requestId: request.requestId, code,
    })
    if (request.action === 'release') {
      const task = this.task
      if (task !== undefined && task.owner === owner && task.request.taskId === request.taskId
        && task.request.sessionId === request.sessionId && task.request.cwd === request.cwd
        && task.request.selection.url === request.selection.url) await this.finish(task, 'CANCELLED')
      return answer('RELEASED')
    }
    if (owner.isDestroyed() || this.active.get(owner) !== request.sessionId) return answer('SESSION_NOT_VISIBLE')
    if (this.task !== undefined || this.busy()) return answer('BUSY')
    return new Promise((resolveResult) => {
      const task: DataTask = {
        owner, request, reply: resolveResult, phase: 'resolving', documentEpoch: 0, observationEpoch: 0, inPagePending: false,
        ownList: false,
        timer: setTimeout(() => { if (task.accumulator?.hasObservation) {
          void this.finish(task, 'OK', task.accumulator.result('deadline')); return
        }
        void this.finish(task, request.selection.source === 'creator'
          ? task.ownList ? 'CREATOR_OWNERSHIP_UNVERIFIED' : 'LOGIN_OR_VERIFICATION_REQUIRED'
          : 'PUBLIC_DATA_UNAVAILABLE') }, request.selection.timeoutMs),
        poll: setInterval(() => { this.tick(task) }, 100),
      }
      this.task = task
      const target = targetVideoId(request.selection.url)
      if (request.selection.source === 'creator' && target !== undefined) task.target = target
      try { this.open(owner, request.sessionId, task.target === undefined ? request.selection.url : creatorPage) }
      catch (_error) { void this.finish(task, 'UI_UNAVAILABLE') }
    })
  }

  /** @param lease - Main-issued guest; renderer values cannot create this association. */
  attached(lease: DouyinGuest): void {
    const task = this.task
    if (task === undefined || task.phase !== 'resolving' || task.lease !== undefined
      || !douyinGuestMatches(lease, task.owner, task.request.sessionId, task.request.cwd)) return
    task.lease = lease
    this.tick(task)
  }

  /** @param lease - Main-issued guest identity that was released or destroyed. */
  released(lease: DesktopBrowserLeaseId): void {
    const task = this.task
    if (task !== undefined && task.lease?.lease === lease) void this.finish(task, 'LEASE_RELEASED')
  }

  private tick(task: DataTask): void {
    if (this.task !== task || task.phase === 'closing') return
    const guest = task.lease?.guest
    if (guest === undefined) return
    if (guest.isDestroyed() || task.owner.isDestroyed()) { void this.finish(task, 'LEASE_RELEASED'); return }
    if (task.phase === 'observing') {
      if (task.request.selection.source !== 'creator' && task.documentEpoch === 1 && !task.inPagePending && task.pageRead === undefined) {
        task.pageRead = this.readPublicPage(task, guest).finally(() => { delete task.pageRead })
      }
      return
    }
    if (guest.isLoadingMainFrame()) return
    if (task.request.selection.source === 'creator' && task.target !== undefined) {
      if (!isCreatorWorkPage(guest.getURL())) return
      task.phase = 'observing'
      task.initialization = this.observe(task, guest)
      void task.initialization.catch(() => { void this.finish(task, 'CREATOR_DATA_UNAVAILABLE') })
      return
    }
    const target = targetVideoId(guest.getURL())
    if (target === undefined) return
    const requested = targetVideoId(task.request.selection.url)
    if (requested !== undefined && requested !== target) { void this.finish(task, 'TARGET_MISMATCH'); return }
    task.target = target
    if (task.request.selection.source === 'creator') {
      delete task.lease
      try { this.open(task.owner, task.request.sessionId, creatorPage) }
      catch (_error) { void this.finish(task, 'UI_UNAVAILABLE') }
      return
    }
    task.phase = 'observing'
    task.initialization = this.observe(task, guest)
    void task.initialization.catch(() => { void this.finish(task, 'PUBLIC_DATA_UNAVAILABLE') })
  }

  private async readPublicPage(task: DataTask, guest: WebContents): Promise<void> {
    const target = task.target, epoch = task.observationEpoch
    if (target === undefined || targetVideoId(guest.getURL()) !== target) return
    let body: unknown
    try { body = await guest.executeJavaScript(publicDataProbe(target)) }
    catch (_error) { return /* A loading or replaced document supplies no page facts. */ }
    if (this.task !== task || task.phase !== 'observing' || task.inPagePending || epoch !== task.observationEpoch
      || targetVideoId(guest.getURL()) !== target || typeof body !== 'string') return
    const comments = task.request.selection.comments.enabled
      ? { status: 'blocked' as const, items: [], cursor: null, hasMore: null,
        code: task.request.selection.comments.cursor === undefined ? 'COMMENTS_UNAVAILABLE' as const : 'COMMENTS_CURSOR_UNAVAILABLE' as const }
      : { status: 'not-requested' as const, items: [], cursor: null, hasMore: null }
    const data = publicData(body, target, new Date().toISOString(), comments, true)
    if (data !== undefined) this.accept(task, guest, data, 'page')
  }

  private accept(task: DataTask, guest: WebContents, data: DouyinDataSnapshot, source: 'page' | 'detail'): void {
    if (this.task !== task || task.phase !== 'observing' || task.lease?.guest !== guest || guest.isDestroyed()
      || this.active.get(task.owner) !== task.request.sessionId || task.documentEpoch !== 1 || task.inPagePending
      || (source === 'page' && targetVideoId(guest.getURL()) !== task.target)) return
    if (!task.request.selection.aggregationWaitMs) { void this.finish(task, 'OK', data); return }
    if (task.target === undefined || (task.aggregationEpoch !== undefined && task.aggregationEpoch !== task.observationEpoch)) {
      void this.finish(task, 'DOCUMENT_CHANGED'); return
    }
    task.aggregationEpoch = task.observationEpoch
    task.accumulator ??= new DouyinDataAccumulator(task.target)
    if (!task.accumulator.add(data, source)) { void this.finish(task, 'DATA_OBSERVATION_CONFLICT'); return }
    if (task.request.selection.source === 'creator') { void this.finish(task, 'OK', task.accumulator.result('creator')); return }
    if (task.accumulator.paired) { void this.finish(task, 'OK', task.accumulator.result('paired')); return }
    task.settleTimer ??= setTimeout(() => {
      if (task.accumulator?.hasObservation) void this.finish(task, 'OK', task.accumulator.result('wait_expired'))
    }, task.request.selection.aggregationWaitMs)
  }

  private async observe(task: DataTask, guest: WebContents): Promise<void> {
    const target = task.target
    if (target === undefined) { void this.finish(task, 'TARGET_MISMATCH'); return }
    const sameTarget = (url: string): boolean => task.request.selection.source === 'creator'
      ? isCreatorWorkPage(url) : targetVideoId(url) === target
    const invalidate = (): void => {
      task.observationEpoch++
      delete task.accumulator
      delete task.aggregationEpoch
      if (task.settleTimer !== undefined) clearTimeout(task.settleTimer)
      delete task.settleTimer
      task.observer?.sameDocument()
    }
    task.navigation = (_event, url, inPlace, mainFrame) => {
      if (this.task !== task || !mainFrame) return
      if (task.phase === 'closing') { void this.finish(task, 'DOCUMENT_CHANGED'); return }
      if (inPlace) {
        if (!sameTarget(url) || task.inPagePending) { void this.finish(task, 'DOCUMENT_CHANGED'); return }
        if (task.documentEpoch === 1) { task.inPagePending = true; task.inPagePendingUrl = url; invalidate() }
        return
      }
      task.documentEpoch++
      task.observationEpoch++
      task.observer?.newDocument()
      if (task.documentEpoch !== 1 || !sameTarget(url)) void this.finish(task, 'DOCUMENT_CHANGED')
    }
    guest.on('did-start-navigation', task.navigation)
    task.inPageNavigation = (_event, url, mainFrame) => {
      if (this.task !== task || !mainFrame || task.documentEpoch < 1) return
      if (task.phase === 'closing' || !sameTarget(url) || !sameTarget(guest.getURL())
        || new URL(url).href !== new URL(guest.getURL()).href
        || (task.inPagePendingUrl !== undefined && new URL(url).href !== new URL(task.inPagePendingUrl).href)) {
        void this.finish(task, 'DOCUMENT_CHANGED'); return
      }
      invalidate()
      task.inPagePending = false
      delete task.inPagePendingUrl
    }
    guest.on('did-navigate-in-page', task.inPageNavigation)
    task.observer = new ProviderResponses(guest, target, () => task.observationEpoch, () => {}, () => {}, (body, epoch) => {
      if (this.task !== task || task.phase !== 'observing' || task.inPagePending || epoch !== task.observationEpoch || task.documentEpoch !== 1
        || (task.request.selection.source === 'creator' ? !isCreatorWorkPage(guest.getURL()) : targetVideoId(guest.getURL()) !== target)) return
      const comments = task.request.selection.comments.enabled
        ? { status: 'blocked' as const, items: [], cursor: null, hasMore: null,
          code: task.request.selection.comments.cursor === undefined ? 'COMMENTS_UNAVAILABLE' as const : 'COMMENTS_CURSOR_UNAVAILABLE' as const }
        : { status: 'not-requested' as const, items: [], cursor: null, hasMore: null }
      const creator = task.request.selection.source === 'creator'
        ? creatorData(body, target, new Date().toISOString(), comments) : undefined
      if (creator?.ownList === true) task.ownList = true
      const data = creator === undefined ? publicData(body, target, new Date().toISOString(), comments) : creator.data
      if (data !== undefined) this.accept(task, guest, data, 'detail')
      else if (creator?.ownList === true && !creator.hasMore) void this.finish(task, 'CREATOR_OWNERSHIP_UNVERIFIED')
    }, task.request.selection.source === 'creator' ? 'creator' : 'public')
    if (!await task.observer.start()) { void this.finish(task, 'PUBLIC_DATA_UNAVAILABLE'); return }
    if (this.task === task && task.phase === 'observing' && !guest.isDestroyed()) guest.reload()
  }

  private async finish(task: DataTask, code: DouyinDataCode, data?: DouyinDataSnapshot): Promise<void> {
    if (task.phase === 'closing') {
      if (code !== 'OK' && task.outcome?.code === 'OK') task.outcome = { code }
      return task.cleanup ?? Promise.resolve()
    }
    task.outcome = { code, ...(data === undefined ? {} : { data }) }
    task.phase = 'closing'
    clearTimeout(task.timer)
    if (task.settleTimer !== undefined) clearTimeout(task.settleTimer)
    clearInterval(task.poll)
    const guest = task.lease?.guest
    task.observer?.close()
    const cleanup = (async () => {
      try {
        await Promise.allSettled(task.initialization === undefined ? [] : [task.initialization])
        await task.pageRead
        await task.observer?.closeAndWait()
      } finally {
        if (guest !== undefined && task.navigation !== undefined) guest.removeListener('did-start-navigation', task.navigation)
        if (guest !== undefined && task.inPageNavigation !== undefined) guest.removeListener('did-navigate-in-page', task.inPageNavigation)
        if (task.outcome?.code === 'OK' && (task.owner.isDestroyed() || guest === undefined || guest.isDestroyed()
          || this.active.get(task.owner) !== task.request.sessionId
          || task.request.selection.source !== 'creator' && targetVideoId(guest.getURL()) !== task.target)) {
          task.outcome = { code: 'DOCUMENT_CHANGED' }
        }
        if (this.task === task) this.task = undefined
        const outcome = task.outcome ?? { code: 'HOST_UNAVAILABLE' as const }
        task.reply({ type: 'douyin-browser-data-result', requestId: task.request.requestId, code: outcome.code,
          ...(outcome.data === undefined ? {} : { data: outcome.data }) })
      }
    })()
    task.cleanup = cleanup
    this.cleanups.add(cleanup)
    void cleanup.then(() => { this.cleanups.delete(cleanup) }, () => { this.cleanups.delete(cleanup) })
    await cleanup
  }

  /** @returns after revoking the active task and joining all owned reads. */
  async dispose(): Promise<void> {
    this.active.clear()
    if (this.task !== undefined) await this.finish(this.task, 'HOST_UNAVAILABLE')
    await Promise.allSettled([...this.cleanups])
  }
}
