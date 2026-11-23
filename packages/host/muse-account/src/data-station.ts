/** Data-station rankings, transcription stock and 立即转写, authorized by the signed-in Muse account. */
import { z } from 'zod'
import { museGatewayOrigin } from './gateway.ts'
import { readMuseSession } from './session.ts'
import type {
  MuseDataBoards, MuseDataCollector, MuseDataPeriod, MuseDataPeriodRequest, MuseDataPlatform, MuseDataRush, MuseDataStock,
  MuseDataStockRequest, MuseDataWorkDetail, MuseDataWorks, MuseDataWorksRequest,
} from './types.ts'

/** Fixed failures; station response bodies and the account token are never retained. */
export type MuseDataFailure =
  | 'sign-in-required' | 'team-access-required' | 'station-unavailable' | 'invalid-input' | 'invalid-response' | 'unconfirmed' | 'timeout' | 'unavailable'
  | 'not-requeueable'

/** Coded data-station failure. */
export class MuseDataError extends Error {
  /** @param code - Fixed failure category shown to the member. */
  constructor(readonly code: MuseDataFailure) {
    super(`Muse data station: ${code}`)
  }
}

/** Product origin, private session file, station route prefix and validated limits. */
export interface MuseDataStationOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  /** Absolute route prefix joined to the account gateway origin, ending before the member route. */
  readonly path: string
  readonly requestTimeoutMs: number
  readonly maxReplyBytes: number
  readonly fetcher?: typeof fetch
}

const PLATFORMS = ['hongguo', 'lvpaopao', 'douyin', 'fanqie', 'qimao'] as const
const label = z.string().max(4096)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const workId = z.string().min(1).max(160)
const metric = z.object({ key: z.string().max(80), label: z.string().max(80), value: z.number().nullable() })
const work = z.object({
  id: workId, sourceId: z.string().max(160), platform: z.enum(PLATFORMS), title: label.nullable(), tags: z.array(label).max(80),
  episodeCount: count.nullable(), wordCount: count.nullable(), metrics: z.array(metric).max(80),
})
const boards = z.object({ boards: z.array(label).max(1000), defaultBoard: label.nullable() })
const recorded = work.extend({
  board: label, rank: count.nullable(), author: label.nullish().transform(value => value ?? null), observedAt: z.string().max(64),
})
const workDetail = z.object({ work: recorded })
/** Characters of a work's description kept in a search result. */
const DESCRIPTION_CHARS = 300
const works = z.object({
  items: z.array(recorded.extend({ description: z.string().transform(value => value.slice(0, DESCRIPTION_CHARS)) })).max(100),
  total: count, page: count, limit: count,
})
const WORK_ID = /^(?:hongguo|fanqie|qimao|douyin|lvpaopao):[0-9A-Za-z_-]{1,64}$/u
const period = z.object({
  platform: z.enum(PLATFORMS), board: label, period: z.enum(['day', 'week', 'month']), date: z.string().max(32),
  items: z.array(z.object({ position: count.nullable(), work })).max(2000),
})
const stage = z.enum(['queued', 'downloading', 'transcribing', 'checking', 'published', 'failed', 'needs-attention', 'rejected'])
const job = z.object({
  workId, state: stage, lane: z.enum(['manual', 'new', 'backlog']), requestedBy: label.nullable(),
  progress: z.object({ episode: count.nullable(), totalEpisodes: count.nullable() }).nullable(),
  lastError: z.object({ reason: label }).nullable().optional(),
})
const stockItem = z.object({
  work: z.object({
    id: workId, sourceId: z.string().max(160), title: label.nullable(), tags: z.array(label).max(80), episodeCount: count.nullable(),
  }),
  evaluation: z.object({
    collection: z.object({ value: z.number() }).nullable().optional(),
    douyin: z.object({ viewCount: z.number().nullable().optional() }).nullable().optional(),
  }).nullable(),
  job: job.nullable(),
  script: z.object({ id: z.string().max(160), fileName: label }).nullable(),
})
const stock = z.object({
  summary: z.object({ stock: count, queued: count, active: count, failures: count, rejected: count, candidates: count }),
  items: z.array(stockItem).max(500), total: count, page: count, limit: count,
})
const rush = z.object({ workId, state: stage, lane: z.enum(['manual', 'new', 'backlog']) })
const collector = z.object({ state: z.string().max(64), label, message: label })

function failure(code: number, write: boolean): MuseDataFailure {
  switch (code) {
    case 400: return 'invalid-input'
    case 401: return 'sign-in-required'
    case 403: return 'team-access-required'
    case 409: return 'not-requeueable'
    case 503: return 'station-unavailable'
    default: return write && code >= 500 ? 'unconfirmed' : 'unavailable'
  }
}

/** Reads and actions on the data station as the member whose Muse login is saved on this computer. */
export class MuseDataStationClient {
  private readonly origin: string
  private readonly stop = new AbortController()

  /** @param options - Product origin, private account file, route prefix and validated limits. */
  constructor(private readonly options: MuseDataStationOptions) {
    this.origin = museGatewayOrigin(options.baseUrl)
  }

  /**
   * The rankings one platform publishes.
   * @param platform - Data-station platform.
   * @returns Ranking names and the station's default.
   */
  async boards(platform: MuseDataPlatform): Promise<MuseDataBoards> {
    return boards.parse(await this.exchange(`/boards?platform=${platform}`))
  }

