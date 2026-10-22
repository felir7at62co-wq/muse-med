/** Allowlisted model-visible projection of the native helper response. */
import { BridgeError, type Action } from './port.ts'
import type { SeriesResult } from './series.ts'
import type { Config } from './config.ts'
import { localDownload, type LocalMedia } from './download.ts'

/** Model actions include orchestration that never enters the native operation registry. */
export type ToolAction = Action | 'download_series' | 'series_status'
type SeriesSummary = { -readonly [Key in keyof Omit<SeriesResult, 'episodes'>]: SeriesResult[Key] extends readonly number[] ? number[] : SeriesResult[Key] }

const candidate = { type: 'object', additionalProperties: false, properties: {
  title: { type: 'string', required: true }, srcAppId: { type: 'string', required: true }, originDramaId: { type: 'string', required: true },
} } as const
/** Canonical schema shared by Native and PTC callers. */
export const outputSchema = { type: 'object', additionalProperties: false, properties: {
  action: { type: 'string', required: true, enum: ['status', 'search', 'detail', 'episodes', 'download_first_episode', 'download_episode', 'download_status', 'download_series', 'series_status', 'rankings'] },
  ok: { type: 'boolean', required: true }, status: { type: 'string', required: true },
  data: { type: 'object', required: true, additionalProperties: false, properties: {
    identityMatched: { type: 'boolean' }, ready: { type: 'boolean' }, appVersion: { type: 'string' },
    envVersion: { type: 'string' }, pluginVersion: { type: 'string' }, hostLoginState: { type: 'boolean' },
    businessCalls: { type: 'integer' }, timedOut: { type: 'boolean' }, hasRequire: { type: 'boolean' },
    hasBizRequest: { type: 'boolean' }, hasNativeWrapper: { type: 'boolean' },
    failurePhase: { type: 'string', enum: ['before-call', 'call-pending', 'response-received', 'projection'] },
    failureKind: { type: 'string', enum: ['TypeError', 'ReferenceError', 'RangeError', 'Error', 'other'] },
    nativeErrorCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    resultCount: { type: 'integer' }, partial: { type: 'boolean' }, candidates: { type: 'array', items: candidate },
    boardType: { type: 'integer' }, pageIndex: { type: 'integer' }, pageSize: { type: 'integer' }, coldStartTime: { type: 'integer' }, total: { type: 'integer' }, hasMore: { type: 'boolean' },
    boards: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      type: { type: 'integer', required: true }, name: { type: 'string', required: true },
    } } },
    entries: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      ...candidate.properties, rank: { type: 'integer', required: true },
    } } },
    srcAppId: { type: 'string' }, dramaId: { type: 'string' }, title: { type: 'string' }, episodeCount: { type: 'integer' },
    isFirstMediaFree: { type: 'boolean' }, hasVideoInfo: { type: 'boolean' }, hasPlayAuthorization: { type: 'boolean' },
    requestedStart: { type: 'integer' }, requestedEndExclusive: { type: 'integer' },
    episodeNumbers: { type: 'array', items: { type: 'integer' } },
    serialNo: { type: 'integer' }, isStraight: { type: 'boolean' }, hasPrivateMedia: { type: 'boolean' },
    receiptReused: { type: 'boolean' }, media: { type: 'object', additionalProperties: false, properties: {
      localPath: { type: 'string', required: true }, receiptPath: { type: 'string', required: true },
      bytes: { type: 'integer', required: true }, sha256: { type: 'string', required: true },
      durationSeconds: { type: 'number', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
      hasAudio: { type: 'boolean', required: true }, fullDecodePassed: { type: 'boolean', required: true },
    } },
    supportedActions: { type: 'array', items: { type: 'string' } },
    series: { type: 'object', additionalProperties: false, properties: {
      taskId: { type: 'string', required: true }, taskDirectory: { type: 'string', required: true }, manifestPath: { type: 'string', required: true },
      status: { type: 'string', required: true, enum: ['complete', 'partial', 'cancelled'] },
      episodeCount: { type: 'integer', required: true }, catalogComplete: { type: 'boolean', required: true },
      actualEpisodeNumbers: { type: 'array', required: true, items: { type: 'integer' } },
      completedEpisodeNumbers: { type: 'array', required: true, items: { type: 'integer' } },
      pendingEpisodeNumbers: { type: 'array', required: true, items: { type: 'integer' } },
      inProgressEpisodeNumbers: { type: 'array', required: true, items: { type: 'integer' } },
      failedEpisodeNumbers: { type: 'array', required: true, items: { type: 'integer' } },
      deniedEpisodeNumbers: { type: 'array', required: true, items: { type: 'integer' } },
      unknownEpisodeNumbers: { type: 'array', required: true, items: { type: 'integer' } },
      missingEpisodeNumbers: { type: 'array', required: true, items: { type: 'integer' } },
    } },

  } },
  warnings: { type: 'array', required: true, items: { type: 'string' } },
  error: { type: 'object', additionalProperties: false, properties: {
    code: { type: 'string', required: true }, message: { type: 'string', required: true },
  } },
} } as const

