/** Explicit file roles, complete selections and honest returned-text coverage. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'
import * as Reader from '../src/manuscript-document.ts'
import { materialDocumentsSchema, readManuscriptMaterials, type ManuscriptMaterialsInput,
  type ManuscriptMaterialsLimits } from '../src/manuscript-materials.ts'

const roots: string[] = []
const signal = new AbortController().signal
const limits: ManuscriptMaterialsLimits = { maxFileBytes: 65536, maxTextChars: 20000, maxDocuments: 8, maxMaterialChars: 40000 }
const script = ['题名', '第1集', '1-1 巷口 日 外', '▲甲抵达。',
  '第2集', '2-1 堂屋 日 内', '乙：我要换床。', '第3集', '3-1 主卧 日 内', '▲旧床被拆开。',
  '第4集', '4-1 主卧 日 内', '甲：房间已经变了。'].join('\n')

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(files: Record<string, string | Uint8Array> = { 'current.md': script }) {
  const root = await mkdtemp(join(tmpdir(), 'muse-materials-')); roots.push(root)
  await Promise.all(Object.entries(files).map(([path, text]) => writeFile(join(root, path), text)))
  return root
}

async function materials(root: string, documents: ManuscriptMaterialsInput, budgets = limits) {
  return readManuscriptMaterials(documents, root, budgets, signal)
}

it('keeps explicit current, reference and candidate roles and returns complete actual neighboring episodes', async () => {
  const root = await workspace({ 'current.md': script, 'reference.txt': script.replace('我要换床', '我不换床'),
    'candidate.md': script.replace('旧床被拆开', '旧床未动') })
  const result = await materials(root, [
    { role: 'current', path: 'current.md', episodes: [2] },
    { role: 'reference', path: 'reference.txt', episodes: [2] },
    { role: 'candidate', path: 'candidate.md', episodes: [3] },
  ])
  expect(result).toMatchObject({ state: 'materials', advisory: true, semantic_assessment: 'not_performed',
    position_basis: 'extracted_text_lines' })
  const [current, reference, candidate] = result.documents
  expect(current).toMatchObject({ role: 'current', line_count: 13, unchanged_since_read: true,
    selection: { kind: 'episodes', requested: [2], included: [1, 2, 3], adjacent: [1, 3] },
    coverage: { basis: 'returned_text_lines', read_ranges: [{ start: 2, end: 10 }],
      unread_ranges: [{ start: 1, end: 1 }, { start: 11, end: 13 }], full_document: false } })
  expect(current?.lines).toEqual(script.split('\n').slice(1, 10).map((text, index) => ({ number: index + 2, text })))
  expect(reference).toMatchObject({ role: 'reference', selection: { kind: 'episodes', requested: [2], included: [2], adjacent: [] },
    lines: [{ number: 5, text: '第2集' }, { number: 6, text: '2-1 堂屋 日 内' }, { number: 7, text: '乙：我不换床。' }] })
  expect(candidate).toMatchObject({ role: 'candidate', selection: { kind: 'episodes', requested: [3], included: [2, 3, 4], adjacent: [2, 4] } })
  expect(candidate?.lines.find(line => line.number === 10)?.text).toBe('▲旧床未动。')
  expect(current?.lines.find(line => line.number === 10)?.text).toBe('▲旧床被拆开。')
})

it('returns full text without selectors and distinguishes exact bytes from extracted-text hashes', async () => {
  const text = '第1集\r\n甲：A。\r\n\r\n▲转身。'
  const root = await workspace({ 'current.txt': text })
  const result = await materials(root, [{ role: 'current', path: 'current.txt' }])
  const document = result.documents[0]
  expect(document).toMatchObject({ path: await realpath(join(root, 'current.txt')),
    file_sha256: createHash('sha256').update(Buffer.from(text)).digest('hex'),
    text_sha256: createHash('sha256').update(text).digest('hex'), selection: { kind: 'full' },
    coverage: { read_ranges: [{ start: 1, end: 4 }], unread_ranges: [], full_document: true } })
  expect(document?.lines).toEqual([{ number: 1, text: '第1集' }, { number: 2, text: '甲：A。' },
    { number: 3, text: '' }, { number: 4, text: '▲转身。' }])
})

it('reads Word body and line breaks without calling extracted lines Word paragraphs', async () => {
  const xml = '<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>第1集</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>甲：开门。</w:t><w:br/><w:t>▲门开了。</w:t></w:r></w:p></w:body></w:document>'
  const bytes = zipSync({ 'word/document.xml': strToU8(xml) })
  const root = await workspace({ 'current.docx': bytes })
  const result = await materials(root, [{ role: 'current', path: 'current.docx', lines: { start: 2, end: 3 } }])
  expect(result.position_basis).toBe('extracted_text_lines')
  expect(result.documents[0]).toMatchObject({ file_sha256: createHash('sha256').update(bytes).digest('hex'),
    text_sha256: createHash('sha256').update('第1集\n甲：开门。\n▲门开了。').digest('hex'),
    selection: { kind: 'lines', start: 2, end: 3 }, lines: [{ number: 2, text: '甲：开门。' }, { number: 3, text: '▲门开了。' }],
    coverage: { read_ranges: [{ start: 2, end: 3 }], unread_ranges: [{ start: 1, end: 1 }], full_document: false } })
  expect(await readFile(join(root, 'current.docx'))).toEqual(Buffer.from(bytes))
})

it.each([
  '第(1)集', '第（一）集', '（第1集）', '【第1集】', '# 第１集：开场', '第001集',
])('recognizes an explicit wrapped or normalized heading: %s', async (heading) => {
  const root = await workspace({ 'current.md': `${heading}\n1-1 门口 日 外\n甲：来。\n第二集\n2-1 堂屋 日 内\n乙：好。` })
  const result = await materials(root, [{ role: 'current', path: 'current.md', episodes: [1] }])
  expect(result.documents[0]?.episode_index).toMatchObject({ state: 'indexed', issues: [],
    episodes: [{ episode: 1, start: 1, end: 3 }, { episode: 2, start: 4, end: 6 }] })
})

it('recognizes conventional Chinese numbers and selects actual adjacent sections without inventing missing episode numbers', async () => {
  const root = await workspace({ 'current.md': '第十二集\n12-1 院里 日 外\n甲：来。\n第二十一集\n21-1 院里 日 外\n乙：好。' })
  const result = await materials(root, [{ role: 'current', path: 'current.md', episodes: [21] }])
  expect(result.documents[0]?.selection).toEqual({ kind: 'episodes', requested: [21], included: [12, 21], adjacent: [12] })
})

it.each([
  ['第1集\n甲：来。\n第1集\n乙：好。', 'ambiguous', '重复'],
  ['第01集\n甲：来。\n第1集\n乙：好。', 'ambiguous', '重复'],
  ['第2集\n乙：好。\n第1集\n甲：来。', 'ambiguous', '递增'],
  ['第1集\n2-1 堂屋 日 内\n甲：来。', 'ambiguous', '不一致'],
  ['第一集\n甲：来。\n第一百二集\n乙：好。', 'ambiguous', '无法可靠识别'],
  ['1-1 堂屋 日 内\n甲：来。', 'unavailable', '缺失'],
])('refuses episode selection when headings are absent or ambiguous: %s', async (text, state, issue) => {
  const root = await workspace({ 'current.md': text })
  await expect(materials(root, [{ role: 'current', path: 'current.md', episodes: [1] }])).rejects.toThrow('MANUSCRIPT_MATERIALS_EPISODES')
  const explicit = await materials(root, [{ role: 'current', path: 'current.md', lines: { start: 1, end: 2 } }])
  expect(explicit.documents[0]?.episode_index.state).toBe(state)
  expect(explicit.documents[0]?.episode_index.issues.join('')).toContain(issue)
  expect(explicit.documents[0]?.lines).toHaveLength(2)
})

it('does not treat a dialogue mention or fenced example as an episode heading', async () => {
  const text = '第1集\n甲：第2集才说这件事。\n```text\n第3集\n3-1 示例 日 内\n```\n第2集\n乙：现在说。'
  const root = await workspace({ 'current.md': text })
  const result = await materials(root, [{ role: 'current', path: 'current.md', episodes: [1] }])
  expect(result.documents[0]?.episode_index.episodes.map(episode => episode.episode)).toEqual([1, 2])
  expect(result.documents[0]?.episode_index.state).toBe('indexed')
  expect(result.documents[0]?.lines).toHaveLength(8)
})

it('keeps an explicitly named file with leading whitespace distinct from its trimmed neighbor', async () => {
  const root = await workspace({ ' current.md': '甲：明确选择带空格的稿。', 'current.md': '甲：另一份稿。' })
  const result = await materials(root, [{ role: 'current', path: ' current.md' }])
  expect(result.documents[0]?.path).toBe(await realpath(join(root, ' current.md')))
  expect(result.documents[0]?.lines).toEqual([{ number: 1, text: '甲：明确选择带空格的稿。' }])
})

it('keeps shorter fences and closing markers with trailing text inside a longer fenced example', async () => {
  const text = ['第1集', '甲：开始。', '````text', '```', '第99集', '99-1 示例 日 内',
    '````still an example', '第98集', '98-1 示例 日 内', '~~~~', '第97集', '````',
    '第2集', '2-1 堂屋 日 内', '乙：继续。', '第3集', '3-1 院里 日 外', '甲：结束。'].join('\n')
  const root = await workspace({ 'current.md': text })
  const result = await materials(root, [{ role: 'current', path: 'current.md', episodes: [2] }])
  expect(result.documents[0]?.episode_index).toMatchObject({ state: 'indexed', issues: [],
    episodes: [{ episode: 1, start: 1, end: 12 }, { episode: 2, start: 13, end: 15 }, { episode: 3, start: 16, end: 18 }] })
  expect(result.documents[0]?.selection).toEqual({ kind: 'episodes', requested: [2], included: [1, 2, 3], adjacent: [1, 3] })
  expect(result.documents[0]?.lines).toEqual(text.split('\n').map((line, index) => ({ number: index + 1, text: line })))
})

it('allows a longer same-character fence with whitespace-only trailing content to close an example', async () => {
  const text = ['第1集', '~~~example', '第99集', '~~~~  ', '第2集', '2-1 堂屋 日 内', '甲：继续。'].join('\n')
  const root = await workspace({ 'current.md': text })
  const result = await materials(root, [{ role: 'current', path: 'current.md', episodes: [2] }])
  expect(result.documents[0]?.episode_index.episodes.map(episode => episode.episode)).toEqual([1, 2])
})

it('does not remove a heading prefix to turn fenced example text into a closing marker', async () => {
  const text = ['第1集', '````text', '# ````', '第99集', '````', '# 第2集', '2-1 堂屋 日 内', '甲：继续。'].join('\n')
  const root = await workspace({ 'current.md': text })
  const result = await materials(root, [{ role: 'current', path: 'current.md', episodes: [2] }])
  expect(result.documents[0]?.episode_index).toMatchObject({ state: 'indexed', issues: [] })
  expect(result.documents[0]?.episode_index.episodes.map(episode => episode.episode)).toEqual([1, 2])
})

it.each([
  [],
  [{ role: 'reference', path: 'a.md' }],
  [{ role: 'current', path: 'a.md' }, { role: 'current', path: 'b.md' }],
  [{ role: 'current', path: 'a.md' }, { role: 'candidate', path: 'b.md' }, { role: 'candidate', path: 'c.md' }],
  [{ role: 'current', path: 'a.md', episodes: [1], lines: { start: 1, end: 2 } }],
  [{ role: 'current', path: 'a.md', episodes: [1, 1] }],
  [{ role: 'current', path: 'a.md', episodes: [1.5] }],
  [{ role: 'current', path: 'a.md', lines: { start: 3, end: 2 } }],
  [{ role: 'current', path: '   ' }],
  [{ role: 'current', path: 'a.md', binding: 'old-work' }],
].map(documents => ({ documents })))('validates model JSON before reading files: $documents', async ({ documents }) => {
  expect(materialDocumentsSchema.safeParse(documents).success).toBe(false)
  await expect(readManuscriptMaterials(documents, '/not-read', limits, signal)).rejects.toThrow()
})

it('rejects canonical-path aliasing instead of treating the same file as current and candidate', async () => {
  const root = await workspace()
  await expect(materials(root, [{ role: 'current', path: 'current.md' },
    { role: 'candidate', path: './current.md' }])).rejects.toThrow('MANUSCRIPT_MATERIALS_ROLES')
})

it('refuses missing episodes and out-of-bounds lines rather than substituting or clamping', async () => {
  const root = await workspace()
  await expect(materials(root, [{ role: 'current', path: 'current.md', episodes: [9] }])).rejects.toThrow('没有第9集')
  await expect(materials(root, [{ role: 'current', path: 'current.md', lines: { start: 10, end: 14 } }])).rejects.toThrow('不能截短')
})

it('rejects full selections over the aggregate body budget without returning a head/tail preview', async () => {
  const root = await workspace({ 'current.md': '甲乙丙丁', 'candidate.txt': '戊己庚辛' })
  await expect(materials(root, [{ role: 'current', path: 'current.md' }, { role: 'candidate', path: 'candidate.txt' }],
    { ...limits, maxMaterialChars: 7 })).rejects.toThrow('请缩小集数或明确行范围')
  const exact = await materials(root, [{ role: 'current', path: 'current.md' }], { ...limits, maxMaterialChars: 4 })
  expect(exact.documents[0]?.lines).toEqual([{ number: 1, text: '甲乙丙丁' }])
  expect(exact.documents[0]?.coverage.full_document).toBe(true)
})

it('checks document and extraction budgets without silently returning a prefix', async () => {
  const root = await workspace()
  await expect(materials(root, [{ role: 'current', path: 'missing.md' }, { role: 'candidate', path: 'also-missing.md' }],
    { ...limits, maxDocuments: 1 })).rejects.toThrow('MANUSCRIPT_MATERIALS_DOCUMENTS')
  await expect(materials(root, [{ role: 'current', path: 'current.md', lines: { start: 1, end: 1 } }],
    { ...limits, maxTextChars: 5 })).rejects.toThrow('MANUSCRIPT_SIZE')
})

it('does not choose a different file or read legacy bindings and writes no materials ledger', async () => {
  const root = await workspace({ 'current.md': '甲：采用稿。', 'newer.md': '甲：无关新稿。' })
  await mkdir(join(root, '.muse', 'manuscript-work'), { recursive: true })
  await writeFile(join(root, '.muse', 'manuscript-work', 'ledger.json'), '{"adopted":"newer.md"}')
  const before = await readdir(root, { recursive: true })
  const result = await materials(root, [{ role: 'current', path: 'current.md' }])
  expect(result.documents).toHaveLength(1)
  expect(result.documents[0]?.lines).toEqual([{ number: 1, text: '甲：采用稿。' }])
  expect(await readdir(root, { recursive: true })).toEqual(before)
})

it('detects a real same-length file change after extraction before returning material snapshots', async () => {
  const root = await workspace({ 'current.md': '甲：原稿。' })
  const read = Reader.readManuscript
  let calls = 0
  vi.spyOn(Reader, 'readManuscript').mockImplementation(async (...args) => {
    const result = await read(...args)
    if (++calls === 1) await writeFile(join(root, 'current.md'), '甲：新稿。')
    return result
  })
  await expect(materials(root, [{ role: 'current', path: 'current.md' }])).rejects.toThrow('MANUSCRIPT_MATERIALS_CHANGED')
  expect(await readFile(join(root, 'current.md'), 'utf8')).toBe('甲：新稿。')
})

it('honors cancellation before reading material files', async () => {
  const controller = new AbortController(); controller.abort(Error('materials cancelled'))
  await expect(readManuscriptMaterials([{ role: 'current', path: 'missing.md' }], '/not-read', limits, controller.signal))
    .rejects.toThrow('materials cancelled')
})
