/** Validate current OCR and visual observation artifacts before formal source adoption. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises'
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

/** One original file and its immutable private copy; this record is not an authorization. */
export interface SourceQaStagedFile {
  readonly originalPath: string
  readonly stagedPath: string
  readonly sha256: string
  readonly bytes: number
  /** Additional spellings already resolved and authorized by the Host. */
  readonly aliases?: readonly string[]
}

/** Exact names observed by the Host when capturing one original directory. */
export interface SourceQaStagedDirectory {
  readonly originalPath: string
  readonly entries: readonly string[]
}

/** A private-stage reader retaining original paths as logical evidence identities. */
export interface SourceQaStagedAccess {
  readonly project: string
  logical(path: string): string
  /** Private file corresponding to a captured original identity. */
  stagedPath(path: string): string
  read(path: string): Promise<Buffer>
  hash(path: string): Promise<string>
  list(directory: string): readonly string[]
}

/**
 * Bind exact original identities to private files. The caller must independently
 * authenticate this mapping and the Session before making any render decision.
 * @param project - Canonical original project path.
 * @param stage - Canonical private stage root.
 * @param files - Complete original-to-stage file facts supplied by the Host.
 * @param signal - Owner lifetime; cancellation stops every staged read.
 * @param directories - Original directory snapshots captured and rechecked by the Host.
 * @returns A reader that checks file identity and bytes on each access.
 */
export function createSourceQaStagedAccess(project: string, stage: string, files: readonly SourceQaStagedFile[],
  signal: AbortSignal, directories: readonly SourceQaStagedDirectory[] = []): SourceQaStagedAccess {
  if (!isAbsolute(project) || resolve(project) !== project || !isAbsolute(stage) || resolve(stage) !== stage) {
    throw new Error('Source QA stage requires canonical absolute roots')
  }
  const originals = new Map<string, SourceQaStagedFile>(), copies = new Set<string>()
  const listed = new Map<string, readonly string[]>()
  for (const directory of directories) {
    if (!isAbsolute(directory.originalPath) || resolve(directory.originalPath) !== directory.originalPath
      || listed.has(fileKey(directory.originalPath)) || new Set(directory.entries).size !== directory.entries.length
      || directory.entries.some(name => !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\'))) {
      throw new Error('Source QA stage has an invalid directory snapshot')
    }
    listed.set(fileKey(directory.originalPath), [...directory.entries])
  }
  for (const file of files) {
    const within = relative(stage, file.stagedPath)
    const originalWithin = relative(stage, file.originalPath)
    if (!isAbsolute(file.originalPath) || resolve(file.originalPath) !== file.originalPath
      || !isAbsolute(file.stagedPath) || resolve(file.stagedPath) !== file.stagedPath
      || !within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)
      || !originalWithin || (!isAbsolute(originalWithin) && originalWithin !== '..' && !originalWithin.startsWith(`..${sep}`))
      || !/^[a-f0-9]{64}$/u.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || originals.has(fileKey(file.originalPath)) || copies.has(fileKey(file.stagedPath))) {
      throw new Error('Source QA stage has an invalid or ambiguous mapping')
    }
    const captured = { ...file, aliases: [...file.aliases ?? []] }
    for (const spelling of [file.originalPath, ...file.aliases ?? []]) {
      const aliasWithin = relative(stage, spelling)
      if (!isAbsolute(spelling) || resolve(spelling) !== spelling || !aliasWithin
        || (!isAbsolute(aliasWithin) && aliasWithin !== '..' && !aliasWithin.startsWith(`..${sep}`))) {
        throw new Error('Source QA stage has an invalid alias')
      }
      const key = fileKey(spelling), existing = originals.get(key)
      if (existing !== undefined && existing.originalPath !== file.originalPath) throw new Error('Source QA stage has an ambiguous alias')
      originals.set(key, captured)
    }
    copies.add(fileKey(file.stagedPath))
  }
  const logical = (file: string): string => {
    const path = resolve(project, file)
    const mapped = originals.get(fileKey(path))
    if (mapped === undefined) throw new Error('Source QA stage has no captured mapping')
    return mapped.originalPath
  }
  const inspect = async (path: string, collect: boolean): Promise<{ sha256: string; bytes?: Buffer }> => {
    signal.throwIfAborted()
    const file = originals.get(fileKey(logical(path)))
    if (file === undefined) throw new Error('Source QA stage has no captured mapping')
    if (await realpath(stage) !== stage || await realpath(file.stagedPath) !== file.stagedPath) {
      throw new Error('Source QA stage file is not canonical')
    }
    const before = await lstat(file.stagedPath)
    if (!before.isFile() || before.isSymbolicLink() || before.size !== file.bytes) throw new Error('Source QA stage file changed')
    if (collect && file.bytes > 64 * 1024 * 1024) throw new Error('Source QA evidence exceeds its read limit')
    const handle = await open(file.stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const start = await handle.stat()
      if (!start.isFile() || start.ino !== before.ino || start.dev !== before.dev) throw new Error('Source QA stage file changed')
      const sha = createHash('sha256'), buffer = Buffer.alloc(65536), chunks: Buffer[] = []
      let size = 0
      for (;;) {
        signal.throwIfAborted()
        const part = await handle.read(buffer, 0, buffer.length, null)
        if (part.bytesRead === 0) break
        const chunk = buffer.subarray(0, part.bytesRead)
        sha.update(chunk); size += chunk.length
        if (size > file.bytes) throw new Error('Source QA stage file changed')
        if (collect) chunks.push(Buffer.from(chunk))
      }
      const end = await handle.stat(), current = await lstat(file.stagedPath)
      const digest = sha.digest('hex')
      signal.throwIfAborted()
      if (size !== file.bytes || digest !== file.sha256 || end.size !== start.size
        || end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs
        || !current.isFile() || current.isSymbolicLink() || current.ino !== start.ino || current.dev !== start.dev
        || current.size !== start.size
        || current.mtimeMs !== start.mtimeMs || current.ctimeMs !== start.ctimeMs
        || await realpath(stage) !== stage || await realpath(file.stagedPath) !== file.stagedPath) {
        throw new Error('Source QA stage file changed')
      }
      return { sha256: digest, ...(collect ? { bytes: Buffer.concat(chunks) } : {}) }
    } finally { await handle.close() }
  }
  return { project, logical, stagedPath: (path) => {
    const file = originals.get(fileKey(logical(path)))
    if (file === undefined) throw new Error('Source QA stage has no captured mapping')
    return file.stagedPath
  }, list: (directory) => {
    const target = resolve(project, directory)
    const names = listed.get(fileKey(target))
    if (names === undefined) throw new Error('Source QA stage has no captured directory snapshot')
    return [...names]
  }, read: async (path) => {
    const result = await inspect(path, true)
    if (result.bytes === undefined) throw new Error('Source QA staged read returned no bytes')
    return result.bytes
  }, hash: async path => (await inspect(path, false)).sha256 }
}