interface Candidate { title: string; srcAppId: string; originDramaId: string }
/** Safe metadata only; no media URL or arbitrary helper object is retained. */
export interface ResultData {
  identityMatched?: boolean; ready?: boolean; appVersion?: string; envVersion?: string; pluginVersion?: string
  hostLoginState?: boolean; businessCalls?: number; timedOut?: boolean; hasRequire?: boolean; hasBizRequest?: boolean
  hasNativeWrapper?: boolean; resultCount?: number; partial?: boolean; candidates?: Candidate[]
  srcAppId?: string; dramaId?: string; title?: string; episodeCount?: number; isFirstMediaFree?: boolean
  hasVideoInfo?: boolean; hasPlayAuthorization?: boolean; requestedStart?: number; requestedEndExclusive?: number
  episodeNumbers?: number[]; serialNo?: number; isStraight?: boolean; hasPrivateMedia?: boolean; supportedActions?: string[]
  receiptReused?: boolean; media?: LocalMedia
  boardType?: number; pageIndex?: number; pageSize?: number; coldStartTime?: number; total?: number; hasMore?: boolean
  boards?: { type: number; name: string }[]
  entries?: (Candidate & { rank: number })[]
  series?: SeriesSummary
  failurePhase?: 'before-call' | 'call-pending' | 'response-received' | 'projection'
  failureKind?: 'TypeError' | 'ReferenceError' | 'RangeError' | 'Error' | 'other'
  nativeErrorCode?: number | null
}
/** One model-visible tool outcome. */
export interface Result {
  action: ToolAction; ok: boolean; status: string; data: ResultData; warnings: string[]
  error?: { code: string; message: string }
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }

/**
 * Validate and select only metadata the model needs.
 * @param action - Requested action, which the response must identify.
 * @param value - JSON from the authenticated helper.
 * @param limits - Configured result collection limits.
 * @returns A bounded, source-free canonical result.
 */
