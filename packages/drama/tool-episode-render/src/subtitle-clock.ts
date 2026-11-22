/**
 * Source identity for an SRT placed on an episode's measured edit clock.
 *
 * Version 1 receipts carry only the SRT digest and one `source_clock_sha256` over the ordered shot rows.
 * Version 2 adds the producer, rules identity, pending review count and the rows themselves, so a reader can
 * name exactly which shots changed; `source_clock_sha256` is computed identically in both versions.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { fileSha256 } from './cache.ts'
import type { ResolvedShot } from './prepare.ts'

/** A readable generated subtitle still matches its receipt, but its source clock changed. */
export class StaleSubtitleClockError extends Error {}

/** A receipt file exists but is not valid JSON or has an unknown version or invalid fields. */
export class InvalidSubtitleClockError extends Error {}

/** Jingliu source identity of one shot, recorded only for a Jingliu project's preview subtitle. */
export interface SubtitleClockJingliuSource {
  readonly shot_id: string
  readonly video_path: string
  readonly etag: string
  readonly clip_in_us: number
  readonly speed: number
}

/** One shot of the measured edit clock, in clip order. */
export interface SubtitleClockRow {
  readonly shot: number
  readonly duration_us: number
  readonly video_sha256: string
  readonly audio_sha256: string
  readonly jingliu?: SubtitleClockJingliuSource
}

/** Producer facts a version 2 receipt adds to the version 1 fields. */
export interface SubtitleClockProducer {
  /** Tool that laid out the cues, for example `episode_subtitles`. */
  readonly producer: string
  /** Digest of the correction and layout rules that produced the text. */
  readonly rules_sha256: string
  /** Review items still waiting for a decision when the SRT was published. */
  readonly review_pending: number
  /** Jingliu source identities by shot number, when the shots came from Jingliu. */
  readonly jingliu?: ReadonlyMap<number, SubtitleClockJingliuSource>
}

/** A parsed version 1 receipt. */
export interface SubtitleClockReceiptV1 {
  readonly version: 1
  readonly srt_sha256: string
  readonly source_clock_sha256: string
}

/** A parsed version 2 receipt. */
export interface SubtitleClockReceiptV2 extends Omit<SubtitleClockReceiptV1, 'version'> {
  readonly version: 2
  readonly producer: string
  readonly rules_sha256: string
  readonly episode: string
  readonly review_pending: number
  readonly shots: readonly SubtitleClockRow[]
}

/** Either accepted receipt version. */
export type SubtitleClockReceipt = SubtitleClockReceiptV1 | SubtitleClockReceiptV2

/** Hash function shared by one receipt computation; callers may supply a stat-keyed cache. */
export type MediaHash = (file: string, signal?: AbortSignal) => Promise<string>

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const SHA256 = /^[0-9a-f]{64}$/u

/**
 * Compute the ordered clock rows of the selected shots.
 * @param shots - Selected picture and voice sources in clip order.
 * @param signal - Optional owning operation cancellation.
 * @param hash - File digest; defaults to reading each distinct file once.
 * @returns One row per shot, in clip order.
 */
export async function subtitleClockRows(shots: readonly ResolvedShot[], signal?: AbortSignal,
  hash: MediaHash = fileSha256): Promise<SubtitleClockRow[]> {
  const files = new Map<string, Promise<string>>()
  const once = (file: string): Promise<string> => {
    let pending = files.get(file)
    if (!pending) { pending = hash(file, signal); files.set(file, pending) }
    return pending
  }
  const rows: SubtitleClockRow[] = []
  for (const shot of shots) {
    rows.push({ shot: shot.source.shot, duration_us: shot.durationUs,
      video_sha256: await once(shot.video), audio_sha256: await once(shot.audio) })
  }
  return rows
}

/**
 * Compute the version-independent source clock digest.
 * @param episode - Two-digit episode identity.
 * @param rows - Ordered clock rows.
 * @returns Lowercase SHA-256 of the compact `[episode, [[shot, duration_us, video, audio], …]]` JSON.
 */
export function sourceClockSha256(episode: string, rows: readonly SubtitleClockRow[]): string {
  return digest(JSON.stringify([episode, rows.map(row => [row.shot, row.duration_us, row.video_sha256, row.audio_sha256])]))
}

/**
 * Name the shots whose duration, picture or sound differs from a version 2 receipt.
 * @param receipt - Version 2 receipt read from disk.
 * @param current - Current ordered clock rows.
 * @returns Shot numbers, ascending, that were added, removed or changed; empty when every row matches.
 */