type ObjectValue = Record<string, unknown>
interface Captured { path: string; sha256: string; value: ObjectValue }
interface Evidence {
  binding: SourceQaEvidenceBinding
  ocr: ObjectValue
  inspection: ObjectValue
  duration: number
  start: number
  end: number
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

async function projectFile(project: string, path: unknown, staged?: SourceQaStagedAccess): Promise<string> {
  const root = staged?.project ?? await realpath(project)
  const requested = resolve(project, text(path, '复验文件路径'))
  const file = staged === undefined ? await realpath(requested) : staged.logical(requested)
  const inside = relative(root, file)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)
    || (staged === undefined && !(await stat(file)).isFile())) {
    fail('复验文件必须是当前项目内的普通文件。')
  }
  return file
}

async function artifact(project: string, ref: unknown, label: string, staged?: SourceQaStagedAccess): Promise<Captured> {
  if (!object(ref) || !digest(ref.sha256)) fail(`${label}缺少文件摘要。`)
  // Inspection tools retain their exact report paths under the owning Session workspace.
  // The independent Host verifier must authorize these paths before adoption.
  const requested = resolve(project, text(ref.path, `${label}文件路径`))
  const path = staged === undefined ? await realpath(requested) : staged.logical(requested)
  if (staged === undefined && !(await stat(path)).isFile()) fail(`${label}不是实际工具文件。`)
  const bytes = staged === undefined ? await readFile(path) : await staged.read(path)
  if (hash(bytes) !== ref.sha256) fail(`${label}文件已变化。`)
  const value: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''))
  if (!object(value)) fail(`${label}文件不是工具记录。`)
  return { path, sha256: ref.sha256, value }
}

