/** Check selected media against the current episode's approved package picks. */
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileSha256 } from './cache.ts'
import type { EpisodePaths } from './paths.ts'
import type { ShotSource } from './types.ts'

interface ReviewedShot {
  readonly shot: number
  readonly videoSha256: string
  readonly audioSha256?: string
  readonly reviewSha256: string
}

function document(bytes: Buffer, file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`选源证据不是 JSON 对象：${file}`)
  }
  return value as Record<string, unknown>
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function evidenceFile(project: string, path: unknown, label: string): Promise<string> {
  if (typeof path !== 'string' || !path.trim()) throw new Error(`${label} 缺少审核证据文件。`)
  const [root, file] = await Promise.all([realpath(project), realpath(resolve(project, path))])
  const rel = relative(root, file)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !(await stat(file)).isFile()) {
    throw new Error(`${label} 审核证据必须是项目内的文件。`)
  }
  return file
}

const contentChecks = ['identity', 'wardrobe', 'scene', 'prop', 'action_and_dialogue', 'visible_artifacts',
  'continuity', 'voice_and_speaker', 'av_sync', 'sensitive_content']

function unavailableErasure(value: unknown): boolean {
  return record(value) && (value.status === 'unavailable' || value.status === 'failed'
    || value.status === 'rejected_quality') && typeof value.reason === 'string' && value.reason.trim() !== ''
}

function validErasureInterval(value: unknown): boolean {
  return record(value) && typeof value.start_seconds === 'number' && typeof value.end_seconds === 'number'
    && Number.isFinite(value.start_seconds) && Number.isFinite(value.end_seconds)
    && value.start_seconds >= 0 && value.end_seconds > value.start_seconds
}

async function verifyDownload(project: string, receiptPath: unknown, media: string, sha256: string | undefined,
  label: string, urlSha256?: string): Promise<void> {
  const file = await evidenceFile(project, receiptPath, label)
  const download = document(await readFile(file), file)
  if (download.version !== 1 || download.kind !== 'video' || download.media_type !== 'video/mp4'
    || typeof download.path !== 'string' || resolve(project, download.path) !== resolve(project, media)
    || sha256 === undefined || download.sha256 !== `sha256:${sha256}`
    || typeof download.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(download.source_sha256)
    || (urlSha256 !== undefined && download.source_sha256 !== urlSha256)) {
    throw new Error(`${label} 正式下载回执与本次选片或原声的字节、结果来源不符。`)
  }
}

