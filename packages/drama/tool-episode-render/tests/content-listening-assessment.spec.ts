import { expect, it } from 'vitest'
import { parseContentListeningAssessment } from '../src/content-listening-assessment.ts'

const durationUs = 59_125_000

function review() {
  const ok = () => ({ status: 'ok', reason: '声音与参考台词一致。' })
  return {
    ranges: [
      { start_us: 0, end_us: 20_000_000, reason: '  前段对白可辨。  ' },
      { start_us: 20_000_000, end_us: durationUs, reason: '末段包含片尾。' },
    ],
    assessments: { pronunciation: ok(), dialogue_completeness: ok(), speaker: ok(), continuity: ok() },
    findings: new Array<{ axis: string; start_us: number; end_us: number; status: string; reason: string }>(),
  }
}

it('normalizes reported full coverage while retaining both approval flags as false', () => {
  const raw = review()
  const normalized = parseContentListeningAssessment(durationUs, raw)
  expect(normalized).toEqual({ ...raw, duration_us: durationUs, status: 'needs_review',
    listening_verified: false, grants_approval: false,
    ranges: [{ ...raw.ranges[0], reason: '前段对白可辨。' }, raw.ranges[1]] })
  expect(raw.ranges[0]?.reason).toBe('  前段对白可辨。  ')
})

it('accepts a complete review with only uncertain findings', () => {
  const raw = review()
  raw.assessments.speaker = { status: 'uncertain', reason: '缺少角色声音参考。' }
  raw.findings.push({ axis: 'speaker', start_us: 0, end_us: durationUs, status: 'uncertain', reason: '缺少角色声音参考。' })
  expect(parseContentListeningAssessment(durationUs, raw)).toMatchObject({
    status: 'needs_review', listening_verified: false, grants_approval: false, findings: raw.findings,
  })
})

it('retains multiple unique and overlapping issues for further review', () => {
  const raw = review()
  raw.assessments.pronunciation = { status: 'issues', reason: '有一个字音可疑。' }
  raw.assessments.dialogue_completeness = { status: 'uncertain', reason: '背景声盖住短句。' }
  raw.findings.push(
    { axis: 'pronunciation', start_us: 100, end_us: 1000, status: 'issues', reason: '有一个字音可疑。' },
    { axis: 'dialogue_completeness', start_us: 400, end_us: 800, status: 'uncertain', reason: '背景声盖住短句。' },
    { axis: 'pronunciation', start_us: 600, end_us: durationUs, status: 'uncertain', reason: '另有待核字音。' },
  )
  expect(parseContentListeningAssessment(durationUs, raw)).toMatchObject({
    status: 'issues_found', listening_verified: false, grants_approval: false, findings: raw.findings,
  })
})

it.each([0, -1, NaN, Infinity, 12.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid local duration %s', (duration) => {
  expect(() => parseContentListeningAssessment(duration, review())).toThrow('缺少成片实测音频时长')
})

it.each([
  [1, durationUs, '须按时间顺序从零连续'],
  [0, durationUs + 1, '须按时间顺序从零连续'],
  [0, durationUs - 1, '须覆盖完整成片音轨'],
] as const)('rejects a range starting at %i and ending at %i', (start, end, message) => {
  const raw = { ...review(), ranges: [{ start_us: start, end_us: end, reason: '覆盖声明。' }] }
  expect(() => parseContentListeningAssessment(durationUs, raw)).toThrow(message)
})

it.each([19_999_999, 20_000_001, 25_000_000])('rejects a gap or overlap before %i', (start) => {
  const raw = review()
  raw.ranges[1] = { start_us: start, end_us: durationUs, reason: '后一段。' }
  expect(() => parseContentListeningAssessment(durationUs, raw)).toThrow('须按时间顺序从零连续')
})

