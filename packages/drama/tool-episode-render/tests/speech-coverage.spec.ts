import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Cache from '../src/cache.ts'
import { reviewSpeechCoverage } from '../src/speech-coverage.ts'
import { formatSrtDocument } from '../src/subtitles.ts'
import type { SubtitleCue, Timeline } from '../src/types.ts'

type Word = { text: string; start: number; end: number }
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const cue = (text: string, startSeconds: number, endSeconds: number, index = 1): SubtitleCue =>
  ({ index, text, startSeconds, endSeconds })

async function fixture(words: Word[] = [{ text: '做', start: 6.670, end: 6.910 }, { text: '饭', start: 6.910, end: 7.150 }]) {
  const project = await mkdtemp(join(tmpdir(), 'muse-speech-coverage-'))
  onTestFinished(() => rm(project, { recursive: true, force: true }))
  const source = join(project, 'part4.mp4'), subtitleSrt = join(project, 'final.srt')
  const transcriptsPath = join(project, 'receipts.json')
  const jobs = join(project, 'transcript', 'jobs'), raw = join(project, 'transcript', 'raw')
  await mkdir(jobs, { recursive: true }); await mkdir(raw)
  await writeFile(source, 'synthetic-source-identity-not-media')
  const receipt = join(jobs, 'part4-v1.json'), transcript = join(raw, 'part4-v1.json')
  await writeFile(receipt, JSON.stringify({ status: 'complete', source, sourceSha256: hash(await readFile(source)), stem: 'part4', version: 1 }))
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 10, text: words.map(word => word.text).join(''), words }]))
  await writeFile(transcriptsPath, JSON.stringify({ shots: [{ shot: 4, receipt }] }))
  await writeFile(subtitleSrt, formatSrtDocument([cue('做饭', 39.854, 40.334)]))
  const timeline: Timeline = { clips: [{ shot: 4, startUs: 33184000, durationUs: 10000000 }], bodyEndSeconds: 43.184 }
  const input = { project, timeline, sources: new Map([[4, source]]), subtitleSrt, transcriptsPath }
  return { ...input, input, source, receipt, transcript,
    setCues: (cues: SubtitleCue[]) => writeFile(subtitleSrt, formatSrtDocument(cues)),
    setWords: (values: Word[]) => writeFile(transcript, JSON.stringify([{ start: 0, end: 10, text: values.map(word => word.text).join(''), words: values }])) }
}

it('reports the two missing EP26 words on the episode clock without changing the SRT or source', async () => {
  const f = await fixture()
  await f.setCues([])
  const files = [f.source, f.subtitleSrt, f.receipt, f.transcript, f.transcriptsPath]
  const before = await Promise.all(files.map(file => readFile(file)))
  const report = await reviewSpeechCoverage(f.input)
  expect(report.evidence_complete).toBe(true)
  expect(report.findings.map(item => [item.kind, item.text, item.start_seconds, item.end_seconds]))
    .toEqual([['recognized_without_subtitle', '做', 39.854, 40.094], ['recognized_without_subtitle', '饭', 40.094, 40.334]])
  expect(report.words[0]).toMatchObject({ source_start_seconds: 6.670, source_end_seconds: 6.910 })
  expect(report.assessment).toBe('asr_candidate_comparison')
  expect(report.listening_verified).toBe(false)
  expect(await Promise.all(files.map(file => readFile(file)))).toEqual(before)
})

it('matches both words to the corrected final SRT without inventing character times', async () => {
  const f = await fixture()
  const report = await reviewSpeechCoverage(f.input)
  expect(report.findings).toEqual([])
  expect(report.matches.map(match => match.text)).toEqual(['做', '饭'])
  expect(report.matches.every(match => match.precision === 'word')).toBe(true)
})

it('retains one-character tail sounds and utterances outside the script as ASR candidates', async () => {
  const f = await fixture([{ text: '做饭', start: 6.670, end: 7.150 }, { text: '啦', start: 7.2, end: 7.3 }, { text: '哼', start: 8, end: 8.2 }])
  const report = await reviewSpeechCoverage(f.input)
  expect(report.findings.map(item => item.text)).toEqual(['啦', '哼'])
})

