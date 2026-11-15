import { expect, it } from 'vitest'
import { isEscapeKeyDown, isPhysicalInput } from '../src/computer-input-flags.ts'

it('does not mistake injected input for user takeover', () => {
  for (const flags of [0, 0x01, 0x20, 0x80]) expect(isPhysicalInput('keyboard', flags)).toBe(true)
  for (const flags of [0x02, 0x10, 0x12, 0x90]) expect(isPhysicalInput('keyboard', flags)).toBe(false)
  expect(isPhysicalInput('mouse', 0)).toBe(true)
  for (const flags of [1, 2, 3]) expect(isPhysicalInput('mouse', flags)).toBe(false)
})

it('recognizes Escape down only after the physical input filter', () => {
  for (const event of [0x100, 0x104, 0x100n, 0x104n]) expect(isEscapeKeyDown(event, 0x1b)).toBe(true)
  for (const event of [0x101, 0x105, 0x101n, 0x105n]) expect(isEscapeKeyDown(event, 0x1b)).toBe(false)
  expect(isEscapeKeyDown(0x100, 0x41)).toBe(false)
  expect(isPhysicalInput('keyboard', 0x10) && isEscapeKeyDown(0x100, 0x1b)).toBe(false)
})
