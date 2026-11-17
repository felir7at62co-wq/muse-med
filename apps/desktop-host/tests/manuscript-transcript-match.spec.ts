/** Literal transcript matching folds numerals, keeps homophones apart and aligns draft lines with ordered source text. */
import { expect, it } from 'vitest'
import { alignTranscript, classifyScreenplayLine, editDistance, normalizeTranscriptText, orderMatchedUnits, substitutionHunks,
  unmarkedFragments, type TranscriptAlignment } from '../src/manuscript-transcript-match.ts'

const signal = new AbortController().signal
const comparable = (text: string) => normalizeTranscriptText(text).chars.join('')

function align(units: readonly string[], lines: readonly string[], maxEditLength = 20_000): TranscriptAlignment {
  const result = alignTranscript(units.map(normalizeTranscriptText), lines.map(normalizeTranscriptText), 0.6, maxEditLength, signal)
  if (result === 'edit_limit') throw Error('The alignment unexpectedly exceeded its edit budget')
  return result
}

it.each([
  ['两万四', '2万4', '24000'],
  ['八十六万', '86万', '860000'],
  ['一千零五', '1005', '1005'],
  ['十二', '12', '12'],
  ['一百四十', '140', '140'],
])('folds %s and %s to one numeral value', (chinese, mixed, value) => {
  expect(comparable(chinese)).toBe(value)
  expect(comparable(mixed)).toBe(value)
})

it('keeps different numbers and homophones apart while ignoring punctuation, whitespace and width', () => {
  expect(comparable('三十')).not.toBe(comparable('三百'))
  expect(comparable('江老板')).not.toBe(comparable('姜老板'))
  expect(comparable('甲， 你好！')).toBe(comparable('甲你好'))
  expect(comparable('ＡＢ１２')).toBe('ab12')
})

it('quotes original text through each character span, including a folded numeral run', () => {
  const text = normalizeTranscriptText('欠我两万四，快还！')
  expect(text.chars.join('')).toBe('欠我24000快还')
  expect(unmarkedFragments(text, text.chars.map((_char, index) => index < 2), 1)).toEqual(['两万四，快还'])
})

it.each([
  ['第1集', 'episode_heading'],
  ['## 第十二集', 'episode_heading'],
  ['1-1 茶楼 日 内', 'scene_heading'],
  ['出场人物：甲、乙', 'metadata'],
  ['▲甲推门进来。', 'action'],
  ['【下集钩子】', 'hook'],
  ['【字幕】三天后', 'marker'],
  ['', 'blank'],
  ['……', 'other'],
  ['乙：（沉默）', 'other'],
])('classifies %s as %s', (line, kind) => {
  expect(classifyScreenplayLine(line).kind).toBe(kind)
})

it('reads the speaker and the speech without parentheticals or emphasis markers', () => {
  expect(classifyScreenplayLine('甲（OS）：（低声）我在这儿。')).toEqual({ kind: 'dialogue', speaker: '甲', speech: '我在这儿。' })
  expect(classifyScreenplayLine('**乙**：走吧')).toEqual({ kind: 'dialogue', speaker: '乙', speech: '走吧' })
})

it('leaves an invented line unmatched while the real line beside it matches', () => {
  const result = align(['妈妈，我的灯笼呢？'], ['妈妈。', '妈妈，我的灯笼呢？'])
  expect(result.lineMatched).toEqual([false, true])
  expect(result.unitMatched).toEqual([true])
})

it('matches one segment split across two lines and two segments merged into one line', () => {
  expect(align(['我今天去了东桥菜场买了三斤排骨'], ['我今天去了东桥菜场', '买了三斤排骨'])).toMatchObject({
    unitMatched: [true], lineMatched: [true, true] })
  expect(align(['你等着', '我马上回来'], ['你等着，我马上回来'])).toMatchObject({ unitMatched: [true, true], lineMatched: [true] })
})

it('still matches a line with a one-character correction', () => {
  expect(align(['那货标签贴歪了'], ['那盒标签贴歪了'])).toMatchObject({ unitMatched: [true], lineMatched: [true] })
})

it('does not link unrelated text through scattered single shared characters', () => {
  const result = align(['我们明天去看海'], ['你们后天在家等'])
  expect(result).toMatchObject({ unitMatched: [false], lineMatched: [false] })
  expect(result.links[0]?.size).toBe(0)
})

it('aligns sparse on-screen text whose characters are scattered through earlier lines with the line that contains it', () => {
  const lines = ['你先坐下喝口水', '这事情不急一时', '是我考虑得不好', '为了这个家里', '难得今天清闲', '老周刚才来过了', '周末再去一趟吧',
    '吗啡这种药不能乱用', '爸，你这不是为难老周吗？他也不容易。']
  const result = align(['哥你这不是为难老周吗'], lines)
  expect(result.unitMatched).toEqual([true])
  expect(result.links[8]?.get(0)).toBe(9)
  expect(orderMatchedUnits(result).placement.get(0)).toBe(8)
})

it('reports an alignment beyond the edit budget and observes cancellation', () => {
  expect(alignTranscript([normalizeTranscriptText('甲乙丙丁')], [normalizeTranscriptText('戊己庚辛')], 0.6, 1, signal)).toBe('edit_limit')
  const controller = new AbortController(), reason = Error('cancel alignment')
  controller.abort(reason)
  expect(() => alignTranscript([normalizeTranscriptText('甲乙')], [normalizeTranscriptText('甲乙')], 0.6, 100, controller.signal))
    .toThrow(reason)
})

it('reports exactly one unit of a swapped pair as out of order', () => {
  const order = orderMatchedUnits(align(['甲乙丙丁', '戊己庚辛', '子丑寅卯'], ['甲乙丙丁', '子丑寅卯', '戊己庚辛']))
  expect(order.inOrder).toHaveLength(2)
  expect(order.outOfOrder).toHaveLength(1)
  expect([...order.placement.entries()].sort()).toEqual([[0, 0], [1, 2], [2, 1]])
})

it('quotes unaligned stretches of at least the minimum length only', () => {
  const text = normalizeTranscriptText('我今天去东桥菜场买排骨，还买了三斤鱼')
  const marks = text.chars.map((_char, index) => index < 8 || (index >= 11 && index < 13))
  expect(unmarkedFragments(text, marks, 4)).toEqual(['了三斤鱼'])
})

it('reports a substituted character against on-screen text but no pure insertion', () => {
  expect(substitutionHunks([normalizeTranscriptText('东桥菜场到了')], normalizeTranscriptText('冬桥菜场到了'), 100))
    .toEqual([{ draft: '冬', on_screen: '东', unit: 0 }])
  expect(substitutionHunks([normalizeTranscriptText('东桥菜场')], normalizeTranscriptText('东桥菜场到了'), 100)).toEqual([])
})

it('measures edit distance over code points', () => {
  expect(editDistance('邵小明', '周小明')).toBe(1)
  expect(editDistance('小明', '邵小明')).toBe(1)
  expect(editDistance('🌧ab', '')).toBe(3)
})