function inspectOcr(ocr: ObjectValue): { duration: number; start: number; end: number } {
  const interval = ocr.interval, coverage = ocr.coverage
  if (ocr.schema_version !== 1 || ocr.evidence_algorithm !== 'decoded-pts-spatial-v2' || ocr.text_source !== 'ocr' || typeof ocr.path !== 'string'
    || !positive(ocr.duration_seconds) || typeof ocr.source_version !== 'string'
    || !object(interval) || typeof interval.start_seconds !== 'number' || !Number.isFinite(interval.start_seconds)
    || interval.start_seconds < 0 || !positive(interval.end_seconds) || interval.end_seconds <= interval.start_seconds
    || interval.end_seconds > ocr.duration_seconds || (ocr.scan_status !== 'complete' && ocr.scan_status !== 'partial')
    || !object(coverage) || !positive(coverage.frame_interval_seconds)
    || coverage.frame_interval_seconds > 0.5) fail('OCR来源或完整扫描状态不符，须用当前版本重新扫描，源画面复验要求至少每0.5秒扫描。')
  const frames = rows(ocr.frames, 'OCR原帧')
  const start = interval.start_seconds, end = interval.end_seconds
  if (!frames.length || start + (frames.length - 1) * coverage.frame_interval_seconds >= end
    || start + frames.length * coverage.frame_interval_seconds < end
    || coverage.planned_frame_count !== frames.length || coverage.processed_frame_count !== frames.length
    || coverage.failed_frame_count !== 0 || !Array.isArray(coverage.failed_timestamps_seconds)
    || coverage.failed_timestamps_seconds.length !== 0) fail('OCR仍有漏扫或失败时段。')
  const unscanned = rows(coverage.unscanned_ranges, 'OCR未扫描范围')
  const remaining = unscanned[0]
  if (ocr.scan_status === 'complete' ? unscanned.length !== 0
    : unscanned.length !== 1 || remaining === undefined || !sameTime(remaining.start_seconds, end)
      || !positive(remaining.end_seconds) || remaining.end_seconds <= end
      || remaining.end_seconds > ocr.duration_seconds
      || remaining.reason !== 'deployment_limit') fail('OCR仍有漏扫或失败时段。')
  let scannedEnd = start
  for (const range of rows(coverage.scanned_ranges, 'OCR扫描范围')) {
    if (!sameTime(range.start_seconds, scannedEnd) || !positive(range.end_seconds) || range.end_seconds <= scannedEnd
      || range.end_seconds > end + 0.001) fail('OCR扫描范围有缺口。')
    scannedEnd = range.end_seconds
  }
  if (!sameTime(scannedEnd, end)) fail('OCR没有覆盖本段源片。')
  const ids = new Set<string>()
  let previous = -1
  for (const [index, frame] of frames.entries()) {
    const id = text(frame.id, 'OCR原帧ID')
    if (ids.has(id) || typeof frame.timestamp_seconds !== 'number' || !Number.isFinite(frame.timestamp_seconds)
      || frame.timestamp_seconds < 0 || frame.timestamp_seconds >= ocr.duration_seconds
      || typeof frame.requested_seconds !== 'number' || !Number.isFinite(frame.requested_seconds)
      || frame.requested_seconds <= previous || frame.requested_seconds >= end
      || !sameTime(frame.requested_seconds, start + index * coverage.frame_interval_seconds)
      || !positive(frame.image_width) || !positive(frame.image_height)) fail('OCR原帧身份或时间无效。')
    rows(frame.lines, 'OCR文字行')
    previous = frame.requested_seconds
    ids.add(id)
  }
  return { duration: ocr.duration_seconds, start, end }
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
  const expectedStatus = hasText ? 'candidate_text_detected' : evidence.ocr.scan_status === 'partial' ? 'indeterminate' : 'no_text_detected'
  if (evidence.ocr.text_status !== expectedStatus) fail('OCR文字结论和实际文字行不符。')
}

async function evidence(project: string, value: unknown, expectedMedia: string, expectedSha256: string,
  verifier: SourceQaVerifier, staged?: SourceQaStagedAccess): Promise<Evidence> {
  if (!object(value) || value.media_sha256 !== expectedSha256) fail('复验没有绑定本次实际源片。')
  const media = await projectFile(project, value.media_path, staged)
  if (fileKey(media) !== fileKey(await projectFile(project, expectedMedia, staged))) fail('复验没有绑定本次实际源片。')
  if (await (staged === undefined ? fileSha256(media) : staged.hash(media)) !== expectedSha256) fail('复验源片已变化。')
  if (!object(value.inspection)) fail('审看身份缺失。')
  const [ocr, inspection] = await Promise.all([artifact(project, value.ocr, 'OCR', staged), artifact(project, value.inspection, '审看报告', staged)])
  for (const record of [ocr.value, inspection.value]) {
    const recordedMedia = text(record.path, '工具记录中的源片路径')
    if (!isAbsolute(recordedMedia)
      || fileKey(staged === undefined ? await realpath(recordedMedia) : staged.logical(recordedMedia)) !== fileKey(media)) {
      fail('OCR或审看报告属于另一份源片。')
    }
  }
  const { duration, start, end } = inspectOcr(ocr.value)
  inspectReport(inspection.value, ocr.value, duration)
  const binding: SourceQaEvidenceBinding = { mediaPath: media, mediaSha256: expectedSha256,
    ocrPath: ocr.path, ocrSha256: ocr.sha256, inspectionPath: inspection.path, inspectionSha256: inspection.sha256,
    sessionId: text(value.inspection.session_id, '审看会话'), reviewId: text(value.inspection.review_id, '审看ID') }
  if (inspection.value.id !== binding.reviewId) fail('审看ID与实际报告不符。')
  await verifier(binding)
  const files = [{ path: media, sha256: expectedSha256 }, { path: ocr.path, sha256: ocr.sha256 },
    { path: inspection.path, sha256: inspection.sha256 }]
  for (const file of files) if (await (staged === undefined ? fileSha256(file.path) : staged.hash(file.path)) !== file.sha256) fail('核实执行记录期间源片或复验文件已变化。')
  return { binding, ocr: ocr.value, inspection: inspection.value, duration, start, end, files }
}

