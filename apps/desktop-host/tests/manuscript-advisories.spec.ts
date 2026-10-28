/** Project guidance notices preserve authorship and literal user references. */
import { expect, it } from 'vitest'
import { manuscriptGuidanceCandidates, manuscriptReadGuidanceCandidates } from '../src/manuscript-advisories.ts'

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