export function changedShots(receipt: SubtitleClockReceiptV2, current: readonly SubtitleClockRow[]): number[] {
  const key = (row: SubtitleClockRow): string => JSON.stringify([row.duration_us, row.video_sha256, row.audio_sha256])
  const recorded = new Map(receipt.shots.map(row => [row.shot, key(row)]))
  const now = new Map(current.map(row => [row.shot, key(row)]))
  return [...new Set([...recorded.keys(), ...now.keys()])]
    .filter(shot => recorded.get(shot) !== now.get(shot)).sort((left, right) => left - right)
}

/**
 * Get the adjacent file recording the edit clock of a generated subtitle.
 * @param srt - Subtitle artifact path.
 * @returns Clock receipt path.
 */
export function subtitleClockPath(srt: string): string { return `${srt}.clock.json` }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clockRow(value: unknown): SubtitleClockRow | undefined {
  if (!record(value) || !Number.isSafeInteger(value.shot) || (value.shot as number) < 1
    || !Number.isSafeInteger(value.duration_us) || (value.duration_us as number) <= 0
    || typeof value.video_sha256 !== 'string' || !SHA256.test(value.video_sha256)
    || typeof value.audio_sha256 !== 'string' || !SHA256.test(value.audio_sha256)) return undefined
  const row = { shot: value.shot as number, duration_us: value.duration_us as number,
    video_sha256: value.video_sha256, audio_sha256: value.audio_sha256 }
  if (value.jingliu === undefined) return row
  const source = value.jingliu
  if (!record(source) || typeof source.shot_id !== 'string' || typeof source.video_path !== 'string'
    || typeof source.etag !== 'string' || !Number.isSafeInteger(source.clip_in_us) || (source.clip_in_us as number) < 0
    || typeof source.speed !== 'number' || !Number.isFinite(source.speed) || source.speed <= 0) return undefined
  return { ...row, jingliu: { shot_id: source.shot_id, video_path: source.video_path, etag: source.etag,
    clip_in_us: source.clip_in_us as number, speed: source.speed } }
}

/**
 * Validate one parsed receipt document.
 * @param value - Parsed JSON.
 * @returns The typed receipt, or undefined when any field is invalid or the version is unknown.
 */
export function parseSubtitleClockReceipt(value: unknown): SubtitleClockReceipt | undefined {
  if (!record(value) || typeof value.srt_sha256 !== 'string' || !SHA256.test(value.srt_sha256)
    || typeof value.source_clock_sha256 !== 'string' || !SHA256.test(value.source_clock_sha256)) return undefined
  const base = { srt_sha256: value.srt_sha256, source_clock_sha256: value.source_clock_sha256 }
  if (value.version === 1) return { version: 1, ...base }
  if (value.version !== 2 || typeof value.producer !== 'string' || !value.producer
    || typeof value.rules_sha256 !== 'string' || !SHA256.test(value.rules_sha256)
    || typeof value.episode !== 'string' || !/^\d{2,}$/u.test(value.episode)
    || !Number.isSafeInteger(value.review_pending) || (value.review_pending as number) < 0
    || !Array.isArray(value.shots)) return undefined
  const shots = value.shots.map(clockRow)
  if (shots.some(row => row === undefined)) return undefined
  return { version: 2, ...base, producer: value.producer, rules_sha256: value.rules_sha256, episode: value.episode,
    review_pending: value.review_pending as number, shots: shots as SubtitleClockRow[] }
}

/**
 * Read the receipt beside one SRT.
 * @param srt - Subtitle artifact path.
 * @param signal - Optional owning operation cancellation.
 * @returns The receipt and its exact text, or undefined when no receipt exists.
 * @throws {InvalidSubtitleClockError} When the receipt is not JSON or has invalid fields.
 */
