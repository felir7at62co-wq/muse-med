/** Adjacent script evidence preserves source distinctions and never applies a suggested join. */
import { expect, it } from 'vitest'
import { manuscriptGuidanceCandidates, manuscriptReadGuidanceCandidates, manuscriptScreenplayCandidates } from '../src/manuscript-advisories.ts'
import { manuscriptScenes } from '../src/manuscript-scenes.ts'

function candidates(text: string, maximum = 40) {
  return manuscriptScreenplayCandidates(manuscriptScenes(text).map(scene => ({ ...scene, path: '/script.md' })), 4, maximum)
}

it('offers complete consecutive utterances while retaining exact lines and each parenthetical', () => {
  const text = '第8集\n8-1 餐厅 日 内\n贺景川（提高了声音）：什么？\n\n贺景川：1万块？\n贺景川：妈，1万块够我喝两瓶酒吗？\n贺景川（看向母亲）：我可是贺家的独生子啊！'
  const result = candidates(text)
  expect(result.dialogue_runs.findings).toHaveLength(1)
  expect(result.dialogue_runs.findings[0]).toMatchObject({ speaker: '贺景川', voice: 'dialogue',
    joined_dialogue_text: '什么？1万块？妈，1万块够我喝两瓶酒吗？我可是贺家的独生子啊！' })
  expect(result.dialogue_runs.findings[0]?.lines.map(line => line.line)).toEqual([3, 5, 6, 7])
  expect(result.dialogue_runs.findings[0]?.lines[3]?.parentheticals).toEqual(['看向母亲'])
  expect(result.semantic_assessment).toBe('not_performed')
  expect(text).toContain('贺景川：1万块？\n贺景川：妈')
})

it('separates speakers, OS/VO, action beats, flashbacks and scene boundaries', () => {
  const result = candidates('第1集\n1-1 家 日 内\n甲：一。\n甲（OS）：二。\n甲（VO）：三。\n乙：四。\n甲：五。\n▲甲放下茶杯。\n甲：六。\n【闪回开始】\n甲：七。\n1-2 家 日 外\n甲：八。\n甲 VO（回忆）：九。\n甲（VO）：十。')
  expect(result.dialogue_runs.total).toBe(1)
  expect(result.dialogue_runs.findings[0]).toMatchObject({ speaker: '甲', voice: 'VO', joined_dialogue_text: '九。十。' })
})

it('locates repeated action clauses and adjacent parenthetical overlap without claiming semantic duplication', () => {
  const result = candidates('第4集\n4-1 餐厅 日 内\n▲叶知遥拉开椅子坐下，把包搁在腿边。\n叶知遥（拉开椅子坐下）：妈，爸。\n▲叶知遥转身走出餐厅。\n▲叶知遥转身走出餐厅，门在身后关上。\n甲（抬手撑住门扇）：等等。\n▲甲抬手撑住门扇，没有离开。')
  expect(result.action_overlaps.findings.map(entry => entry.kind)).toEqual(['action_parenthetical', 'adjacent_action_lines', 'action_parenthetical'])
  expect(result.action_overlaps.findings[0]).toMatchObject({ shared_text: '拉开椅子坐下', first: { line: 3 }, second: { line: 4 } })
  expect(result.action_overlaps.notice).toContain('未覆盖改写后的重复')
  expect(candidates('第1集\n1-1 家 日 内\n▲甲拉开椅子坐下。\n乙：来了。\n甲（拉开椅子坐下）：嗯。').action_overlaps.total).toBe(0)
})

it('reports candidate overflow separately and ignores labels and unmarked prose as dialogue joins', () => {
  const result = candidates('第1集\n1-1 家 日 内\n人物：甲、乙\n人物：丙\n甲：一。\n甲：二。\n乙：三。\n乙：四。\n▲甲慢慢拉开木门。\n▲甲慢慢拉开木门。\n▲甲慢慢拉开木门。', 1)
  expect(result.dialogue_runs).toMatchObject({ total: 2, omitted: 1 })
  expect(result.action_overlaps).toMatchObject({ total: 2, omitted: 1 })
  expect(result.dialogue_runs.findings[0]?.speaker).toBe('甲')
})

