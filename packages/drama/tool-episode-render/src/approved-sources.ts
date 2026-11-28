/** Check selected media against the current episode's approved package picks. */
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { fileSha256 } from './cache.ts'
import type { EpisodePaths } from './paths.ts'
import type { ShotSource } from './types.ts'
import { approvedDialoguePatchSchema, isLocalDialoguePatchOutput, verifySourceQa, type LocalDialoguePatchSourceBinding,
  type SourceQaStagedAccess, type SourceQaVerifier, type SourceQaVerification } from './source-qa.ts'

interface ReviewedShot {
  readonly shot: number
  readonly videoSha256: string
  readonly audioSha256?: string
  readonly reviewSha256: string
  readonly requiresLocalDialoguePatch?: true
  readonly sourceQa?: SourceQaVerification
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

async function evidenceFile(project: string, path: unknown, label: string, staged?: SourceQaStagedAccess): Promise<string> {
  if (typeof path !== 'string' || !path.trim()) throw new Error(`${label} 缺少审核证据文件。`)
  const [root, file] = staged === undefined ? await Promise.all([realpath(project), realpath(resolve(project, path))])
    : [staged.project, staged.logical(resolve(project, path))]
  const rel = relative(root, file)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)
    || (staged === undefined && !(await stat(file)).isFile())) {
    throw new Error(`${label} 审核证据必须是项目内的文件。`)
  }
  if (staged !== undefined) await staged.hash(file)
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
  label: string, capture: (path: string, sha256: string) => void, urlSha256?: string, staged?: SourceQaStagedAccess) {
  const file = await evidenceFile(project, receiptPath, label, staged)
  const bytes = await (staged === undefined ? readFile(file) : staged.read(file))
  const download = document(bytes, file)
  if (download.version !== 1 || download.kind !== 'video' || download.media_type !== 'video/mp4'
    || typeof download.path !== 'string' || resolve(project, download.path) !== resolve(project, media)
    || sha256 === undefined || download.sha256 !== `sha256:${sha256}`
    || typeof download.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(download.source_sha256)
    || (urlSha256 !== undefined && download.source_sha256 !== urlSha256)) {
    throw new Error(`${label} 正式下载回执与本次选片或原声的字节、结果来源不符。`)
  }
  capture(file, digest(bytes))
  return { receiptPath: file, urlSha256: download.source_sha256 }
}

const positiveId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0

function localPatchPending(label: string): HarnessError {
  return new HarnessError(`${label} 局部修音候选须在原制作会话完成同片原声、读音和源片复验后才可交付。`, 'SOURCE_DIALOGUE_PATCH_PENDING')
}

async function verifyDialoguePatchFiles(paths: EpisodePaths, review: Record<string, unknown>, row: ShotSource,
  plan: Record<string, unknown> | undefined, tasks: readonly unknown[], videoSha256: string, audioSha256: string | undefined, label: string,
  capture: (path: string, sha256: string) => void, staged?: SourceQaStagedAccess,
): Promise<LocalDialoguePatchSourceBinding> {
  const declaration = approvedDialoguePatchSchema.safeParse(review.local_dialogue_patch)
  const project = paths.project
  const task = tasks[Number(row.package) - 1]
  if (!declaration.success || staged !== undefined || !positiveId(plan?.script_id) || !positiveId(plan.episode_id)
    || !record(task) || task.index !== row.package || !positiveId(task.storyboard_id) || review.storyboard_id !== task.storyboard_id
    || review.subtitle_cleanup !== 'not_required' || review.original_download_receipt_path !== undefined
    || review.subtitle_erasure !== undefined || review.video_upscale !== undefined || review.source_clock_conform !== undefined
    || review.local_clip_repair !== undefined || review.local_picture_patch !== undefined
    || hasSeparateAudio(project, row) || review.audio_sha256 !== videoSha256 || audioSha256 !== videoSha256) {
    throw localPatchPending(label)
  }
  const projectRoot = await realpath(project)
  const selected = await evidenceFile(project, row.video, label)
  if (resolve(project, row.video) !== selected || !isLocalDialoguePatchOutput(projectRoot, selected)) throw localPatchPending(label)
  const config = await evidenceFile(project, 'project_config.json', label)
  const configBytes = await readFile(config)
  if (document(configBytes, config).jubian_script_id !== plan.script_id) throw localPatchPending(label)
  capture(config, digest(configBytes))

  const original = async ({ source_path, source_sha256, download_receipt_path, ...identity }: typeof declaration.data.target) => {
    const path = await evidenceFile(project, source_path, label)
    const sha256 = await fileSha256(path)
    if (resolve(project, source_path) !== path || sha256 !== source_sha256) throw localPatchPending(label)
    capture(path, sha256)
    const transport = await verifyDownload(project, download_receipt_path, path, sha256, label, capture)
    return { ...identity, path, sha256, ...transport }
  }
  const { target: targetSource, donor: donorSource, recheck_evidence_id: recheckEvidenceId } = declaration.data
  const [target, donor] = await Promise.all([original(targetSource), original(donorSource)])
  if (target.task_id === donor.task_id || target.subtask_id === donor.subtask_id || target.first_result_id === donor.first_result_id
    || target.path === donor.path || target.path === selected || donor.path === selected
    || target.sha256 === donor.sha256 || target.sha256 === videoSha256 || donor.sha256 === videoSha256
    || target.receiptPath === donor.receiptPath || target.urlSha256 === donor.urlSha256) {
    throw localPatchPending(label)
  }
  return { project: projectRoot, episode: paths.episode, output: selected, sha256: videoSha256,
    scriptId: plan.script_id, episodeId: plan.episode_id, storyboardId: task.storyboard_id, recheckEvidenceId,
    originals: { target, donor } }
}

