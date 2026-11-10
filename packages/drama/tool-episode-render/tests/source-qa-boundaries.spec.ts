import { join, basename } from 'node:path'
import { copyFile, mkdir, realpath, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { verifySourceQa, summarizeSourceQa } from '../src/source-qa.ts'
import { fileSha256 } from '../src/cache.ts'
import { cleanup, tempProject, writePlaceholder } from './harness.ts'
import { sourceQaFixture, sourceQaOcrLine, verifiedSourceQaFixture } from './source-qa-fixture.ts'

const projects: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(projects.splice(0).map(cleanup)) })

async function fixture(clean = false) {
  const project = await tempProject()
  projects.push(project)
  const videoPath = join(project, 'selected.mp4'), originalPath = clean ? join(project, 'original.mp4') : videoPath
  await writePlaceholder(videoPath, 'selected test media')
  if (clean) await writePlaceholder(originalPath, 'original test media')
  const selected = await sourceQaFixture(project, videoPath)
  const original = clean ? await sourceQaFixture(project, originalPath, 'original') : undefined
  const qa = { version: 1, selected: selected.declaration, original: original?.declaration,
    affected_intervals: clean ? [{ start_seconds: 2, end_seconds: 3 }] : [] }
  const input = { project, review: { subtitle_cleanup: clean ? 'clean' : 'not_required', source_qa: qa },
    videoPath, videoSha256: await fileSha256(videoPath), originalPath, originalSha256: await fileSha256(originalPath),
    verifier: verifiedSourceQaFixture }
  return { input, selected, original, qa }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

function watermark(f: Fixture) {
  f.selected.ocr.frames[0]!.lines = [sourceQaOcrLine('内容由AI生成')]
  f.selected.ocr.segments = [{ text: '内容由AI生成', start_seconds: 0, end_seconds: 5, evidence_frame_ids: ['ocr-frame-1'] }]
  f.selected.ocr.text_status = 'candidate_text_detected'
  f.selected.declaration.text_decisions = [{ segment_index: 0, text: '内容由AI生成', start_seconds: 0, end_seconds: 5,
    kind: 'disclosure_watermark', reason: '观察到右下角AI标识', observation_frame_ids: ['F00001'] }]
}

const scanCases: [string, (f: Fixture) => void, RegExp][] = [
  ['non-array frames', (f) => { Reflect.set(f.selected.ocr, 'frames', {}) }, /OCR原帧不是/u],
  ['non-record frame', (f) => { Reflect.set(f.selected.ocr, 'frames', [null]) }, /OCR原帧不是/u],
  ['no frames', (f) => { f.selected.ocr.frames = [] }, /漏扫/u],
  ['failed count', (f) => { f.selected.ocr.coverage.failed_frame_count = 1 }, /漏扫/u],
  ['missing failure timestamps', (f) => { Reflect.deleteProperty(f.selected.ocr.coverage, 'failed_timestamps_seconds') }, /漏扫/u],
  ['failed timestamp', (f) => { Reflect.set(f.selected.ocr.coverage, 'failed_timestamps_seconds', [1]) }, /漏扫/u],
  ['missing unscanned ranges', (f) => { Reflect.deleteProperty(f.selected.ocr.coverage, 'unscanned_ranges') }, /未扫描范围不是实际工具数组/u],
  ['unscanned range', (f) => { f.selected.ocr.coverage.unscanned_ranges = [{ start_seconds: 1, end_seconds: 2, reason: 'decode failed' }] }, /漏扫/u],
  ['wrong planned count', (f) => { f.selected.ocr.coverage.planned_frame_count = 9 }, /漏扫/u],
  ['wrong processed count', (f) => { f.selected.ocr.coverage.processed_frame_count = 9 }, /漏扫/u],
  ['short final range', (f) => { f.selected.ocr.coverage.scanned_ranges[0]!.end_seconds = 4 }, /没有覆盖本段源片/u],
  ['zero range end', (f) => { f.selected.ocr.coverage.scanned_ranges[0]!.end_seconds = 0 }, /扫描范围有缺口/u],
  ['backward range', (f) => { f.selected.ocr.coverage.scanned_ranges = [{ start_seconds: 0, end_seconds: 3 }, { start_seconds: 3, end_seconds: 2 }] }, /扫描范围有缺口/u],
  ['out of bounds range', (f) => { f.selected.ocr.coverage.scanned_ranges[0]!.end_seconds = 6 }, /扫描范围有缺口/u],
  ['duplicate frame id', (f) => { f.selected.ocr.frames[1]!.id = 'ocr-frame-1' }, /原帧身份/u],
  ['missing frame id', (f) => { Reflect.deleteProperty(f.selected.ocr.frames[0]!, 'id') }, /原帧ID缺失/u],
  ['non-numeric decoded timestamp', (f) => { Reflect.set(f.selected.ocr.frames[0]!, 'timestamp_seconds', '0') }, /原帧身份/u],
  ['negative decoded timestamp', (f) => { f.selected.ocr.frames[0]!.timestamp_seconds = -1 }, /原帧身份/u],
  ['decoded timestamp at end', (f) => { f.selected.ocr.frames[0]!.timestamp_seconds = 5 }, /原帧身份/u],
  ['missing requested timestamp', (f) => { Reflect.deleteProperty(f.selected.ocr.frames[0]!, 'requested_seconds') }, /原帧身份/u],
  ['unordered requested timestamp', (f) => { f.selected.ocr.frames[1]!.requested_seconds = 0 }, /原帧身份/u],
  ['requested timestamp at end', (f) => { f.selected.ocr.frames[1]!.requested_seconds = 5 }, /原帧身份/u],
  ['off-grid requested timestamp', (f) => { f.selected.ocr.frames[1]!.requested_seconds = 0.6 }, /原帧身份/u],
  ['zero image width', (f) => { f.selected.ocr.frames[0]!.image_width = 0 }, /原帧身份/u],
  ['zero image height', (f) => { f.selected.ocr.frames[0]!.image_height = 0 }, /原帧身份/u],
  ['missing image lines', (f) => { Reflect.deleteProperty(f.selected.ocr.frames[0]!, 'lines') }, /OCR文字行不是/u],
  ['missing schema', (f) => { Reflect.deleteProperty(f.selected.ocr, 'schema_version') }, /OCR来源/u],
  ['wrong text source', (f) => { f.selected.ocr.text_source = 'script' }, /OCR来源/u],
  ['missing media path', (f) => { Reflect.deleteProperty(f.selected.ocr, 'path') }, /源片路径缺失/u],
  ['nonpositive duration', (f) => { f.selected.ocr.duration_seconds = 0 }, /OCR来源/u],
  ['missing source version', (f) => { Reflect.deleteProperty(f.selected.ocr, 'source_version') }, /OCR来源/u],
  ['missing interval', (f) => { Reflect.deleteProperty(f.selected.ocr, 'interval') }, /OCR来源/u],
  ['wrong interval start', (f) => { f.selected.ocr.interval.start_seconds = 1 }, /漏扫/u],
  ['wrong interval end', (f) => { f.selected.ocr.interval.end_seconds = 4 }, /漏扫/u],
  ['missing coverage', (f) => { Reflect.deleteProperty(f.selected.ocr, 'coverage') }, /OCR来源/u],
  ['zero scan interval', (f) => { f.selected.ocr.coverage.frame_interval_seconds = 0 }, /OCR来源/u],
  ['incomplete visual scan', (f) => { f.selected.inspection.scan_complete = false }, /没有覆盖当前/u],
  ['wrong visual duration', (f) => { f.selected.inspection.duration = 4 }, /没有覆盖当前/u],
  ['short visual scan', (f) => { f.selected.inspection.scanned_until = 4 }, /没有覆盖当前/u],
  ['no observed frames', (f) => { f.selected.inspection.frames = [] }, /审看帧未全部/u],
  ['missing displayed image', (f) => { Reflect.deleteProperty(f.selected.inspection.frames[0]!, 'image') }, /审看帧未全部/u],
  ['missing observation', (f) => { Reflect.deleteProperty(f.selected.inspection.frames[0]!, 'observation') }, /审看帧未全部/u],
  ['missing requested visual time', (f) => { Reflect.deleteProperty(f.selected.inspection.frames[0]!, 'time') }, /审看帧未全部/u],
  ['negative requested visual time', (f) => { f.selected.inspection.frames[0]!.time = -1 }, /审看帧未全部/u],
  ['requested visual time at end', (f) => { f.selected.inspection.frames[0]!.time = 5 }, /审看帧未全部/u],
  ['invalid text-status conclusion', (f) => { f.selected.ocr.text_status = 'candidate_text_detected' }, /文字结论/u],
]
it.each(scanCases)('refuses rehashed incomplete tool output: %s', async (_name, mutate, message) => {
  const f = await fixture()
  mutate(f)
  await f.selected.save()
  await expect(verifySourceQa(f.input)).rejects.toThrow(message)
})

const decisionCases: [string, (f: Fixture) => void, RegExp][] = [
  ['non-array decisions', (f) => { Reflect.set(f.selected.declaration, 'text_decisions', {}) }, /不是实际工具数组/u],
  ['non-number segment index', (f) => { Reflect.set(f.selected.declaration.text_decisions[0]!, 'segment_index', '0') }, /编号无效/u],
  ['fractional segment index', (f) => { f.selected.declaration.text_decisions[0]!.segment_index = 0.5 }, /编号无效/u],
  ['negative segment index', (f) => { f.selected.declaration.text_decisions[0]!.segment_index = -1 }, /编号无效/u],
  ['duplicate segment approval', (f) => { f.selected.declaration.text_decisions.push({ ...f.selected.declaration.text_decisions[0]! }) }, /重复/u],
  ['missing segment', (f) => { f.selected.declaration.text_decisions[0]!.segment_index = 1 }, /精确对应/u],
  ['changed text', (f) => { f.selected.declaration.text_decisions[0]!.text = '另一行' }, /精确对应/u],
  ['missing segment start', (f) => { Reflect.deleteProperty(f.selected.ocr.segments[0]!, 'start_seconds') }, /精确对应/u],
  ['missing segment end', (f) => { Reflect.deleteProperty(f.selected.ocr.segments[0]!, 'end_seconds') }, /精确对应/u],
  ['wrong decision start', (f) => { f.selected.declaration.text_decisions[0]!.start_seconds = 1 }, /精确对应/u],
  ['wrong decision end', (f) => { f.selected.declaration.text_decisions[0]!.end_seconds = 4 }, /精确对应/u],
  ['unrecognized category', (f) => { f.selected.declaration.text_decisions[0]!.kind = 'dialogue' }, /精确对应/u],
  ['empty reason', (f) => { f.selected.declaration.text_decisions[0]!.reason = ' ' }, /理由缺失/u],
  ['missing observation ids', (f) => { Reflect.deleteProperty(f.selected.declaration.text_decisions[0]!, 'observation_frame_ids') }, /明确的已观察帧/u],
  ['empty observation ids', (f) => { f.selected.declaration.text_decisions[0]!.observation_frame_ids = [] }, /明确的已观察帧/u],
  ['duplicate observation ids', (f) => { f.selected.declaration.text_decisions[0]!.observation_frame_ids = ['F00001', 'F00001'] }, /明确的已观察帧/u],
  ['non-string OCR segment text', (f) => { f.selected.declaration.text_decisions = []; Reflect.set(f.selected.ocr.segments[0]!, 'text', 1) }, /时段记录无效/u],
  ['missing OCR segment frames', (f) => { Reflect.deleteProperty(f.selected.ocr.segments[0]!, 'evidence_frame_ids') }, /时段记录无效/u],
  ['non-string OCR line text', (f) => { Reflect.set(f.selected.ocr.frames[0]!.lines[0]!, 'text', 1) }, /文字行记录无效/u],
]
it.each(decisionCases)('refuses an ungrounded non-dialogue decision: %s', async (_name, mutate, message) => {
  const f = await fixture()
  watermark(f)
  mutate(f)
  await f.selected.save()
  await expect(verifySourceQa(f.input)).rejects.toThrow(message)
})

it('accepts observed scene text separately from disclosures and omits absent decisions on text-free media', async () => {
  const f = await fixture()
  Reflect.deleteProperty(f.selected.declaration, 'text_decisions')
  await expect(verifySourceQa(f.input)).resolves.toHaveProperty('sha256')
  watermark(f)
  f.selected.declaration.text_decisions[0]!.kind = 'non_dialogue_text'
  await f.selected.save()
  await expect(verifySourceQa(f.input)).resolves.toHaveProperty('sha256')
  f.selected.ocr.frames[1]!.lines = [sourceQaOcrLine('  ')]
  await f.selected.save()
  await expect(verifySourceQa(f.input)).resolves.toHaveProperty('sha256')
})

it.each(['win32', 'linux'])('keeps canonical file identities when applying the %s path-key rule', async (platform) => {
  const f = await fixture()
  const verifier = vi.fn(verifiedSourceQaFixture)
  vi.stubGlobal('process', { ...process, platform })
  try {
    const result = await verifySourceQa({ ...f.input, verifier })
    expect(result.files[0]!.path).toBe(await realpath(f.input.videoPath))
    expect(verifier).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mediaPath: await realpath(f.input.videoPath) }))
  } finally { vi.unstubAllGlobals() }
})

