/** Account-safe media requests, cloud receipts and controlled file consumption. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Company-owned media receipt identity, unrelated to the provider's task ID. */
export type MuseMediaJobId = Branded<'MuseMediaJobId'>

/** Stable download submission key reused with identical content after uncertainty. */
export type MuseMediaRequestId = Branded<'MuseMediaRequestId'>

/** Public platforms supported by the company service. */
export type MuseMediaPlatform = 'douyin' | 'tiktok' | 'bilibili'

/** JSON source material returned by the service; it never authorizes execution. */
export type MuseMediaJson = null | boolean | number | string | readonly MuseMediaJson[] | { readonly [key: string]: MuseMediaJson }

/** Read operations available without granting provider administration. */
export type MuseMediaDataAction = 'parse_url' | 'get_video' | 'get_user' | 'list_user_posts' | 'list_comments' | 'get_content_history'

/** Per-operation public inputs; account identity is absent from every request. */
export interface MuseMediaDataParameters {
  readonly parse_url: { readonly url: string }
  readonly get_video: { readonly platform: MuseMediaPlatform; readonly content_id: string }
  readonly get_user: { readonly platform: MuseMediaPlatform; readonly uid: string }
  readonly list_user_posts: {
    readonly platform: MuseMediaPlatform
    readonly uid: string
    readonly cursor?: string | null
    readonly count?: number | null
  }
  readonly list_comments: {
    readonly platform: MuseMediaPlatform
    readonly content_id: string
    readonly cursor?: string | null
    readonly count?: number | null
    readonly sort?: 'hot' | 'new' | null
  }
  readonly get_content_history: { readonly platform: MuseMediaPlatform; readonly content_id: string; readonly since?: string | null }
}

/** Explicit cloud download request; a saved cloud file is not a local asset. */
export interface MuseMediaDownloadRequest {
  readonly requestId: MuseMediaRequestId
  readonly url?: string
  readonly platform?: MuseMediaPlatform
  readonly content_id?: string
  readonly skip_existing?: boolean
  readonly part?: number
}

/** Persisted file facts used to authorize and verify an import. */
export interface MuseMediaFile {
  readonly name: string
  readonly bytes: number
  readonly sha256: string
  readonly kind: 'video' | 'image' | 'cover' | 'live_video' | 'metadata'
}

/** Disclosed difference between the provider manifest and accepted file entries. */
export interface MuseMediaFileCoverage {
  readonly reported: number | null
  readonly accepted: number
  readonly rejected: number | null
  readonly complete: boolean
  readonly truncated: boolean
}

/** Safe service result; a failed tool may carry only state and code. */
export interface MuseMediaReceipt {
  readonly state: 'ok' | 'pending' | 'unconfirmed' | 'cloud_saved' | 'partial' | 'failed'
  readonly job_id?: MuseMediaJobId | undefined
  readonly request_id?: MuseMediaRequestId | undefined
  readonly tool?: MuseMediaDataAction | 'download_media' | 'get_task_result' | undefined
  readonly files?: readonly MuseMediaFile[] | undefined
  readonly file_coverage?: MuseMediaFileCoverage | undefined
  readonly code?: string | undefined
  readonly retry_after?: number | undefined
  readonly created_at?: number | undefined
  readonly updated_at?: number | undefined
  readonly automatic_resubmit?: false | undefined
  readonly reservation_active?: boolean | undefined
  readonly next_action?: 'query_original' | 'inspect_receipt' | undefined
  readonly data?: MuseMediaJson | undefined
  readonly status?: 'ok' | 'pending' | undefined
  readonly platform?: MuseMediaPlatform | undefined
  readonly resource?: string | undefined
  readonly content_id?: string | undefined
  readonly uid?: string | undefined
  readonly url?: string | undefined
  readonly cached?: boolean | undefined
  readonly guest_fallback?: boolean | undefined
  readonly cursor?: string | null | undefined
  readonly has_more?: boolean | undefined
  readonly truncated?: boolean | undefined
  readonly projection_truncated?: boolean | undefined
  readonly since?: string | undefined
  readonly point_count?: number | undefined
  readonly points?: readonly MuseMediaJson[] | undefined
}

/** One account-owned receipt page with an explicit continuation offset. */
export interface MuseMediaJobPage {
  readonly jobs: readonly MuseMediaReceipt[]
  readonly next_offset: number | null
}

/** Service readiness and limits visible only to the authenticated account. */
export interface MuseMediaStatus {
  readonly ready: boolean
  readonly limits: {
    readonly requests_per_minute: number
    readonly concurrent_requests: number
    readonly downloads_per_day: number
    readonly concurrent_downloads: number
  }
}

/** Bounded failures without raw response text, account values or upstream keys. */
export type MuseMediaFailure =
  | 'sign-in-required' | 'company-access-required' | 'account-changed' | 'rate-limited' | 'request-conflict' | 'not-found'
  | 'invalid-input' | 'invalid-response' | 'unconfirmed' | 'unavailable' | 'cancelled' | 'timeout' | 'file-too-large' | 'file-incomplete'

/** Origin-bound private session and explicit transport limits supplied by the product. */
export interface MuseMediaOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly requestTimeoutMs: number
  readonly fileTimeoutMs: number
  readonly maxReplyBytes: number
  readonly maxFileBytes: number
  readonly fetcher?: typeof fetch
}

/** File stream whose caller retains cancellation and account checks through publication. */
export interface MuseMediaTransfer {
  readonly body: ReadableStream<Uint8Array>
  readonly file: MuseMediaFile
  readonly job: MuseMediaReceipt
  readonly signal: AbortSignal
  /** @returns Confirmation that the original login is still current; otherwise throws. */
  readonly assertCurrent: () => Promise<void>
}
