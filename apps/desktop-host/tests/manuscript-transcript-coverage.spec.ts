/** Per-episode literal coverage reports dropped, invented, reordered and substituted text against saved ASR and on-screen text. */
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { measureTranscriptCoverage, transcriptCharactersSchema, transcriptSourcesSchema, type TranscriptCharacters,
  type TranscriptCoverageLimits, type TranscriptSources } from '../src/manuscript-transcript-coverage.ts'

const roots: string[] = [], signal = new AbortController().signal
const limits: TranscriptCoverageLimits = { maxFileBytes: 1024 * 1024, maxTextChars: 200_000, maxDocuments: 8, maxMaterialChars: 200_000,
  transcriptMinSimilarity: 0.6, transcriptMinGapChars: 4, transcriptMaxEditLength: 20_000, transcriptMaxOutputChars: 1_000_000 }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function workspace(files: Record<string, string | object>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'muse-transcript-coverage-')); roots.push(root)
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), typeof content === 'string' ? content : JSON.stringify(content))
  return root
}

const asr = (rows: [number, number, string][]) => rows.map(([start, end, text]) => ({ start, end, text, speaker_id: 'A' }))
function ocr(path: string, scanned: [number, number], status: 'complete' | 'partial', segments: [number, number, string, string?][]) {
  return { schema_version: 1, evidence_algorithm: 'decoded-pts-spatial-v2', path, duration_seconds: 150, text_source: 'ocr',
    scan_status: status, coverage: { scanned_ranges: [{ start_seconds: scanned[0], end_seconds: scanned[1] }] }, frames: [],
    segments: segments.map(([start, end, text, classification]) => ({ start_seconds: start, end_seconds: end, text,
      classification: classification ?? 'content_candidate', evidence_frame_ids: [] })) }
}
const parse = (sources: unknown): TranscriptSources => transcriptSourcesSchema.parse(sources)
const table = (characters: unknown): TranscriptCharacters => transcriptCharactersSchema.parse(characters)

const episodeOne = ['第1集', '1-1 东桥菜场 日 外', '出场人物：甲、乙', '▲甲提着菜篮走进菜场。',
  '甲：妈妈。', '乙：妈妈，我的灯笼呢？', '甲：灯笼在柜子上，你自己去拿。', '甲：老实告诉你，这个月一共欠了2万4。', '乙：先还一半。',
  '甲：我今天去了东桥菜场。', '甲：买了三斤排骨。', '乙：你等着，我马上回来。', '甲：老板说明天早上再来。', '▲乙把门关好，转身离开。',
  '乙：你明早记得去取。', '甲：钥匙放在门口的花盆底下。', '【下集钩子】', '▲甲回头，看见门外站着一个人。'].join('\n')
const asrOne = asr([[0, 1.2, '妈妈，我的灯笼呢？'], [1.5, 2, '嗯。'], [2.2, 4, '灯笼在柜子上，你自己去拿'], [4.5, 6, '这个月一共欠了两万四'],
  [6.2, 7, '先还一半'], [7.5, 9, '我今天去了东桥菜场买了三斤排骨'], [9.5, 10, '你等着'], [10.2, 11, '我马上回来'],
  [11.5, 13, '老板说明天早上再来送一批新货'], [13.5, 15, '把门关好'], [15.5, 17, '钥匙放在门口的花盆底下'], [17.5, 19, '你明早记得去取'],
  [19.5, 21, '我们走着瞧']])

