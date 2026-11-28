/** Verify an original provider generation against a fresh native download in the same ordinary Session. */
import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { MEDIA_LIMITS } from '@deepseek-ai/dsh-jubian-api'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { z } from 'zod'
import { readEpisodeBytes } from './episode-delivery.ts'
import type { HistoricalVideoSourceIdentity } from './video-sources.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jubianHistoricalVideoSource: HistoricalVideoSourceVerifier
  }
}

const id = z.number().int().positive()
const digest = z.hash('sha256')
const path = z.string().min(1).max(32767).refine(isAbsolute)
const identity = z.object({ scriptId: id, episodeId: id, storyboardId: id, taskId: id, subtaskId: id, firstResultId: id })
const original = identity.extend({ originalUrlSha256: digest })
const media = z.object({ path, source_sha256: digest, sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  kind: z.literal('video'), media_type: z.literal('video/mp4'), bytes: z.number().int().positive().max(MEDIA_LIMITS.video) })
const download = media.extend({ download_receipt_path: path })
const receipt = media.extend({ version: z.literal(1) })
const sourceArgs = z.object({ method: z.literal('sources'), script_id: id, storyboard_id: id })
const downloadArgs = z.object({ method: z.literal('download'), media_kind: z.literal('video'), media_url: z.string().min(1),
  resume: z.literal(true) })
const pending = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sources'), scriptId: id, storyboardId: id }),
  z.object({ kind: z.literal('download'), urlSha256: digest }),
])
const limit = 512
const historyBody = z.object({ [TOOL_BODY_META_KEY]: z.object({ historical_video_sources: z.array(original).max(limit) }) })
const downloadBody = z.object({ [TOOL_BODY_META_KEY]: download.extend({ reused: z.literal(false) }) })
const stateSchema = z.object({
  inheritedEventCount: z.number().int().nonnegative(), pending: z.record(z.string(), pending),
  originals: z.record(z.string(), original), downloads: z.record(z.string(), download),
})
type State = z.infer<typeof stateSchema>
type Pending = z.infer<typeof pending>

function samePath(first: string, second: string): boolean { return relative(first, second) === '' }

function contained(root: string, file: string): boolean {
  const inside = relative(root, file)
  return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
}

function sourceKey(source: HistoricalVideoSourceIdentity): string {
  return JSON.stringify([source.scriptId, source.episodeId, source.storyboardId, source.taskId, source.subtaskId, source.firstResultId])
}

function downloadKey(file: string, urlSha256: string): string {
  const absolute = resolve(file)
  return JSON.stringify([process.platform === 'win32' ? absolute.toLowerCase() : absolute, urlSha256])
}

function newest<T>(items: Readonly<Record<string, T>>, key: string, value: T): Record<string, T> {
  const { [key]: _previous, ...remaining } = items
  return Object.fromEntries(Object.entries({ ...remaining, [key]: value }).slice(-limit))
}

function argsOf(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return undefined }
}

function start(state: State, key: string, name: string, args: unknown): State {
  if (name === 'jubian_media') {
    const parsed = downloadArgs.safeParse(args)
    if (!parsed.success) return state
    const urlSha256 = createHash('sha256').update(parsed.data.media_url).digest('hex')
    return { ...state, pending: newest<Pending>(state.pending, key, { kind: 'download', urlSha256 }) }
  }
  const parsed = sourceArgs.safeParse(args)
  if (!parsed.success) return state
  const { script_id: scriptId, storyboard_id: storyboardId } = parsed.data
  // A renewed read of this card invalidates any older observation, even if the read is incomplete.
  const otherCard = (fact: { scriptId: number; storyboardId: number }) => fact.scriptId !== scriptId || fact.storyboardId !== storyboardId
  return { ...state, originals: Object.fromEntries(Object.entries(state.originals).filter(([, fact]) => otherCard(fact))),
    pending: newest<Pending>(Object.fromEntries(Object.entries(state.pending)
      .filter(([, call]) => call.kind === 'download' || otherCard(call))), key, { kind: 'sources', scriptId, storyboardId }) }
}

function settle(state: State, key: string, meta: unknown): State {
  const call = state.pending[key]
  if (call === undefined) return state
  const { [key]: _matched, ...pendingCalls } = state.pending
  const next = { ...state, pending: pendingCalls }
  if (call.kind === 'download') {
    const parsed = downloadBody.safeParse(meta)
    if (!parsed.success) return next
    const { reused: _fresh, ...item } = parsed.data[TOOL_BODY_META_KEY]
    if (item.source_sha256 !== call.urlSha256) return next
    return { ...next, downloads: newest(state.downloads, downloadKey(item.path, item.source_sha256), item) }
  }
  const parsed = historyBody.safeParse(meta)
  if (!parsed.success) return next
  const facts = parsed.data[TOOL_BODY_META_KEY].historical_video_sources
  const episodeId = facts[0]?.episodeId
  const verified = new Map<string, z.infer<typeof original>>()
  for (const fact of facts) {
    const id = sourceKey(fact)
    if (fact.scriptId !== call.scriptId || fact.storyboardId !== call.storyboardId
      || fact.episodeId !== episodeId || verified.has(id)) return next
    verified.set(id, fact)
  }
  return { ...next, originals: Object.fromEntries([...Object.entries(state.originals), ...verified].slice(-limit)) }
}