export function projectResult(action: Action, value: unknown, limits: Pick<Config, 'maxResultItems' | 'maxEpisodeCount'>): Result {
  const local = localDownload(value)
  if ((action === 'download_first_episode' || action === 'download_episode' || action === 'download_status') && local !== undefined) {
    return { action, ok: true, status: 'download-returned', data: { identityMatched: true,
      srcAppId: local.srcAppId, dramaId: local.dramaId, ...(local.title === undefined ? {} : { title: local.title }),
      serialNo: local.episodeNo ?? 1, isStraight: true, ...(action === 'download_first_episode' && local.playAuthorization === undefined ? { isFirstMediaFree: true } : {}), receiptReused: local.receiptReused,
      businessCalls: local.businessCalls, media: local.media },
      warnings: ['The file matches the verified helper media bytes. Technical access does not establish content reuse rights.'] }
  }
  if (action === 'status' && record(value) && value.status === 'waiting_target') {
    if (Object.keys(value).length !== 3 || value.ready !== false || value.expectedAppId !== 'wx404dde55fb12df78') throw new BridgeError('invalid-response')
    return { action, ok: true, status: 'waiting-target', data: { ready: false },
      warnings: ['Open or reopen Lvpaopao in the selected qualified WeChat window, then call status again.'] }
  }
  if (!record(value) || value.operation !== (action === 'download_status' ? 'download_episode' : action) || !text(value.status, 64) || !/^[a-z][a-z0-9-]*$/.test(value.status)) throw new BridgeError('invalid-response')
  const data: ResultData = {}
  if (Object.hasOwn(value, 'failurePhase')) {
    if (value.failurePhase !== 'before-call' && value.failurePhase !== 'call-pending'
      && value.failurePhase !== 'response-received' && value.failurePhase !== 'projection') throw new BridgeError('invalid-response')
    data.failurePhase = value.failurePhase
  }
  if (Object.hasOwn(value, 'failureKind')) {
    if (value.failureKind !== 'TypeError' && value.failureKind !== 'ReferenceError' && value.failureKind !== 'RangeError'
      && value.failureKind !== 'Error' && value.failureKind !== 'other') throw new BridgeError('invalid-response')
    data.failureKind = value.failureKind
  }
  if (Object.hasOwn(value, 'nativeErrorCode')) {
    if (value.nativeErrorCode !== null && (typeof value.nativeErrorCode !== 'number' || !Number.isInteger(value.nativeErrorCode)
      || value.nativeErrorCode < -2147483648 || value.nativeErrorCode > 2147483647)) throw new BridgeError('invalid-response')
    data.nativeErrorCode = value.nativeErrorCode
  }
  for (const key of ['identityMatched', 'ready', 'hostLoginState', 'timedOut', 'hasRequire', 'hasBizRequest',
    'hasNativeWrapper', 'partial', 'isFirstMediaFree', 'hasVideoInfo', 'hasPlayAuthorization', 'isStraight', 'hasPrivateMedia', 'hasMore'] as const) {
    if (value[key] === undefined || value[key] === null) continue
    if (typeof value[key] !== 'boolean') throw new BridgeError('invalid-response')
    data[key] = value[key]
  }
  for (const key of ['appVersion', 'envVersion', 'pluginVersion', 'srcAppId', 'dramaId', 'title'] as const) {
    if (value[key] === undefined || value[key] === null) continue
    if (!text(value[key], key === 'title' ? 300 : 160)) throw new BridgeError('invalid-response')
    data[key] = value[key]
  }
  for (const key of ['businessCalls', 'resultCount', 'episodeCount', 'requestedStart', 'requestedEndExclusive', 'serialNo', 'boardType', 'pageIndex', 'pageSize', 'coldStartTime', 'total'] as const) {
    if (value[key] === undefined || value[key] === null) continue
    if (!count(value[key])) throw new BridgeError('invalid-response')
    data[key] = value[key]
  }
  if (value.candidates !== undefined) {
    if (!Array.isArray(value.candidates) || value.candidates.length > limits.maxResultItems) throw new BridgeError('invalid-response')
    data.candidates = value.candidates.map(item => {
      if (!record(item) || !text(item.title, 300) || !text(item.srcAppId, 18) || !/^wx[0-9a-f]{16}$/.test(item.srcAppId)
        || typeof item.originDramaId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item.originDramaId)) throw new BridgeError('invalid-response')
      return { title: item.title, srcAppId: item.srcAppId, originDramaId: item.originDramaId }
    })
  }
  if (action === 'rankings') {
    if (!Array.isArray(value.boards) || value.boards.length > limits.maxResultItems
      || !Array.isArray(value.entries) || value.entries.length > limits.maxEpisodeCount) throw new BridgeError('invalid-response')
    data.boards = value.boards.map(item => {
      if (!record(item) || !count(item.type) || item.type < 1 || !text(item.name, 160)) throw new BridgeError('invalid-response')
      return { type: item.type, name: item.name }
    })
    data.entries = value.entries.map(item => {
      if (!record(item) || !text(item.title, 160) || !text(item.srcAppId, 18) || !/^wx[0-9a-f]{16}$/.test(item.srcAppId)
        || typeof item.originDramaId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item.originDramaId)
        || !count(item.rank) || item.rank < 1) throw new BridgeError('invalid-response')
      return { title: item.title, srcAppId: item.srcAppId, originDramaId: item.originDramaId, rank: item.rank }
    })
    if (value.status === 'rankings-returned' && (data.boardType === undefined || data.pageIndex === undefined
      || data.pageSize === undefined || data.coldStartTime === undefined || data.total === undefined || data.hasMore === undefined)) throw new BridgeError('invalid-response')
    if (value.status === 'rankings-returned') {
      const { boardType, pageIndex, pageSize, coldStartTime, total } = data
      if (boardType === undefined || boardType < 1 || pageIndex === undefined || pageSize === undefined
        || pageSize < 1 || pageSize > limits.maxEpisodeCount || coldStartTime === undefined || coldStartTime < 1
        || total === undefined || data.hasMore !== ((pageIndex + 1) * pageSize < total)
        || new Set(data.boards.map(board => board.type)).size !== data.boards.length
        || data.entries.some((entry, index, rows) => entry.rank <= pageIndex * pageSize || entry.rank > (pageIndex + 1) * pageSize
          || index > 0 && entry.rank <= rows[index - 1]!.rank)
        || data.partial !== true && data.entries.length !== Math.min(pageSize, Math.max(0, total - pageIndex * pageSize))) throw new BridgeError('invalid-response')
    }
  }
  if (value.episodeNumbers !== undefined) {
    if (!Array.isArray(value.episodeNumbers) || value.episodeNumbers.length > limits.maxEpisodeCount
      || !value.episodeNumbers.every(item => count(item) && item > 0)
      || new Set(value.episodeNumbers).size !== value.episodeNumbers.length) throw new BridgeError('invalid-response')
    data.episodeNumbers = value.episodeNumbers
  }
  const downloadAction = action === 'download_first_episode' || action === 'download_episode'
  const success = `${downloadAction ? 'download' : action}-returned`
  const ok = value.status === success && data.identityMatched === true && data.timedOut !== true
  const warnings: string[] = []
  if (action === 'status') {
    data.ready = ok
    if (ok && data.hostLoginState === false) warnings.push('The Lvpaopao connection is ready. hostLoginState is auxiliary mini-program business state, not desktop WeChat login or a query prerequisite. Evaluate search and rankings by their actual results.')
  }
  if (action === 'episodes' && data.partial === true) warnings.push('Only the returned episode numbers are verified; this is not a complete-series result.')
  if (downloadAction) warnings.push('This response contains no verified local file; it cannot establish a completed download.')
  if (!ok) warnings.push('This operation did not return an accepted result. Use the actual status; do not infer provider availability or retry an unknown outcome automatically.')
  // No download success is exposed before a verified local file lane exists.
  return { action, ok: downloadAction ? false : ok, status: value.status, data, warnings }
}

