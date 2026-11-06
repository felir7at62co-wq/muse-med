/** Validate current OCR and visual observation artifacts before formal source adoption. */
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileSha256 } from './cache.ts'
import { normalizeOcrText } from '@deepseek-ai/dsh-tool-video-inspect'

/** Exact local artifacts whose successful execution the Host must establish. */
export interface SourceQaEvidenceBinding {
  readonly mediaPath: string
  readonly mediaSha256: string
  readonly ocrPath: string
  readonly ocrSha256: string
  readonly inspectionPath: string
  readonly inspectionSha256: string
  readonly sessionId: string
  readonly reviewId: string
}

/** Host-owned access to actual OCR execution and durable video observation records. */
export type SourceQaVerifier = (binding: SourceQaEvidenceBinding) => Promise<void>

/** Current inspected artifacts and the decision summary consumed by a formal render. */
export interface SourceQaVerification {
  readonly sha256: string
  readonly files: readonly { readonly path: string; readonly sha256: string }[]
}

type ObjectValue = Record<string, unknown>
interface Captured { path: string; sha256: string; value: ObjectValue }
interface Evidence {
  binding: SourceQaEvidenceBinding
  ocr: ObjectValue
  inspection: ObjectValue
  duration: number
  files: { path: string; sha256: string }[]
}

