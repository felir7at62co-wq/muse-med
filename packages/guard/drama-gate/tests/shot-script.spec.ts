/** Advisory speech estimates and persisted matched JSON use the public structural helpers. */
import { expect, it } from 'vitest'
import { checkMatchedJsonText, countEffectiveChars, requiredSeconds } from '../src/shot-script.ts'

it('counts spoken characters and rounds advisory durations without imposing a delivery ceiling', () => {
  expect(countEffectiveChars('甲乙 A1，！？')).toBe(4)
  expect(countEffectiveChars('，！？')).toBe(0)
  expect(requiredSeconds(0)).toBe(1)
  expect(requiredSeconds(9)).toBe(1)
  expect(requiredSeconds(10)).toBe(2)
})

it('accepts a bare matched shot array and reports invalid duration fields', () => {
  expect(checkMatchedJsonText(JSON.stringify([{ script_duration: 2, text: 'spoken' }]))).toBeUndefined()
  expect(checkMatchedJsonText(JSON.stringify([{ duration: 0 }]))).toContain('正整数秒')
})
