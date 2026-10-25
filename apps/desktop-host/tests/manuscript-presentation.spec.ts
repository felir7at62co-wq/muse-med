/** Screenplay presentation evidence preserves literal positions without adding creative decisions. */
import { expect, it } from 'vitest'
import { manuscriptFormatReference, manuscriptPresentationEvidence } from '../src/manuscript-presentation.ts'
import { manuscriptScenes } from '../src/manuscript-scenes.ts'

function evidence(text: string, maximumFindings = 40, maxTextCharacters = 200_000,
  changedLines?: ReadonlyMap<string, ReadonlySet<number>>) {
  return manuscriptPresentationEvidence(manuscriptScenes(text).map(scene => ({ ...scene, path: '/draft.md' })),
    { maximumFindings, maxTextCharacters }, changedLines)
}

it('keeps synchronized action and speech as separate literal locations without deciding their narrative roles', () => {
  const text = '第1集\n1-1 餐厅 日 内\n▲甲把钥匙推到乙面前，同时开口。\n甲（盯着乙）：你走吧。\n乙：你认真的？\n▲乙收起钥匙，转身出门。'
  const report = evidence(text), episode = report.episodes[0]!
  expect(episode.action_locations.findings).toMatchObject([
    { kind: 'action_line', line: 3, quote: '▲甲把钥匙推到乙面前，同时开口。', adjacent_material: [{ line: 4, kind: 'dialogue' }] },
    { kind: 'dialogue', line: 4, quote: '甲（盯着乙）：你走吧。', parentheticals: ['盯着乙'],
      adjacent_material: [{ line: 3, kind: 'action_line' }, { line: 5, kind: 'dialogue' }] },
    { kind: 'action_line', line: 6, quote: '▲乙收起钥匙，转身出门。' },
  ])
  expect(report.semantic_assessment).toBe('not_performed')
  expect(episode.adjacent_lines.findings).toContainEqual(expect.objectContaining({ line: 5, quote: '乙：你认真的？' }))
  expect(episode.adjacent_line_relation).toBe('same_scene_neighbors_not_event_alignment')
  expect(report).not.toHaveProperty('minimum_action_count')
  expect(report.notice).toContain('不按数量报警')
  expect(manuscriptFormatReference().action_line).toContain('不按动作长短或是否同步说话机械拆分')
})

it('reports marker absence as structure while retaining the actual final action and dialogue', () => {
  const report = evidence('第1集\n1-1 餐厅 日 内\n甲：我明白了。\n▲甲推门离开。\n1-2 门外 日 外\n▲乙站在门外。\n乙（低声）：他终于走了。\n【全剧终】')
  expect(report.episodes[0]?.ending).toMatchObject({ marker_status: 'not_found', marker_count: 0,
    last_scene: { id: '1:2', start_line: 5, end_line: 8 }, suspense_assessment: 'not_performed',
    last_scene_lines: { findings: [{ line: 6, quote: '▲乙站在门外。' }, { line: 7, quote: '乙（低声）：他终于走了。' }] },
    following_last_marker: { findings: [], total: 0, omitted: 0 } })
  expect(report.notice).toContain('大结局不构成违规')
  expect(report.episodes[0]?.ending).not.toHaveProperty('violation')
})

it('keeps hook aliases and their actual original content without duplicating or adding an ending', () => {
  const text = '第1集\n1-1 门外 日 外\n▲甲关上门。\n【集尾钩子】甲的手机亮起。\n甲：怎么会是他？\n第2集\n2-1 门外 夜 外\n乙：我在这里。\n[下集钩子]\n▲门后有人敲了三下。'
  const report = evidence(text)
  expect(report.episodes).toHaveLength(2)
  expect(report.episodes[0]?.ending).toMatchObject({ marker_status: 'present',
    hook_markers: { findings: [{ line: 4, quote: '【集尾钩子】甲的手机亮起。', marker: '集尾钩子', inline_content: '甲的手机亮起。' }] },
    following_last_marker: { findings: [{ line: 5, quote: '甲：怎么会是他？' }] } })
  expect(report.episodes[1]?.ending.hook_markers.findings[0]?.marker).toBe('下集钩子')
  expect(text).not.toContain('提前出现的新事实')
})