it('does not use a later repeated word to cover a subtitle in another time window', async () => {
  const f = await fixture([{ text: '饭', start: 8, end: 8.2 }])
  await f.setCues([cue('饭', 39.854, 40.334)])
  const report = await reviewSpeechCoverage(f.input)
  expect(report.matches).toEqual([])
  expect(report.findings.map(item => item.kind)).toEqual(['recognized_without_subtitle', 'subtitle_without_recognition'])
})

it('does not let one recognized character cover two repeated subtitle characters', async () => {
  const f = await fixture([{ text: '饭', start: 6.670, end: 7.150 }])
  await f.setCues([cue('饭饭', 39.854, 40.334)])
  const report = await reviewSpeechCoverage(f.input)
  expect(report.matches).toHaveLength(1)
  expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'subtitle_without_recognition', text: '饭' }))
})

it('keeps a multi-character token at word precision across two cues and reports uncertain boundaries', async () => {
  const f = await fixture([{ text: '做饭', start: 6.670, end: 7.150 }])
  await f.setCues([cue('做', 39.854, 40.094), cue('饭', 40.094, 40.334, 2)])
  const report = await reviewSpeechCoverage(f.input)
  expect(report.matches.map(match => [match.text, match.precision])).toEqual([['做', 'word'], ['饭', 'word']])
  expect(report.words).toHaveLength(1)
  expect(report.findings.every(item => item.kind === 'timing_mismatch')).toBe(true)
  expect(report.findings).toHaveLength(2)
})

it('reports a subtitle character absent from a partially matching recognized word', async () => {
  const f = await fixture([{ text: '做', start: 6.670, end: 7.150 }])
  const report = await reviewSpeechCoverage(f.input)
  expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'subtitle_without_recognition', text: '饭' }))
})

it.each([
  { word: '饭做饭', subtitle: '做', kind: 'recognized_without_subtitle' },
  { word: '做', subtitle: '饭做饭', kind: 'subtitle_without_recognition' },
])('keeps repeated $kind runs individually addressable by listening statements', async ({ word, subtitle, kind }) => {
  const f = await fixture([{ text: word, start: 6.670, end: 7.150 }])
  await f.setCues([cue(subtitle, 39.854, 40.334)])
  const report = await reviewSpeechCoverage(f.input), item = report.findings[0]!
  expect(report.findings.map(finding => [finding.kind, finding.text])).toEqual([[kind, '饭'], [kind, '饭']])
  const { id, ...originalFinding } = item
  expect(id).toBe(hash(JSON.stringify(originalFinding)))
  const decisionsPath = join(f.project, 'one-item-listening.json')
  await writeFile(decisionsPath, JSON.stringify({ schema_version: 1, evidence_sha256: report.evidence_sha256,
    decisions: [{ item_id: id, decision: 'keep', reason: '仅记录第一段待核内容，不替第二段作决定', observed_text: '饭',
      reviewed_start_seconds: item.start_seconds, reviewed_end_seconds: item.end_seconds }] }))
  const reviewed = await reviewSpeechCoverage({ ...f.input, decisionsPath })
  expect(reviewed.findings.map(finding => finding.id)).toEqual(report.findings.map(finding => finding.id))
  expect({ distinctIds: new Set(report.findings.map(finding => finding.id)).size,
    reviews: reviewed.findings.map(finding => finding.review?.decision) })
    .toEqual({ distinctIds: 2, reviews: ['keep', undefined] })
})

it('returns incomplete evidence for a changed source instead of declaring silence or success', async () => {
  const f = await fixture()
  await writeFile(f.source, 'different-source')
  const report = await reviewSpeechCoverage(f.input)
  expect(report.evidence_complete).toBe(false)
  expect(report.words).toEqual([])
  expect(report.warnings.join('\n')).toContain('SHA-256')
})

