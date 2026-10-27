/** Explicit performance budgets preserve sequential work before episode packing. */
import { describe, expect, it } from 'vitest'
import { parseShotScript } from '../src/script.ts'
import { actionShot, speakingShot } from './harness.ts'

const BUDGET = ['动作预算：6秒', '发声预算：3秒', '反应预算：2秒']

describe('declared performance timing', () => {
  it.each([
    ['同时', 8], ['先动作后台词', 11], ['先台词后动作', 11],
  ])('calculates %s without compressing action to the speech estimate', (order, seconds) => {
    const result = parseShotScript(speakingShot(1, '苏晚：等我回来。', [...BUDGET, `表演顺序：${order}`]),
      { actionShotSeconds: 2, speechCharsPerSecond: 5 })
    expect(result.issues).toEqual([])
    expect(result.shots[0]).toMatchObject({ durationSeconds: seconds, durationSource: 'declared', text: '等我回来。' })
    expect(result.shots[0]?.visual).not.toMatch(/(?:动作预算|发声预算|反应预算|表演顺序)：/)
  })

  it('budgets silent movement and its reaction without adding a speech second', () => {
    const result = parseShotScript(actionShot(1, [
      '动作预算：8秒', '发声预算：0秒', '反应预算：1秒', '表演顺序：同时',
    ]), { actionShotSeconds: 2 })
    expect(result.issues).toEqual([])
    expect(result.shots[0]?.durationSeconds).toBe(9)
  })

  it.each([
    { fields: ['动作预算：0秒', '发声预算：0秒', '反应预算：0秒', '表演顺序：同时'] },
    { fields: ['动作预算：1秒', '发声预算：1秒', '反应预算：0秒', '表演顺序：同时'] },
  ])('refuses silent plans with no performance time or invented speech: $fields', ({ fields }) => {
    const result = parseShotScript(actionShot(1, fields), { actionShotSeconds: 2 })
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'timing_plan_invalid' }))
  })

  it.each([
    ['missing field', [...BUDGET]],
    ['duplicate field', [...BUDGET, '动作预算：1秒', '表演顺序：同时']],
    ['unknown order', [...BUDGET, '表演顺序：快速完成']],
    ['fraction', ['动作预算：1.5秒', '发声预算：3秒', '反应预算：0秒', '表演顺序：同时']],
    ['negative', ['动作预算：-1秒', '发声预算：3秒', '反应预算：0秒', '表演顺序：同时']],
    ['silent speech', ['动作预算：1秒', '发声预算：0秒', '反应预算：0秒', '表演顺序：同时']],
    ['unsafe sum', ['动作预算：9007199254740991秒', '发声预算：3秒', '反应预算：0秒', '表演顺序：先动作后台词']],
  ])('reports an invalid %s without accepting an incomplete timing plan', (_label, fields) => {
    const result = parseShotScript(speakingShot(1, '苏晚：等我回来。', fields), { actionShotSeconds: 2 })
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'timing_plan_invalid', severity: 'failure' }))
  })

  it('rejects declared time below the authored arithmetic, rather than below a heuristic', () => {
    const result = parseShotScript(speakingShot(1, '苏晚：等我回来。', [
      ...BUDGET, '表演顺序：先动作后台词', '时长：4秒',
    ]), { actionShotSeconds: 2 })
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'timing_plan_exceeds_duration', severity: 'failure' }))
    expect(result.shots[0]?.durationSeconds).toBe(4)
  })

  it('retains longer declared duration and ordinary prose second warnings', () => {
    const result = parseShotScript(speakingShot(1, '苏晚：等我3秒。', [
      ...BUDGET, '表演顺序：同时', '时长：10秒',
    ]), { actionShotSeconds: 2 })
    expect(result.issues.map(issue => issue.code)).toEqual(['seconds_in_shot_body', 'legacy_duration_mismatch'])
    expect(result.shots[0]?.durationSeconds).toBe(10)
  })

  it('keeps diagnostic line numbers when metadata precedes actual dialogue seconds', () => {
    const text = speakingShot(1, '苏晚：等我3秒。').replace('景别：近景', [...BUDGET, '表演顺序：同时', '景别：近景'].join('\n'))
    const result = parseShotScript(text, { actionShotSeconds: 2 })
    expect(result.issues.find(issue => issue.code === 'seconds_in_shot_body')?.line)
      .toBe(text.split('\n').findIndex(line => line.startsWith('台词：')) + 1)
  })
})
