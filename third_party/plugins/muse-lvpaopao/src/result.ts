/** Allowlisted model-visible projection of the Windows helper response. */
import { BridgeError, type Action } from './port.ts'
import type { Config } from './config.ts'
import { localDownload, type LocalMedia } from './download.ts'

const candidate = { type: 'object', additionalProperties: false, properties: {
  title: { type: 'string', required: true }, srcAppId: { type: 'string', required: true }, originDramaId: { type: 'string', required: true },
} } as const
/** Canonical schema shared by Native and PTC callers. */
export const outputSchema = { type: 'object', additionalProperties: false, properties: {
  action: { type: 'string', required: true, enum: ['status', 'search', 'detail', 'episodes', 'download_first_episode'] },
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
  failurePhase?: 'before-call' | 'call-pending' | 'response-received' | 'projection'
  failureKind?: 'TypeError' | 'ReferenceError' | 'RangeError' | 'Error' | 'other'
  nativeErrorCode?: number | null
}
/** One model-visible tool outcome. */
export interface Result {
  action: Action; ok: boolean; status: string; data: ResultData; warnings: string[]
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
  if (action === 'download_first_episode' && local !== undefined) {
    return { action, ok: true, status: 'download-returned', data: { identityMatched: true,
      srcAppId: local.srcAppId, dramaId: local.dramaId, ...(local.title === undefined ? {} : { title: local.title }),
      serialNo: 1, isStraight: true, isFirstMediaFree: true, receiptReused: local.receiptReused,
      businessCalls: local.businessCalls, media: local.media },
      warnings: ['The file matches the verified helper media bytes. Technical access does not establish content reuse rights.'] }
  }
  if (action === 'status' && record(value) && value.status === 'waiting_target') {
    if (Object.keys(value).length !== 3 || value.ready !== false || value.expectedAppId !== 'wx404dde55fb12df78') throw new BridgeError('invalid-response')
    return { action, ok: true, status: 'waiting-target', data: { ready: false },
      warnings: ['Open or reopen Lvpaopao in the selected Windows WeChat window, then call status again.'] }
  }
  if (!record(value) || value.operation !== action || !text(value.status, 64) || !/^[a-z][a-z0-9-]*$/.test(value.status)) throw new BridgeError('invalid-response')
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
    'hasNativeWrapper', 'partial', 'isFirstMediaFree', 'hasVideoInfo', 'hasPlayAuthorization', 'isStraight', 'hasPrivateMedia'] as const) {
    if (value[key] === undefined || value[key] === null) continue
    if (typeof value[key] !== 'boolean') throw new BridgeError('invalid-response')
    data[key] = value[key]
  }
  for (const key of ['appVersion', 'envVersion', 'pluginVersion', 'srcAppId', 'dramaId', 'title'] as const) {
    if (value[key] === undefined || value[key] === null) continue
    if (!text(value[key], key === 'title' ? 300 : 160)) throw new BridgeError('invalid-response')
    data[key] = value[key]
  }
  for (const key of ['businessCalls', 'resultCount', 'episodeCount', 'requestedStart', 'requestedEndExclusive', 'serialNo'] as const) {
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
  if (value.episodeNumbers !== undefined) {
    if (!Array.isArray(value.episodeNumbers) || value.episodeNumbers.length > limits.maxEpisodeCount
      || !value.episodeNumbers.every(item => count(item) && item > 0)
      || new Set(value.episodeNumbers).size !== value.episodeNumbers.length) throw new BridgeError('invalid-response')
    data.episodeNumbers = value.episodeNumbers
  }
  const success = `${action === 'download_first_episode' ? 'download' : action}-returned`
  const ok = value.status === success && data.identityMatched === true && data.timedOut !== true
  const warnings: string[] = []
  if (action === 'episodes' && data.partial === true) warnings.push('Only the returned episode numbers are verified; this is not a complete-series result.')
  if (action === 'download_first_episode') warnings.push('The current adapter does not deliver a media file; local file transfer and cancellation acceptance are pending.')
  if (!ok) warnings.push('This operation did not return an accepted result. Use the actual status; do not infer provider availability or retry an unknown outcome automatically.')
  // No download success is exposed before a verified local file lane exists.
  return { action, ok: action === 'download_first_episode' ? false : ok, status: value.status, data, warnings }
}

/**
 * Render fixed error wording rather than subprocess or provider exception text.
 * @param action - Requested action.
 * @param error - Contained transport or executor failure.
 * @returns Safe tool outcome.
 */
export function errorResult(action: Action, error: unknown): Result {
  const code = error instanceof BridgeError ? error.code : 'transport-error'
  return { action, ok: false, status: code, data: {}, warnings: [], error: {
    code, message: 'The requested operation was not completed. Check connection status and the original operation before retrying.',
  } }
}
