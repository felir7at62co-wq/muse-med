/** Bind episode content judgments to observed source/output images and a real listening answer. */
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { hasReviewUncertainty, type VideoObservationVerifier } from '@deepseek-ai/dsh-tool-video-inspect'
import { createVideoObservationVerifier } from '@deepseek-ai/dsh-tool-video-inspect/source-qa'
import { fileSha256 } from './cache.ts'
import { contentListeningQuestion, installContentListeningState, verifyProjectedContentListening } from './content-listening.ts'
export { contentListeningQuestion, verifyContentListeningAnswer } from './content-listening.ts'

/** A current video observation issued by the Host, rather than a model-written pass flag. */
export interface ContentVideoBinding {
  readonly kind: 'video'
  readonly mediaPath: string
  readonly mediaSha256: string
  readonly inspectionPath: string
  readonly inspectionSha256: string
  readonly sessionId: string
  readonly reviewId: string
}

/** A user answer to the exact current output's listening question. */
export interface ContentListeningBinding {
  readonly kind: 'listening'
  readonly sessionId: string
  readonly callId: string
  readonly questionId: string
  readonly question: string
}

/** Verify real observation/answer origins without acquiring media or making paid calls. */
export type ContentReviewVerifier = (binding: ContentVideoBinding | ContentListeningBinding) => Promise<void>

/** Create operation-local content checks after the Host observation and listening readers are ready.
 * @param ctx - Owning Host scope with filesystem, policy and Session projections.
 * @returns A factory binding each check to its actual initiating Session and cancellation signal.
 */
export async function createContentReviewVerifier(ctx: Context): Promise<(
  session: Parameters<VideoObservationVerifier>[0], signal: AbortSignal) => ContentReviewVerifier> {
  const observe = await createVideoObservationVerifier(ctx)
  const readListening = await installContentListeningState(ctx)
  ctx.fiber.assertActive()
  return (session, signal) => async (binding) => {
    if (binding.kind === 'video') {
      await observe(session, binding, signal)
      return
    }
    signal.throwIfAborted()
    verifyProjectedContentListening(readListening, session, binding)
  }
}

/** Files whose exact versions must remain available at the final delivery operation. */
export interface ContentReviewReceipt {
  readonly path: string
  readonly sha256: string
  readonly files: readonly { readonly path: string; readonly sha256: string }[]
  /**
   * Unattended runs only: findings a person still has to settle after the whole drama is made, in review order.
   * Absent when nothing is pending, so attended receipts keep their previous shape.
   */
  readonly pending?: readonly string[]
}

/**
 * Unattended runs may defer at most this many picture findings per episode. More means the episode needs repair,
 * not a longer list for the person who reviews the finished drama.
 */
export const UNATTENDED_PICTURE_PENDING_LIMIT = 3

/** First line of the pending list when no person has listened to the current output. */
export const LISTENING_PENDING = '整集试听待人工听校：无人值守运行中没有人试听当前成片，发音、漏说错说、说话人和声音衔接须在全剧完成后人工听校。'

/**
 * Whether this Host runs without a person, read from the session coordinator's deployment mode when it is mounted.
 * @param ctx - Any Host scope; the coordinator is optional and read structurally so this package keeps no dependency on it.
 * @returns True only when a mounted coordinator reports `unattended`.
 */
export function unattendedReviewMode(ctx: Pick<Context, 'get'>): boolean {
  const coordinator: unknown = (ctx.get as (name: string) => unknown)('sessionCoordinator')
  if (coordinator === null || typeof coordinator !== 'object') return false
  const mode: unknown = (coordinator as { mode?: unknown }).mode
  return mode !== null && typeof mode === 'object' && (mode as { unattended?: unknown }).unattended === true
}

type Row = Record<string, unknown>
const dimensions = ['physical_logic', 'continuity'] as const
/** Audio issue tags in the built-in video-review skill's film review register. */
const audioIssueItems = new Set<unknown>(['bgm_volume', 'bgm_fit', 'bgm_adjacent_repeat'])
function fail(reason: string): never { throw Error(`CONTENT_REVIEW_PENDING: ${reason} 保留工作候选，修复对应时段并复验后再交付；不自动购买转写。`) }
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const rows = (value: unknown, label: string): Row[] => Array.isArray(value) && value.every(object) ? value : fail(`${label}缺失或无效。`)
const equalPath = (left: string, right: string) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)