it('does not mistake a character mentioning the marker or source prose for a structural hook heading', () => {
  const report = evidence('第1集\n1-1 家 日 内\n甲：你写的【下集钩子】呢？\n这里讨论下集钩子：不是剧本标识。\n▲甲合上纸稿。')
  expect(report.episodes[0]?.ending.marker_status).toBe('not_found')
})

it('accepts a plain Markdown hook heading and keeps an empty heading distinct from actual suspense', () => {
  const report = evidence('第1集\n1-1 家 日 内\n▲甲关门。\n## 下集钩子')
  expect(report.episodes[0]?.ending).toMatchObject({ marker_status: 'present', marker_count: 1,
    following_last_marker: { findings: [], total: 0 }, suspense_assessment: 'not_performed' })
  expect(report.episodes[0]?.ending.hook_markers.findings[0]).toMatchObject({ quote: '## 下集钩子', inline_content: '' })
})

it('returns role endpoints rather than the whole last scene and counts omitted original lines', () => {
  const report = evidence('第1集\n1-1 家 日 内\n▲甲进门。\n甲（急促）：第一句。\n甲：第二句。\n乙：第三句。\n▲乙出门。\n乙：最后一句。')
  const ending = report.episodes[0]!.ending
  expect(ending.last_scene_lines).toMatchObject({ total: 6, omitted: 3 })
  expect(ending.last_scene_lines.findings.map(line => line.line)).toEqual([4, 7, 8])
  expect(ending.last_scene_lines.findings.some(line => line.quote === '甲：第二句。')).toBe(false)
})

it('keeps hook content in its own episode and never links neighboring material across scenes', () => {
  const report = evidence('第1集\n1-1 家 日 内\n甲（点头）：好。\n1-2 街道 夜 外\n▲乙跑过路口。\n【下集钩子】\n乙：站住！\n第2集\n2-1 街道 夜 外\n▲丙转身。')
  expect(report.episodes[0]?.action_locations.findings[0]?.adjacent_material).toEqual([])
  expect(report.episodes[0]?.ending.following_last_marker.findings.map(line => line.quote)).toEqual(['乙：站住！'])
  expect(report.episodes[1]?.ending.marker_status).toBe('not_found')
})

it('scopes changed action lines and episodes while preserving the affected episode ending', () => {
  const report = evidence('第1集\n1-1 家 日 内\n▲甲坐下。\n甲（低声）：旧话。\n【下集钩子】\n甲：新消息？\n第2集\n2-1 家 日 内\n▲乙起身。', 40, 200_000,
    new Map([['/draft.md', new Set([3])]]))
  expect(report.scope).toBe('changed_episodes_and_action_lines')
  expect(report.episodes).toHaveLength(1)
  expect(report.episodes[0]?.action_locations.findings.map(line => line.line)).toEqual([3])
  expect(report.episodes[0]?.ending.following_last_marker.findings[0]?.line).toBe(6)
})

