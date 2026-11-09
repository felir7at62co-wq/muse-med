/** Literal scans keep exact source positions, bounded enumeration and explicit semantic limits. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readManuscriptMaterials, type ManuscriptMaterialsDocument } from '../src/manuscript-materials.ts'
import { scanManuscriptRepetitions, type RepeatScanCandidate, type RepeatScanLimits } from '../src/manuscript-repeat-scan.ts'

const roots: string[] = [], signal = new AbortController().signal
const limits: RepeatScanLimits = { repeatMinChars: 24, repeatMaxSeedPairs: 20000,
  repeatMaxCandidates: 80, repeatMaxOutputChars: 50000 }
const readLimits = { maxFileBytes: 1024 * 1024, maxTextChars: 200000, maxDocuments: 8, maxMaterialChars: 200000 }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function document(text: string): Promise<ManuscriptMaterialsDocument> {
  const root = await mkdtemp(join(tmpdir(), 'muse-repeat-scan-')); roots.push(root)
  await writeFile(join(root, '原稿.md'), '原稿仅供版本对照，不属于被扫描候选正文。')
  await writeFile(join(root, '稿件.md'), text)
  const result = await readManuscriptMaterials([{ role: 'current', path: '原稿.md' }, { role: 'candidate', path: '稿件.md' }], root, readLimits, signal)
  const selected = result.documents.find(value => value.role === 'candidate')
  if (selected === undefined) throw Error('The selected source document is missing')
  return selected
}

function sourceSpan(source: ManuscriptMaterialsDocument, candidate: RepeatScanCandidate, occurrence: number): string {
  const span = candidate.occurrences[occurrence]
  if (span === undefined) throw Error('The expected repetition occurrence is missing')
  return source.lines.filter(line => span.start.line <= line.number && line.number <= span.end.line).map((line) => {
    const characters = Array.from(line.text)
    const start = line.number === span.start.line ? span.start.column - 1 : 0
    const end = line.number === span.end.line ? span.end.column : characters.length
    return characters.slice(start, end).join('')
  }).join('\n')
}

it('finds a 180-character shared passage despite a one-character prefix shift', async () => {
  const repeated = Array.from({ length: 180 }, (_value, index) => String.fromCodePoint(0x4e00 + index)).join('')
  const left = `甲${repeated}终`, right = `乙乙${repeated}止`
  const oldWindows = (text: string) => Array.from({ length: Math.floor((text.length - 30) / 20) + 1 },
    (_value, index) => text.slice(index * 20, index * 20 + 30))
  expect(oldWindows(left).filter(value => oldWindows(right).includes(value))).toEqual([])
  const source = await document(`第1集\n1-1 茶楼 日 内\n${left}\n第2集\n2-1 茶楼 日 内\n${right}`)
  const result = scanManuscriptRepetitions(source, { ...limits, repeatMinChars: 30 }, signal)
  expect(result.coverage.complete).toBe(true)
  expect(result.candidates).toHaveLength(1)
  expect(result.candidates[0]).toMatchObject({ text: repeated, characters: 180,
    occurrences: [{ start: { line: 3, column: 2 }, end: { line: 3, column: 181 }, episode: 1 },
      { start: { line: 6, column: 3 }, end: { line: 6, column: 182 }, episode: 2 }] })
})

it('does not skip a repeated scene when episode lengths differ by more than 150 characters', async () => {
  const repeated = '▲甲接过回执，逐字核对签名后交给守门人，守门人点头并把回执收进抽屉。'
  const extra = Array.from({ length: 220 }, (_value, index) => String.fromCodePoint(0x5a00 + index)).join('')
  const source = await document(`第1集\n1-1 门口 日 外\n${repeated}甲\n${extra}\n第2集\n2-1 门口 日 外\n${repeated}乙`)
  const result = scanManuscriptRepetitions(source, limits, signal)
  expect(result.candidates.some(candidate => candidate.text === repeated && candidate.occurrences.length === 2)).toBe(true)
  expect(result.coverage.enumeration_complete).toBe(true)
})

it('finds repeated dialogue inside one episode without comparing it with the original draft', async () => {
  const repeated = '甲：这张回执已经亲手交给陈管事，请他在明早开门以前核对。'
  const source = await document(`第1集\n1-1 门口 日 外\n${repeated}\n乙：先说下一件事。\n${repeated}`)
  const before = JSON.stringify(source)
  const result = scanManuscriptRepetitions(source, limits, signal)
  expect(result.target).toMatchObject({ role: 'candidate', file_sha256: source.file_sha256 })
  expect(result.semantic_assessment).toBe('not_performed')
  expect(result.candidates.some(candidate => candidate.text === repeated
    && candidate.occurrences.map(occurrence => occurrence.episode).every(episode => episode === 1))).toBe(true)
  expect(JSON.stringify(source)).toBe(before)
  expect(await readFile(source.path, 'utf8')).toContain(repeated)
})

it('groups three nonoverlapping occurrences of the same passage', async () => {
  const repeated = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄宇宙洪荒'
  const source = await document(`第1集\n1-1 茶楼 日 内\n先${repeated}止\n后${repeated}毕\n再${repeated}终`)
  const result = scanManuscriptRepetitions(source, limits, signal)
  expect(result.candidates).toHaveLength(1)
  expect(result.candidates[0]?.occurrences).toHaveLength(3)
  expect(result.candidates[0]?.text).toBe(repeated)
})

it('excludes repeated episode, scene and cast metadata without treating them as body repetition', async () => {
  const metadata = '人物：林川、陈管事、周先生、沈晴、客人甲、客人乙、守门人、老板、工人和邻居。'
  const source = await document(`第1集\n1-1 这里是连续三十个字以上的相同场景标题用于结构排除 日 内\n${metadata}\n甲：先走。\n`
    + `第2集\n2-1 这里是连续三十个字以上的相同场景标题用于结构排除 日 内\n${metadata}\n乙：回来。`)
  const result = scanManuscriptRepetitions(source, limits, signal)
  expect(result.candidates).toEqual([])
  expect(result.coverage.complete).toBe(true)
  expect(result.coverage.excluded_ranges).toEqual([{ start: 1, end: 3 }, { start: 5, end: 7 }])
})

it.each(['unread', 'metadata'] as const)('does not synthesize a repeated span across an %s gap', async (gap) => {
  const left = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰', right = '天地玄黄宇宙洪荒日月盈昃辰宿列'
  const full = await document(`${left}\n${gap === 'metadata' ? '人物：林川、沈晴。' : '这一行实际没有被返回。'}\n${right}\n场间分隔\n${left}\n${right}`)
  const source = gap === 'metadata' ? full : { ...full, lines: full.lines.filter(line => line.number !== 2),
    coverage: { ...full.coverage, read_ranges: [{ start: 1, end: 1 }, { start: 3, end: 6 }],
      unread_ranges: [{ start: 2, end: 2 }], full_document: false } }
  const result = scanManuscriptRepetitions(source, limits, signal)
  expect(result.candidates).toEqual([])
  expect(result.coverage.complete).toBe(true)
  expect(result.coverage.full_document).toBe(gap === 'metadata')
  expect(result.coverage.unread_ranges).toEqual(gap === 'metadata' ? [] : [{ start: 2, end: 2 }])
})

it.each([
  ['甲：现在不要交出这把钥匙，等到所有手续办好以后再说。', '甲：现在要交出这把钥匙，等到所有手续办好以后再说。'],
  ['甲：欠款必须等七天才能还清，一共九万元。', '甲：欠款必须等三天才能还清，一共十万元。'],
])('keeps negation and numeric differences in literal matching: %s', async (first, second) => {
  const source = await document(`${first}\n${second}`)
  const result = scanManuscriptRepetitions(source, { ...limits, repeatMinChars: Array.from(first).length - 1 }, signal)
  expect(result.candidates).toEqual([])
  expect(result.coverage.complete).toBe(true)
})

it('stops pathological seed pairing explicitly instead of claiming a complete zero-result scan', async () => {
  const source = await document('啊'.repeat(5000))
  const result = scanManuscriptRepetitions(source, { ...limits, repeatMinChars: 4, repeatMaxSeedPairs: 5 }, signal)
  expect(result.coverage).toMatchObject({ complete: false, enumeration_complete: false,
    stop_reason: 'seed_pair_budget', examined_seed_pairs: 5, full_document: true })
  expect(result.notice).toContain('零候选不代表零剧情重复')
})

it('reports candidate-count omissions separately from complete seed enumeration', async () => {
  const first = Array.from({ length: 32 }, (_value, index) => String.fromCodePoint(0x4e00 + index)).join('')
  const second = Array.from({ length: 34 }, (_value, index) => String.fromCodePoint(0x5a00 + index)).join('')
  const source = await document(`先${first}止\n后${first}毕\n再${second}终\n又${second}完`)
  const result = scanManuscriptRepetitions(source, { ...limits, repeatMaxCandidates: 1 }, signal)
  expect(result.candidates).toHaveLength(1)
  expect(result.coverage).toMatchObject({ complete: false, enumeration_complete: true, omitted_candidates: 1, stop_reason: 'candidate_limit' })
})

it('omits a whole over-budget candidate rather than shortening its literal text', async () => {
  const repeated = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄宇宙洪荒'
  const source = await document(`先${repeated}止\n后${repeated}毕`)
  const result = scanManuscriptRepetitions(source, { ...limits, repeatMaxOutputChars: 20 }, signal)
  expect(result.candidates).toEqual([])
  expect(result.coverage).toMatchObject({ complete: false, enumeration_complete: true,
    omitted_candidates: 1, stop_reason: 'output_chars_limit' })
})

it('uses Unicode code-point columns and leaves each quoted source span unchanged', async () => {
  const repeated = '春雨🌧落在窗边，林川把旧账本放回抽屉并锁上。'
  const source = await document(`😀${repeated}甲\n🙃🙃${repeated}乙`)
  const result = scanManuscriptRepetitions(source, { ...limits, repeatMinChars: 12 }, signal)
  expect(result.candidates).toHaveLength(1)
  const candidate = result.candidates[0]!
  expect(candidate.text).toBe(repeated)
  expect(candidate.characters).toBe(Array.from(repeated).length)
  expect(candidate.occurrences.map(occurrence => occurrence.start)).toEqual([{ line: 1, column: 2 }, { line: 2, column: 3 }])
  expect(sourceSpan(source, candidate, 0)).toBe(repeated)
  expect(sourceSpan(source, candidate, 1)).toBe(repeated)
  expect(candidate.occurrences.map(occurrence => occurrence.episode)).toEqual([null, null])
})

it('binds candidate hashes to actual file bytes and positions without including workspace paths', async () => {
  const text = '先甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄宇宙洪荒止\n后甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄宇宙洪荒毕'
  const first = await document(text), second = await document(text)
  expect(first.path).not.toBe(second.path)
  expect(scanManuscriptRepetitions(first, limits, signal).candidates.map(candidate => candidate.candidate_sha256))
    .toEqual(scanManuscriptRepetitions(second, limits, signal).candidates.map(candidate => candidate.candidate_sha256))
})

it('normalizes file line endings while retaining complete multiline matches and source locations', async () => {
  const text = '甲：先把门关好，再把上面的灯打开。\n乙：回执已经收到，我会把原件放进抽屉。'
  const source = await document(`先${text}甲\n场间分隔\n后${text}乙`.replaceAll('\n', '\r\n'))
  const result = scanManuscriptRepetitions(source, { ...limits, repeatMinChars: 30 }, signal)
  expect(result.candidates).toHaveLength(1)
  expect(result.candidates[0]?.text).toBe(text)
  expect(result.candidates[0]?.text).not.toContain('\r')
  expect(sourceSpan(source, result.candidates[0]!, 0)).toBe(text)
  expect(sourceSpan(source, result.candidates[0]!, 1)).toBe(text)
})

it('does not infer semantic nonrepetition from rephrased events with no long literal match', async () => {
  const source = await document('▲第一天他已把欠条烧成灰烬。\n▲次日他再次从口袋拿出那张欠条，当众撕碎后点燃。')
  const result = scanManuscriptRepetitions(source, limits, signal)
  expect(result.candidates).toEqual([])
  expect(result.semantic_assessment).toBe('not_performed')
})

it('observes cancellation before returning any scan result', async () => {
  const source = await document('这段正文不应在取消之后产生检查结果。')
  const controller = new AbortController(), reason = Error('cancel literal scan')
  controller.abort(reason)
  expect(() => scanManuscriptRepetitions(source, limits, controller.signal)).toThrow(reason)
})
