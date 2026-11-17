/** The Host entry of the coordinator client package is an inert marker. */
import { expect, it } from 'vitest'
import { apply } from '../src/index.ts'

it('accepts no Host context and loads without throwing', () => {
  expect(apply.length).toBe(0)
  expect(() => { apply() }).not.toThrow()
})
