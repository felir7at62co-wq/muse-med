import type { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { seriesBudgetLimit } from '../src/budget-settings.ts'

function context(section: unknown): Context {
  return { get: (name: string) => name === 'settings' ? { get: () => section } : undefined } as unknown as Context
}

it('reads the resolved drama section for the next paid call', () => {
  const section = { seriesBudgetCents: 400_000 }
  const ctx = context(section)
  expect(seriesBudgetLimit(ctx)).toBe(400_000)
  section.seriesBudgetCents = 150_000
  expect(seriesBudgetLimit(ctx)).toBe(150_000)
})

it('keeps manual authorization when the drama namespace is not composed', () => {
  expect(seriesBudgetLimit(context(undefined))).toBeUndefined()
})

it('rejects a malformed stored budget instead of buying with a guessed default', () => {
  expect(() => seriesBudgetLimit(context({ seriesBudgetCents: -1 }))).toThrow()
})