it('reports dropped, invented, reordered, split, merged and partly written text in one episode', async () => {
  const root = await workspace({ 'ep1.md': episodeOne, 'ep1.json': asrOne })
  const result = await measureTranscriptCoverage(parse([{ path: 'ep1.md', asr_path: 'ep1.json' }]), undefined, root, limits, signal)
  const episode = result.episodes[0]!
  expect(episode).toMatchObject({ label: '第1集', status: 'measured', reason: null, draft: { lines: { start: 1, end: 18 } },
    asr: { segments: 13 }, ocr: null, last_supported_line: 16, last_asr_segment_covered: false, last_asr_end_seconds: 21 })
  expect(episode.counts).toEqual({ dialogue_lines: 11, asr_segments: 13, asr_covered_in_order: 9, asr_covered_out_of_order: 1,
    asr_uncovered: 3, asr_in_action_lines: 1, asr_partly_missing: 1, lines_without_source: 1, lines_on_screen_text_only: 0,
    lines_with_added_text: 1, on_screen_text_differs: 0, on_screen_text_not_in_dialogue: 0, ending_lines_after_source: 2 })
  expect(episode.asr_uncovered).toEqual([{ segment_id: 'S00002', start_seconds: 1.5, end_seconds: 2, text: '嗯。' },
    { segment_id: 'S00010', start_seconds: 13.5, end_seconds: 15, text: '把门关好', action_line: 14 },
    { segment_id: 'S00013', start_seconds: 19.5, end_seconds: 21, text: '我们走着瞧' }])
  expect(episode.lines_without_source).toEqual([{ line: 5, quote: '甲：妈妈。' }])
  expect(episode.asr_out_of_order).toEqual([{ segment_id: 'S00011', start_seconds: 15.5, text: '钥匙放在门口的花盆底下', line: 16 }])
  expect(episode.asr_partly_missing).toEqual([{ segment_id: 'S00009', text: '老板说明天早上再来送一批新货', missing: ['送一批新货'] }])
  expect(episode.lines_with_added_text).toEqual([{ line: 8, quote: '甲：老实告诉你，这个月一共欠了2万4。', added: ['老实告诉你'] }])
  expect(episode.ending_after_source).toEqual([{ line: 17, kind: 'hook', quote: '【下集钩子】' },
    { line: 18, kind: 'action', quote: '▲甲回头，看见门外站着一个人。' }])
  expect(episode.summary).toBe('第1集：台词11行；ASR 13段，按序9、错序1、未写入3（入▲行1）、部分缺失1；'
    + '无来源台词1、仅画面文字0、新增措辞1；画面文字未提供；最后有来源台词后2行')
  expect(episode).not.toHaveProperty('speakers_outside_table')
  expect(result).toMatchObject({ state: 'transcript_coverage', advisory: true, semantic_assessment: 'not_performed', names: null,
    totals: { episodes: 1, measured: 1, not_measured: 0, without_asr: 0, with_ocr: 0, dialogue_lines: 11, asr_uncovered: 3 },
    output: { complete: true, limit_reasons: [] } })
})

it('uses on-screen content text from several video_ocr files and ignores persistent text', async () => {
  const draft = ['第2集', '2-1 东桥菜场 日 外', '甲：冬桥菜场到了。', '乙：快进去吧。', '乙：别忘了带钱包。'].join('\n')
  const root = await workspace({ 'ep2.md': draft, 'ep2.json': asr([[0, 2, '冬桥菜场到了'], [125, 127, '快进去吧']]),
    'a.json': ocr('ep2.mp4', [0, 120], 'partial', [[0.5, 2, '东桥菜场到了'], [0, 120, '东桥TV', 'persistent_text_candidate']]),
    'b.json': ocr('ep2.mp4', [120, 150], 'complete', [[125, 127, '快进去吧'], [128, 130, '别忘了带钱包'], [140, 142, '明天见']]) })
  const result = await measureTranscriptCoverage(parse([{ path: 'ep2.md', asr_path: 'ep2.json', ocr_paths: ['a.json', 'b.json'] }]),
    undefined, root, limits, signal)
  const episode = result.episodes[0]!
  expect(episode.ocr).toMatchObject({ scanned_seconds: 150, duration_seconds: 150, segments: 4,
    files: [{ video_path: 'ep2.mp4', scan_status: 'partial' }, { video_path: 'ep2.mp4', scan_status: 'complete' }] })
  expect(episode.lines_on_screen_text_only).toEqual([{ line: 5, quote: '乙：别忘了带钱包。' }])
  expect(episode.lines_without_source).toEqual([])
  expect(episode.on_screen_text_differs).toEqual([{ line: 3, start_seconds: 0.5, draft: '冬', on_screen: '东', asr_segments: ['S00001'] }])
  expect(episode.on_screen_text_not_in_dialogue).toEqual([{ start_seconds: 140, text: '明天见' }])
  expect(JSON.stringify(result)).not.toContain('东桥TV')
  expect(episode.summary).toContain('画面文字不同1、未入台词1')
})

