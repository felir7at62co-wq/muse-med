/**
 * The automatic per-series ceiling as the paid-call path reads it.
 *
 * The ceiling is only readable while the drama row publishes a namespace: the
 * settings service skips a row whose schema declares no volatile field, and this
 * reader then finds no section at all. Both halves are asserted here — the limit
 * a serving composition publishes, and what a composed settings service that
 * serves no such section makes the paid call do.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { JubianLedger, checkBudget } from '@deepseek-ai/dsh-jubian'
import { expect, it, vi } from 'vitest'
import { seriesBudgetLimit } from '../src/budget-settings.ts'

/**
 * A host context whose settings service describes the sections handed in.
 * @param sections - One `[namespace, value]` pair per descriptor `describe()` answers.
 * @returns The context, carrying a settings service and cordis's own logger.
 */
function context(sections: readonly (readonly [string, unknown])[] = []): Context {
  const ctx = new Context()
  ctx.provide('settings', { describe: () => sections.map(([ns, value]) => ({ ns, value })) })
  return ctx
}

it('reads the resolved drama section at each paid claim', () => {
  const section = { seriesBudgetCents: 400_000 }
  const ctx = context([['drama-settings', section]])
  expect(seriesBudgetLimit(ctx)).toBe(400_000)
  section.seriesBudgetCents = 150_000
  expect(seriesBudgetLimit(ctx)).toBe(150_000)
})

it('keeps manual authorization when the deployment composes no settings provider', () => {
  const ctx = new Context()
  const warn = vi.spyOn(ctx.logger, 'warn')
  expect(seriesBudgetLimit(ctx)).toBeUndefined()
  expect(warn).not.toHaveBeenCalled()
})

it('warns about a composed settings service that serves no readable drama section', () => {
  const ctx = context()
  const warn = vi.spyOn(ctx.logger, 'warn')
  expect(seriesBudgetLimit(ctx)).toBeUndefined()
  expect(warn).toHaveBeenCalledOnce()
  const [format, ...args] = warn.mock.calls[0] as [string, ...unknown[]]
  expect(format).toContain('series ceiling')
  expect(args).toEqual(['drama-settings', 'drama-settings'])
})

it('rejects a malformed stored budget instead of buying with a guessed default', () => {
  expect(() => seriesBudgetLimit(context([['drama-settings', { seriesBudgetCents: -1 }]]))).toThrow()
})

it('refuses a paid call whose ceiling cannot be read rather than authorizing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-unreadable-budget-'))
  try {
    // No drama section and no authorization file: the only safe answer is a
    // refusal, never a claim that the project may spend without a ceiling.
    const ledger = new JubianLedger({ root, defaultLimitCents: () => seriesBudgetLimit(context()) })
    const decision = await checkBudget({ ledger, method: 'image_generate', scriptId: 2708,
      quote: { amount: '1.00', unit: 'CNY' } })
    expect(decision.status).toBe('refused')
    expect(decision.reason).toContain('authorization.json')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
