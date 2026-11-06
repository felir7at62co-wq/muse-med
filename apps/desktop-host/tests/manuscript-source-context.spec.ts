/** Actual headings locate evidence without promoting dialogue locations or archived chapters into scene metadata. */
import { expect, it } from 'vitest'
import { buildWindow } from '@deepseek-ai/dsh-tool-fs'
import { manuscriptRepetitions, manuscriptScenes, manuscriptStructure, parseManuscriptHeading } from '../src/manuscript-scenes.ts'
import { indexManuscriptSource, manuscriptSourceCitationContext, manuscriptSourceCitationLabels,
  manuscriptSourceLineLabels, manuscriptSourcePageContext, manuscriptSourceRangeContext } from '../src/manuscript-source-context.ts'

const source = '剧本草案\n第1集\n1-0 日/夜 内外 开篇先导快切\n▲甲看到门开。\n1-1 日 内 三楼备勤间\n人物：甲、乙\n甲：你把一楼大厅打扫完了吗？\n甲OS：原定第47章会出事。\n第2集\n2-1 二楼 夜 外\n乙：别过去。'

it('labels literal headings, directions and named dialogue without turning metadata into a speaker', () => {
  const text = '第1集\n1-1 日 内 门口\n人物：甲、乙\n▲甲停下。\n△三天后。\n甲：妈妈，等我。\n甲OS（心里：😀）：爸爸呢？\n乙（VO）：我回来了。\nOS：妈妈。\n系统档案：甲是董事长。\n【当前身份：甲的父亲】'
  expect(manuscriptSourceLineLabels(text, 1, 11)).toEqual([
    ...[1, 2].map(line => ({ line, kind: 'heading', speaker_label: null, voice_marker: null, speaker_annotation: null, speech_column: null })),
    { line: 3, kind: 'other', speaker_label: null, voice_marker: null, speaker_annotation: null, speech_column: null },
    ...[4, 5].map(line => ({ line, kind: 'action', speaker_label: null, voice_marker: null, speaker_annotation: null, speech_column: null })),
    { line: 6, kind: 'dialogue', speaker_label: '甲', voice_marker: null, speaker_annotation: null, speech_column: 3 },
    { line: 7, kind: 'dialogue', speaker_label: '甲', voice_marker: 'OS', speaker_annotation: '（心里：😀）', speech_column: 11 },
    { line: 8, kind: 'dialogue', speaker_label: '乙', voice_marker: 'VO', speaker_annotation: '（VO）', speech_column: 7 },
    { line: 9, kind: 'other', speaker_label: null, voice_marker: 'OS', speaker_annotation: null, speech_column: 4 },
    ...[10, 11].map(line => ({ line, kind: 'other', speaker_label: null, voice_marker: null, speaker_annotation: null, speech_column: null })),
  ])
})

it('preserves literal case and parentheses without inferring audibility or trimming Latin names into voice markers', () => {
  const text = '甲（os）：别说。\n乙 vo（低声）：回来。\nCARLOS：我在。\n甲（心里想着）：妈妈。\n丙(旁边的人说：等等)(心声)：我记得。'
  expect(manuscriptSourceLineLabels(text, 1, 5)).toMatchObject([
    { speaker_label: '甲', voice_marker: 'os', speaker_annotation: '（os）' },
    { speaker_label: '乙', voice_marker: 'vo', speaker_annotation: '（低声）' },
    { speaker_label: 'CARLOS', voice_marker: null },
    { speaker_label: '甲', voice_marker: null, speaker_annotation: '（心里想着）' },
    { speaker_label: '丙', voice_marker: '心声', speaker_annotation: '(旁边的人说：等等)(心声)' },
  ])
  expect(text).toContain('甲（os）：别说。')
})

it('keeps unfamiliar or unbalanced notation unassigned instead of guessing a named speaker', () => {
  const text = '普通文字没有分隔符\n甲（OS：妈妈\n甲（OS)）：妈妈\n甲（OS）和乙（VO）：妈妈\n：妈妈\n甲/乙：妈妈'
  expect(manuscriptSourceLineLabels(text, 1, 6).every(row => row.kind === 'other' && row.speaker_label === null)).toBe(true)
})

