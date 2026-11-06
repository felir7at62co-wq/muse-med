/** Literal △ navigation preserves complete reading lines and real title ownership without asserting events. */
import { expect, it } from 'vitest'
import { indexManuscriptSource, manuscriptSourceCitationLabels, manuscriptSourceCues,
  manuscriptSourceRangeContext } from '../src/manuscript-source-context.ts'

it('keeps full Unicode/CRLF cue lines and canonical citations within a scene and across episodes', () => {
  const lines = ['第七集', '7-1 日 内 门厅', '  △稍后😀，原稿提示不证明动作已完成。  ',
    '▲人物收起杯子。', '甲：对白里说△是标记。', '\t△布景说明：这里只是字面提示。',
    '7-2 夜 外 庭院', '△另一场的原句。', '第八集', '8-1 日 内 走廊', '　△下一段提示😀。']
  const text = lines.join('\r\n') + '\r\n', before = text
  const cues = manuscriptSourceCues(text), index = indexManuscriptSource(text)
  expect(cues).toEqual([3, 6, 8, 11].map(line => ({ line, text: lines[line - 1],
    citation_labels: manuscriptSourceCitationLabels(manuscriptSourceRangeContext(index, line, line)) })))
  expect(cues.map(cue => cue.citation_labels)).toEqual([
    [{ start_line: 3, end_line: 3, episode: '第七集', scene_id: '7-1', source_scene_id: 'source-scene-1' }],
    [{ start_line: 6, end_line: 6, episode: '第七集', scene_id: '7-1', source_scene_id: 'source-scene-1' }],
    [{ start_line: 8, end_line: 8, episode: '第七集', scene_id: '7-2', source_scene_id: 'source-scene-2' }],
    [{ start_line: 11, end_line: 11, episode: '第八集', scene_id: '8-1', source_scene_id: 'source-scene-3' }],
  ])
  expect(cues[0]?.text).toBe('  △稍后😀，原稿提示不证明动作已完成。  ')
  expect(text).toBe(before)
})

it('retains unassigned cues and episode-only bodies without guessing a scene', () => {
  const text = '△未分集的提示。\n普通文字。\n第九集\n△只有集标题的提示。'
  expect(manuscriptSourceCues(text)).toEqual([
    { line: 1, text: '△未分集的提示。', citation_labels: [
      { start_line: 1, end_line: 1, episode: 'unassigned', scene_id: null, source_scene_id: null },
    ] },
    { line: 4, text: '△只有集标题的提示。', citation_labels: [
      { start_line: 4, end_line: 4, episode: '第九集', scene_id: null, source_scene_id: null },
    ] },
  ])
})

it('does not collect ▲ actions, dialogue mentions, quoted markers or non-prefix occurrences', () => {
  const text = ['▲△不是行首提示。', '甲：△这段是对白。', '甲OS：文中有△标记。',
    '“△引号内文字。”', '普通文字△稍后。', '  ▲另一条动作。', '  ', '△'].join('\n')
  expect(manuscriptSourceCues(text)).toEqual([{ line: 8, text: '△', citation_labels: [
    { start_line: 8, end_line: 8, episode: 'unassigned', scene_id: null, source_scene_id: null },
  ] }])
})

it.each(['', '普通原稿。\n甲：稍后再说。', '\r', '\r\n', '\t  '])('has no cues when the full source has no △ prefix: %j', (text) => {
  expect(manuscriptSourceCues(text)).toEqual([])
})

it('preserves long complete lines without truncation or semantic classification', () => {
  const original = ` \t△${'😀原句'.repeat(4000)}；这也可能只是计划或布景提示。 `
  const result = manuscriptSourceCues(original + '\r')
  expect(result).toEqual([{ line: 1, text: original, citation_labels: [
    { start_line: 1, end_line: 1, episode: 'unassigned', scene_id: null, source_scene_id: null },
  ] }])
  expect(Object.keys(result[0] ?? {})).toEqual(['line', 'text', 'citation_labels'])
})

it('keeps distinct source occurrences for repeated titles and does not turn cue mentions into headings', () => {
  const text = '第六集\n6-1 日 内 门厅\n△档案提到第十集，不能更换本行归属。\n第六集\n6-1 日 内 门厅\n△相同标题的新一处提示。'
  expect(manuscriptSourceCues(text).map(cue => cue.citation_labels)).toEqual([
    [{ start_line: 3, end_line: 3, episode: '第六集', scene_id: '6-1', source_scene_id: 'source-scene-1' }],
    [{ start_line: 6, end_line: 6, episode: '第六集', scene_id: '6-1', source_scene_id: 'source-scene-2' }],
  ])
})