async function verifyContentEvidence(project: string, review: Record<string, unknown>, row: ShotSource,
  videoSha256: string, audioSha256: string | undefined, label: string, capture: (path: string, sha256: string) => void,
  staged: SourceQaStagedAccess | undefined, verifyDialoguePatch?: () => Promise<LocalDialoguePatchSourceBinding>,
): Promise<LocalDialoguePatchSourceBinding | undefined> {
  const checks = review.content_review
  if (!record(checks) || checks.embedded_subtitles !== 'absent' || contentChecks.some(key => checks[key] !== 'pass')) {
    throw new Error(`${label} 内容复核不完整或仍有待修项。请核对所选片的内容、烧录字幕、音画和敏感画面。`)
  }
  if (!Array.isArray(review.review_frames) || review.review_frames.length === 0) {
    throw new Error(`${label} 缺少审核抽帧。`)
  }
  const reviewedFrames = await Promise.all(review.review_frames.map(frame => evidenceFile(project, frame, label, staged)))
  for (const frame of reviewedFrames) capture(frame, await (staged === undefined ? fileSha256(frame) : staged.hash(frame)))
  if (verifyDialoguePatch !== undefined) return await verifyDialoguePatch()
  if (review.subtitle_cleanup !== 'clean') {
    if (hasSeparateAudio(project, row) && audioSha256 !== undefined && audioSha256 !== videoSha256) {
      throw new Error(`${label} 独立原声音轨缺少可验证的原片复验，不能按未处理片归档。`)
    }
    await verifyDownload(project, review.original_download_receipt_path, row.video, videoSha256, label, capture, undefined, staged)
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
    const originalFrame = await evidenceFile(project, erasure.original_review_frame, label, staged)
    if (reviewedFrames.includes(originalFrame)) throw new Error(`${label} 本地去字幕需要独立的处理前后抽帧。`)
    capture(originalFrame, await (staged === undefined ? fileSha256(originalFrame) : staged.hash(originalFrame)))
    await verifyDownload(project, review.original_download_receipt_path, row.audio, audioSha256, label, capture, undefined, staged)
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
  await verifyDownload(project, erasure.download_receipt_path, row.video, videoSha256, label, capture, erasure.output_url_sha256, staged)
  await verifyDownload(project, review.original_download_receipt_path, row.audio, audioSha256, label, capture, undefined, staged)
  return undefined
}

/** Compare normalized selected paths, including the manifest's default embedded audio.
 * @param project - Absolute project root for resolving selected media.
 * @param row - One selected picture and sound source.
 * @returns Whether picture and sound use different source paths.
 */
export function hasSeparateAudio(project: string, row: ShotSource): boolean {
  return resolve(project, row.video) !== resolve(project, row.audio)
}

async function episodeReviews(paths: EpisodePaths,
  staged?: SourceQaStagedAccess): Promise<Map<number, { row: Record<string, unknown>; sha256: string }>> {
  const directory = resolve(paths.project, 'reviews')
  let names: string[]
  try { names = staged === undefined ? await readdir(directory) : [...staged.list(directory)] }
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
    const bytes = await (staged === undefined ? readFile(file) : staged.read(file))
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
 * @param paths - Current project's episode paths.
 * @param rows - Explicit selected picture and sound sources.
 * @param delivering - Whether missing required source approval must prevent delivery.
 * @param requireContent - Whether each source needs complete content and real OCR/visual evidence.
 * @param sourceQaVerifier - Host-owned access to the actual OCR execution and durable observation records.
 * @param staged - Optional Host-captured mapping; its completeness and authorization are the caller's responsibility.
 * @returns Checked per-shot media and review identities with optional strict source QA evidence.
 */
export async function verifySelectedSourceReviews(paths: EpisodePaths, rows: readonly ShotSource[],
  delivering = false, requireContent = false, sourceQaVerifier?: SourceQaVerifier,
  staged?: SourceQaStagedAccess): Promise<ReviewedShot[]> {
  if (staged !== undefined && staged.project !== paths.project) throw new Error('Source QA stage belongs to another project')
  const reviews = await episodeReviews(paths, staged)
  const approvedPackages = [...reviews].filter(([, review]) => review.row.status === 'approved').map(([pack]) => pack)
  const hashes = new Map<string, Promise<string>>()
  const fileHash = (file: string): Promise<string> => {
    const path = resolve(paths.project, file)
    const existing = hashes.get(path)
    if (existing !== undefined) return existing
    const pending = staged === undefined ? fileSha256(path) : staged.hash(path)
    hashes.set(path, pending)
    return pending
  }
  let packageSha256: string | undefined
  let plan: Record<string, unknown> | undefined
  let videoTasks: readonly unknown[] = []
  let packageCount = 0
  if (approvedPackages.length > 0 || (delivering && reviews.size > 0)) {
    const file = resolve(paths.project, 'episode_packages', paths.episode, 'package.json')
    const bytes = await (staged === undefined ? readFile(file) : staged.read(file))
    plan = document(bytes, file)
    const tasks = plan.video_tasks
    if (plan.episode !== paths.episode || !Array.isArray(tasks) || tasks.length === 0
      || tasks.some((task: unknown) => !record(task) || !Array.isArray(task.shots) || task.shots.length === 0
        || task.shots.some((shot: unknown) => typeof shot !== 'number' || !Number.isSafeInteger(shot) || shot < 1))) {
      throw new Error(`EP${paths.episode} 编译分包清单的集号或包内容无效。`)
    }
    packageCount = tasks.length
    videoTasks = tasks
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
    const patchDeclared = approved?.row.local_dialogue_patch !== undefined
    const patchPath = [row.video, row.audio].some(path => isLocalDialoguePatchOutput(paths.project, path))
    const markedApproved = approved?.row.status === 'approved'
    const pendingPatch = !patchDeclared || !patchPath || separate || !markedApproved
    if ((patchDeclared || patchPath) && ((delivering && !requireContent) || ((delivering || markedApproved) && pendingPatch))) {
      throw localPatchPending(label)
    }
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
    let sourceQa: SourceQaVerification | undefined
    if (requireContent) {
      const contentFiles = new Map<string, string>()
      const capture = (path: string, sha256: string): void => {
        const previous = contentFiles.get(path)
        if (previous !== undefined && previous !== sha256) throw new Error(`${label} 审核证据在核验期间已变化。`)
        contentFiles.set(path, sha256)
      }
      const verifyPatch = patchDeclared
        ? () => verifyDialoguePatchFiles(paths, review, row, plan, videoTasks, videoSha256, audioSha256, label, capture, staged)
        : undefined
      const patch = await verifyContentEvidence(paths.project, review, row, videoSha256, audioSha256, label, capture, staged, verifyPatch)
      sourceQa = await verifySourceQa({ project: paths.project, review, videoPath: row.video, videoSha256,
        originalPath: row.audio, originalSha256: audioSha256 ?? videoSha256,
        ...(sourceQaVerifier === undefined ? {} : { verifier: sourceQaVerifier }), ...(staged === undefined ? {} : { staged }),
        ...(patch === undefined ? {} : { localDialoguePatch: patch }) })
      sourceQa = { ...sourceQa, files: [...sourceQa.files,
        ...[...contentFiles].map(([path, sha256]) => ({ path, sha256 })),
        { path: resolve(paths.project, 'reviews', `ep${paths.episode}-p${String(row.package).padStart(2, '0')}.json`), sha256: approved.sha256 },
        { path: resolve(paths.project, 'episode_packages', paths.episode, 'package.json'), sha256: packageSha256 as string }] }
    }
    verified.push({ shot: row.shot, videoSha256,
      ...(audioSha256 === undefined ? {} : { audioSha256 }), reviewSha256: approved.sha256,
      ...(patchDeclared ? { requiresLocalDialoguePatch: true } : {}),
      ...(sourceQa === undefined ? {} : { sourceQa }) })
  }
  for (const shot of verified) for (const file of shot.sourceQa?.files ?? []) {
    if (await (staged === undefined ? fileSha256(file.path) : staged.hash(file.path)) !== file.sha256) {
      throw new Error('核验期间源片或审核证据已变化。')
    }
  }
  return verified
}