it('binds optional listening statements to the exact evidence and preserves unresolved decisions', async () => {
  const f = await fixture()
  await f.setCues([])
  const initial = await reviewSpeechCoverage(f.input)
  const decisionsPath = join(f.project, 'listening.json')
  await writeFile(decisionsPath, JSON.stringify({ schema_version: 1, evidence_sha256: initial.evidence_sha256,
    decisions: initial.findings.map(item => ({ item_id: item.id, decision: 'unresolved', reason: '尚未核听，不把识别当真声', observed_text: '',
      reviewed_start_seconds: item.start_seconds, reviewed_end_seconds: item.end_seconds })) }))
  const reviewed = await reviewSpeechCoverage({ ...f.input, decisionsPath })
  expect(reviewed.findings.every(item => item.review?.decision === 'unresolved')).toBe(true)
  expect(reviewed.listening_verified).toBe(false)
  await f.setCues([cue('做饭', 39.854, 40.334)])
  expect((await reviewSpeechCoverage({ ...f.input, decisionsPath })).warnings.join('\n')).toContain('已变化')
})

it('reuses a source receipt for a repeated clip without discarding either playback', async () => {
  const f = await fixture()
  const timeline: Timeline = { clips: [...f.timeline.clips, { shot: 4, startUs: 43184000, durationUs: 10000000 }], bodyEndSeconds: 53.184 }
  await f.setCues([cue('做饭', 39.854, 40.334), cue('做饭', 49.854, 50.334, 2)])
  const report = await reviewSpeechCoverage({ ...f.input, timeline })
  expect(report.evidence_complete).toBe(true)
  expect(report.words.map(word => word.id)).toEqual(['1:1', '1:2', '2:1', '2:2'])
  expect(report.findings).toEqual([])
})

it('matches legal out-of-order timeline rows on their actual episode clock while retaining original IDs', async () => {
  const f = await fixture()
  const timeline: Timeline = { clips: [{ shot: 4, startUs: 43184000, durationUs: 10000000 }, ...f.timeline.clips], bodyEndSeconds: 53.184 }
  await f.setCues([cue('做饭', 39.854, 40.334), cue('做饭', 49.854, 50.334, 2)])
  const report = await reviewSpeechCoverage({ ...f.input, timeline })
  expect(report.findings).toEqual([])
  expect(report.words.map(word => word.id)).toEqual(['2:1', '2:2', '1:1', '1:2'])
})

it('compares punctuation-insensitive text without deleting repeated recognized characters', async () => {
  const f = await fixture([{ text: '做，饭饭', start: 6.670, end: 7.150 }])
  const report = await reviewSpeechCoverage(f.input)
  expect(report.matches.map(match => match.text)).toEqual(['做饭'])
  expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'recognized_without_subtitle', text: '饭' }))
})

it('ignores only non-spoken punctuation when both texts contain no letters', async () => {
  const f = await fixture([{ text: '，。', start: 6.670, end: 7.150 }])
  await f.setCues([cue('，。', 39.854, 40.334)])
  expect((await reviewSpeechCoverage(f.input)).findings).toEqual([])
})

it('marks a complete silent receipt as recognition evidence, not listening approval', async () => {
  const f = await fixture()
  const row = JSON.parse(await readFile(f.receipt, 'utf8')) as Record<string, unknown>
  await writeFile(f.receipt, JSON.stringify({ ...row, status: 'silent' }))
  await rm(f.transcript)
  const report = await reviewSpeechCoverage(f.input)
  expect(report.evidence_complete).toBe(true)
  expect(report.words).toEqual([])
  expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'subtitle_without_recognition', text: '做饭' }))
  expect(report.listening_verified).toBe(false)
})

it('reads existing relative mapping paths from the project rather than the runner cwd', async () => {
  const f = await fixture()
  await writeFile(f.transcriptsPath, JSON.stringify({ shots: [{ shot: 4, receipt: 'transcript/jobs/part4-v1.json' }] }))
  expect((await reviewSpeechCoverage({ ...f.input, transcriptsPath: 'receipts.json' })).findings).toEqual([])
})

