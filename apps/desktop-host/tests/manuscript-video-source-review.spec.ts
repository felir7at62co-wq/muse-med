/** Source-only omissions, real target quotations and complete sample coverage are independent acceptance conditions. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { VideoReviewId } from '@deepseek-ai/dsh-tool-video-inspect'
import { readManuscriptMaterials } from '../src/manuscript-materials.ts'
import { buildVideoSourceOutputSchema, validateVideoSourceAssessment, videoSourceInputsSchema,
  type VideoSourceBundle, type VideoSourceAssessment } from '../src/manuscript-video-source-review.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'video-source-validation-')); roots.push(root)
  await writeFile(join(root, 'draft.md'), '第1集\n1-1 门口 日 外\n▲甲把箱子交给乙。\n甲：不要开门。')
  const materials = await readManuscriptMaterials([{ role: 'current', path: 'draft.md' }], root,
    { maxFileBytes: 65536, maxTextChars: 20000, maxDocuments: 4, maxMaterialChars: 40000 }, new AbortController().signal)
  const document = materials.documents[0]!
  const target = { role: document.role, path: document.path, file_sha256: document.file_sha256, text_sha256: document.text_sha256 }
  const source = { mapping: 1, review_id: VideoReviewId('source-1'), path: 'source.mp4', source_version: 'v1',
    material_sha256: 'a'.repeat(64), packet_sha256: 'b'.repeat(64), start_seconds: 0, end_seconds: 12,
    draft_lines: { start: 1, end: 4 }, frames: [{ frame_id: 'F00001', planned_seconds: 3, image_sha256: 'c'.repeat(64) }],
    speech_segment_ids: ['S00001', 'S00002'], context_only_segment_ids: ['S00003'],
    scan_complete: true, scanned_until: 12, duration_seconds: 12 }
  const bundle: VideoSourceBundle = { manifest: { scope: 'sampled_frames_and_saved_asr', audio_verification: 'not_performed',
    asr_origin_and_speaker_verified: false, target, sources: [source], inputs: [{ review_id: source.review_id,
      start_seconds: 0, end_seconds: 12, draft_lines: source.draft_lines, frame_ids: ['F00001'] }],
    mapped_ranges: [source.draft_lines], unmapped_lines: [] }, content: [], expectedImages: [], timelines: [],
  coverage_complete: true, issues: [] }
  const anchor = (line: number) => ({ ...target, line, quote: document.lines.find(item => item.number === line)!.text })
  const report: VideoSourceAssessment = { status: 'issues', findings: [], unknowns: [], source_checks: [{ mapping: 1,
    status: 'issues', explanation: '来源识别文本有一句未被放入已选场景，需要回到原片确认是否漏写。',
    frame_checks: [{ id: 'F00001', disposition: 'matched', explanation: '画面中的交箱状态与所列动作对照。', draft_evidence: [anchor(3)] }],
    speech_checks: [{ id: 'S00001', disposition: 'matched', explanation: '保存ASR文字对应这一稿的台词，不表示原音校听。', draft_evidence: [anchor(4)] },
      { id: 'S00002', disposition: 'omitted', explanation: '本选区没有对应这一识别原段；遗漏候选应回原音核实。', draft_evidence: [] }],
  }] }
  return { materials, target, bundle, report, anchor }
}

it('accepts a localized source-only omission without inventing a draft quotation for missing text', async () => {
  const { materials, target, bundle, report } = await fixture()
  expect(validateJsonSchemaValue(buildVideoSourceOutputSchema(materials, bundle), report)).toEqual([])
  expect(validateVideoSourceAssessment(report, materials, target, bundle, 8)).toMatchObject({ reason: 'reviewed', status: 'issues',
    source_checks: [{ speech_checks: [{ disposition: 'matched' }, { disposition: 'omitted', draft_evidence: [] }] }] })
})

it.each(['mapping', 'frame', 'speech'] as const)('rejects schema-valid omitted %s coverage instead of accepting consistent', async (kind) => {
  const { materials, target, bundle, report, anchor } = await fixture()
  report.status = 'consistent'; report.source_checks[0]!.status = 'consistent'
  report.source_checks[0]!.speech_checks[1]!.disposition = 'matched'
  report.source_checks[0]!.speech_checks[1]!.draft_evidence = [anchor(4)]
  if (kind === 'speech') report.source_checks[0]!.speech_checks = report.source_checks[0]!.speech_checks.slice(0, 1)
  if (kind === 'mapping') report.source_checks = []
  if (kind === 'frame') report.source_checks[0]!.frame_checks = []
  expect(validateJsonSchemaValue(buildVideoSourceOutputSchema(materials, bundle), report)).toEqual([])
  expect(validateVideoSourceAssessment(report, materials, target, bundle, 8)).toMatchObject({ status: 'unknown', reason: 'invalid_evidence' })
})

it.each(['quote', 'path', 'hash', 'line', 'frame', 'context_only', 'duplicate'] as const)('rejects fabricated or mismatched %s evidence', async (kind) => {
  const { materials, target, bundle, report } = await fixture()
  const check = report.source_checks[0]!, item = check.frame_checks[0]!, anchor = item.draft_evidence[0]!
  if (kind === 'quote') anchor.quote = '▲不存在于稿件的动作。'
  if (kind === 'path') anchor.path += '.another'
  if (kind === 'hash') anchor.file_sha256 = '0'.repeat(64)
  if (kind === 'line') bundle.manifest.sources[0]!.draft_lines = { start: 1, end: 2 }
  if (kind === 'frame') item.id = 'F99999'
  if (kind === 'context_only') check.speech_checks[1]!.id = 'S00003'
  if (kind === 'duplicate') check.speech_checks[1]!.id = 'S00001'
  expect(validateVideoSourceAssessment(report, materials, target, bundle, 8)).toMatchObject({ status: 'unknown', reason: 'invalid_evidence' })
})

it('keeps source uncertainties and rejects mismatches hidden under a consistent status', async () => {
  const { materials, target, bundle, report } = await fixture()
  report.status = 'consistent'
  expect(validateVideoSourceAssessment(report, materials, target, bundle, 8).status).toBe('unknown')
  report.status = 'unknown'; report.source_checks[0]!.status = 'unknown'
  report.source_checks[0]!.speech_checks[1]!.disposition = 'unknown'
  expect(validateVideoSourceAssessment(report, materials, target, bundle, 8).reason).toBe('invalid_evidence')
  report.unknowns.push('无法从保存ASR确认人物声源。')
  expect(validateVideoSourceAssessment(report, materials, target, bundle, 8)).toMatchObject({ status: 'unknown', reason: 'reviewed' })
})

it('requires an exact actual-human citation for authorized adaptation omissions', async () => {
  const { materials, target, bundle, report } = await fixture()
  const item = report.source_checks[0]!.speech_checks[1]!
  item.disposition = 'authorized_change'
  report.status = 'consistent'; report.source_checks[0]!.status = 'consistent'
  expect(validateVideoSourceAssessment(report, materials, target, bundle, 8).reason).toBe('invalid_evidence')
  item.authorization = { message_id: 'human-1', quote: '可以省略寒暄。' }
  const request = { request: { message_id: MessageId('human-1'), text: '沿原片改编，可以省略寒暄。' }, continuations: [], revision: false }
  expect(validateVideoSourceAssessment(report, materials, target, bundle, 8, request)).toMatchObject({ status: 'consistent', reason: 'reviewed' })
  expect(validateVideoSourceAssessment(report, materials, target, bundle, 8, undefined, [request.request]))
    .toMatchObject({ status: 'consistent', reason: 'reviewed' })
  item.authorization.quote = '可以改变结局。'
  expect(validateVideoSourceAssessment(report, materials, target, bundle, 8, request).reason).toBe('invalid_evidence')
})

it('does not accept source comparisons for unmapped target text or over-budget findings', async () => {
  const { materials, target, bundle, report } = await fixture()
  report.source_checks[0]!.frame_checks[0]!.disposition = 'mismatch'
  expect(validateVideoSourceAssessment(report, materials, target, bundle, 1).reason).toBe('invalid_evidence')
  bundle.coverage_complete = false; bundle.issues = ['Target line 4 has no mapping.']
  expect(validateVideoSourceAssessment(report, materials, target, bundle, 8).reason).toBe('invalid_evidence')
})

it('retains missing-ASR uncertainty even when every available image was declared matched', async () => {
  const { materials, target, bundle, report } = await fixture()
  bundle.manifest.sources[0]!.speech_segment_ids = []
  bundle.issues = ['Mapping 1 has no current saved ASR; dialogue remains unverified.']
  report.source_checks[0]!.speech_checks = []
  report.status = 'consistent'; report.source_checks[0]!.status = 'consistent'
  expect(validateVideoSourceAssessment(report, materials, target, bundle, 8))
    .toMatchObject({ status: 'unknown', reason: 'reviewed', unknowns: bundle.issues })
})

it('rejects inverted or non-finite source ranges at the tool JSON parser', () => {
  const base = { review_id: 'source-1', start_seconds: 2, end_seconds: 1, draft_lines: { start: 1, end: 4 }, frame_ids: ['F1'] }
  expect(videoSourceInputsSchema.safeParse([base]).success).toBe(false)
  expect(videoSourceInputsSchema.safeParse([{ ...base, end_seconds: Infinity }]).success).toBe(false)
})
