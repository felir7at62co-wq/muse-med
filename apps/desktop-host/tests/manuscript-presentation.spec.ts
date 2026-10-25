/** Screenplay presentation evidence preserves literal positions without adding creative decisions. */
import { expect, it } from 'vitest'
import { manuscriptEndingCue, manuscriptFormatReference, manuscriptPresentationEvidence } from '../src/manuscript-presentation.ts'
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
  expect(manuscriptFormatReference('unknown').source_scope).toContain('不授权新增或改写原片事实')
  expect(manuscriptFormatReference('edit').source_scope).toBe(manuscriptFormatReference().source_scope)
  expect(manuscriptFormatReference().ending).toContain('只是格式标注，不改变剧情')
  expect(manuscriptFormatReference().ending).toContain('完全收束或大结局不强编悬念')
})

it('places the actual missing marker, final quotes and distinct source times before the existing format reference', () => {
  const current = evidence('第8集\n8-1 餐厅 日 内\n贺景川：妈，你非要这么咄咄逼人吗？\n▲乔静仪转眼看向他们，露出笑意。')
  const cue = manuscriptEndingCue(current, [{ episode: '8', last_asr: {
    text: '妈，你非要这么咄咄逼人吗？', start_seconds: 53.489, end_seconds: 55.009 },
  frames: [{ frame_id: 'F-56', time: 56.5 }, { frame_id: 'F-55', time: 55.5 }] }],
  { maximumFindings: 40, maxTextCharacters: 200_000 }, 'transcribe')
  expect(cue.split('\n')[0]).toBe('第8集当前结尾：未找到【下集钩子】标识（只记结构，不判悬念质量）。')
  expect(cue).toContain('末动作第4行「▲乔静仪转眼看向他们，露出笑意。」')
  expect(cue).toContain('末对白第3行「贺景川：妈，你非要这么咄咄逼人吗？」')
  expect(cue).toContain('来源最后已有ASR（53.489—55.009秒）：「妈，你非要这么咄咄逼人吗？」')
  expect(cue).toContain('末图引用56.5秒/F-56，两者不作同步认定')
  expect(cue.indexOf('当前稿原句')).toBeLessThan(cue.indexOf('标注参考'))
  expect(cue).toContain(manuscriptFormatReference('transcribe').ending)
  expect(cue).toContain(manuscriptFormatReference('transcribe').action_line)
  expect(cue).toContain(manuscriptFormatReference('transcribe').parenthetical)
  expect(cue).toContain(manuscriptFormatReference('transcribe').source_scope)
})

it('acknowledges an existing marker without claiming its suspense succeeded or asking for another copy', () => {
  const cue = manuscriptEndingCue(evidence('第1集\n1-1 门外 夜 外\n【下集钩子】\n▲门后响起三声敲门。'),
    [{ episode: '1', last_asr: null }], { maximumFindings: 40, maxTextCharacters: 200_000 })
  expect(cue).toContain('已有钩子标识1处（只记结构，不判悬念质量）')
  expect(cue).not.toContain('未找到【下集钩子】')
  expect(cue).toContain('不另抄一遍末段')
  expect(cue).toContain('没有可用末句')
})

it('keeps a closed source ending conditional and does not turn missing ASR into certified silence', () => {
  const cue = manuscriptEndingCue(evidence('第1集\n1-1 家 日 内\n▲两人并肩走远。\n【全剧终】'),
    [{ episode: '1', last_asr: null, frames: [{ frame_id: 'last', time: 90 }] }],
    { maximumFindings: 40, maxTextCharacters: 200_000 }, 'transcribe')
  expect(cue).toContain('原片完全收束或大结局时如实保留，不强编悬念')
  expect(cue).toContain('来源最后已有ASR：没有可用末句')
  expect(cue).toContain('不代表无声或台词同步')
  expect(cue).not.toContain('原片结尾没有台词')
  expect(cue).not.toContain('必须补')
})

it('keeps source ambiguity and a missing source distinct without granting adaptation permission', () => {
  const current = evidence('第1集\n1-1 家 日 内\n甲：结束。')
  const limits = { maximumFindings: 40, maxTextCharacters: 200_000 }
  const ambiguous = manuscriptEndingCue(current, [{ episode: '1', last_asr: null }, { episode: '1', last_asr: null }], limits)
  expect(ambiguous).toContain('来源末段有2份候选，未选择唯一来源')
  expect(ambiguous).toContain('格式整理不授权新增或改写原片事实')
  expect(manuscriptEndingCue(current, [], limits)).toContain('没有可用候选，未推定原片结尾')
  expect(manuscriptEndingCue(current, [{ episode: '1', draft_path: '/other.md', last_asr: null }], limits))
    .toContain('没有可用候选')
})