it.each([
  ['null root', null], ['array root', []], ['missing shots', {}], ['non-array shots', { shots: null }],
  ['null shot', { shots: [null] }], ['array shot', { shots: [[]] }], ['zero shot', { shots: [{ shot: 0, receipt: 'x' }] }],
  ['fractional shot', { shots: [{ shot: 1.5, receipt: 'x' }] }], ['missing shot', { shots: [{ receipt: 'x' }] }],
  ['missing receipt', { shots: [{ shot: 4 }] }], ['empty receipt', { shots: [{ shot: 4, receipt: '' }] }],
  ['duplicate shot', { shots: [{ shot: 4, receipt: 'x' }, { shot: 4, receipt: 'x' }] }],
] as const)('reports incomplete evidence for %s mapping data', async (_name, document) => {
  const f = await fixture()
  await writeFile(f.transcriptsPath, JSON.stringify(document))
  const report = await reviewSpeechCoverage(f.input)
  expect(report.evidence_complete).toBe(false)
  expect(report.warnings.join('\n')).toContain('映射未核实')
})

it('does not interpret missing, invalid JSON or empty mapping files as no speech', async () => {
  const f = await fixture()
  for (const document of ['not-json', JSON.stringify({ shots: [] })]) {
    await writeFile(f.transcriptsPath, document)
    expect((await reviewSpeechCoverage(f.input)).evidence_complete).toBe(false)
  }
  await rm(f.transcriptsPath)
  expect((await reviewSpeechCoverage(f.input)).evidence_complete).toBe(false)
})

it.each([
  ['no source', { source: null }], ['wrong digest', { sourceSha256: '0'.repeat(64) }],
  ['processing', { status: 'processing' }], ['invalid stem', { stem: '../other' }],
  ['missing stem', { stem: null }], ['invalid version', { version: 0 }], ['fractional version', { version: 1.5 }],
  ['string version', { version: '1' }], ['wrong original path', { stem: 'other' }],
] as const)('does not trust %s in a receipt', async (_name, patch) => {
  const f = await fixture()
  const prior = JSON.parse(await readFile(f.receipt, 'utf8')) as Record<string, unknown>
  await writeFile(f.receipt, JSON.stringify({ ...prior, ...patch }))
  const report = await reviewSpeechCoverage(f.input)
  expect(report.evidence_complete).toBe(false)
  expect(report.words).toEqual([])
})

it('does not accept the same bytes under a different selected source path', async () => {
  const f = await fixture()
  const other = join(f.project, 'other.mp4')
  await writeFile(other, await readFile(f.source))
  expect((await reviewSpeechCoverage({ ...f.input, sources: new Map([[4, other]]) })).evidence_complete).toBe(false)
  expect((await reviewSpeechCoverage({ ...f.input, sources: new Map() })).evidence_complete).toBe(false)
})

it.each([
  ['non-array', {}], ['empty segments', []], ['null segment', [null]], ['missing words', [{ start: 0, end: 10 }]],
  ['empty words', [{ start: 0, end: 10, words: [] }]],
  ['null word', [{ start: 0, end: 10, words: [null] }]],
  ['string time', [{ start: 0, end: 10, words: [{ text: '做', start: '1', end: 2 }] }]],
  ['negative time', [{ start: 0, end: 10, words: [{ text: '做', start: -1, end: 2 }] }]],
  ['nonfinite time', [{ start: 0, end: 10, words: [{ text: '做', start: Number.NaN, end: 2 }] }]],
  ['invalid text', [{ start: 0, end: 10, words: [{ text: 1, start: 1, end: 2 }] }]],
  ['inverted word', [{ start: 0, end: 10, words: [{ text: '做', start: 2, end: 1 }] }]],
  ['before segment', [{ start: 2, end: 10, words: [{ text: '做', start: 1, end: 3 }] }]],
  ['after segment', [{ start: 0, end: 1, words: [{ text: '做', start: 1, end: 2 }] }]],
  ['after clip', [{ start: 0, end: 11, words: [{ text: '做', start: 10, end: 11 }] }]],
  ['unordered', [{ start: 0, end: 10, words: [{ text: '做', start: 2, end: 3 }, { text: '饭', start: 1, end: 2 }] }]],
] as const)('keeps %s word evidence unverified', async (_name, document) => {
  const f = await fixture()
  await writeFile(f.transcript, JSON.stringify(document))
  const report = await reviewSpeechCoverage(f.input)
  expect(report.evidence_complete).toBe(false)
  expect(report.words).toEqual([])
  expect(report.listening_verified).toBe(false)
})