async function evidenceSet(project: string, value: unknown, expectedMedia: string, expectedSha256: string,
  verifier: SourceQaVerifier, staged?: SourceQaStagedAccess): Promise<Evidence[]> {
  if (!object(value)) fail('复验没有绑定本次实际源片。')
  const refs: readonly unknown[] = Array.isArray(value.ocr) ? value.ocr : [value.ocr]
  if (!refs.length) fail('复验缺少OCR文件。')
  const parts: Evidence[] = []
  for (const ref of refs) parts.push(await evidence(project, { ...value, ocr: ref }, expectedMedia, expectedSha256, verifier, staged))
  const first = parts[0]
  if (first === undefined) fail('复验缺少OCR文件。')
  let end = 0
  for (const part of parts) {
    if (part.start !== end || part.duration !== first.duration
      || part.ocr.source_version !== first.ocr.source_version) fail('OCR分段没有按顺序覆盖同一源片。')
    end = part.end
  }
  if (end !== first.duration) fail('OCR没有覆盖完整源片。')
  const decisions = value.text_decisions === undefined ? [] : rows(value.text_decisions, '非对白文字判定')
  for (const decision of decisions) {
    const index = decision.ocr_index ?? (parts.length === 1 ? 0 : undefined)
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= parts.length) fail('文字判定缺少有效OCR分段编号。')
  }
  for (const [index, part] of parts.entries()) {
    verifyTextDecisions(part, { text_decisions: decisions.filter(decision => (decision.ocr_index ?? 0) === index) })
  }
  return parts
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
  staged?: SourceQaStagedAccess
}): Promise<SourceQaVerification> {
  if (input.staged !== undefined && input.staged.project !== input.project) fail('暂存证据属于另一项目。')
  const qa = input.review.source_qa
  if (!object(qa) || qa.version !== 1 || !object(qa.selected)) fail('缺少当前源片的source_qa记录。先对实际源片运行video_ocr完整扫描（间隔0.5秒），再优先用video_source_review，或已启用完整模式的video_inspect执行scan→next实际查看图片→observe。按渲染工具README记录工具返回的真实路径、摘要和身份后重验。')
  if (input.verifier === undefined) fail('缺少真实OCR执行和审看记录核验，请在Muse正常drama_render入口，沿video_source_review或已启用完整模式的video_inspect补齐真实审看后重验。')
  const selectedParts = await evidenceSet(input.project, qa.selected, input.videoPath, input.videoSha256, input.verifier, input.staged)
  const selected = selectedParts[0]
  if (selected === undefined) fail('复验缺少OCR文件。')
  const files = selectedParts.flatMap(part => part.files)
  let originalParts: Evidence[] | undefined
  if (input.review.subtitle_cleanup === 'clean') {
    if (input.originalSha256 === input.videoSha256) fail('清理片与原片字节相同，须核对实际去字幕结果。')
    originalParts = await evidenceSet(input.project, qa.original, input.originalPath, input.originalSha256, input.verifier, input.staged)
    const original = originalParts[0]
    if (original === undefined) fail('复验缺少OCR文件。')
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
    files.push(...originalParts.flatMap(part => part.files))
  }
  const uniqueFiles = [...new Map(files.map(file => [file.path, file])).values()]
  for (const file of uniqueFiles) if (await (input.staged === undefined ? fileSha256(file.path) : input.staged.hash(file.path)) !== file.sha256) fail('核实分段证据期间源片或复验文件已变化。')
  return { sha256: hash(JSON.stringify({ version: 1, qa, selected: selectedParts.map(part => part.binding),
    original: originalParts?.map(part => part.binding) })), files: uniqueFiles }
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
