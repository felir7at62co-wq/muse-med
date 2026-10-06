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