export async function readSubtitleClockReceipt(srt: string, signal?: AbortSignal):
Promise<{ readonly text: string; readonly receipt: SubtitleClockReceipt } | undefined> {
  let text: string
  signal?.throwIfAborted()
  try { text = await readFile(subtitleClockPath(srt), { encoding: 'utf8', signal }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let value: unknown
  try { value = JSON.parse(text) }
  catch (error) { throw new InvalidSubtitleClockError(`${subtitleClockPath(srt)}: 字幕时钟回执不是 JSON，请重新生成字幕。`, { cause: error }) }
  const receipt = parseSubtitleClockReceipt(value)
  if (receipt === undefined) throw new InvalidSubtitleClockError(`${subtitleClockPath(srt)}: 字幕时钟回执无效，请重新生成字幕。`)
  return { text, receipt }
}

/**
 * Publish one subtitle clock receipt before publishing its matching SRT.
 * @param srt - SRT destination.
 * @param text - The exact SRT document being published.
 * @param episode - Source episode identity.
 * @param shots - Selected picture and voice sources in clip order.
 * @param alignedAudio - Source hashes to recheck before publishing, including missing entries the caller requires.
 * @param producer - Producer facts; present, it writes a version 2 receipt with per-shot rows.
 * @param hash - File digest; defaults to reading each distinct file once.
 * @returns Written receipt path.
 */
export async function writeSubtitleClock(srt: string, text: string, episode: string,
  shots: readonly ResolvedShot[], alignedAudio?: ReadonlyMap<number, string | undefined>,
  producer?: SubtitleClockProducer, hash?: MediaHash): Promise<string> {
  const rows = await subtitleClockRows(shots, undefined, hash)
  for (const row of rows) {
    if (alignedAudio?.has(row.shot) && alignedAudio.get(row.shot) !== row.audio_sha256) {
      throw new Error('字幕自动修复缺少与当前声音文件一致的对齐证据，镜头 '
        + String(row.shot) + ' 请重新取得同源对齐。')
    }
  }
  const base = { srt_sha256: digest(text), source_clock_sha256: sourceClockSha256(episode, rows) }
  const content = producer === undefined ? { version: 1, ...base } : { version: 2, ...base,
    producer: producer.producer, rules_sha256: producer.rules_sha256, episode, review_pending: producer.review_pending,
    shots: rows.map((row) => {
      const source = producer.jingliu?.get(row.shot)
      return source === undefined ? row : { ...row, jingliu: source }
    }) }
  const receipt = subtitleClockPath(srt)
  await writeFileAtomic(receipt, `${JSON.stringify(content)}\n`, { mode: 0o600, dirMode: 0o700 })
  return receipt
}

/**
 * Carry a previously verified edit clock to a display-only subtitle derivative.
 * @param source - Subtitle already verified against the current source media by the caller.
 * @param target - New normalized or word-split display subtitle.
 * @param text - Exact derived SRT bytes, with existing measured cue boundaries.
 * @returns New receipt path, or undefined for an unbound legacy source.
 */
export async function writeDerivedSubtitleClock(source: string, target: string, text: string): Promise<string | undefined> {
  let original: string
  try { original = await readFile(subtitleClockPath(source), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const receipt = parseSubtitleClockReceipt(JSON.parse(original))
  if (receipt === undefined || receipt.srt_sha256 !== await fileSha256(source)) {
    throw new Error('显示字幕派生前的原字幕或来源时钟已变化，请用当前素材重跑 prepare。')
  }
  const path = subtitleClockPath(target)
  await writeFileAtomic(path, `${JSON.stringify({ ...receipt, srt_sha256: digest(text) })}\n`, { mode: 0o600, dirMode: 0o700 })
  return path
}

/**
 * Check a generated SRT against the current media and clip order.
 * @param srt - Subtitle to install.
 * @param episode - Target episode identity.
 * @param readShots - Current selected picture and voice sources in clip order, resolved only for a generated SRT.
 * @param signal - Optional owning operation cancellation.
 * @returns Verified receipt text, or undefined for an unbound manual or legacy SRT; a batch caller treats undefined as refused.
 */
export async function verifySubtitleClock(srt: string, episode: string,
  readShots: () => readonly ResolvedShot[] | Promise<readonly ResolvedShot[]>, signal?: AbortSignal): Promise<string | undefined> {
  const stale = () => new Error('生成字幕与当前集、分包素材或切点不一致。请使用当前清单和同源对齐记录重跑 drama_render subtitles，再重跑 prepare。')
  let read
  try { read = await readSubtitleClockReceipt(srt, signal) }
  catch (error) {
    if (error instanceof InvalidSubtitleClockError) throw stale()
    throw error
  }
  if (read === undefined) return undefined
  if (read.receipt.srt_sha256 !== await fileSha256(srt, signal)) throw stale()
  if (read.receipt.source_clock_sha256 !== sourceClockSha256(episode, await subtitleClockRows(await readShots(), signal))) {
    throw new StaleSubtitleClockError(stale().message)
  }
  return read.text
}
