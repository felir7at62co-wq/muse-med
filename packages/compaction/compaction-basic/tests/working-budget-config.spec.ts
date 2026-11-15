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

describe('adaptive common desktop policy', () => {
  const config = resolveConfig({
    adaptiveBudget: true, workingTokenLimit: 475_000, thresholdRatio: 0.45,
    headroomTokens: 16_384, retainTokens: 65_536, maxTokens: 16_384,
    modelPolicies: [{ provider: 'custom', model: 'exact', adaptiveBudget: false, retainTokens: 1_000 }],
  })

  it.each([
    ['muse-cloud-deepseek-official', 'deepseek-v4.1-flash-261017', 1_000_000, 393_216, 450_000, 65_536, 16_384],
    ['muse-cloud-volcengine-ark', 'glm-5.3-flash-260828', 475_000, 128_000, 213_750, 65_536, 16_384],
    ['muse-cloud-yunying', 'gpt-6.1-sol', 1_050_000, 128_000, 472_500, 65_536, 16_384],
    ['muse-cloud-yunying', 'gemini-3.1-pro', 1_048_576, 65_536, 471_859, 65_536, 16_384],
    ['other', 'small', 8_192, 2_048, 3_380, 1_521, 3_686],
    ['other', 'tight', 8_192, 8_000, 106, 47, 3_686],
  ])('scales %s/%s to its actual window', (provider, model, window, output, threshold, retained, summary) => {
    const spec = resolveCompactSpec(resolveTargetPolicy(config, { provider, model }), window, output)
    expect(spec).toMatchObject({
      contextWindow: window, thresholdTokens: threshold, retainTokens: retained,
      maxTokens: summary, workingTokenLimit: 475_000,
    })
    expect(spec.retainTokens).toBeLessThan(spec.thresholdTokens)
  })

  it('preserves feasible explicit headroom, retained tail and summary cap while adapting only infeasible values', () => {
    const policy = resolveTargetPolicy(resolveConfig({
      adaptiveBudget: true, thresholdRatio: 0.45, headroomTokens: 40_000, retainTokens: 50_000, maxTokens: 16_000,
    }), target)
    expect(resolveCompactSpec(policy, 200_000, 40_000)).toMatchObject({ thresholdTokens: 90_000, retainTokens: 50_000, maxTokens: 16_000 })
  })

  it('preserves an explicit model override to disable adaptation', () => {
    const policy = resolveTargetPolicy(config, { provider: 'custom', model: 'exact' })
    expect(policy.adaptiveBudget).toBe(false)
    expect(resolveCompactSpec(policy, 100_000, 32_000)).toMatchObject({ retainTokens: 1_000, maxTokens: 16_384 })
    expect(() => resolveCompactSpec(policy, 8_192, 2_048)).toThrow(/headroomTokens/)
  })

  it('rejects a nonboolean adaptive setting and impossible output reservations', () => {
    const invalid: BasicCompactionConfig = { adaptiveBudget: true }
    Object.assign(invalid, { adaptiveBudget: 'true' })
    expect(() => resolveConfig(invalid)).toThrow(/adaptiveBudget must be a boolean/)
    const policy = resolveTargetPolicy(config, target)
    expect(() => resolveCompactSpec(policy, 8_192, 8_192)).toThrow(/leaving no message budget/)
  })
})