it('does not invent word timing when raw output is missing', async () => {
  const f = await fixture()
  await rm(f.transcript)
  expect((await reviewSpeechCoverage(f.input)).evidence_complete).toBe(false)
})

it('rejects an invalid final SRT span rather than matching text without a clock', async () => {
  const f = await fixture()
  await writeFile(f.subtitleSrt, '1\n00:00:02,000 --> 00:00:01,000\n做饭\n')
  await expect(reviewSpeechCoverage(f.input)).rejects.toThrow('无效时间')
})

it('does not read lexical paths or junction targets outside its project', async () => {
  const f = await fixture()
  const external = await mkdtemp(join(tmpdir(), 'muse-speech-external-'))
  onTestFinished(() => rm(external, { recursive: true, force: true }))
  await writeFile(join(external, 'receipts.json'), 'private external contents')
  expect((await reviewSpeechCoverage({ ...f.input, transcriptsPath: join(external, 'receipts.json') })).evidence_complete).toBe(false)
  const link = join(f.project, 'external-link')
  await symlink(external, link, 'junction')
  try {
    const report = await reviewSpeechCoverage({ ...f.input, transcriptsPath: join(link, 'receipts.json') })
    expect(report.evidence_complete).toBe(false)
    expect(report.warnings.join('\n')).toContain('链接指向项目外')
    expect(report.warnings.join('\n')).not.toContain('private external contents')
  } finally { await unlink(link) }
})

it('rejects source changes during the comparison instead of publishing a stale fingerprint', async () => {
  const f = await fixture()
  const original = Cache.fileSha256
  let changed = false
  const spy = vi.spyOn(Cache, 'fileSha256').mockImplementation(async (path) => {
    const result = await original(path)
    if (path === f.source && !changed) { changed = true; await writeFile(path, 'changed-during-review') }
    return result
  })
  try { await expect(reviewSpeechCoverage(f.input)).rejects.toThrow('比较期间输入文件已变化') }
  finally { spy.mockRestore() }
})

it('keeps partial listening statements without clearing the other candidates', async () => {
  const f = await fixture()
  await f.setCues([])
  const initial = await reviewSpeechCoverage(f.input), item = initial.findings[0]!
  const decisionsPath = join(f.project, 'listening.json')
  await writeFile(decisionsPath, JSON.stringify({ schema_version: 1, evidence_sha256: initial.evidence_sha256,
    decisions: [{ item_id: item.id, decision: 'keep', reason: '记录调用方核听说明，不冒充Host验收', observed_text: '做',
      reviewed_start_seconds: item.start_seconds, reviewed_end_seconds: item.end_seconds }] }))
  const report = await reviewSpeechCoverage({ ...f.input, decisionsPath })
  expect(report.findings[0]?.review?.decision).toBe('keep')
  expect(report.findings[1]?.review).toBeUndefined()
  expect(report.listening_verified).toBe(false)
})

it.each([
  ['missing id', { item_id: '' }], ['missing reason', { reason: ' ' }], ['invalid decision', { decision: 'approved' }],
  ['unrelated item', { item_id: 'other' }], ['no observed text', { observed_text: null }],
  ['short reviewed interval', { reviewed_start_seconds: 40 }], ['inverted reviewed interval', { reviewed_end_seconds: 39 }],
] as const)('does not adopt a listening statement with %s', async (_name, patch) => {
  const f = await fixture()
  await f.setCues([])
  const initial = await reviewSpeechCoverage(f.input), item = initial.findings[0]!
  const decisionsPath = join(f.project, 'listening.json')
  await writeFile(decisionsPath, JSON.stringify({ schema_version: 1, evidence_sha256: initial.evidence_sha256,
    decisions: [{ item_id: item.id, decision: 'adjust_subtitle', reason: '核听记录', observed_text: item.text,
      reviewed_start_seconds: item.start_seconds, reviewed_end_seconds: item.end_seconds, ...patch }] }))
  const report = await reviewSpeechCoverage({ ...f.input, decisionsPath })
  expect(report.findings.every(finding => finding.review === undefined)).toBe(true)
  expect(report.warnings.join('\n')).toContain('核听声明未采用')
})
