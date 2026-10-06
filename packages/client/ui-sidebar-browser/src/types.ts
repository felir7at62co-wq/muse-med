/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** A guest's main-issued storage partition; Douyin video tabs retain their workspace login. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /**
   * @param workspace - Resolved storage account.
   * @param sessionId - Owning Session.
   * @param initialUrl - Initial page used to select Douyin login storage.
   * @returns One approved guest reservation.
   */
  acquire(workspace: string, sessionId?: string, initialUrl?: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
  /** Main-owned request; consumer opens only in the currently selected Session. */
  onDownloadPageRequested?(listener: (request: { sessionId: string; url: string }) => void): () => void
  /** Revoke pending downloads when the selected Session changes. */
  activeSession?(sessionId: string | undefined): void
}

/** Host-issued task identity, never a renderer-issued authorization. */
export type DouyinTaskId = Branded<'DouyinTaskId'>

/** Private child-process request; credentials and arbitrary output paths are absent. */
export interface DouyinDesktopRequest {
  readonly type: 'douyin-browser'
  readonly requestId: string
  readonly taskId: DouyinTaskId
  readonly action: 'prepare' | 'download' | 'release'
  readonly sessionId: string
  readonly cwd: string
  readonly url: string
  /** Tool deployment's validated per-video file bound. */
  readonly maxDownloadBytes: number
  readonly targetVideoId?: string
}

/** Sanitized answer from the main process. Signed media URLs never cross IPC. */
export interface DouyinDesktopResult {
  readonly type: 'douyin-browser-result'
  readonly requestId: string
  readonly code: string
  readonly targetVideoId?: string
  readonly path?: string
  readonly evidence?: {
    readonly responseStatus: number
    readonly mediaHost: string
    readonly mediaUrlHash: string
    readonly association: 'player-exact' | 'provider-detail-verified'
    readonly currentSrcMatched: boolean
    readonly provider?: {
      readonly detailResponseStatus: number
      readonly detailHost: string
      readonly detailPath: string
      readonly targetVideoId: string
      readonly sourceField: 'video.play_addr' | 'video.bit_rate.play_addr'
      readonly durationMs: number
      readonly width: number
      readonly height: number
      readonly documentEpoch: number
    }
  }
}

/** A validated public work identity retained as decimal text. */
export type DouyinVideoId = Branded<'DouyinVideoId'>

/** A validated public comment identity; user and account identifiers are absent. */
export type DouyinCommentId = Branded<'DouyinCommentId'>

/** Correlation identity validated at the private data IPC parser. */
export type DouyinDataRequestId = Branded<'DouyinDataRequestId'>

/** Public page and normal Creator page data remain distinct from official OAuth data. */
export type DouyinDataSource = 'public-page' | 'creator-page'

/** A displayed rounded count never claims the precision of an exact provider integer. */
export type DouyinDataCount =
  | { readonly value: number; readonly precision: 'exact' | 'rounded'; readonly display?: string }
  | { readonly value: null; readonly precision: 'unavailable'; readonly reason: 'not-exposed' | 'missing' | 'invalid' }

/** Only the selected public comment's text and aggregate counters cross process IPC. */
export interface DouyinDataComment {
  readonly id: DouyinCommentId
  readonly text: string
  readonly digg_count: number | null
  /** Original page timestamp in Unix seconds; absent or invalid timestamps are null. */
  readonly create_time: number | null
  readonly reply_comment_total: number | null
}

/** Comment items and pagination are independent from the work's total comment count. */
export interface DouyinDataComments {
  readonly status: 'not-requested' | 'available' | 'blocked'
  readonly items: readonly DouyinDataComment[]
  readonly cursor: string | null
  readonly hasMore: boolean | null
  readonly code?: 'COMMENTS_UNAVAILABLE' | 'COMMENTS_CURSOR_UNAVAILABLE'
}

/** Fixed data diagnostics omit upstream messages, response bodies and credentials. */
export type DouyinDataCode =
  | 'OK' | 'RELEASED' | 'HOST_UNAVAILABLE' | 'TRANSPORT_TIMEOUT' | 'SESSION_NOT_VISIBLE' | 'BUSY'
  | 'INVALID_REQUEST' | 'INVALID_URL' | 'INVALID_RESULT' | 'CANCELLED' | 'WORKSPACE_UNAVAILABLE'
  | 'UI_UNAVAILABLE' | 'LEASE_RELEASED' | 'DOCUMENT_CHANGED' | 'TARGET_MISMATCH'
  | 'LOGIN_OR_VERIFICATION_REQUIRED' | 'PUBLIC_DATA_UNAVAILABLE' | 'CREATOR_DATA_UNAVAILABLE'
  | 'CREATOR_OWNERSHIP_UNVERIFIED' | 'COMMENTS_UNAVAILABLE' | 'COMMENTS_CURSOR_UNAVAILABLE' | 'EXPIRED'

/** Bounded, target-associated page facts; media addresses and authentication material are absent. */
export interface DouyinDataSnapshot {
  readonly status: 'ok'
  readonly source: DouyinDataSource
  readonly targetVideoId: DouyinVideoId
  readonly observedAt: string
  readonly counts: {
    readonly play_count: DouyinDataCount
    readonly digg_count: DouyinDataCount
    readonly comment_count: DouyinDataCount
    readonly share_count: DouyinDataCount
    readonly collect_count: DouyinDataCount
  }
  readonly comments: DouyinDataComments
}

/** Initiator-owned data selection; normal page requests are observed without constructing API requests. */
export interface DouyinDataSelection {
  readonly url: string
  readonly source: 'public' | 'creator' | 'auto'
  readonly comments: { readonly enabled: boolean; readonly cursor?: string; readonly count: number }
  readonly timeoutMs: number
}

/** Private Host request; the Main process owns guest, document and target association. */
export interface DouyinDesktopDataRequest {
  readonly type: 'douyin-browser-data'
  readonly requestId: DouyinDataRequestId
  readonly taskId: DouyinTaskId
  readonly action: 'read' | 'release'
  readonly sessionId: string
  readonly cwd: string
  readonly selection: DouyinDataSelection
}

/** Data errors contain only fixed safe codes; a successful snapshot contains no raw response fields. */
export interface DouyinDesktopDataResult {
  readonly type: 'douyin-browser-data-result'
  readonly requestId: DouyinDataRequestId
  readonly code: DouyinDataCode
  readonly data?: DouyinDataSnapshot
}