it('reports a substitution inside sparse on-screen text that covers only part of its line', async () => {
  const draft = ['第6集', '甲：你先坐下喝口水。', '乙：老周刚才来过了。', '丙：爸，你这不是为难老周吗？他也不容易，你就别再逼他了。'].join('\n')
  const root = await workspace({ 'ep6.md': draft, 'ocr.json': ocr('ep6.mp4', [0, 30], 'complete', [[20, 21, '哥你这不是为难老周吗']]) })
  const episode = (await measureTranscriptCoverage(parse([{ path: 'ep6.md', ocr_paths: ['ocr.json'] }]), undefined, root, limits, signal))
    .episodes[0]!
  expect(episode.on_screen_text_differs).toEqual([{ line: 4, start_seconds: 20, draft: '爸', on_screen: '哥', asr_segments: [] }])
  expect(episode.on_screen_text_not_in_dialogue).toEqual([])
  expect(episode.lines_without_source.map(line => line.line)).toEqual([2, 3, 4])
})

it('reports every line as without source when no transcript was supplied', async () => {
  const root = await workspace({ 'ep3.md': '第3集\n甲：咱早些弄完。\n乙：好。\n▲二人离开。' })
  const result = await measureTranscriptCoverage(parse([{ path: 'ep3.md' }]), undefined, root, limits, signal)
  expect(result.episodes[0]).toMatchObject({ asr: null, ocr: null, last_supported_line: null, last_asr_segment_covered: null,
    counts: { dialogue_lines: 2, lines_without_source: 2, asr_segments: 0 }, ending_after_source: [] })
  expect(result.episodes[0]?.summary).toBe('第3集：台词2行；ASR未提供；无来源台词2、仅画面文字0、新增措辞0；画面文字未提供；没有有来源的台词')
  expect(result.totals).toMatchObject({ without_asr: 1, lines_without_source: 2 })
})

it('lists speaker labels outside an explicit character table and known wrong spellings', async () => {
  const draft = ['第4集', '出场人物：邵小明、林春', '周小明：今天收摊早。', '小明：我去进货。', '邵小明：路上小心。', '▲林椿推着车出门。', '林春：走了。'].join('\n')
  const root = await workspace({ 'ep4.md': draft, 'ep4.json': asr([[0, 1, '今天收摊早'], [1, 2, '我去进货'], [2, 3, '路上小心'], [3, 4, '走了']]) })
  const characters = table([{ name: '邵小明' }, { name: '林春', variants: ['林椿'] }])
  const sources = parse([{ path: 'ep4.md', asr_path: 'ep4.json' }])
  const episode = (await measureTranscriptCoverage(sources, characters, root, limits, signal)).episodes[0]!
  expect(episode.speakers_outside_table).toEqual([{ label: '周小明', lines: [3], near: ['邵小明'] }, { label: '小明', lines: [4], near: ['邵小明'] }])
  expect(episode.listed_variants).toEqual([{ name: '林春', variant: '林椿', lines: [6] }])
  expect(episode.counts).toMatchObject({ speaker_lines_outside_table: 2, listed_variant_lines: 1 })
  expect(episode.summary).toContain('表外说话人2行、已知错写1处')
  const plain = (await measureTranscriptCoverage(sources, undefined, root, limits, signal)).episodes[0]!
  expect(plain).not.toHaveProperty('listed_variants')
  expect(plain.counts).not.toHaveProperty('speaker_lines_outside_table')
  expect(transcriptCharactersSchema.safeParse([{ name: '林春', variants: ['林春'] }]).success).toBe(false)
  expect(transcriptCharactersSchema.safeParse([{ name: '林春' }, { name: '林春' }]).success).toBe(false)
})