it('derives attribution from the full line when the reading window starts inside a long Unicode body', async () => {
  const text = '甲OS（轻声）：' + '😀字'.repeat(1600) + '妈妈。'
  const page = await buildWindow([text], { offset: 1, column: 2200, limit: 1, maxLineLength: 20, maxBytes: 4096 }, 'synthetic.txt')
  expect(page.lines[0]?.text).not.toContain('甲OS')
  const labels = manuscriptSourceLineLabels(text, 1, 1)
  expect(labels).toMatchObject([{ line: 1, speaker_label: '甲', voice_marker: 'OS', speaker_annotation: '（轻声）', speech_column: 9 }])
  expect(JSON.stringify(labels).length).toBeLessThan(200)
})

it('uses reader line numbering for CRLF, final CR and empty source lines', () => {
  const text = '甲（OS）：妈妈。\r\n\r\n乙：等等。\r'
  expect(manuscriptSourceLineLabels(text, 1, 3)).toMatchObject([
    { line: 1, kind: 'dialogue', speaker_label: '甲', voice_marker: 'OS' },
    { line: 2, kind: 'other', speaker_label: null },
    { line: 3, kind: 'dialogue', speaker_label: '乙' },
  ])
})

it.each(['', '\r', '甲：妈妈。\n', '甲：妈妈。\r\n', '甲：妈妈。\n\r'])('labels reader-visible empty lines in %j without changing title indexing', (text) => {
  const last = text === '' || text === '\r' ? 1 : 2
  expect(manuscriptSourceLineLabels(text, last, last)).toEqual([
    { line: last, kind: 'other', speaker_label: null, voice_marker: null, speaker_annotation: null, speech_column: null },
  ])
  if (text === '') expect(indexManuscriptSource(text)).toEqual({ total_lines: 0, sections: [] })
  else if (!text.endsWith('\r')) expect(indexManuscriptSource(text).total_lines).toBe(1)
})

it('locates a first-floor dialogue mention in its actual third-floor scene and retains the complete scene', () => {
  const index = indexManuscriptSource(source), context = manuscriptSourceRangeContext(index, 7, 8)
  expect(context).toMatchObject({ start_line: 7, end_line: 8, crosses_episodes: false, crosses_scenes: false,
    sections: [{ section_index: 4, source_scene_id: 'source-scene-2', episode: '1', episode_number: '1',
      episode_label: '第1集', episode_basis: 'episode_heading', scene_id: '1-1',
      heading: '1-1 日 内 三楼备勤间', heading_line: 5, heading_setting: '日 内 三楼备勤间',
      start_line: 5, end_line: 8, selected_start_line: 7, selected_end_line: 8,
      episode_heading: { line: 2, text: '第1集', label: '第1集' },
      previous_scene_index: 3, next_scene_index: 6,
      previous_section: { scene_id: '1-0', start_line: 3, end_line: 4 },
      next_section: { kind: 'episode_body', episode: '2', start_line: 9, end_line: 9 } }] })
  expect(context.sections[0]?.heading_setting).not.toContain('一楼')
})

it('preserves complete selected ownership while neighbors expose only real navigation fields', () => {
  const index = indexManuscriptSource(source), canonical = manuscriptSourceRangeContext(index, 7, 8)
  const before = structuredClone(canonical), page = manuscriptSourcePageContext(index, 7, 8)
  const selected = canonical.sections[0]
  if (!selected) throw Error('Expected selected source scene')
  const { previous_section: _previous, next_section: _next, ...fields } = selected
  expect(page.sections[0]).toEqual({ ...fields,
    previous_section: { section_index: 3, source_scene_id: 'source-scene-1', episode: '1', scene_id: '1-0',
      heading: '1-0 日/夜 内外 开篇先导快切', start_line: 3, end_line: 4 },
    next_section: { section_index: 5, source_scene_id: null, episode: '2', scene_id: null,
      heading: '第2集', start_line: 9, end_line: 9 } })
  expect(manuscriptSourceRangeContext(index, 7, 8)).toEqual(before)
  expect(JSON.stringify(page).length).toBeLessThan(JSON.stringify(canonical).length)
  expect(manuscriptSourcePageContext(index, 1, 11).sections[0]?.previous_section).toBeNull()
  expect(manuscriptSourcePageContext(index, 1, 11).sections.at(-1)?.next_section).toBeNull()
})