async function localFile(project: string, path: unknown, expected?: unknown, confined = true) {
  if (!text(path)) fail('审查证据缺少路径。')
  const root = await realpath(project), file = resolve(project, path)
  const part = relative(root, await realpath(file))
  if (confined && (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part))) fail('审查文件必须位于当前项目。')
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) fail('审查文件必须是8MiB以内的普通文件。')
  const bytes = await readFile(file), sha256 = createHash('sha256').update(bytes).digest('hex')
  if (expected !== undefined && (!hash(expected) || sha256 !== expected)) fail('审查或观察文件已变化。')
  const value: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''))
  if (!object(value)) fail('审查文件必须是JSON对象。')
  return { path: file, sha256, value }
}

/**
 * Require reviewed ranges to cover the whole duration; an open finding inside a reviewed range goes to `concern`.
 * Gaps and malformed ranges always fail: something must actually have been reviewed.
 */
function coverage(ranges: readonly Row[], dimension: string, duration: number, concern: (reason: string) => void = fail): void {
  const selected = ranges.filter(row => row.dimension === dimension).sort((a, b) => Number(a.start_seconds) - Number(b.start_seconds))
  let covered = 0
  for (const row of selected) {
    if (!number(row.start_seconds) || !number(row.end_seconds) || row.start_seconds < 0
      || row.end_seconds <= row.start_seconds || row.end_seconds > duration + 0.001
      || row.start_seconds > covered + 0.001) fail(`${dimension}存在未审查区间。`)
    if (!text(row.reason)) fail(`${dimension} ${row.start_seconds}–${row.end_seconds}秒缺少审查说明。`)
    if (row.status !== 'ok') concern(`${dimension} ${row.start_seconds}–${row.end_seconds}秒仍有问题或未核实：${row.reason}`)
    covered = Math.max(covered, row.end_seconds)
  }
  if (covered < duration - 0.001) fail(`${dimension}未覆盖完整的${duration}秒。`)
}

/** Require current source/output content review before staging or sending a final episode.
 * @param input - Current independently verified output and selected pre-concatenation clips. With `unattended`,
 * the review must still exist and cover every frame and range, but open picture findings, recorded issues and the
 * missing human listening answer become `pending` items for the person who reviews the finished drama.
 * Subtitle and spec verdicts stay mandatory in both modes.
 * @returns Exact review files to bind to the delivery receipt; no semantic perfection is claimed.
 */
