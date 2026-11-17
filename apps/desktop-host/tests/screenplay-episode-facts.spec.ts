/** Literal per-episode structure facts and screenplay-format violations of video-sourced screenplays. */
import { expect, it } from 'vitest'
import { screenplayFacts } from '../src/screenplay-episode-facts.ts'

const limits = { formatDominantSpeakerMinLines: 4, formatDominantSpeakerShare: 0.9, formatRepeatedSceneEpisodes: 3, formatMaxMessages: 20 }
const valid = [
  '第1集', '1-1 街头古玩摊 日 外', '人物：林墨、刘老四、金蟾（VO）',
  '▲林墨蹲在摊前，盯着压报纸的铜蛤蟆。', '金蟾 VO：小伙子别走！', '林墨 OS：四百万的宝石。', '刘老四（眯眼）：小兄弟看上哪件了？',
  '【下集钩子】', '▲刘老四一把按住铜蛤蟆。',
  '', '第2集', '2-1 街头古玩摊 日 外', '人物：林墨、刘老四', '▲林墨指着铜蛤蟆。', '林墨：这个怎么卖？',
].join('\n')

it('counts scenes, actions, dialogue and speakers of a conforming screenplay without errors', () => {
  const facts = screenplayFacts(valid, limits)
  expect(facts.error_count).toBe(0)
  expect(facts.episodes.map(episode => [episode.episode, episode.scenes, episode.action_lines, episode.dialogue_lines]))
    .toEqual([[1, 1, 2, 3], [2, 1, 1, 1]])
  expect(facts.episodes[0]?.speakers).toEqual([{ name: '金蟾', lines: 1 }, { name: '林墨', lines: 1 }, { name: '刘老四', lines: 1 }])
})

it.each([
  ['a scene without a cast line', '第1集\n1-1 门口 日 外\n▲甲开门。\n甲：进来。', '下一行不是「人物：」行'],
  ['a placeholder speaker', '第1集\n1-1 门口 日 外\n人物：甲\n▲甲开门。\n某人：进来。', '是占位名'],
  ['a speaker outside the cast line', '第1集\n1-1 门口 日 外\n人物：甲\n▲甲开门。\n乙：进来。', '不在本场「人物：」行里'],
  ['an episode without action lines', '第1集\n1-1 门口 日 外\n人物：甲\n甲：进来。', '没有一行▲动作'],
  ['a bare trailing hook marker', '第1集\n1-1 门口 日 外\n人物：甲\n▲甲开门。\n【下集钩子】', '最后一行'],
  ['a scene heading without time and setting', '第1集\n1-1 门口\n人物：甲\n▲甲开门。', '缺少日/夜与内/外'],
  ['body before the first scene', '第1集\n▲甲开门。\n1-1 门口 日 外\n人物：甲\n▲甲进屋。', '正文出现在第1集第一个场次标题之前'],
  ['a document without episode headings', '1-1 门口 日 外\n人物：甲\n▲甲开门。', '没有可识别的「第N集」标题'],
  ['a scene number of another episode', '第1集\n2-1 门口 日 外\n人物：甲\n▲甲开门。', '场次集号2与第1集标题不一致'],
])('reports %s as a format error', (_name, text, message) => {
  const facts = screenplayFacts(text, limits)
  expect(facts.error_count).toBeGreaterThan(0)
  expect([...facts.errors, ...facts.episodes.flatMap(episode => episode.errors)].join('\n')).toContain(message)
})

it('keeps a hook marker followed by source content and non-cast labels such as subtitles', () => {
  const facts = screenplayFacts('第1集\n1-1 门口 夜 内\n人物：甲\n▲甲开门。\n字幕：三年后\n【下集钩子】甲：你回来了？', limits)
  expect(facts.error_count).toBe(0)
})

it('warns about a dominant speaker, repeated single-scene episodes, scenes without action and unclassified lines', () => {
  const episode = (number: number, extra = '') => `第${number}集\n${number}-1 街头古玩摊 日 外\n人物：林墨、刘老四\n▲林墨开口。\n`
    + '林墨：一。\n林墨：二。\n林墨：三。\n林墨：四。' + extra
  const text = [episode(1), episode(2), episode(3), episode(4, '\n4-2 店内 日 内\n人物：林墨\n林墨：五。\n这是一行散文。')].join('\n')
  const facts = screenplayFacts(text, limits)
  const warnings = [...facts.warnings, ...facts.episodes.flatMap(item => item.warnings)].join('\n')
  expect(facts.error_count).toBe(0)
  expect(warnings).toContain('第1–3集都只有一个场次「街头古玩摊 日 外」')
  expect(warnings).toContain('4句台词里有4句标为「林墨」')
  expect(warnings).toContain('场次「店内 日 内」没有▲动作行')
  expect(warnings).toContain('既不是▲动作行')
})

it('caps message texts while keeping exact counts', () => {
  const text = `第1集\n1-1 门口 日 外\n人物：甲\n▲甲开门。\n${Array.from({ length: 30 }, (_, index) => `乙${index}：话。`).join('\n')}`
  const facts = screenplayFacts(text, { ...limits, formatMaxMessages: 5 })
  expect(facts.episodes[0]?.error_count).toBe(30)
  expect(facts.episodes[0]?.errors).toHaveLength(5)
  expect(facts.error_count).toBe(30)
})