it('rejects a zero-length interval or conflicting finding times', () => {
  const raw = review()
  const zeroLength = { ...raw, ranges: [{ start_us: 0, end_us: 20, reason: '第一段。' },
    { start_us: 20, end_us: 20, reason: '空区间。' }, { start_us: 20, end_us: durationUs, reason: '后一段。' }] }
  expect(() => parseContentListeningAssessment(durationUs, zeroLength)).toThrow('须按时间顺序从零连续')
  raw.assessments.continuity = { status: 'issues', reason: '接缝跳变。' }
  raw.findings.push({ axis: 'continuity', start_us: 100, end_us: 100, status: 'issues', reason: '接缝跳变。' })
  expect(() => parseContentListeningAssessment(durationUs, raw)).toThrow('区间无效')
  raw.findings[0] = { axis: 'continuity', start_us: durationUs, end_us: durationUs + 1, status: 'issues', reason: '接缝跳变。' }
  expect(() => parseContentListeningAssessment(durationUs, raw)).toThrow('超出实际音轨范围')
})

it('requires each assessment status to agree with its timed findings', () => {
  const raw = review()
  const issue = { axis: 'speaker', start_us: 0, end_us: 100, status: 'issues', reason: '疑似角色说错。' }
  const checked = () => {
    expect(() => parseContentListeningAssessment(durationUs, raw)).toThrow('听校结论')
  }
  raw.findings.push(issue)
  checked()
  raw.assessments.speaker = { status: 'uncertain', reason: '角色待核。' }
  checked()
  raw.findings.length = 0
  raw.assessments.speaker = { status: 'issues', reason: '角色待核。' }
  checked()
  raw.findings.push({ ...issue, status: 'uncertain' })
  checked()
})

it('rejects approval flags, unknown properties, missing axes and blank reasons', () => {
  const raw = review()
  const malformed = (value: unknown) => {
    expect(() => parseContentListeningAssessment(durationUs, value)).toThrow('听校回复格式无效')
  }
  malformed({ ...raw, grants_approval: true })
  malformed({ ...raw, listening_verified: true })
  malformed({ ...raw, score: 100 })
  malformed({ ...raw, findings: [], assessments: { pronunciation: raw.assessments.pronunciation } })
  malformed({ ...raw, ranges: [{ start_us: 0, end_us: durationUs, reason: ' \t\r\n ' }] })
  malformed({ ...raw, ranges: [{ start_us: 0.5, end_us: durationUs, reason: '时间须为整数。' }] })
})

it('bounds reason length in UTF-8 bytes, including multibyte text', () => {
  const raw = review()
  const bounded = { ...raw, ranges: [{ start_us: 0, end_us: durationUs, reason: '字'.repeat(128) }] }
  expect(parseContentListeningAssessment(durationUs, bounded).ranges).toEqual(bounded.ranges)
  const oversized = { ...raw, ranges: [{ ...bounded.ranges[0], reason: '字'.repeat(129) }] }
  expect(() => parseContentListeningAssessment(durationUs, oversized)).toThrow('听校回复格式无效')
})

it('bounds the number of ranges and findings', () => {
  const raw = review()
  const findings = Array.from({ length: 64 }, (_, start) => ({
    axis: 'speaker', start_us: start, end_us: start + 1, status: 'issues', reason: '角色待核。',
  }))
  const ranges = Array.from({ length: 64 }, (_, start) => ({
    start_us: start, end_us: start + 1, reason: '区间试听依据。',
  }))
  raw.assessments.speaker = { status: 'issues', reason: '角色待核。' }
  expect(parseContentListeningAssessment(64, { ...raw, findings, ranges })).toMatchObject({ findings, ranges })
  expect(() => parseContentListeningAssessment(65, { ...raw, findings,
    ranges: [...ranges, { start_us: 64, end_us: 65, reason: '范围外。' }] })).toThrow('听校回复格式无效')
  expect(() => parseContentListeningAssessment(64, { ...raw, ranges,
    findings: [...findings, { ...findings[0], reason: '数量超出。' }] })).toThrow('听校回复格式无效')
})

it('rejects a retained report that exceeds the complete JSON byte limit', () => {
  const raw = review()
  const reason = '\\'.repeat(384)
  const ranges = Array.from({ length: 64 }, (_, start) => ({ start_us: start, end_us: start + 1, reason }))
  const findings = ranges.map(range => ({ ...range, axis: 'speaker', status: 'issues' }))
  raw.assessments.speaker = { status: 'issues', reason: '角色待核。' }
  expect(() => parseContentListeningAssessment(64, { ...raw, ranges, findings })).toThrow('听校报告过长')
})
