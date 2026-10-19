/** User-revision checks preserve exact changed paragraphs without freezing unrelated manuscript edits. */
import { describe, expect, it } from 'vitest'
import { diffManuscript, manuscriptParagraphs, validateManuscriptCandidate } from '../src/manuscript-diff.ts'

const limits = { maxParagraphs: 1000, maxEditLength: 200 }

describe('manuscript paragraph comparison', () => {
  it('returns every insertion, replacement and deletion with stable distinct identities', () => {
    const baseline = '开场\n甲：旧台词。\n过场\n乙：删掉这句。\n结尾'
    const revised = '新增开场\n开场\n甲：用户的新台词！\n过场\n结尾\n用户的新结尾'
    const review = diffManuscript(baseline, revised, limits)
    expect(review.changes.map(({ kind, before, after }) => ({ kind, before, after }))).toEqual([
      { kind: 'insert', before: [], after: ['新增开场'] },
      { kind: 'replace', before: ['甲：旧台词。'], after: ['甲：用户的新台词！'] },
      { kind: 'delete', before: ['乙：删掉这句。'], after: [] },
      { kind: 'insert', before: [], after: ['用户的新结尾'] },
    ])
    expect(new Set(review.changes.map(change => change.id)).size).toBe(4)
    expect(diffManuscript(baseline, revised, limits)).toEqual(review)
    expect(review.changes[1]).toMatchObject({ beforeStart: 2, afterStart: 3 })
    expect(review.changes[2]).toMatchObject({ beforeStart: 4, afterStart: 5 })
  })

  it('ignores blank lines and simple Markdown while retaining meaningful whitespace and punctuation', () => {
    expect(manuscriptParagraphs('\uFEFF# 第一集\r\n\r\n **甲**：`你好`。 \n_▲离开_')).toEqual(['第一集', '甲：你好。', '▲离开'])
    expect(diffManuscript('第一集\n甲：你好。\n▲离开', '# 第一集\n\n**甲**：你好。\n_▲离开_', limits).changes).toEqual([])
    expect(diffManuscript('甲：我  不走。', '甲：我 不走！', limits).changes).toHaveLength(1)
    expect(diffManuscript('1. 第一场', '2. 第一场', limits).changes).toHaveLength(1)
  })

  it('does not silently truncate paragraphs or over-budget edit searches', () => {
    expect(() => diffManuscript('甲\n乙', '甲\n乙\n丙', { ...limits, maxParagraphs: 2 })).toThrow('manuscript_diff_budget')
    expect(() => diffManuscript('甲\n乙', '丙\n丁', { ...limits, maxEditLength: 1 })).toThrow('manuscript_diff_budget')
    expect(() => diffManuscript('甲', '乙', { ...limits, maxEditLength: 0 })).toThrow('manuscript_diff_limits')
  })

  it('reports separated changes at both ends of a long unchanged manuscript', () => {
    const middle = Array.from({ length: 500 }, (_, index) => `未改段落${index}`).join('\n')
    const review = diffManuscript(`旧开头\n${middle}\n旧结尾`, `新开头\n${middle}\n新结尾`, limits)
    expect(review.changes).toHaveLength(2)
    expect(review.revised).toHaveLength(502)
    expect(review.changes.at(-1)?.after).toEqual(['新结尾'])
  })
})