function fail(reason: string): never { throw new Error(`源画面复验未完成：${reason}`) }
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function hash(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex') }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 }
function rows(value: unknown, name: string): ObjectValue[] {
  if (!Array.isArray(value) || !value.every(object)) fail(`${name}不是实际工具数组。`)
  return value
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${name}缺失。`)
  return value
}
function sameTime(left: unknown, right: number): boolean {
  return typeof left === 'number' && Number.isFinite(left) && Math.abs(left - right) <= 0.001
}
function fileKey(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path }

async function projectFile(project: string, path: unknown): Promise<string> {
  const root = await realpath(project)
  const file = await realpath(resolve(project, text(path, '复验文件路径')))
  const inside = relative(root, file)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !(await stat(file)).isFile()) {
    fail('复验文件必须是当前项目内的普通文件。')
  }
  return file
}

async function artifact(project: string, ref: unknown, label: string): Promise<Captured> {
  if (!object(ref) || !digest(ref.sha256)) fail(`${label}缺少文件摘要。`)
  // Inspection tools retain their exact report paths under the owning Session workspace.
  // The independent Host verifier must authorize these paths before adoption.
  const path = await realpath(resolve(project, text(ref.path, `${label}文件路径`)))
  if (!(await stat(path)).isFile()) fail(`${label}不是实际工具文件。`)
  const bytes = await readFile(path)
  if (hash(bytes) !== ref.sha256) fail(`${label}文件已变化。`)
  const value: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''))
  if (!object(value)) fail(`${label}文件不是工具记录。`)
  return { path, sha256: ref.sha256, value }
}

function inspectOcr(ocr: ObjectValue): number {
  const interval = ocr.interval, coverage = ocr.coverage
  if (ocr.schema_version !== 1 || ocr.text_source !== 'ocr' || typeof ocr.path !== 'string'
    || !positive(ocr.duration_seconds) || typeof ocr.source_version !== 'string'
    || ocr.scan_status !== 'complete' || !object(interval)
    || !sameTime(interval.start_seconds, 0) || !sameTime(interval.end_seconds, ocr.duration_seconds)
    || !object(coverage) || !positive(coverage.frame_interval_seconds)
    || coverage.frame_interval_seconds > 0.5) fail('OCR来源或完整扫描状态不符，源画面复验要求至少每0.5秒扫描。')
  const frames = rows(ocr.frames, 'OCR原帧')
  if (!frames.length || frames.length !== Math.ceil(ocr.duration_seconds / coverage.frame_interval_seconds)
    || coverage.planned_frame_count !== frames.length || coverage.processed_frame_count !== frames.length
    || coverage.failed_frame_count !== 0 || !Array.isArray(coverage.failed_timestamps_seconds)
    || coverage.failed_timestamps_seconds.length !== 0 || !Array.isArray(coverage.unscanned_ranges)
    || coverage.unscanned_ranges.length !== 0) fail('OCR仍有漏扫或失败时段。')
  let end = 0
  for (const range of rows(coverage.scanned_ranges, 'OCR扫描范围')) {
    if (!sameTime(range.start_seconds, end) || !positive(range.end_seconds) || range.end_seconds <= end
      || range.end_seconds > ocr.duration_seconds + 0.001) fail('OCR扫描范围有缺口。')
    end = range.end_seconds
  }
  if (!sameTime(end, ocr.duration_seconds)) fail('OCR没有覆盖完整源片。')
  const ids = new Set<string>()
  let previous = -1
  for (const [index, frame] of frames.entries()) {
    const id = text(frame.id, 'OCR原帧ID')
    if (ids.has(id) || typeof frame.timestamp_seconds !== 'number' || !Number.isFinite(frame.timestamp_seconds)
      || frame.timestamp_seconds < 0 || frame.timestamp_seconds >= ocr.duration_seconds
      || typeof frame.requested_seconds !== 'number' || !Number.isFinite(frame.requested_seconds)
      || frame.requested_seconds <= previous || frame.requested_seconds >= ocr.duration_seconds
      || !sameTime(frame.requested_seconds, index * coverage.frame_interval_seconds)
      || !positive(frame.image_width) || !positive(frame.image_height)) fail('OCR原帧身份或时间无效。')
    rows(frame.lines, 'OCR文字行')
    previous = frame.requested_seconds
    ids.add(id)
  }
  return ocr.duration_seconds
}

function inspectReport(report: ObjectValue, ocr: ObjectValue, duration: number): void {
  if (typeof report.path !== 'string' || report.source_version !== ocr.source_version || report.scan_complete !== true
    || !sameTime(report.duration, duration) || !sameTime(report.scanned_until, duration)) fail('审看报告没有覆盖当前完整源片。')
  const frames = rows(report.frames, '审看帧')
  if (!frames.length || frames.some(frame => frame.exposed !== true || !object(frame.image)
    || !object(frame.observation) || typeof frame.time !== 'number' || !Number.isFinite(frame.time)
    || frame.time < 0 || frame.time >= duration || typeof frame.decoded_time !== 'number' || !Number.isFinite(frame.decoded_time)
    || frame.decoded_time < 0 || frame.decoded_time >= duration)) fail('审看帧未全部实际展示、记录观察和有效的实际解码时码。')
}

function observedFrames(evidence: Evidence, ids: unknown): ObjectValue[] {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) fail('文字判定缺少明确的已观察帧。')
  const frames = rows(evidence.inspection.frames, '审看帧')
  return ids.map(id => frames.find(frame => frame.id === id) ?? fail('文字判定引用了其他审看的帧。'))
}

function verifyTextDecisions(evidence: Evidence, declaration: ObjectValue): void {
  const decisions = declaration.text_decisions === undefined ? [] : rows(declaration.text_decisions, '非对白文字判定')
  const segments = rows(evidence.ocr.segments, 'OCR文字时段')
  const frames = rows(evidence.ocr.frames, 'OCR原帧')
  const approved = new Set<number>()
  for (const decision of decisions) {
    const index = decision.segment_index
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || approved.has(index)) fail('非对白文字判定的时段编号无效或重复。')
    const segment = segments[index]
    if (segment === undefined || segment.text !== decision.text || typeof segment.start_seconds !== 'number'
      || typeof segment.end_seconds !== 'number' || !sameTime(decision.start_seconds, segment.start_seconds)
      || !sameTime(decision.end_seconds, segment.end_seconds)
      || (decision.kind !== 'non_dialogue_text' && decision.kind !== 'disclosure_watermark')) fail('非对白文字判定没有精确对应OCR时段。')
    text(decision.reason, '非对白文字判定理由')
    const observations = observedFrames(evidence, decision.observation_frame_ids)
    if (!observations.some(frame => (frame.decoded_time as number) >= (segment.start_seconds as number)
      && (frame.decoded_time as number) < (segment.end_seconds as number))) fail('非对白文字时段没有对应的已观察画面。')
    approved.add(index)
  }
  for (const [index, segment] of segments.entries()) {
    if (typeof segment.text !== 'string' || !Array.isArray(segment.evidence_frame_ids)) fail('OCR文字时段记录无效。')
    if (segment.text.trim() && !approved.has(index)) fail(`所选源片仍有待判断文字「${segment.text}」，不能声明无残字。`)
  }
  for (const frame of frames) {
    for (const line of rows(frame.lines, 'OCR文字行')) {
      if (typeof line.text !== 'string') fail('OCR文字行记录无效。')
      if (normalizeOcrText(line.text) && !segments.some((segment, index) => approved.has(index)
        && typeof segment.text === 'string' && normalizeOcrText(segment.text) === normalizeOcrText(line.text as string)
        && Array.isArray(segment.evidence_frame_ids) && segment.evidence_frame_ids.includes(frame.id))) {
        fail('所选源片有未经逐时段判定的OCR文字行。')
      }
    }
  }
  const hasText = frames.some(frame => rows(frame.lines, 'OCR文字行').some(line => typeof line.text === 'string' && normalizeOcrText(line.text)))
  if (evidence.ocr.text_status !== (hasText ? 'candidate_text_detected' : 'no_text_detected')) fail('OCR文字结论和实际文字行不符。')
}

async function evidence(project: string, value: unknown, expectedMedia: string, expectedSha256: string,
  verifier: SourceQaVerifier): Promise<Evidence> {
  if (!object(value) || value.media_sha256 !== expectedSha256) fail('复验没有绑定本次实际源片。')
  const media = await projectFile(project, value.media_path)
  if (fileKey(media) !== fileKey(await projectFile(project, expectedMedia))) fail('复验没有绑定本次实际源片。')
  if (await fileSha256(media) !== expectedSha256) fail('复验源片已变化。')
  if (!object(value.inspection)) fail('审看身份缺失。')
  const [ocr, inspection] = await Promise.all([artifact(project, value.ocr, 'OCR'), artifact(project, value.inspection, '审看报告')])
  for (const record of [ocr.value, inspection.value]) {
    const recordedMedia = text(record.path, '工具记录中的源片路径')
    if (!isAbsolute(recordedMedia) || fileKey(await realpath(recordedMedia)) !== fileKey(media)) fail('OCR或审看报告属于另一份源片。')
  }
  const duration = inspectOcr(ocr.value)
  inspectReport(inspection.value, ocr.value, duration)
  const binding: SourceQaEvidenceBinding = { mediaPath: media, mediaSha256: expectedSha256,
    ocrPath: ocr.path, ocrSha256: ocr.sha256, inspectionPath: inspection.path, inspectionSha256: inspection.sha256,
    sessionId: text(value.inspection.session_id, '审看会话'), reviewId: text(value.inspection.review_id, '审看ID') }
  if (inspection.value.id !== binding.reviewId) fail('审看ID与实际报告不符。')
  await verifier(binding)
  const files = [{ path: media, sha256: expectedSha256 }, { path: ocr.path, sha256: ocr.sha256 },
    { path: inspection.path, sha256: inspection.sha256 }]
  for (const file of files) if (await fileSha256(file.path) !== file.sha256) fail('核实执行记录期间源片或复验文件已变化。')
  return { binding, ocr: ocr.value, inspection: inspection.value, duration, files }
}

/**
 * Require actual complete OCR and observed video evidence for the selected source.
 * Cleaned footage additionally needs its original and paired observations inside each affected interval.
 * Text categories remain model judgments grounded in observed frames.
 * @param input - Selected source identities, review decisions and the independent Host execution verifier.
 * @returns Current source QA digest and the exact files that must remain bound to the render.
 */
export async function verifySourceQa(input: {
  project: string
  review: ObjectValue
  videoPath: string
  videoSha256: string
  originalPath: string
  originalSha256: string
  verifier?: SourceQaVerifier
}): Promise<SourceQaVerification> {
  const qa = input.review.source_qa
  if (!object(qa) || qa.version !== 1 || !object(qa.selected)) fail('缺少当前源片的source_qa记录。先对实际源片运行video_ocr完整扫描（间隔0.5秒），再优先用video_source_review，或已启用完整模式的video_inspect执行scan→next实际查看图片→observe。按渲染工具README记录工具返回的真实路径、摘要和身份后重验。')
  if (input.verifier === undefined) fail('缺少真实OCR执行和审看记录核验，请在Muse正常drama_render入口，沿video_source_review或已启用完整模式的video_inspect补齐真实审看后重验。')
  const selected = await evidence(input.project, qa.selected, input.videoPath, input.videoSha256, input.verifier)
  verifyTextDecisions(selected, qa.selected)
  const files = [...selected.files]
  let original: Evidence | undefined
  if (input.review.subtitle_cleanup === 'clean') {
    if (input.originalSha256 === input.videoSha256) fail('清理片与原片字节相同，须核对实际去字幕结果。')
    original = await evidence(input.project, qa.original, input.originalPath, input.originalSha256, input.verifier)
    if (!sameTime(original.duration, selected.duration)) fail('清理片与原片时长不一致，不能沿用原声。')
    const intervals = rows(qa.affected_intervals, '处理时段')
    if (!intervals.length) fail('清理片缺少实际处理时段。')
    for (const interval of intervals) {
      if (typeof interval.start_seconds !== 'number' || !Number.isFinite(interval.start_seconds) || interval.start_seconds < 0
        || !positive(interval.end_seconds) || interval.end_seconds <= interval.start_seconds
        || interval.end_seconds > selected.duration + 0.001) fail('处理时段超出当前源片。')
      for (const source of [original, selected]) {
        if (!rows(source.inspection.frames, '审看帧').some(frame => (frame.decoded_time as number) >= (interval.start_seconds as number)
          && (frame.decoded_time as number) < (interval.end_seconds as number))) {
          const midpoint = (interval.start_seconds + interval.end_seconds) / 2
          fail(`实际处理时段缺少清理前后的已观察画面，须补充审看。优先用video_source_review，或已启用完整模式的video_inspect，对对应源片运行scan并传timestamps_seconds:[${midpoint}]，然后next查看真实图片、observe记录观察，取得新报告后重验。`)
        }
      }
    }
    files.push(...original.files)
  }
  return { sha256: hash(JSON.stringify({ version: 1, qa, selected: selected.binding, original: original?.binding })), files }
}

/** Bind each currently approved shot and all inspected files to one render decision.
 * @param reviews - Current checked shot reviews, each with its bound source QA result.
 * @returns Ordered review digest and the complete deduplicated set of evidence files.
 */
export function summarizeSourceQa(
  reviews: readonly { shot: number; reviewSha256: string; sourceQa?: SourceQaVerification }[],
): SourceQaVerification {
  if (!reviews.length) fail('本集缺少完整源片复验。')
  const ordered = reviews.map((review) => {
    if (review.sourceQa === undefined) fail('本集缺少完整源片复验。')
    return { ...review, sourceQa: review.sourceQa }
  }).sort((left, right) => left.shot - right.shot)
  return { sha256: hash(JSON.stringify(ordered.map(review => ({ shot: review.shot,
    review_sha256: review.reviewSha256, source_qa_sha256: review.sourceQa.sha256 })))),
  files: [...new Map(ordered.flatMap(review => review.sourceQa.files).map(file => [file.path, file])).values()] }
}