it('retains explicitly affected episode endings for deletion-only changes without treating unchanged actions as changed', () => {
  const scenes = manuscriptScenes('第1集\n1-1 家 日 内\n▲甲坐下。\n甲：到此为止。\n第2集\n2-1 门外 日 外\n▲乙转身。\n乙（低声）：等等。')
    .map(scene => ({ ...scene, path: '/draft.md' }))
  const limits = { maximumFindings: 40, maxTextCharacters: 200_000 }, changedLines = new Map([['/draft.md', new Set<number>()]])
  expect(manuscriptPresentationEvidence(scenes, limits, changedLines).episodes).toEqual([])
  const report = manuscriptPresentationEvidence(scenes, limits, changedLines, new Map([['/draft.md', new Set(['1'])]]))
  expect(report.episodes.map(episode => episode.episode)).toEqual(['1'])
  expect(report.episodes[0]?.ending).toMatchObject({ marker_status: 'not_found', last_scene: { id: '1:1' },
    last_scene_lines: { findings: [{ line: 3, quote: '▲甲坐下。' }, { line: 4, quote: '甲：到此为止。' }] } })
  expect(report.episodes[0]?.action_locations).toMatchObject({ findings: [], total: 0, omitted: 0 })
  expect(report.episodes[0]?.adjacent_lines.findings).toEqual([])
  expect(report.scope).toBe('changed_episodes_and_action_lines')
})

it('combines explicit ending scope with actually changed episodes and respects each file path', () => {
  const scenes = ['/draft.md', '/other.md'].flatMap(path => manuscriptScenes('第1集\n1-1 家 日 内\n▲甲坐下。\n第2集\n2-1 门外 日 外\n乙（低声）：等等。')
    .map(scene => ({ ...scene, path })))
  const report = manuscriptPresentationEvidence(scenes, { maximumFindings: 40, maxTextCharacters: 200_000 },
    new Map([['/draft.md', new Set([6])]]), new Map([['/draft.md', new Set(['1'])]]))
  expect(report.episodes.map(({ path, episode }) => [path, episode])).toEqual([['/draft.md', '1'], ['/draft.md', '2']])
  expect(report.episodes[0]?.action_locations.findings).toEqual([])
  expect(report.episodes[1]?.action_locations.findings).toMatchObject([{ line: 6, quote: '乙（低声）：等等。' }])
})

it('accounts for shared quote budget and count overflow without cutting an original quote', () => {
  const report = evidence('第1集\n1-1 家 日 内\n▲甲坐下。\n甲（低声）：旧话。\n【下集钩子】\n甲：新消息？\n第2集\n2-1 家 日 内\n▲乙起身。', 1, 6)
  expect(report.omitted_episodes).toBe(1)
  expect(report.quote_characters).toBeLessThanOrEqual(6)
  expect(report.truncated).toBe(true)
  expect(report.episodes[0]?.ending.last_scene_lines.omitted).toBeGreaterThan(0)
  expect(report.episodes[0]?.ending.hook_markers).toMatchObject({ findings: [], total: 1, omitted: 1 })
  const quotes = report.episodes.flatMap(episode => [...episode.ending.last_scene_lines.findings,
    ...episode.ending.hook_markers.findings, ...episode.ending.following_last_marker.findings, ...episode.action_locations.findings])
  expect(quotes.every(line => ['▲甲坐下。', '甲（低声）：旧话。', '甲：新消息？'].includes(line.quote))).toBe(true)
})

it('keeps identical episode labels from different files independent', () => {
  const scenes = ['/first.md', '/second.md'].flatMap(path => manuscriptScenes('第1集\n1-1 家 日 内\n甲：到此为止。')
    .map(scene => ({ ...scene, path })))
  const report = manuscriptPresentationEvidence(scenes, { maximumFindings: 40, maxTextCharacters: 200_000 })
  expect(report.episodes.map(episode => episode.path)).toEqual(['/first.md', '/second.md'])
})

it('distinguishes faithful transcription from adaptation and grants no adaptation permission by default', () => {
  expect(manuscriptFormatReference('transcribe').source_scope).toContain('不提前搬入下一集')
  expect(manuscriptFormatReference('transcribe').source_scope).toContain('不强编悬念')
  expect(manuscriptFormatReference('adapt').source_scope).toContain('用户已授权')
  expect(manuscriptFormatReference('unknown').source_scope).toContain('不构成新增事实或改动结尾的授权')
  expect(manuscriptFormatReference('edit').source_scope).toBe(manuscriptFormatReference().source_scope)
})