it('labels every selected interval by actual source episode and distinct scene occurrence', () => {
  const index = indexManuscriptSource(source), canonical = manuscriptSourceRangeContext(index, 8, 11)
  const labels = [{ start_line: 8, end_line: 8, episode: '第1集', scene_id: '1-1', source_scene_id: 'source-scene-2' },
    { start_line: 9, end_line: 9, episode: '第2集', scene_id: null, source_scene_id: null },
    { start_line: 10, end_line: 11, episode: '第2集', scene_id: '2-1', source_scene_id: 'source-scene-3' }]
  expect(manuscriptSourceCitationLabels(canonical)).toEqual(labels)
  expect(manuscriptSourceCitationLabels(manuscriptSourcePageContext(index, 8, 11))).toEqual(labels)
  expect(manuscriptSourceCitationLabels(manuscriptSourcePageContext(index, 1, 1))).toEqual([
    { start_line: 1, end_line: 1, episode: 'unassigned', scene_id: null, source_scene_id: null },
  ])
  const repeated = indexManuscriptSource('第3集\n3-1 日 内 门口\n甲：先来。\n第3集\n3-1 日 内 门口\n乙：后来。')
  expect(manuscriptSourceCitationLabels(manuscriptSourcePageContext(repeated, 3, 6))).toEqual([
    { start_line: 3, end_line: 3, episode: '第3集', scene_id: '3-1', source_scene_id: 'source-scene-1' },
    { start_line: 4, end_line: 4, episode: '第3集', scene_id: null, source_scene_id: null },
    { start_line: 5, end_line: 6, episode: '第3集', scene_id: '3-1', source_scene_id: 'source-scene-2' },
  ])
})

it('retains selected citation fields and labels without copying neighboring or additional top-level data', () => {
  const range = manuscriptSourceRangeContext(indexManuscriptSource(source), 8, 11), before = structuredClone(range)
  const evidenceRange = { ...range, source_path: 'bound.txt', source_sha256: 'a'.repeat(64), time_basis: [] }
  const citation = manuscriptSourceCitationContext(evidenceRange)
  expect(citation).toEqual({ start_line: 8, end_line: 11, crosses_episodes: true, crosses_scenes: true,
    citation_labels: manuscriptSourceCitationLabels(range),
    sections: range.sections.map(({ previous_section: _previous, next_section: _next, ...selected }) => selected) })
  expect(manuscriptSourceCitationLabels(citation)).toEqual(manuscriptSourceCitationLabels(range))
  expect(range).toEqual(before)
  expect(citation).not.toHaveProperty('source_path')
  expect(citation).not.toHaveProperty('time_basis')
  expect(citation.sections.every(section => !('previous_section' in section) && !('next_section' in section))).toBe(true)
  expect(JSON.stringify(citation).length).toBeLessThan(JSON.stringify(range).length)
})

it('keeps the introductory 1-0 and actual 1-1 as separate source scene occurrences', () => {
  const index = indexManuscriptSource(source), scenes = index.sections.filter(row => row.kind === 'scene')
  expect(scenes.map(row => [row.source_scene_id, row.scene_id, row.start_line, row.end_line])).toEqual([
    ['source-scene-1', '1-0', 3, 4], ['source-scene-2', '1-1', 5, 8], ['source-scene-3', '2-1', 10, 11],
  ])
  expect(manuscriptSourceRangeContext(index, 3, 8)).toMatchObject({ crosses_scenes: true, crosses_episodes: false })
  expect(index.sections[0]).toMatchObject({ kind: 'unassigned', episode: 'unassigned', scene_id: null, start_line: 1, end_line: 1 })
  expect(manuscriptSourceRangeContext(index, 1, 3).crosses_episodes).toBe(false)
})

it('returns all source ownership for a cross-episode citation instead of choosing the first title', () => {
  const context = manuscriptSourceRangeContext(indexManuscriptSource(source), 8, 11)
  expect(context.crosses_episodes).toBe(true)
  expect(context.crosses_scenes).toBe(true)
  expect(context.sections.map(row => [row.episode, row.scene_id, row.selected_start_line, row.selected_end_line])).toEqual([
    ['1', '1-1', 8, 8], ['2', null, 9, 9], ['2', '2-1', 10, 11],
  ])
  expect(context.sections.at(-1)?.next_section).toBeNull()
  expect(context.sections.at(-1)?.next_scene_index).toBeNull()
})