/**
 * Render fixed error wording rather than subprocess or provider exception text.
 * @param action - Requested action.
 * @param error - Contained transport or executor failure.
 * @returns Safe tool outcome.
 */
export function errorResult(action: ToolAction, error: unknown): Result {
  const code = error instanceof BridgeError ? error.code : 'transport-error'
  const warnings = code === 'mac-isolated-wechat-required' ? ['The qualified isolated Mac WeChat copy is not running. Ordinary WeChat cannot initialize this adapter. Open the separately prepared isolated copy, log in and open Lvpaopao, then call status once. Do not repeat search or rankings while setup is unavailable. No native business request was submitted.']
    : code === 'mac-runtime-build-unsupported' ? ['The isolated Mac WeChat build does not match the supported executable hashes. Use the verified isolated build; do not modify ordinary WeChat or retry queries. After correcting the runtime, call status once. No native business request was submitted.']
    : code === 'mac-runtime-home-invalid' ? ['The Mac copy is not running with its verified private data directory. Start the prepared isolated copy with its private home, then call status once. Do not change ordinary WeChat data or retry queries. No native business request was submitted.']
    : code === 'setup-timeout' ? ['Local runtime initialization timed out before the native business request was submitted. Check the qualified WeChat runtime, login and target window first; on Mac use the separately prepared isolated copy. After correcting setup, call status once rather than repeating search or rankings.']
    : code === 'setup-required' ? ['Local setup is not ready. Use a qualified WeChat runtime (Mac currently requires a separately prepared isolated copy), log in and open Lvpaopao, then explicitly call status. Do not replay an unknown media request.']
    : code === 'target-not-ready' ? ['The existing connection is waiting for Lvpaopao. Call status after opening or reconnecting the target; this operation did not start native business work.'] : []
  return { action, ok: false, status: code, data: action === 'status' || code === 'target-not-ready' ? { ready: false } : {}, warnings, error: {
    code, message: 'The requested operation was not completed. Check connection status and the original operation before retrying.',
  } }
}

/**
 * Summarize a locally validated task; individual file evidence remains in its manifest.
 * @param action - Start/resume or read-only task status action.
 * @param value - Task engine result, never an untrusted native response.
 * @returns Bounded progress with explicit missing, denied and unknown episodes.
 */
export function seriesResult(action: 'download_series' | 'series_status', value: SeriesResult): Result {
  const { episodes: _episodes, ...metadata } = value
  const summary: SeriesSummary = { ...metadata,
    actualEpisodeNumbers: [...value.actualEpisodeNumbers], completedEpisodeNumbers: [...value.completedEpisodeNumbers],
    pendingEpisodeNumbers: [...value.pendingEpisodeNumbers], inProgressEpisodeNumbers: [...value.inProgressEpisodeNumbers],
    failedEpisodeNumbers: [...value.failedEpisodeNumbers], deniedEpisodeNumbers: [...value.deniedEpisodeNumbers],
    unknownEpisodeNumbers: [...value.unknownEpisodeNumbers], missingEpisodeNumbers: [...value.missingEpisodeNumbers] }
  return { action, ok: value.status === 'complete', status: `series-${value.status}`, data: { series: summary },
    warnings: value.status === 'complete' ? [] : ['This series is incomplete. Inspect missing, denied, failed and unknown episodes before resuming the same task.'] }
}