it.each(['missing source qa', 'wrong version', 'missing selected', 'wrong media hash', 'wrong media file', 'changed media',
  'missing inspection', 'missing ocr hash', 'blank ocr path', 'artifact directory', 'non-object artifact',
  'relative tool media path', 'empty session', 'empty review', 'wrong review'] as const)
('refuses unbound source evidence: %s', async (kind) => {
  const f = await fixture()
  if (kind === 'missing source qa') Reflect.deleteProperty(f.input.review, 'source_qa')
  if (kind === 'wrong version') f.qa.version = 2
  if (kind === 'missing selected') Reflect.deleteProperty(f.qa, 'selected')
  if (kind === 'wrong media hash') f.selected.declaration.media_sha256 = 'a'.repeat(64)
  if (kind === 'wrong media file') {
    const copy = join(f.input.project, 'same-byte-copy.mp4')
    await copyFile(f.input.videoPath, copy)
    f.selected.declaration.media_path = copy
  }
  if (kind === 'changed media') await writeFile(f.input.videoPath, 'modified source')
  if (kind === 'missing inspection') Reflect.deleteProperty(f.selected.declaration, 'inspection')
  if (kind === 'missing ocr hash') Reflect.deleteProperty(f.selected.declaration.ocr, 'sha256')
  if (kind === 'blank ocr path') f.selected.declaration.ocr.path = ' '
  if (kind === 'artifact directory') f.selected.declaration.ocr.path = f.input.project
  if (kind === 'non-object artifact') {
    await writeFile(f.selected.declaration.ocr.path, '[]')
    f.selected.declaration.ocr.sha256 = await fileSha256(f.selected.declaration.ocr.path)
  }
  if (kind === 'relative tool media path') {
    f.selected.ocr.path = basename(f.input.videoPath)
    await f.selected.save()
  }
  if (kind === 'empty session') f.selected.declaration.inspection.session_id = ' '
  if (kind === 'empty review') f.selected.declaration.inspection.review_id = ' '
  if (kind === 'wrong review') f.selected.declaration.inspection.review_id = 'review-other'
  await expect(verifySourceQa(f.input)).rejects.toThrow(/源画面复验未完成/u)
})