it('does not turn source summaries, character speech, OS or mentioned chapters into headings', () => {
  const text = '第3集\n3-1 日 内 门口\n甲：第9集他提到一楼。\nOS：第8集不要相信他。\n【档案：原定第47章，十二楼事故】\n第47章\n▲第6集，甲曾在这里等人。'
  const index = indexManuscriptSource(text)
  expect(index.sections).toHaveLength(2)
  expect(manuscriptSourceRangeContext(index, 3, 7)).toMatchObject({ crosses_scenes: false, crosses_episodes: false,
    sections: [{ episode: '3', scene_id: '3-1', heading_setting: '日 内 门口', start_line: 2, end_line: 7 }] })
  expect(manuscriptStructure([{ path: 'source.txt', text }])).toMatchObject({ episode_heading_count: 1, scene_heading_count: 1 })
})

it('retains repeated episode and scene labels with distinct occurrence identities and neighbor references', () => {
  const text = '第3集\n3-1 家 日 内\n甲：第一次。\n第3集\n3-1 家 日 内\n乙：第二次。'
  const index = indexManuscriptSource(text), context = manuscriptSourceRangeContext(index, 3, 6)
  expect(index.sections.filter(row => row.kind === 'scene').map(row => [row.scene_id, row.source_scene_id, row.episode_index])).toEqual([
    ['3-1', 'source-scene-1', 1], ['3-1', 'source-scene-2', 2],
  ])
  expect(context.crosses_episodes).toBe(true)
  expect(context.crosses_scenes).toBe(true)
  expect(context.sections[0]?.previous_section).toMatchObject({ kind: 'episode_body', start_line: 1 })
  expect(manuscriptScenes(text).map(row => row.id)).toEqual(['3:1', '3:1:occurrence-2'])
})

it('uses explicit episode titles before conflicting scene prefixes without changing legacy candidate IDs', () => {
  const text = '第2集\n7-1 日 内 办公室\n甲：别急。'
  expect(indexManuscriptSource(text).sections[1]).toMatchObject({ episode: '2', episode_number: '2',
    episode_basis: 'episode_heading', scene_id: '7-1', scene_episode_label: '7', episode_scene_consistency: 'conflict' })
  expect(manuscriptScenes(text)[0]).toMatchObject({ id: '7:1', episode: '7' })
})

it('uses scene-number ownership only when no explicit episode title has been read', () => {
  const index = indexManuscriptSource('4-1 日 内 大厅\n甲：声音。\n4-2 日 内 过道\n乙：跟上。\n5-1 夜 外 街口\n▲雨。')
  expect(index.sections.map(row => [row.episode, row.episode_index, row.episode_basis])).toEqual([
    ['4', 1, 'scene_number'], ['4', 1, 'scene_number'], ['5', 2, 'scene_number'],
  ])
  expect(index.sections[0]).toMatchObject({ episode_heading: null, episode_label: '4', episode_scene_consistency: 'matches',
    previous_scene_index: null, next_scene_index: 2 })
  expect(manuscriptSourceRangeContext(index, 1, 4)).toMatchObject({ crosses_episodes: false, crosses_scenes: true })
  expect(manuscriptSourceRangeContext(index, 3, 6).crosses_episodes).toBe(true)
})

it.each([
  ['十二', '12'], ['〇一二', '12'], ['一百零二', '102'], ['一百一十', '110'], ['十', '10'], ['二十一', '21'], ['0012', '12'],
])('compares the actual episode label %s with numeric scene prefix %s', (label, numeric) => {
  const section = indexManuscriptSource(`第${label}集\n${numeric}—2 日 内 办公室`).sections[1]
  expect(section).toMatchObject({ episode: label, episode_number: numeric, episode_label: `第${label}集`,
    episode_scene_consistency: 'matches', scene_id: `${numeric}-2`, heading_setting: '日 内 办公室' })
})