it('omits whole oversized quotes with literal line references instead of returning a falsely complete excerpt', () => {
  const longQuote = '甲：' + '这是不能被伪装成完整短句的原话。'.repeat(100)
  const current = evidence('第1集\n1-1 家 日 内\n' + longQuote)
  const cue = manuscriptEndingCue(current, [{ episode: '1', last_asr: {
    text: longQuote, start_seconds: 1, end_seconds: 9 } }], { maximumFindings: 40, maxTextCharacters: 180 })
  expect(cue.length).toBeLessThanOrEqual(180)
  expect(cue).toContain('末对白第3行（原句因预算省略）')
  expect(cue).toContain('部分材料因预算省略')
  expect(cue).not.toContain('这是不能被伪装')
  expect(manuscriptEndingCue(current, [], { maximumFindings: 40, maxTextCharacters: 1 })).toBe('…')
})

it('bounds episode entries and names omitted episodes without cross-file source selection', () => {
  const current = evidence('第1集\n1-1 家 日 内\n甲：一。\n第2集\n2-1 家 日 内\n乙：二。')
  const cue = manuscriptEndingCue(current, [{ episode: '1', draft_path: '/draft.md', last_asr: {
    text: '一。', start_seconds: 1, end_seconds: 2 } }], { maximumFindings: 1, maxTextCharacters: 200_000 }, 'adapt')
  expect(cue).toContain('第1集当前结尾')
  expect(cue).not.toContain('第2集当前结尾')
  expect(cue).toContain('另有1集因条目预算未列')
  expect(cue).toContain(manuscriptFormatReference('adapt').source_scope)
})

it('keeps the real ending positions when a shared quote budget omits the final dialogue', () => {
  const text = '第1集\n1-1 家 日 内\n▲' + '甲'.repeat(280)
    + '\n第2集\n2-1 家 日 内\n甲（低声）：前一句。\n▲甲走到门口。\n甲：' + '真末句'.repeat(200)
  const limits = { maximumFindings: 40, maxTextCharacters: 1000 }
  expect(text.length).toBeLessThan(limits.maxTextCharacters)
  const current = manuscriptPresentationEvidence(manuscriptScenes(text).map(scene => ({ ...scene, path: '/draft.md' })), limits)
  const ending = current.episodes[1]!.ending
  expect(ending.last_material_locations).toEqual({ action: { scene: '2:1', line: 7 },
    dialogue: { scene: '2:1', line: 8 }, parenthetical: { scene: '2:1', line: 6 } })
  expect(ending.last_scene_lines.budget_omitted).toBe(1)
  expect(ending.last_scene_lines.findings.map(line => line.line)).toEqual([6, 7])
  const cue = manuscriptEndingCue(current, [], limits)
  expect(cue).toContain('末动作第7行「▲甲走到门口。」')
  expect(cue).toContain('末对白第8行（原句因预算省略）')
  expect(cue).not.toContain('末对白第6行')
  expect(cue).not.toContain('「甲：真末句')
  expect(cue.length).toBeLessThanOrEqual(limits.maxTextCharacters)
})

it('distinguishes absent action or dialogue endpoints from budget omissions', () => {
  const limits = { maximumFindings: 40, maxTextCharacters: 1000 }
  const actionOnly = evidence('第1集\n1-1 家 日 内\n▲甲走远。')
  expect(actionOnly.episodes[0]?.ending.last_material_locations).toEqual({ action: { scene: '1:1', line: 3 },
    dialogue: null, parenthetical: null })
  expect(manuscriptEndingCue(actionOnly, [], limits)).toContain('末动作第3行「▲甲走远。」')
  expect(manuscriptEndingCue(actionOnly, [], limits)).not.toContain('末对白')
  const dialogueOnly = evidence('第1集\n1-1 家 日 内\n甲（低声）：前一句。\n甲：最后一句。')
  expect(dialogueOnly.episodes[0]?.ending.last_material_locations).toEqual({ action: null,
    dialogue: { scene: '1:1', line: 4 }, parenthetical: { scene: '1:1', line: 3 } })
  expect(manuscriptEndingCue(dialogueOnly, [], limits)).toContain('末对白第4行「甲：最后一句。」')
  expect(manuscriptEndingCue(dialogueOnly, [], limits)).not.toContain('末动作')
  const headingOnly = evidence('第1集\n1-1 家 日 内\n人物：甲')
  expect(headingOnly.episodes[0]?.ending.last_material_locations).toEqual({ action: null, dialogue: null, parenthetical: null })
  expect(manuscriptEndingCue(headingOnly, [], limits)).toContain('没有返回可识别的动作或对白原句')
})