it.each(['project directory', 'nested directory', 'outside file'] as const)('requires media to remain an ordinary file in its project: %s', async (kind) => {
  const f = await fixture()
  let path = f.input.project
  if (kind === 'nested directory') { path = join(path, 'directory'); await mkdir(path) }
  if (kind === 'outside file') {
    const outside = await tempProject()
    projects.push(outside)
    path = join(outside, 'outside.mp4')
    await writePlaceholder(path, 'outside project source')
  }
  f.selected.declaration.media_path = path
  await expect(verifySourceQa(f.input)).rejects.toThrow(/当前项目内的普通文件/u)
})

it.each(['same bytes', 'different duration', 'empty intervals', 'negative start', 'missing start', 'zero end', 'backward end', 'outside end'] as const)
('refuses unsafe cleaned-source substitution: %s', async (kind) => {
  const f = await fixture(true)
  if (kind === 'same bytes') f.input.originalSha256 = f.input.videoSha256
  if (kind === 'different duration') {
    const original = f.original!
    original.ocr.duration_seconds = 4
    original.ocr.interval.end_seconds = 4
    original.ocr.coverage.scanned_ranges[0]!.end_seconds = 4
    original.ocr.frames.splice(8)
    original.ocr.coverage.planned_frame_count = 8
    original.ocr.coverage.processed_frame_count = 8
    original.inspection.duration = 4
    original.inspection.scanned_until = 4
    await original.save()
  }
  if (kind === 'empty intervals') f.qa.affected_intervals = []
  if (kind === 'negative start') f.qa.affected_intervals[0]!.start_seconds = -1
  if (kind === 'missing start') Reflect.deleteProperty(f.qa.affected_intervals[0]!, 'start_seconds')
  if (kind === 'zero end') f.qa.affected_intervals[0]!.end_seconds = 0
  if (kind === 'backward end') f.qa.affected_intervals[0]!.end_seconds = 1
  if (kind === 'outside end') f.qa.affected_intervals[0]!.end_seconds = 6
  await expect(verifySourceQa(f.input)).rejects.toThrow(/源画面复验未完成/u)
})

it('deduplicates the exact evidence files and sorts shot decisions without changing caller order', async () => {
  const f = await fixture()
  const sourceQa = await verifySourceQa(f.input)
  const first = { shot: 1, reviewSha256: 'first', sourceQa }
  const second = { shot: 2, reviewSha256: 'second', sourceQa }
  const input = [second, first]
  const result = summarizeSourceQa(input)
  expect(result.files).toHaveLength(3)
  expect(result.files[0]!.path).toBe(await realpath(f.input.videoPath))
  expect(result.sha256).toBe(summarizeSourceQa([first, second]).sha256)
  expect(input).toEqual([second, first])
  expect(() => summarizeSourceQa([])).toThrow(/缺少完整源片/u)
  expect(() => summarizeSourceQa([{ shot: 1, reviewSha256: 'unverified' }])).toThrow(/缺少完整源片/u)
})