describe('subsequent manuscript candidates', () => {
  const review = diffManuscript('场次一\n甲：旧台词。\n▲普通动作。\n乙：删掉。\n结尾', '场次一\n甲：用户台词！\n▲普通动作。\n用户新增段落\n结尾', limits)

  it('permits refinement only outside the user changes and preserves exact user text', () => {
    expect(validateManuscriptCandidate(review, '场次一\n甲：用户台词！\n▲她把门轻轻合上。\n用户新增段落\n结尾')).toEqual({ ok: true, violations: [] })
    expect(validateManuscriptCandidate(review, review.revised.join('\n'))).toEqual({ ok: true, violations: [] })
    expect(validateManuscriptCandidate(review, '# 场次一\n\n**甲**：用户台词！\n▲普通动作。\n用户新增段落\n结尾').ok).toBe(true)
  })

  it('rejects a changed, omitted or reordered user paragraph', () => {
    for (const candidate of [
      '场次一\n甲：我重写了。\n▲普通动作。\n用户新增段落\n结尾',
      '场次一\n▲普通动作。\n用户新增段落\n结尾',
      '场次一\n用户新增段落\n▲普通动作。\n甲：用户台词！\n结尾',
    ]) {
      const result = validateManuscriptCandidate(review, candidate)
      expect(result.ok).toBe(false)
      expect(result.violations.some(item => item.code === 'protected_paragraph_changed')).toBe(true)
    }
  })

  it('retains deletion tombstones and prevents restoring overwritten original lines', () => {
    for (const old of ['乙：删掉。', '甲：旧台词。']) {
      const result = validateManuscriptCandidate(review, [...review.revised, old].join('\n'))
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(expect.objectContaining({ code: 'deleted_paragraph_restored', text: old }))
    }
  })

  it('checks repeated deleted dialogue by occurrence count instead of simple text presence', () => {
    const repeated = diffManuscript('开场\n甲：一样。\n过场\n甲：一样。\n结尾', '开场\n甲：一样。\n过场\n结尾', limits)
    expect(validateManuscriptCandidate(repeated, '新开场\n甲：一样。\n新过场\n结尾').ok).toBe(true)
    expect(validateManuscriptCandidate(repeated, '开场\n甲：一样。\n过场\n甲：一样。\n结尾').violations).toContainEqual(
      expect.objectContaining({ code: 'deleted_paragraph_restored', text: '甲：一样。' }),
    )
  })

  it('does not let another identical user line substitute for an omitted occurrence', () => {
    const repeated = diffManuscript('开场\n过场\n结尾', '开场\n甲：用户句。\n过场\n甲：用户句。\n结尾', limits)
    const result = validateManuscriptCandidate(repeated, '开场\n过场\n甲：用户句。\n结尾')
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(expect.objectContaining({ code: 'protected_paragraph_changed', text: '甲：用户句。' }))
  })

  it('does not confuse deletion of an unchanged duplicate with editing the remaining protected occurrence', () => {
    const repeated = diffManuscript('甲：一样。\n中场\n结尾', '甲：一样。\n中场\n甲：一样。\n结尾', limits)
    expect(validateManuscriptCandidate(repeated, '新的开场\n中场\n甲：一样。\n结尾').ok).toBe(true)
    expect(validateManuscriptCandidate(repeated, '甲：一样。\n中场\n结尾').ok).toBe(false)
  })

  it('permits moving an unchanged surviving duplicate without treating its mere presence as restoration', () => {
    const repeated = diffManuscript('甲：重复句。\n过场\n甲：重复句。\n结尾', '过场\n甲：重复句。\n结尾', limits)
    expect(validateManuscriptCandidate(repeated, '甲：重复句。\n新的过场\n结尾')).toEqual({ ok: true, violations: [] })
    expect(validateManuscriptCandidate(repeated, '甲：重复句。\n新的过场\n**甲**：重复句。\n结尾').ok).toBe(false)
  })

  it('keeps change identities stable when only Markdown and blank lines differ', () => {
    const plain = diffManuscript('甲：旧句。\n结尾', '甲：用户句。\n用户新增\n结尾', limits)
    const formatted = diffManuscript('**甲**：旧句。\n\n结尾', '**甲**：用户句。\n`用户新增`\n\n结尾', limits)
    expect(formatted).toEqual(plain)
  })

  it('fails a candidate comparison that exceeds its original complete-comparison budget', () => {
    const bounded = diffManuscript('甲', '用户甲', { maxParagraphs: 2, maxEditLength: 2 })
    expect(() => validateManuscriptCandidate(bounded, '用户甲\n乙\n丙')).toThrow('manuscript_diff_budget')
  })
})
