/** Ordered physical directions require preparation even when the author omits complexity. */
import { describe, expect, it } from 'vitest'
import { parseShotScript } from '../src/script.ts'
import { actionShot } from './harness.ts'

const parse = (fields: string[]) => parseShotScript(actionShot(1, fields), { actionShotSeconds: 2 })
const preparation = (fields: string[]) => parse(fields).issues.filter(row =>
  ['action_stages_missing', 'performance_budget_missing'].includes(row.code))

describe('ordered physical action preparation', () => {
  it('surfaces a sequence hidden in action state without requiring an authored complexity label', () => {
    const fields = ['动作状态：【先朝锅口示意，再比一指高度，最后从灶膛抽柴放到一边】；',
      '手部状态：【右手指锅、左手比划水面高度】，【无】；']
    const result = parse(fields)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'action_stages_missing', severity: 'warning' }))
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'performance_budget_missing', severity: 'warning' }))
    expect(result.shots[0]?.visual).toContain(fields[0])
    expect(result.shots[0]?.durationSeconds).toBe(2)
  })

  it.each(['再', '然后', '随后', '接着', '最后'])('recognizes %s as an authored later phase', (later) => {
    expect(preparation([`动作状态：【先把杯子放稳，${later}接住钥匙】；`])).toHaveLength(2)
  })

  it('does not convert spoken plans, generic directions or an earlier-state mention into physical actions', () => {
    for (const fields of [
      ['动作状态：【指着锅讲解】；', '台词：甲：先冒足汽，再抽粗柴。', '发声类型：dialogue'],
      ['运镜：先推近再横移', '动作状态：【保持站立】；'],
      ['动作状态：【先前拿着杯子，现在右手空着】；'],
      ['动作状态：【先前拿着杯子，随后一直保持原姿态】；'],
      ['动作状态：【先生再次抬手】；'],
      ['动作状态：【手捏着花朵，目光望向远处】；'],
    ]) expect(preparation(fields)).toEqual([])
  })

  it('accepts source-backed phases and a declared budget without rewriting the sequence', () => {
    const fields = ['动作状态：【先放杯，再接钥匙】；', '时长：6秒',
      '动作起点：左手提箱，右手端杯，乙握着钥匙',
      '接触与支撑：右手放稳杯后接钥匙，乙待甲握稳才松手',
      '动作落点：杯在门边台面，甲右手持钥匙、左手提箱']
    expect(preparation(fields)).toEqual([])
    expect(parse(fields).shots[0]?.durationSeconds).toBe(6)
  })

  it('retains stage review when only time was declared and time review when only stages were declared', () => {
    const fields = ['动作状态：【先放杯，再接钥匙】；']
    expect(preparation([...fields, '时长：6秒']).map(row => row.code)).toEqual(['action_stages_missing'])
    expect(preparation([...fields, '动作起点：右手端杯', '接触与支撑：放杯后接物', '动作落点：右手拿钥匙'])
      .map(row => row.code)).toEqual(['performance_budget_missing'])
  })
})
