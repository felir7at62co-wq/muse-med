/** Optional estimated working budgets remain independent of adapter capacity and output caps. */
import { describe, expect, it } from 'vitest'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy } from '../src/config.ts'
import type { BasicCompactionConfig } from '../src/types.ts'

const target = { provider: 'official', model: 'flash' }

describe('estimated working budget configuration', () => {
  it('leaves the resolved configuration unchanged when no working budget is configured', () => {
    const config = resolveConfig({})
    const policy = resolveTargetPolicy(config, target)
    const spec = resolveCompactSpec(policy, 1_000_000, 65_536)
    expect(config).not.toHaveProperty('workingTokenLimit')
    expect(policy).not.toHaveProperty('workingTokenLimit')
    expect(spec).not.toHaveProperty('workingTokenLimit')
    expect(spec.thresholdTokens).toBe(800_000)
  })

  it('inherits the global working budget and overrides only the exact configured target', () => {
    const config = resolveConfig({
      workingTokenLimit: 475_000,
      modelPolicies: [{ ...target, workingTokenLimit: 300_000 }],
    })
    expect(resolveTargetPolicy(config, target).workingTokenLimit).toBe(300_000)
    expect(resolveTargetPolicy(config, { ...target, model: 'other' }).workingTokenLimit).toBe(475_000)
    expect(resolveTargetPolicy(config, { ...target, provider: 'other' }).workingTokenLimit).toBe(475_000)
  })

  it('keeps an exact-target working budget absent from other routes', () => {
    const config = resolveConfig({ modelPolicies: [{ ...target, workingTokenLimit: 475_000 }] })
    expect(config).not.toHaveProperty('workingTokenLimit')
    expect(resolveTargetPolicy(config, target).workingTokenLimit).toBe(475_000)
    expect(resolveTargetPolicy(config, { ...target, provider: 'other' })).not.toHaveProperty('workingTokenLimit')
  })

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, '475000', null])(
    'rejects an invalid working budget %s at both configuration levels', (workingTokenLimit) => {
      const global = { workingTokenLimit }
      const exact = { modelPolicies: [{ ...target, workingTokenLimit }] }
      for (const config of [global, exact]) {
        expect(() => resolveConfig(config as BasicCompactionConfig)).toThrow(/workingTokenLimit.*positive integer/)
      }
    },
  )

  it('caps the pressure trigger without reducing the physical model capacity or routed output cap', () => {
    const policy = resolveTargetPolicy(resolveConfig({
      workingTokenLimit: 475_000, headroomTokens: 16_384, retainTokens: 65_536,
    }), target)
    const spec = resolveCompactSpec(policy, 1_000_000, 393_216)
    expect(spec.contextWindow).toBe(1_000_000)
    expect(spec.workingTokenLimit).toBe(475_000)
    expect(spec.thresholdTokens).toBe(475_000)
    expect(spec.retainTokens).toBe(65_536)
  })

  it.each([8192, 65_536, 131_072, 393_216])(
    'starts proactive compaction at 450k with a %s-token request output cap', (output) => {
      const policy = resolveTargetPolicy(resolveConfig({
        workingTokenLimit: 475_000,
        thresholdRatio: 0.45,
        headroomTokens: 16_384,
        retainTokens: 65_536,
        maxTokens: 16_384,
      }), target)
      const spec = resolveCompactSpec(policy, 1_000_000, output)
      expect(spec.thresholdTokens).toBe(450_000)
      expect(spec.retainTokens).toBe(65_536)
      expect(spec.maxTokens).toBe(16_384)
    },
  )

  it('still obeys the output reservation when the physical request budget is smaller', () => {
    const policy = resolveTargetPolicy(resolveConfig({
      workingTokenLimit: 475_000, headroomTokens: 16_384, retainTokens: 2048,
    }), target)
    expect(resolveCompactSpec(policy, 128_000, 32_768).thresholdTokens).toBe(78_848)
  })

  it('rejects a retained tail that cannot fit below the working budget', () => {
    const policy = resolveTargetPolicy(resolveConfig({
      workingTokenLimit: 475_000, retainTokens: 475_000,
    }), target)
    expect(() => resolveCompactSpec(policy, 1_000_000, 65_536)).toThrow(/retainTokens.*475000.*threshold tokens 475000/)
  })
})