it.each(['十百', '1十', '1二', '九'.repeat(20) + '十'])('retains an uncomparable authored ordinal %s without inventing a numeric match', (label) => {
  expect(indexManuscriptSource(`第${label}集\n1-1 日 内 门口`).sections[1]).toMatchObject({
    episode: label, episode_basis: 'episode_heading', episode_number: null, episode_scene_consistency: 'not_compared',
  })
})

it('keeps only known source heading syntax and the exact raw Markdown title', () => {
  const raw = '  ## 12－3  夜 外 河岸  '
  expect(parseManuscriptHeading(raw)).toMatchObject({ kind: 'scene', label: '12-3', setting: '夜 外 河岸' })
  const section = indexManuscriptSource(raw + '\n甲：😀。').sections[0]
  expect(section).toMatchObject({ heading: raw, heading_line: 1, heading_setting: '夜 外 河岸', end_line: 2 })
  expect(parseManuscriptHeading('1-1.门口 夜 外')).toMatchObject({ kind: 'scene', setting: '门口 夜 外' })
  expect(parseManuscriptHeading('第 2 集：尾声')).toMatchObject({ kind: 'episode', label: '第 2 集' })
})

it('reports an unrecognized source as unassigned rather than deriving a location from body text', () => {
  const index = indexManuscriptSource('正文\n甲：到一楼去。\nOS：原定第47章还有一件事。')
  expect(index.sections).toMatchObject([{ kind: 'unassigned', episode: 'unassigned', episode_basis: 'unassigned',
    source_scene_id: null, scene_id: null, heading: null, heading_setting: null, start_line: 1, end_line: 3 }])
  expect(manuscriptSourceRangeContext(index, 1, 3)).toMatchObject({ crosses_episodes: false, crosses_scenes: false,
    sections: [{ previous_section: null, next_section: null, previous_scene_index: null, next_scene_index: null }] })
  expect(indexManuscriptSource('')).toEqual({ total_lines: 0, sections: [] })
  expect(manuscriptScenes(' \n')).toEqual([])
})

it('keeps within-scene and neighboring-scene repetition attribution after sharing heading recognition', () => {
  const text = '第1集\n1-1 门口 日 内\n甲：同一个事实需要清楚说明。\n甲：同一个事实需要清楚说明。\n1-2 客厅 日 内\n乙：同一个事实需要清楚说明。'
  const result = manuscriptRepetitions(manuscriptScenes(text), 6, 10)
  expect(result.findings.map(row => row.kind)).toEqual(['within_scene', 'within_episode'])
  expect(result.total).toBe(2)
})

it.each(['第1集\r\n1-1 日 内 门口\r\n甲：😀。\r\n', '第1集\n1-1 日 内 门口\n甲：😀。', '\r', '\n\r', '甲\r\r\n'])('uses the same CRLF, Unicode and terminal-line positions as source reading', async (text) => {
  const page = await buildWindow([text], { offset: 1, column: 1, limit: 100, maxLineLength: 100, maxBytes: 4096 }, 'synthetic.txt')
  const index = indexManuscriptSource(text)
  expect(index.total_lines).toBe(page.totalLines)
  expect(index.sections[0]?.start_line).toBe(1)
  expect(index.sections.at(-1)?.end_line).toBe(page.totalLines)
  expect(index.sections.flatMap(row => Array.from({ length: row.end_line - row.start_line + 1 }, (_, n) => row.start_line + n)))
    .toEqual(Array.from({ length: page.totalLines }, (_, n) => n + 1))
})

it.each([[0, 1], [2, 1], [1, 12], [1.5, 2], [1, 2.5], [Number.NaN, 1]])('rejects a nonexistent citation range %j', (start, end) => {
  expect(() => manuscriptSourceRangeContext(indexManuscriptSource(source), start, end)).toThrow('MANUSCRIPT_SOURCE_CONTEXT_RANGE')
  expect(() => manuscriptSourcePageContext(indexManuscriptSource(source), start, end)).toThrow('MANUSCRIPT_SOURCE_CONTEXT_RANGE')
  expect(() => manuscriptSourceLineLabels(source, start, end)).toThrow('MANUSCRIPT_SOURCE_CONTEXT_RANGE')
})
