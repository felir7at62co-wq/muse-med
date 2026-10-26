/** Production prompts retain physical action stages and declared continuity between packages. */
import { describe, expect, it } from 'vitest'
import { packEpisode } from '../src/episode.ts'
import { parseShotScript } from '../src/script.ts'
import { actionShot, scriptOf } from './harness.ts'
import type { CompiledShot } from '../src/types.ts'

const stages = ['动作起点：人物站在地面，板凳在手边', '接触与支撑：摆稳板凳后双脚依次踏上凳面', '动作落点：双脚站稳，手扶横梁']
const state = (value: string): string => `连续性状态：肉条A｜横梁左一挂点｜${value}｜1`
const shot = (number: number, rows: string[] = []): string => actionShot(number, ['核心场景：灶房', ...rows])
const parse = (source: string) => parseShotScript(source, { actionShotSeconds: 2 })

describe('first-pass physical performance', () => {
  it('requires a scene only when continuity state or a change is declared', () => {
    expect(parse(actionShot(1)).issues).not.toContainEqual(expect.objectContaining({ code: 'continuity_declaration_invalid' }))
    for (const field of [state('完整'), '连续性变化：肉条A｜原文切肉']) {
      expect(parse(actionShot(1, [field])).issues)
        .toContainEqual(expect.objectContaining({ code: 'continuity_declaration_invalid', severity: 'failure' }))
    }
  })

  it('preserves action stages in the submitted visual rather than only in budget metadata', () => {
    const result = parse(shot(1, [...stages, '动作复杂度：较复杂', '动作预算：7秒', '发声预算：0秒', '反应预算：1秒', '表演顺序：同时']))
    expect(result.issues).toEqual([])
    expect(result.shots[0]?.durationSeconds).toBe(8)
    for (const stage of stages) expect(result.shots[0]?.visual).toContain(stage)
  })

  it.each([
    stages.slice(0, 2), [...stages, stages[0]!], ['动作起点：待补', ...stages.slice(1)], ['动作起点：', ...stages.slice(1)],
  ].map(fields => ({ fields })))('rejects incomplete or ambiguous action declarations: $fields', ({ fields }) => {
    expect(parse(shot(1, fields)).issues).toContainEqual(expect.objectContaining({ code: 'action_stages_invalid', severity: 'failure' }))
  })

  it('flags complex auto-estimated actions without rejecting existing scripts or inventing performance time', () => {
    const result = parse(shot(1, ['动作复杂度：复杂']))
    expect(result.issues.map(issue => issue.code)).toEqual(['action_stages_missing', 'performance_budget_missing'])
    expect(result.issues.every(issue => issue.severity === 'warning')).toBe(true)
    expect(result.shots[0]?.durationSeconds).toBe(4)
  })

  it('does not demand action stages for a simple reaction or camera-only movement', () => {
    expect(parse(shot(1)).issues).toEqual([])
  })
})

describe('declared scene continuity', () => {
  it('flags a meat-state reset even when an intervening close-up omits the object', () => {
    const result = parse(scriptOf(shot(1, [state('薄皮和骨头')]), shot(2), shot(3, [state('完整厚肉')])))
    expect(result.issues).toEqual([expect.objectContaining({ code: 'continuity_change_unexplained', shot: 3, severity: 'warning' })])
  })

  it('tracks character position and prop quantity without interpreting counts as whole-scene totals', () => {
    const result = parse(scriptOf(shot(1, [state('完整厚肉'), '连续性状态：人物甲｜灶台左侧｜站立｜1']),
      shot(2, [state('完整厚肉'), '连续性状态：人物甲｜门口｜站立｜0'])))
    expect(result.issues.filter(issue => issue.code === 'continuity_change_unexplained')).toHaveLength(1)
    expect(result.issues[0]?.message).toContain('人物甲')
  })

  it('allows a source-backed change while retaining its explanation for generation', () => {
    const change = '连续性变化：肉条A｜原文第8行，人物切肉吃掉一部分'
    const result = parse(scriptOf(shot(1, [state('完整厚肉')]), shot(2, [state('薄皮和骨头'), change])))
    expect(result.issues).toEqual([])
    expect(result.shots[1]?.visual).toContain(change)
  })

  it('isolates explicit source scenes and retains state on returning to an earlier one', () => {
    const result = parse(scriptOf(shot(1, ['连续性场次：15-1', state('完整厚肉')]),
      shot(2, ['连续性场次：15-3', state('薄皮和骨头')]), shot(3, ['连续性场次：15-1', state('完整厚肉')])))
    expect(result.issues).toEqual([])
  })

  it('inherits a declared period when subsequent same-scene close-ups omit it', () => {
    const result = parse(scriptOf(shot(1, ['连续性场次：15-3', state('薄皮')]), shot(2), shot(3, [state('完整')])))
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'continuity_change_unexplained', shot: 3 }))
  })

  it('keeps Latin object names and tab-prefixed declarations intact', () => {
    const result = parse(scriptOf(shot(1, ['连续性状态：\ttargetA｜横梁｜完整｜1']),
      shot(2, ['连续性状态：targetA｜横梁｜薄皮｜1'])))
    expect(result.issues.map(issue => issue.code)).toEqual(['continuity_change_unexplained'])
    expect(result.issues[0]?.message).toContain('targetA')
  })

  it.each([
    ['连续性状态：肉条A｜横梁｜完整｜-1'],
    ['连续性状态：肉条A｜横梁｜完整｜9007199254740992'],
    ['连续性状态：肉条A｜横梁｜完整'],
    [state('完整'), state('薄皮')],
    ['连续性变化：肉条A｜原文切肉'],
    [state('薄皮'), '连续性变化：肉条A｜待补'],
    ['连续性场次：15-1', '连续性场次：15-3'],
  ].map(fields => ({ fields })))('rejects malformed or unmatched continuity declarations: $fields', ({ fields }) => {
    expect(parse(shot(1, fields)).issues).toContainEqual(expect.objectContaining({ code: 'continuity_declaration_invalid', severity: 'failure' }))
  })

  it.each(['strict', 'advisory'] as const)('carries prior same-scene state into the next %s package', (reviewMode) => {
    const parsed = parse(scriptOf(shot(1, [state('薄皮和骨头'), '子任务边界：是']), shot(2)))
    const compiled: CompiledShot[] = parsed.shots.map(item => ({ shot: item, characters: [], scene: '灶房', props: [], assets: [], start: 0, end: item.durationSeconds }))
    const packages = packEpisode(compiled, 9, { reviewMode })
    expect(packages).toHaveLength(2)
    expect(packages[1]?.prompt).toContain('对象肉条A：位置=横梁左一挂点；状态=薄皮和骨头；数量=1。')
    expect(packages[1]?.prompt).not.toContain('完整厚肉')
    expect(packages[0]?.prompt).not.toContain('本包动作开始前')
  })

  it.each(['strict', 'advisory'] as const)('separates same-location day and night periods in %s packing', (reviewMode) => {
    const parsed = parse(scriptOf(shot(1, ['连续性场次：15-1', state('完整')]),
      shot(2, ['连续性场次：15-3', state('薄皮')]), shot(3, [state('薄皮')])))
    const compiled: CompiledShot[] = parsed.shots.map(item => ({ shot: item, characters: [], scene: '灶房', props: [], assets: [], start: 0, end: item.durationSeconds }))
    const packages = packEpisode(compiled, 29, { reviewMode })
    expect(packages.map(item => item.shots)).toEqual([[1], [2, 3]])
    expect(packages[1]?.prompt).not.toContain('状态=完整')
  })
})