  /**
   * One ranking for a day, week or month.
   * @param request - Platform, ranking, period and optional Beijing date.
   * @returns Ranked works with their metrics.
   */
  async period(request: MuseDataPeriodRequest): Promise<MuseDataPeriod> {
    const query = new URLSearchParams({ platform: request.platform, board: request.board, period: request.period })
    if (request.date !== undefined) query.set('date', request.date)
    return period.parse(await this.exchange(`/boards/period?${query}`))
  }

  /**
   * The 储备看板: Hongguo dramas selected for transcription and their stage.
   * @param request - Filter, optional title or ID search and page.
   * @returns Summary counts and one page of dramas.
   */
  async stock(request: MuseDataStockRequest): Promise<MuseDataStock> {
    const query = new URLSearchParams({ filter: request.filter, page: String(request.page), limit: String(request.limit) })
    if (request.q !== undefined && request.q.trim() !== '') query.set('q', request.q.trim())
    return stock.parse(await this.exchange(`/hits/board?${query}`))
  }

  /**
   * Move one Hongguo drama to the front of the transcription queue as this member.
   * @param id - Station work ID (`hongguo:<series id>`).
   * @returns The queued job.
   */
  async rush(id: string): Promise<MuseDataRush> {
    if (!/^hongguo:\d{1,32}$/u.test(id)) throw new MuseDataError('invalid-input')
    return rush.parse(await this.exchange(`/hits/${encodeURIComponent(id)}/rush`, '{}'))
  }

  /**
   * One work as the data station last recorded it, such as a finalized script's original novel or drama.
   * @param id - Station work ID (`fanqie:<id>`, `hongguo:<id>`, …).
   * @returns The work with its platform metrics, ranking and collection time.
   */
  async work(id: string): Promise<MuseDataWorkDetail> {
    if (!WORK_ID.test(id)) throw new MuseDataError('invalid-input')
    return workDetail.parse(await this.exchange(`/works/${encodeURIComponent(id)}`)).work
  }

  /**
   * Search the station's whole collection (全收录): every work it recorded from rankings and catalog discovery, newest
   * observation first.
   * @param request - Optional platform, optional words matched against title, author, ID, description and tags, and page.
   * @returns One page of matching works and how many match in all.
   */
  async works(request: MuseDataWorksRequest): Promise<MuseDataWorks> {
    const query = new URLSearchParams({ origin: 'live', sort: 'recent', page: String(request.page), limit: String(request.limit) })
    if (request.platform !== undefined) query.set('platform', request.platform)
    const words = request.q?.trim() ?? ''
    if (words !== '') query.set('q', words)
    return works.parse(await this.exchange(`/works?${query}`))
  }

  /**
   * Read the 绿泡泡 collector's current status from the data station.
   * @returns The collector state, label and message.
   */
  async collector(): Promise<MuseDataCollector> {
    return collector.parse(await this.exchange('/lvpaopao/status'))
  }

  /** Abort requests still running. */
  dispose(): void {
    this.stop.abort()
  }

  private async exchange(path: string, body?: string): Promise<unknown> {
    let session
    try { session = await readMuseSession(this.options.sessionFile, this.origin) }
    catch (_error) { throw new MuseDataError('unavailable') }
    if (session === null) throw new MuseDataError('sign-in-required')
    const token = session.cookie.slice('__Host-muse='.length)
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs)
    const signal = AbortSignal.any([this.stop.signal, timeout])
    let response: Response
    try {
      // Node fetch adds no Origin header; the station refuses account-token requests that carry one.
      response = await (this.options.fetcher ?? fetch)(new URL(`${this.options.path}${path}`, this.origin), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal,
        headers: { 'x-muse-account-token': token, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body }),
      })
    } catch (_error) {
      throw new MuseDataError(body !== undefined ? 'unconfirmed' : timeout.aborted ? 'timeout' : 'unavailable')
    }
    if (!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
      await response.body?.cancel()
      throw new MuseDataError(response.ok ? 'invalid-response' : failure(response.status, body !== undefined))
    }
    const bytes = await this.readCapped(response)
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch (_error) { throw new MuseDataError('invalid-response') }
    if (text.includes(token)) throw new MuseDataError('invalid-response')
    try { return JSON.parse(text) as unknown }
    catch (_error) { throw new MuseDataError('invalid-response') }
  }

  private async readCapped(response: Response): Promise<Uint8Array> {
    const reader = response.body?.getReader()
    if (reader === undefined) throw new MuseDataError('invalid-response')
    const parts: Uint8Array[] = []
    let total = 0
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > this.options.maxReplyBytes) {
        await reader.cancel()
        throw new MuseDataError('invalid-response')
      }
      parts.push(next.value)
    }
    return Buffer.concat(parts, total)
  }
}

/**
 * Read a station reply schema failure as a coded failure.
 * @param error - Thrown value from a client call.
 * @returns The coded failure for the member.
 */
export function museDataFailure(error: unknown): MuseDataError {
  if (error instanceof MuseDataError) return error
  if (error instanceof z.ZodError) return new MuseDataError('invalid-response')
  return new MuseDataError('unavailable')
}
