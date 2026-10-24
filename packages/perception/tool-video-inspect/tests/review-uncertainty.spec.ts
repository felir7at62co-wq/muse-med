import { expect, it } from 'vitest'
import { hasReviewUncertainty } from '../src/review-state.ts'

it.each(['', ' ', '无', '无。', '无疑点', ' 无疑点 ！ ', 'none', 'None.', 'n/a', ' N / A； '])(
  'treats only exact conventional empty markers as no concern: %j', (text) => {
    expect(hasReviewUncertainty(text)).toBe(false)
  })

it.each(['无？', 'none?', '无...', '无明显变化，但手里是否有钥匙不清楚。', '无疑点？需要再看门后的动作。', 'none except the prop position',
  '是否有接触不清楚。', '暂时无法确认说话者。', 'n/a but another person may be present']) (
  'keeps actual or qualified uncertainty: %j', (text) => {
    expect(hasReviewUncertainty(text)).toBe(true)
  })