it('keeps action-marked dialogue as a separate format candidate with exact text and line numbers', () => {
  const quote = '▲贺景川（眉头拧紧）：妈，你非要这么咄咄逼人吗？'
  const result = candidates(`第8集\n8-1 餐厅 日 内\n人物：贺景川、乔静仪\n${quote}\n△贺景川：先听我说。`, 1)
  expect(result.mixed_action_dialogue_lines).toMatchObject({ total: 2, omitted: 1,
    findings: [{ quote, line: 4, speaker: '贺景川', parentheticals: ['眉头拧紧'], text: '妈，你非要这么咄咄逼人吗？' }] })
  expect(result.dialogue_runs.total).toBe(0)
  expect(result.action_overlaps.total).toBe(0)
  expect(result.mixed_action_dialogue_lines.notice).toContain('不自动移除符号或改稿')
})

it('does not treat ordinary action narration, quoted screen text or a colon alone as a named speaker', () => {
  const result = candidates('第8集\n8-1 餐厅 日 内\n人物：贺景川、乔静仪\n▲贺景川说：“妈，你先听我说。”\n▲屏幕上浮出文字：“禁止入内”。\n▲她指向门牌：主任室。\n▲乔静仪（失神）举起茶杯，说：“走吧。”')
  expect(result.mixed_action_dialogue_lines.total).toBe(0)
  expect(result.dialogue_runs.total).toBe(0)
})

it('attributes newly written project restrictions without treating missing literal evidence as a conflict', () => {
  const after = '# 写作规范\n- 不改写、不删减、不合并台词。\n- 对白：`人物名（括注）：台词`。\n- 每句对白都要加括注。'
  const report = manuscriptGuidanceCandidates({ path: '/project/写作规范.md', before: null, after }, [], 40)
  expect(report).toMatchObject({ attribution: 'current_model_tool_mutation', scope: 'newly_written_lines_only', total: 3,
    authority_assessment: 'not_performed' })
  expect(report?.findings[0]).toMatchObject({ line: 2, quote: '- 不改写、不删减、不合并台词。', restriction: '不合并台词', user_basis: 'no_literal_user_text_found' })
  expect(report?.notice).toContain('不等于与用户冲突')
  expect(manuscriptGuidanceCandidates({ path: '/project/正文.md', before: null, after }, [], 40)).toBeUndefined()
  expect(manuscriptGuidanceCandidates({ path: '/project/写作规范.md', before: after, after }, [], 40)).toBeUndefined()
})

it('retains literal real-user references rather than claiming the model supplied their requirement', () => {
  const report = manuscriptGuidanceCandidates({ path: '写作规范.md', before: null, after: '不合并台词。' },
    [{ message_id: 'user-1', text: '不合并台词。' }], 40)
  expect(report?.findings[0]).toMatchObject({ user_basis: 'literal_user_text_found',
    literal_user_mentions: [{ message_id: 'user-1', quote: '不合并台词。' }], literal_user_mentions_omitted: 0 })
  expect(report?.authority_assessment).toBe('not_performed')
})

it('checks only returned guidance lines, keeping authorship and incomplete reading scope explicit', () => {
  const report = manuscriptReadGuidanceCandidates({ path: '写作规范.md',
    lines: [{ number: 35, text: '- 不合并台词。' }, { number: 36, text: '- 每句对白必须带括注。' }] }, [], 1)
  expect(report).toMatchObject({ attribution: 'document_read_authorship_unknown', scope: 'tool_returned_lines_only', total: 2, omitted: 1 })
  expect(report?.findings[0]?.line).toBe(35)
})