async function verifyContentEvidence(project: string, review: Record<string, unknown>, row: ShotSource,
  videoSha256: string, audioSha256: string | undefined, label: string): Promise<void> {
  const checks = review.content_review
  if (!record(checks) || checks.embedded_subtitles !== 'absent' || contentChecks.some(key => checks[key] !== 'pass')) {
    throw new Error(`${label} 内容复核不完整或仍有待修项。请核对所选片的内容、烧录字幕、音画和敏感画面。`)
  }
  if (!Array.isArray(review.review_frames) || review.review_frames.length === 0) {
    throw new Error(`${label} 缺少审核抽帧。`)
  }
  const reviewedFrames = await Promise.all(review.review_frames.map(frame => evidenceFile(project, frame, label)))
  if (review.subtitle_cleanup !== 'clean') {
    await verifyDownload(project, review.original_download_receipt_path, row.video, videoSha256, label)
    return
  }

  const erasure = review.subtitle_erasure
  if (record(erasure) && erasure.stage === 'local_erase') {
    if (!unavailableErasure(erasure.free) || !unavailableErasure(erasure.yudian)
      || !Array.isArray(erasure.intervals) || erasure.intervals.length === 0
      || !erasure.intervals.every(validErasureInterval)
      || !hasSeparateAudio(project, row) || audioSha256 === undefined || audioSha256 === videoSha256) {
      throw new Error(`${label} 本地去字幕需要两条正式路线的明确终态、处理区间和原片独立音轨。`)
    }
    const originalFrame = await evidenceFile(project, erasure.original_review_frame, label)
    if (reviewedFrames.includes(originalFrame)) throw new Error(`${label} 本地去字幕需要独立的处理前后抽帧。`)
    await verifyDownload(project, review.original_download_receipt_path, row.audio, audioSha256, label)
    return
  }
  if (!record(erasure) || erasure.stage !== 'erase_subtitle'
    || ![erasure.source_task_id, erasure.operation_task_id, erasure.result_id].every(
      id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
    || erasure.source_task_id === erasure.operation_task_id
    || typeof erasure.output_url_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(erasure.output_url_sha256)
    || !hasSeparateAudio(project, row)) {
    throw new Error(`${label} 去字幕选片需要正式去字幕结果、原片独立音轨及下载回执。`)
  }
  await verifyDownload(project, erasure.download_receipt_path, row.video, videoSha256, label, erasure.output_url_sha256)
  await verifyDownload(project, review.original_download_receipt_path, row.audio, audioSha256, label)
}

/** Compare normalized selected paths, including the manifest's default embedded audio. */
export function hasSeparateAudio(project: string, row: ShotSource): boolean {
  return resolve(project, row.video) !== resolve(project, row.audio)
}

async function episodeReviews(paths: EpisodePaths): Promise<Map<number, { row: Record<string, unknown>; sha256: string }>> {
  const directory = resolve(paths.project, 'reviews')
  let names: string[]
  try { names = await readdir(directory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
  const reviews = new Map<number, { row: Record<string, unknown>; sha256: string }>()
  const pattern = new RegExp(`^ep${paths.episode}-p(\\d{2,})\\.json$`, 'u')
  for (const name of names) {
    const number = pattern.exec(name)?.[1]
    if (number === undefined) continue
    const file = resolve(directory, name)
    const bytes = await readFile(file)
    const row = document(bytes, file)
    const pack = Number(number)
    if (!Number.isSafeInteger(pack) || number !== String(pack).padStart(2, '0') || reviews.has(pack)) {
      throw new Error(`审核包号或文件名无效：${file}`)
    }
    reviews.set(pack, { row, sha256: digest(bytes) })
  }
  return reviews
}

/**
 * Verify evidence independently of the caller's shot manifest. Legacy previews may
 * work without reviews; delivery requires approval for each distinct audio source.
 * Strict source review also requires full content evidence on every selected package.
 */
export async function verifySelectedSourceReviews(paths: EpisodePaths, rows: readonly ShotSource[],
  delivering = false, requireContent = false): Promise<ReviewedShot[]> {
  const reviews = await episodeReviews(paths)
  const approvedPackages = [...reviews].filter(([, review]) => review.row.status === 'approved').map(([pack]) => pack)
  const hashes = new Map<string, Promise<string>>()
  const fileHash = (file: string): Promise<string> => {
    const path = resolve(paths.project, file)
    const existing = hashes.get(path)
    if (existing !== undefined) return existing
    const pending = fileSha256(path)
    hashes.set(path, pending)
    return pending
  }
  let packageSha256: string | undefined
  let packageCount = 0
  if (approvedPackages.length > 0 || (delivering && reviews.size > 0)) {
    const file = resolve(paths.project, 'episode_packages', paths.episode, 'package.json')
    const bytes = await readFile(file)
    const plan = document(bytes, file)
    const tasks = plan.video_tasks
    if (plan.episode !== paths.episode || !Array.isArray(tasks) || tasks.length === 0
      || tasks.some(task => !Array.isArray(task?.shots) || task.shots.length === 0
        || task.shots.some((shot: unknown) => typeof shot !== 'number' || !Number.isSafeInteger(shot) || shot < 1))) {
      throw new Error(`EP${paths.episode} 编译分包清单的集号或包内容无效。`)
    }
    packageCount = tasks.length
    packageSha256 = digest(bytes)
    const selected = new Set(rows.map(row => row.package))
    if (rows.some(row => row.package === undefined || row.package > packageCount)
      || approvedPackages.some(pack => pack < 1 || pack > packageCount || !selected.has(pack))
      || (delivering && selected.size !== packageCount)) {
      throw new Error(`EP${paths.episode} 选源没有覆盖本集编译分包和已审核包，须显式核对包号。`)
    }
  }

  const verified: ReviewedShot[] = []
  for (const row of rows) {
    const separate = hasSeparateAudio(paths.project, row)
    const approved = row.package === undefined ? undefined : reviews.get(row.package)
    const label = `EP${paths.episode} 镜头 ${row.shot}${row.package === undefined ? '' : ` P${row.package}`}`
    if (approved?.row.status !== 'approved') {
      if (delivering && (requireContent || separate || reviews.size > 0)) {
        throw new Error(`${label} 缺少本集选源审核，独立原声音频须有明确来源后才能归档。`)
      }
      continue
    }
    const review = approved.row
    if ((review.episode !== paths.episode && review.episode !== Number(paths.episode)) || review.package !== row.package
      || review.package_sha256 !== packageSha256
      || (review.subtitle_cleanup !== 'clean' && review.subtitle_cleanup !== 'not_required')) {
      throw new Error(`${label} 的审核集号、包号、分包版本或去字幕状态不符。`)
    }
    if (typeof review.video_path !== 'string'
      || resolve(paths.project, review.video_path) !== resolve(paths.project, row.video)) {
      throw new Error(`${label} 所选画面路径与已审核视频不符。`)
    }
    const videoSha256 = await fileHash(row.video)
    if (review.video_sha256 !== videoSha256) throw new Error(`${label} 所选画面字节与已审核视频不符。`)
    const hasAudioReview = review.audio_path !== undefined || review.audio_sha256 !== undefined
    if (separate && !hasAudioReview && delivering) {
      throw new Error(`${label} 缺少已审核的独立原声音频，不能归档。`)
    }
    const audioSha256 = hasAudioReview ? await fileHash(row.audio) : separate ? undefined : videoSha256
    if (hasAudioReview && (typeof review.audio_path !== 'string'
      || resolve(paths.project, review.audio_path) !== resolve(paths.project, row.audio)
      || review.audio_sha256 !== audioSha256)) {
      throw new Error(`${label} 所选原声音频路径或字节与已审核来源不符。`)
    }
    if (requireContent) await verifyContentEvidence(paths.project, review, row, videoSha256, audioSha256, label)
    verified.push({ shot: row.shot, videoSha256,
      ...(audioSha256 === undefined ? {} : { audioSha256 }), reviewSha256: approved.sha256 })
  }
  return verified
}