it('selects one episode of a merged manuscript by episode or by extracted lines', async () => {
  const merged = ['第1集', '甲：第一集的话。', '第2集', '乙：第二集的话。', '甲：还有一句。'].join('\n')
  const root = await workspace({ 'all.md': merged, 'ep2.json': asr([[0, 1, '第二集的话'], [1, 2, '还有一句']]) })
  const byEpisode = await measureTranscriptCoverage(parse([{ path: 'all.md', episode: 2, asr_path: 'ep2.json' }]), undefined, root, limits, signal)
  expect(byEpisode.episodes[0]).toMatchObject({ label: '第2集', draft: { lines: { start: 3, end: 5 } },
    counts: { dialogue_lines: 2, lines_without_source: 0, asr_covered_in_order: 2 }, last_supported_line: 5 })
  const byLines = await measureTranscriptCoverage(parse([{ path: 'all.md', lines: { start: 3, end: 5 }, asr_path: 'ep2.json' }]),
    undefined, root, limits, signal)
  expect(byLines.episodes[0]).toMatchObject({ label: '第2集', counts: byEpisode.episodes[0]?.counts })
  await expect(measureTranscriptCoverage(parse([{ path: 'all.md' }]), undefined, root, limits, signal))
    .rejects.toThrow('MANUSCRIPT_TRANSCRIPT_EPISODE: all.md含2集')
  await expect(measureTranscriptCoverage(parse([{ path: 'all.md', episode: 3 }]), undefined, root, limits, signal)).rejects.toThrow('没有第3集')
  expect(transcriptSourcesSchema.safeParse([{ path: 'all.md', episode: 2 }, { path: 'all.md', episode: 2 }]).success).toBe(false)
  expect(transcriptSourcesSchema.safeParse([{ path: 'all.md', episode: 2, lines: { start: 3, end: 5 } }]).success).toBe(false)
  expect(transcriptSourcesSchema.safeParse([{ path: 'all.md', extra: true }]).success).toBe(false)
  await expect(measureTranscriptCoverage(parse([{ path: 'all.md', episode: 1 }, { path: 'all.md', episode: 2 }]), undefined, root,
    { ...limits, maxDocuments: 1 }, signal)).rejects.toThrow('MANUSCRIPT_DOCUMENT_LIMIT')
})

it.each([
  ['an ASR value that is not an array', 'asr', { segments: [] }, 'output_json'],
  ['an ASR row without text', 'asr', [{ start: 0, end: 1 }], 'output_json'],
  ['ASR rows with descending start times', 'asr', asr([[2, 3, '后'], [0, 1, '前']]), 'output_json'],
  ['an ASR text file', 'asr', '[00:00.000 --> 00:01.000] 你好', '不是有效JSON'],
  ['OCR evidence with another schema version', 'ocr', { ...ocr('v.mp4', [0, 1], 'complete', []), schema_version: 2 }, 'raw_json_path'],
  ['an OCR merged text file', 'ocr', '你好\n再见', '不是有效JSON'],
])('rejects %s and names the file', async (_name, kind, content, message) => {
  const root = await workspace({ 'ep.md': '第1集\n甲：你好。', 'source.json': content })
  const source = kind === 'ocr' ? { path: 'ep.md', ocr_paths: ['source.json'] } : { path: 'ep.md', asr_path: 'source.json' }
  await expect(measureTranscriptCoverage(parse([source]), undefined, root, limits, signal)).rejects.toThrow(/source\.json/u)
  await expect(measureTranscriptCoverage(parse([source]), undefined, root, limits, signal)).rejects.toThrow(message)
})