function capture(state: State, event: SessionEvent): State {
  if (event.seq < state.inheritedEventCount) return state
  if (event.type === 'tool/call' && (event.data.name === 'jubian_media' || event.data.name === 'jubian_video')) {
    const { turn, step, callId, name, arguments: args } = event.data
    return start(state, JSON.stringify([turn, step, callId]), name, argsOf(args))
  }
  if (event.type === 'tool/result') {
    const { turn, step, message, meta } = event.data
    return settle(state, JSON.stringify([turn, step, message.toolCallId]), message.isError === false ? meta : undefined)
  }
  return state
}

function sameVersion(before: Stats, after: Stats): boolean {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.ctimeMs === after.ctimeMs && before.mtimeMs === after.mtimeMs
}

async function currentDigest(file: string, bytes: number, signal: AbortSignal): Promise<string | undefined> {
  const before = await lstat(file)
  if (!before.isFile() || before.size !== bytes) return undefined
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!sameVersion(before, await handle.stat())) return undefined
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let count = 0
    while (count <= bytes) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, bytes + 1 - count), null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      count += bytesRead
    }
    if (count !== bytes || !sameVersion(before, await handle.stat()) || !sameVersion(before, await lstat(file))
      || !samePath(file, await realpath(file))) return undefined
    signal.throwIfAborted()
    return hash.digest('hex')
  } finally { await handle.close() }
}

/** Current local project bytes bound to one exact original provider result. */
export interface HistoricalVideoSourceReceipt {
  readonly path: string
  readonly sha256: string
  readonly receiptPath: string
  readonly urlSha256: string
}

/** Read native history and a fresh download proved by the same ordinary Session. */
export interface HistoricalVideoSourceVerifier {
  /**
   * Verify the original source and its current bytes without making a provider call.
   * @param session - Ordinary Session that issued both native tool calls.
   * @param input - Exact provider identity, authorized project directory, and local source path.
   * @param signal - Cancellation for local evidence reads.
   * @returns Canonical original media and receipt paths with their assigned digests.
   */
  (session: Session | undefined, input: HistoricalVideoSourceIdentity & {
    readonly projectDir: string
    readonly sourcePath: string
  }, signal: AbortSignal): Promise<HistoricalVideoSourceReceipt>
}

/**
 * Install original generation evidence read by the local repair and source approval flows.
 * @param ctx - Scope owning the Session projection registry.
 * @returns The same-Session source verifier.
 */
export async function createHistoricalVideoSourceVerifier(ctx: Context): Promise<HistoricalVideoSourceVerifier> {
  const projection = await ctx.sessionProjections.register({
    key: 'jubianHistoricalOriginalSource', stateVersion: 1, stateSchema,
    init: (_header, inheritedEventCount) => ({ inheritedEventCount, pending: {}, originals: {}, downloads: {} }),
    apply: capture,
  })
  return async (session, input, signal) => {
    signal.throwIfAborted()
    if (session === undefined || session.header.origin === 'subagent' || !path.safeParse(input.sourcePath).success
      || !path.safeParse(input.projectDir).success || !identity.safeParse(input).success) {
      throw new Error('HISTORICAL_VIDEO_SOURCE_SESSION: 请在当前普通 Muse 会话核验本项目的原片。')
    }
    const key = sourceKey(input)
    const state = projection.stateOf(session)
    const original = state.originals[key]
    if (original === undefined) {
      throw new Error('HISTORICAL_VIDEO_SOURCE_RESULT: 当前会话缺少本集同卡原始生成的核验，请先用 jubian_video sources 查询。')
    }
    const sourceKeyForDownload = downloadKey(input.sourcePath, original.originalUrlSha256)
    const observed = state.downloads[sourceKeyForDownload]
    if (observed === undefined) {
      throw new Error('HISTORICAL_VIDEO_SOURCE_DOWNLOAD: 需要当前会话从已核验原片地址保存的新下载回执。')
    }
    const changed = () => new Error('HISTORICAL_VIDEO_SOURCE_CHANGED: 原片文件或下载回执与当前会话记录不符。')
    try {
      const [root, mediaPath, receiptPath] = await Promise.all([
        realpath(input.projectDir), realpath(input.sourcePath), realpath(observed.download_receipt_path),
      ])
      if (!samePath(mediaPath, input.sourcePath) || !samePath(mediaPath, observed.path)
        || !samePath(receiptPath, observed.download_receipt_path)
        || !contained(root, mediaPath) || !contained(root, receiptPath)) throw changed()
      const bytes = await readEpisodeBytes(receiptPath, 64 * 1024, signal)
      const saved = receipt.safeParse(bytes === undefined ? undefined : JSON.parse(bytes.toString('utf8')))
      if (!saved.success || !samePath(saved.data.path, mediaPath) || saved.data.sha256 !== observed.sha256
        || saved.data.bytes !== observed.bytes || saved.data.source_sha256 !== observed.source_sha256) throw changed()
      const sha256 = await currentDigest(mediaPath, observed.bytes, signal)
      const current = projection.stateOf(session)
      if (sha256 === undefined || `sha256:${sha256}` !== observed.sha256 || current.originals[key] !== original
        || current.downloads[sourceKeyForDownload] !== observed) throw changed()
      signal.throwIfAborted()
      return { path: mediaPath, sha256, receiptPath, urlSha256: observed.source_sha256 }
    } catch {
      signal.throwIfAborted()
      throw changed()
    }
  }
}