export async function verifyEpisodeContentReview(input: {
  readonly project: string
  readonly episode: string
  readonly output: string
  readonly outputSha256: string
  readonly duration: number
  readonly sources: readonly { readonly shot: number; readonly sha256: string; readonly duration: number }[]
  readonly cuts: readonly number[]
  readonly path?: string
  readonly verifier?: ContentReviewVerifier
  readonly unattended?: boolean
}): Promise<ContentReviewReceipt> {
  const unattended = input.unattended === true
  const pending: string[] = []
  const picturePending = new Set<string>()
  const concern = (reason: string, audio = false): void => {
    if (!unattended) fail(reason)
    if (!pending.includes(reason)) pending.push(reason)
    if (!audio) picturePending.add(reason)
  }
  const audioConcern = (reason: string): void => { concern(reason, true) }
  const saved = await localFile(input.project, input.path ?? '_probe/delivery-config/film-reviews.json')
  const films = saved.value.films, film = object(films) ? films[input.episode] ?? films[String(Number(input.episode))] : undefined
  if (!object(film) || !text(film.source) || !equalPath(resolve(input.project, film.source), input.output)
    || film.sha256 !== input.outputSha256 || film.reviewed !== true) fail('缺少当前成片SHA-256绑定的审查登记。')
  if (!Array.isArray(film.issues)) fail('成片审查缺少issues列表。')
  if (!unattended) {
    if (['picture', 'audio', 'subtitle', 'spec'].some(key => film[key] !== 'ok')
      || film.issues.length !== 0) fail('成片审查仍有issues或unverified，技术通过不能放行。')
  } else {
    if (['subtitle', 'spec'].some(key => film[key] !== 'ok')) fail('成片字幕或规格审查未通过，无人值守也不能放行。')
    for (const key of ['picture', 'audio'] as const) if (film[key] !== 'ok') concern(`成片${key === 'picture' ? '画面' : '声音'}审查为${String(film[key])}，待人工复核。`, key === 'audio')
    for (const issue of film.issues) {
      const audio = object(issue) && audioIssueItems.has(issue.item)
      concern(`成片审查问题：${typeof issue === 'string' ? issue : JSON.stringify(issue)}`, audio)
    }
  }
  const content = film.content_review
  if (!object(content) || content.version !== 1 || !object(content.output)) fail('缺少分包和成片的内容证据。')
  const sources = rows(content.sources, '原始分包审查')
  if (sources.length !== input.sources.length) fail('分包审查数量与本次选源不符。')
  if (input.verifier === undefined) fail('当前入口不能验证真实观察和试听来源。')
  const files = [{ path: saved.path, sha256: saved.sha256 }]
  for (const [index, target] of [...sources, content.output].entries()) {
    const source = input.sources[index], final = index === sources.length
    const expected = final ? input.outputSha256 : source?.sha256
    if (!hash(expected) || (!final && target.shot !== source?.shot) || target.sha256 !== expected || !text(target.source)
      || (final && !equalPath(resolve(input.project, target.source), input.output))) fail('内容审查引用了其他分包或成片版本。')
    const media = resolve(input.project, target.source)
    const relativeMedia = relative(await realpath(input.project), await realpath(media))
    if (!relativeMedia || relativeMedia === '..' || relativeMedia.startsWith(`..${sep}`) || isAbsolute(relativeMedia)) fail('审查媒体必须在当前项目内。')
    if (await fileSha256(media) !== expected) fail('审查后媒体字节已变化。')
    const observation = target.inspection
    if (!object(observation) || !text(observation.session_id) || !text(observation.review_id)) fail('内容审查缺少真实观察身份。')
    // Observation reports live in the owning Session cache; the Host verifies their exact issuance.
    const report = await localFile(input.project, observation.path, observation.sha256, false)
    const duration = report.value.duration
    if (!number(duration) || duration <= 0 || (final && Math.abs(duration - input.duration) > 0.05)
      || (!final && duration < (source?.duration ?? Infinity) - 0.05)) fail('内容观察没有覆盖当前媒体时长。')
    await input.verifier({ kind: 'video', mediaPath: media, mediaSha256: expected,
      inspectionPath: report.path, inspectionSha256: report.sha256, sessionId: observation.session_id, reviewId: observation.review_id })
    const frames = rows(report.value.frames, '实际观察帧'), checks = rows(target.checks, '内容判断')
    const frameIds = new Set<string>()
    for (const frame of frames) {
      if (!text(frame.id) || frameIds.has(frame.id) || !number(frame.decoded_time)
        || frame.decoded_time < 0 || frame.decoded_time >= duration) fail('实际观察帧身份或解码时间无效。')
      frameIds.add(frame.id)
    }
    if (!frameIds.size) fail('内容判断没有实际观察帧。')
    if (report.value.event_groups !== undefined) for (const event of rows(report.value.event_groups, '动作事件')) {
      if (typeof event.uncertainty !== 'string') fail('已观察动作事件缺少疑点说明。')
      if (hasReviewUncertainty(event.uncertainty)) concern(`${final ? '成片' : `第${String(target.shot)}镜分包`}已观察动作事件仍有未决疑点：${event.uncertainty}`)
    }
    for (const dimension of dimensions) coverage(checks, dimension, duration, concern)
    for (const check of checks) {
      if (!dimensions.includes(check.dimension as typeof dimensions[number]) || !text(check.expected)
        || !Array.isArray(check.frame_ids) || check.frame_ids.length < 2
        || new Set(check.frame_ids).size !== check.frame_ids.length) fail('内容判断须说明预期并引用至少两张不同实际观察帧。')
      for (const id of check.frame_ids) {
        const frame = frames.find(row => row.id === id)
        if (frame === undefined || !number(frame.decoded_time) || frame.decoded_time < Number(check.start_seconds)
          || frame.decoded_time > Number(check.end_seconds)) fail('内容判断的帧与所述时段不符。')
      }
    }
    for (const dimension of dimensions) {
      const used = new Set(checks.filter(check => check.dimension === dimension)
        .flatMap(check => check.frame_ids as string[]))
      if ([...frameIds].some(id => !used.has(id))) fail(`${dimension}跳过了已检测的切镜或画面变化；须逐项判断全部观察帧。`)
    }
    if (final) for (const cut of input.cuts) {
      const near = frames.filter(frame => number(frame.decoded_time) && Math.abs(frame.decoded_time - cut) <= 0.5)
      const before = new Set(near.filter(frame => Number(frame.decoded_time) < cut).map(frame => frame.id))
      const after = new Set(near.filter(frame => Number(frame.decoded_time) >= cut).map(frame => frame.id))
      if (before.size === 0 || after.size === 0) {
        fail(`成片${cut.toFixed(3)}秒接缝缺少两侧实际观察帧。`)
      }
      if (!checks.some(({ dimension, frame_ids: ids }) => dimension === 'continuity' && Array.isArray(ids)
        && ids.some(id => before.has(id)) && ids.some(id => after.has(id)))) {
        fail(`成片${cut.toFixed(3)}秒接缝缺少引用两侧实际观察帧的连续性判断。`)
      }
    }
    files.push({ path: media, sha256: expected }, { path: report.path, sha256: report.sha256 })
  }
  const audio: Row = object(content.audio) ? content.audio : {}
  const answered = audio.status === 'ok' && text(audio.session_id) && text(audio.question_call_id)
  if (!unattended && !answered) fail('实际发音仍未听核。')
  if (!unattended) {
    const audioRanges = rows(audio.ranges, '声音审查')
    if (audioRanges.some(row => row.dimension !== 'pronunciation')) fail('声音范围必须明确核对实际发音。')
    coverage(audioRanges, 'pronunciation', input.duration)
  } else if (audio.ranges !== undefined) {
    // Unattended: machine pronunciation ranges are optional evidence; gaps and open ranges go to the person.
    try {
      const audioRanges = rows(audio.ranges, '声音审查')
      if (audioRanges.some(row => row.dimension !== 'pronunciation')) fail('声音范围必须明确核对实际发音。')
      if (audioRanges.length > 0) coverage(audioRanges, 'pronunciation', input.duration, audioConcern)
    } catch (error) {
      audioConcern(String(error).replace(/^(?:Error: )?CONTENT_REVIEW_PENDING: /u, '机器读音检查：'))
    }
  }
  let listened = false
  if (answered) {
    const question = contentListeningQuestion(input.output, input.outputSha256, input.duration)
    try {
      await input.verifier({ kind: 'listening', sessionId: String(audio.session_id), callId: String(audio.question_call_id),
        questionId: question.id, question: question.question })
      listened = true
    } catch (error) {
      // Nobody can answer in an unattended run; a claimed answer that does not verify leaves listening to a person.
      if (!unattended || !String(error).includes('CONTENT_REVIEW_PENDING')) throw error
    }
  }
  if (picturePending.size > UNATTENDED_PICTURE_PENDING_LIMIT) {
    fail(`无人值守：本集画面类待核 ${picturePending.size} 项，超过上限 ${UNATTENDED_PICTURE_PENDING_LIMIT} 项。`
      + `请先局部修复或返工受影响的包并复审，再归档。待核清单：${[...picturePending].join('；')}`)
  }
  if (unattended && !listened) pending.unshift(LISTENING_PENDING)
  for (const file of files) if (await fileSha256(file.path) !== file.sha256) fail('核验期间内容证据已变化。')
  return { path: saved.path, sha256: saved.sha256, files, ...(pending.length === 0 ? {} : { pending }) }
}
