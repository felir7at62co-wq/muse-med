import { describe, expect, it } from 'vitest'
import { promptRiskReview, resolvePromptRiskReview } from '../src/prompt-risk.ts'

describe('advisory literal-term findings', () => {
  it('reports negative lists, quoted text and repeated terms without altering prompts', () => {
    const cards = [{ storyboard_id: 1957105, card_name: 'EP01-P1',
      prompt: '夜色。全局禁止：不出现国旗国徽。角色说：“国旗。”' },
    { storyboard_id: 1957106, card_name: 'EP01-P2', prompt: '备注：不要国徽。' }]
    const before = structuredClone(cards)
    const options = resolvePromptRiskReview({ terms: ['国旗', '国徽'], contextChars: 5 })
    expect(promptRiskReview(cards, options)).toMatchSnapshot('negative lists and unverified dialogue')
    expect(cards).toEqual(before)
  })

  it('bounds findings across cards, counts undisplayed matches and preserves Unicode context', () => {
    const cards = [{ storyboard_id: 1, card_name: null, prompt: '😀国旗😀国旗😀' },
      { storyboard_id: 2, card_name: '第二包', prompt: '国旗' }]
    expect(promptRiskReview(cards, resolvePromptRiskReview({ terms: ['国旗'], contextChars: 1, maxMatches: 1 })))
      .toMatchObject({ prompt_risk_review: { mode: 'advisory', total_matches: 3, truncated: true,
        matches: [{ storyboard_id: 1, card_name: null, term: '国旗', offset: 2, context: '😀国旗😀' }] } })
    expect(promptRiskReview(cards, resolvePromptRiskReview({ terms: ['国旗'], contextChars: 0, maxMatches: 1 })))
      .toMatchObject({ prompt_risk_review: { matches: [{ context: '国旗' }] } })
  })

  it('reports no literal findings without claiming complete compliance and leaves unconfigured calls unchanged', () => {
    const cards = [{ storyboard_id: 1, card_name: 'EP01-P1', prompt: '婚房内，两人相视。' }]
    const result = promptRiskReview(cards, resolvePromptRiskReview({ terms: ['国旗'] }))
    expect(result).toMatchObject({ prompt_risk_review: { total_matches: 0, matches: [], truncated: false } })
    expect(JSON.stringify(result)).toContain('未命中不代表完整审核通过')
    expect(promptRiskReview(cards, resolvePromptRiskReview())).toEqual({})
  })

  it.each([
    { terms: [] }, { terms: [''] }, { terms: [' 国旗'] }, { terms: ['国旗', '国旗'] },
    { terms: ['国旗'], contextChars: -1 }, { terms: ['国旗'], contextChars: 201 },
    { terms: ['国旗'], contextChars: 0.5 }, { terms: ['国旗'], maxMatches: 0 },
    { terms: ['国旗'], maxMatches: 1001 }, { terms: ['国旗'], maxMatches: 1.5 },
  ])('rejects invalid deployment review configuration: %j', (config) => {
    expect(() => resolvePromptRiskReview(config)).toThrow('promptRiskReview')
  })
})
