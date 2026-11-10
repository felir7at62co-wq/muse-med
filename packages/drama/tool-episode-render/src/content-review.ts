/** Bind episode content judgments to observed source/output images and a real listening answer. */
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { hasReviewUncertainty, verifyVideoObservationEvidence } from '@deepseek-ai/dsh-tool-video-inspect'
import { fileSha256 } from './cache.ts'
import { contentListeningQuestion, verifyProjectedContentListening } from './content-listening.ts'
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

/** Bind content checks to the actual tool initiator and its committed observation/answer events.
 * @param ctx - Same-world Host services.
 * @param session - Actual initiating Session, absent for agentless calls.
 * @param signal - Cancellation for read-only evidence verification.
 * @returns A verifier that never generates media or treats model-written approval as user listening.
 */
export function createContentReviewVerifier(ctx: Context,
  session: Parameters<typeof verifyVideoObservationEvidence>[1], signal: AbortSignal): ContentReviewVerifier {
  return async (binding) => {
    if (binding.kind === 'video') {
      await verifyVideoObservationEvidence(ctx, session, binding, signal)
      return
    }
    signal.throwIfAborted()
    verifyProjectedContentListening(ctx, session, binding)
  }
}

/** Files whose exact versions must remain available at the final delivery operation. */
export interface ContentReviewReceipt {
  readonly path: string
  readonly sha256: string
  readonly files: readonly { readonly path: string; readonly sha256: string }[]
}

type Row = Record<string, unknown>
const dimensions = ['physical_logic', 'continuity'] as const
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

function coverage(ranges: readonly Row[], dimension: string, duration: number): void {
  const selected = ranges.filter(row => row.dimension === dimension).sort((a, b) => Number(a.start_seconds) - Number(b.start_seconds))
  let covered = 0
  for (const row of selected) {
    if (!number(row.start_seconds) || !number(row.end_seconds) || row.start_seconds < 0
      || row.end_seconds <= row.start_seconds || row.end_seconds > duration + 0.001
      || row.start_seconds > covered + 0.001) fail(`${dimension}存在未审查区间。`)
    if (row.status !== 'ok' || !text(row.reason)) fail(`${dimension} ${row.start_seconds}–${row.end_seconds}秒仍有问题或未核实。`)
    covered = Math.max(covered, row.end_seconds)
  }
  if (covered < duration - 0.001) fail(`${dimension}未覆盖完整的${duration}秒。`)
}

/** Require current source/output content review before staging or sending a final episode.
 * @param input - Current independently verified output and selected pre-concatenation clips.
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
}): Promise<ContentReviewReceipt> {
  const saved = await localFile(input.project, input.path ?? '_probe/delivery-config/film-reviews.json')
  const films = saved.value.films, film = object(films) ? films[input.episode] ?? films[String(Number(input.episode))] : undefined
  if (!object(film) || !text(film.source) || !equalPath(resolve(input.project, film.source), input.output)
    || film.sha256 !== input.outputSha256 || film.reviewed !== true) fail('缺少当前成片SHA-256绑定的审查登记。')
  if (['picture', 'audio', 'subtitle', 'spec'].some(key => film[key] !== 'ok')
    || !Array.isArray(film.issues) || film.issues.length !== 0) fail('成片审查仍有issues或unverified，技术通过不能放行。')
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
    if (report.value.event_groups !== undefined && rows(report.value.event_groups, '动作事件').some(event =>
      typeof event.uncertainty !== 'string' || hasReviewUncertainty(event.uncertainty))) fail('已观察动作事件仍有未决疑点。')
    for (const dimension of dimensions) coverage(checks, dimension, duration)
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
      if (!near.some(frame => Number(frame.decoded_time) < cut) || !near.some(frame => Number(frame.decoded_time) >= cut)) {
        fail(`成片${cut.toFixed(3)}秒接缝缺少两侧实际观察帧。`)
      }
    }
    files.push({ path: media, sha256: expected }, { path: report.path, sha256: report.sha256 })
  }
  const audio = content.audio
  if (!object(audio) || audio.status !== 'ok' || !text(audio.session_id) || !text(audio.question_call_id)) fail('实际发音仍未听核。')
  const audioRanges = rows(audio.ranges, '声音审查')
  if (audioRanges.some(row => row.dimension !== 'pronunciation')) fail('声音范围必须明确核对实际发音。')
  coverage(audioRanges, 'pronunciation', input.duration)
  const question = contentListeningQuestion(input.output, input.outputSha256, input.duration)
  await input.verifier({ kind: 'listening', sessionId: audio.session_id, callId: audio.question_call_id,
    questionId: question.id, question: question.question })
  for (const file of files) if (await fileSha256(file.path) !== file.sha256) fail('核验期间内容证据已变化。')
  return { path: saved.path, sha256: saved.sha256, files }
}