it('refuses a symbolic link and a file over the byte limit', async () => {
  const root = await workspace({ 'ep.md': '第1集\n甲：你好。', 'real.json': asr([[0, 1, '你好']]) })
  await symlink(join(root, 'real.json'), join(root, 'link.json'))
  await expect(measureTranscriptCoverage(parse([{ path: 'ep.md', asr_path: 'link.json' }]), undefined, root, limits, signal))
    .rejects.toThrow('MANUSCRIPT_TRANSCRIPT_SOURCE: link.json')
  const draftBytes = Buffer.byteLength('第1集\n甲：你好。')
  await expect(measureTranscriptCoverage(parse([{ path: 'ep.md', asr_path: 'real.json' }]), undefined, root,
    { ...limits, maxFileBytes: draftBytes }, signal)).rejects.toThrow('MANUSCRIPT_TRANSCRIPT_SOURCE: real.json')
})

it('omits whole findings beyond the output budget, counts them, and keeps complete totals', async () => {
  const root = await workspace({ 'ep1.md': episodeOne, 'ep1.json': asrOne })
  const sources = parse([{ path: 'ep1.md', asr_path: 'ep1.json' }])
  const full = await measureTranscriptCoverage(sources, undefined, root, limits, signal)
  const size = Array.from(JSON.stringify(full)).length
  const exact = await measureTranscriptCoverage(sources, undefined, root, { ...limits, transcriptMaxOutputChars: size }, signal)
  expect(exact.output.complete).toBe(true)
  const bounded = await measureTranscriptCoverage(sources, undefined, root, { ...limits, transcriptMaxOutputChars: size - 150 }, signal)
  expect(Array.from(JSON.stringify(bounded)).length).toBeLessThanOrEqual(size - 150)
  expect(bounded.output).toMatchObject({ complete: false, limit_reasons: ['output_chars_limit'] })
  const omitted = Object.values(bounded.output.omitted).reduce((sum, count) => sum + count, 0)
  expect(omitted).toBeGreaterThan(0)
  expect(bounded.totals).toEqual(full.totals)
  expect(bounded.episodes[0]?.counts).toEqual(full.episodes[0]?.counts)
  expect(bounded.episodes[0]?.asr_uncovered).toEqual(full.episodes[0]?.asr_uncovered)
  await expect(measureTranscriptCoverage(sources, undefined, root, { ...limits, transcriptMaxOutputChars: 200 }, signal))
    .rejects.toThrow('MANUSCRIPT_TRANSCRIPT_OUTPUT')
})

it('reports an episode beyond the edit budget as not measured and still measures the next one', async () => {
  const root = await workspace({ 'ep1.md': episodeOne, 'ep1.json': asrOne, 'ep5.md': '第5集\n甲：一模一样。', 'ep5.json': asr([[0, 1, '一模一样']]) })
  const result = await measureTranscriptCoverage(parse([{ path: 'ep1.md', asr_path: 'ep1.json' }, { path: 'ep5.md', asr_path: 'ep5.json' }]),
    undefined, root, { ...limits, transcriptMaxEditLength: 1 }, signal)
  expect(result.episodes.map(episode => [episode.status, episode.reason])).toEqual([['not_measured', 'edit_limit'], ['measured', null]])
  expect(result.episodes[0]).toMatchObject({ counts: null, summary: '第1集：未测量（超出比对上限）', asr_uncovered: [] })
  expect(result.totals).toMatchObject({ episodes: 2, measured: 1, not_measured: 1, dialogue_lines: 1 })
})

it('observes cancellation and returns byte-identical results for the same input', async () => {
  const root = await workspace({ 'ep1.md': episodeOne, 'ep1.json': asrOne })
  const sources = parse([{ path: 'ep1.md', asr_path: 'ep1.json' }])
  const controller = new AbortController(), reason = Error('cancel coverage')
  controller.abort(reason)
  await expect(measureTranscriptCoverage(sources, undefined, root, limits, controller.signal)).rejects.toThrow(reason)
  expect(JSON.stringify(await measureTranscriptCoverage(sources, undefined, root, limits, signal)))
    .toBe(JSON.stringify(await measureTranscriptCoverage(sources, undefined, root, limits, signal)))
})
