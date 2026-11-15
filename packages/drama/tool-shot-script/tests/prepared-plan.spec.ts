import { describe, expect, it } from 'vitest'
import { reviewPreparedPlan } from '../src/prepared-plan.ts'
import { parseShotScript } from '../src/script.ts'
import { actionShot, speakingShot } from './harness.ts'

const policy = { emptyShotMaxSeconds: 2, repetitiveShotThreshold: 3 }
const review = (prompt: string, overrides = {}) => reviewPreparedPlan(prompt,
  parseShotScript(prompt, { actionShotSeconds: 2, sourceScope: 'prepared_package' }).shots, { ...policy, ...overrides })
const codes = (prompt: string, overrides = {}) => review(prompt, overrides).issues.map(issue => issue.code)
const empty = (seconds = 3, extra: string[] = []) => actionShot(1,
  ['镜头类型：纯环境空镜', '空镜用途：交代院落位置', `时长：${seconds}秒`, ...extra])

describe('explicit prepared plan review', () => {
  it('retains supplied fields and original lines while leaving omitted declarations unknown', () => {
    const prompt = speakingShot(15, '苏晚：等我。', ['镜头类型：对话', '景别：近景', '主运镜：缓慢推进',
      '视线目标：画外门口', '情绪触发：听见门外脚步', '空镜用途：', '镜头设计依据：强调迟疑']).replace('景别：近景\n', '')
    const result = review(prompt), declared = result.declarations[0]
    expect(result.issues).toEqual([])
    expect(declared).toMatchObject({ shot: 15, fields: {
      镜头类型: { value: '对话' }, 景别: { value: '近景' }, 主运镜: { value: '缓慢推进' },
      视线目标: { value: '画外门口' }, 情绪触发: { value: '听见门外脚步' }, 空镜用途: { value: '' }, 眼部特效依据: null,
    } })
    expect(declared?.fields['视线目标']?.line).toBe(prompt.split('\n').indexOf('视线目标：画外门口') + 1)
  })

  it('does not choose between duplicate declarations or pretend a legacy omission is known', () => {
    const result = review(actionShot(1, ['主运镜：固定', '主运镜：推进']))
    expect(result.declarations[0]?.fields['主运镜']).toBeNull()
    expect(result.issues).toEqual([expect.objectContaining({ code: 'prepared_declaration_ambiguous', shot: 1 })])
    expect(review(actionShot(1)).declarations[0]?.fields['镜头类型']).toBeNull()
    expect(review('').declarations).toEqual([])
  })

  it('reads the skill bracket and trailing-semicolon notation without modifying the prompt', () => {
    const prompt = [1, 2, 3].map(number => actionShot(number,
      ['核心场景：后厨', '镜头类型：【纯环境空镜】；', '景别：【特写】；', '主运镜：【固定机位】;',
        '视线目标：【未知】；', '时长：3秒']).replace('景别：全景\n', '')).join('\n')
    const result = review(prompt)
    expect(result.declarations[0]?.fields['景别']?.value).toBe('特写')
    expect(result.declarations[0]?.fields['视线目标']?.value).toBe('未知')
    expect(result.issues.map(issue => issue.code)).toContain('prepared_repetitive_framing')
    expect(result.issues.map(issue => issue.code)).toContain('prepared_empty_shot_over_budget')
    expect(prompt).toContain('景别：【特写】；')
  })

  it('warns only for explicitly silent environment inserts above the configured content budget', () => {
    expect(codes(empty())).toContain('prepared_empty_shot_over_budget')
    expect(codes(empty().replace('纯环境空镜', '环境空镜'))).toContain('prepared_empty_shot_over_budget')
    expect(codes(empty(2))).toEqual([])
    expect(codes(empty(3), { emptyShotMaxSeconds: 3 })).toEqual([])
    expect(codes(empty(8, ['空镜超时依据：剧本：第一场明确要求长时间等待晨雾散去']))).toEqual([])
    expect(codes(empty(8, ['空镜超时依据：原文：第三行，静候天亮']))).toEqual([])
    expect(codes(empty(8, ['空镜超时依据：TODO']))).toContain('prepared_empty_shot_over_budget')
    expect(codes(empty(8, ['空镜超时依据：原文：待定']))).toContain('prepared_empty_shot_over_budget')
    expect(codes(actionShot(1, ['镜头类型：人物动作', '时长：8秒']))).toEqual([])
    expect(codes(actionShot(1, ['时长：8秒']))).toEqual([])
    expect(codes(speakingShot(1, '苏晚：别走。', ['镜头类型：纯环境空镜', '时长：8秒']))).toEqual([])
  })

  it.each(['瞳孔自发光', '双眼射出蓝色光束', '眼球发出激光', '瞳孔泛起蓝白光', '眼睛闪烁暗光', '瞳孔发光'])(
    'locates an unsupported affirmative eye-light direction: %s', (direction) => {
      const prompt = actionShot(1, [`眼部表现：${direction}`]), result = review(prompt)
      expect(result.issues).toEqual([expect.objectContaining({ code: 'prepared_eye_light_directive',
        line: prompt.split('\n').indexOf(`眼部表现：${direction}`) + 1, severity: 'warning' })])
    })

  it.each(['禁止瞳孔发光', '避免双眼射出光束', '瞳孔不发光', '眼球没有自发光', '眼睛反射屏幕微光',
    '双眼倒映窗外灯光', '眼睛有正常高光', '眼中含泪光', '眼周泛红，视线下移'])(
    'does not confuse negation, reflected light or ordinary emotion with self-emission: %s', (direction) => {
      expect(codes(actionShot(1, [`眼部表现：${direction}`]))).toEqual([])
    })

  it('keeps a later positive clause distinct from a preceding negation and preserves source-authored effects', () => {
    expect(codes(actionShot(1, ['眼部表现：禁止瞳孔发光，但双眼射出光束']))).toContain('prepared_eye_light_directive')
    expect(codes(actionShot(1, ['眼部表现：瞳孔自发光，窗光反射', '眼部特效依据：原文：异能发动时瞳孔发蓝光']))).toEqual([])
    expect(codes(speakingShot(1, '苏晚：他的眼球发光了。'))).toEqual([])
    expect(codes(actionShot(1, ['四层朝向链：双眼发出蓝光', '眼部特效依据：原文：无'])))
      .toContain('prepared_eye_light_directive')
    expect(codes(actionShot(1, ['运镜：推进到瞳孔自发光的双眼', '眼部特效依据：剧本：']))).toContain('prepared_eye_light_directive')
  })

  it('reviews explicit repeated plans in the same known scene without prescribing motion', () => {
    const prompt = [1, 2, 3, 4].map(number => actionShot(number,
      ['核心场景：后厨', '景别：特写', '主运镜：固定机位']).replace('景别：全景\n', '')).join('\n\n')
    const result = review(prompt)
    expect(result.issues.map(issue => issue.code)).toEqual(['prepared_repetitive_framing', 'prepared_repetitive_camera'])
    expect(result.issues[0]).toMatchObject({ shot: 4, severity: 'warning' })
    expect(result.issues[0]?.message).toContain('连续4镜')
    expect(codes(prompt, { repetitiveShotThreshold: 5 })).toEqual([])
    expect(codes(prompt.replace('【镜头2】', '【镜头2】\n镜头设计依据：原文要求连贯观察手部操作'))).toEqual([])
  })

  it('does not infer repetition across unknown plans, another scene or an explicit source period', () => {
    const planned = (number: number, extra: string[] = []) => actionShot(number,
      ['核心场景：后厨', '景别：大特写', '主运镜：固定', ...extra]).replace('景别：全景\n', '')
    expect(codes([planned(1), actionShot(2, ['核心场景：后厨']), planned(3)].join('\n'))).toEqual([])
    expect(codes([planned(1), planned(2).replace('核心场景：后厨', '核心场景：院落'), planned(3)].join('\n'))).toEqual([])
    expect(codes([planned(1, ['连续性场次：回忆']), planned(2), planned(3, ['连续性场次：现在'])].join('\n'))).toEqual([])
    expect(codes([1, 2, 3].map(number => actionShot(number, ['景别：特写', '主运镜：固定镜头'])
      .replace('景别：全景\n', '')).join('\n'))).toEqual([])
    expect(codes([1, 2, 3].map(number => planned(number, ['镜头设计依据：无'])).join('\n')))
      .toContain('prepared_repetitive_camera')
  })
})
