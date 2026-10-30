/** Product compaction budgets leave useful input space for small-window cloud models. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import { parse as parseYaml } from 'yaml'
import { expect, it } from 'vitest'

interface PresetRow {
  readonly id?: string
  readonly config?: unknown
}

const smallModels = ['gpt-6-sol', 'gpt-6-astra', 'gemini-3.1-pro']
const presets = ['standard', 'ptc', 'cordis', 'short-drama', 'creation', 'bot-coordinator']

function presetConfig(preset: string): BasicCompactionConfig {
  const rows = parseYaml(readFileSync(new URL(`../presets/${preset}/agent.cordis.yml`, import.meta.url), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
  }) as PresetRow[]
  const children = rows.find(row => row.id === 'compaction')?.config
  if (!Array.isArray(children)) throw new Error(`Preset ${preset} has no compaction group`)
  const basic = (children as PresetRow[]).find(row => row.id === 'compaction-basic')
  if (basic === undefined) throw new Error(`Preset ${preset} has no compaction backend`)
  return basic.config as BasicCompactionConfig | undefined ?? {}
}

function hostDefaultsConfig(): BasicCompactionConfig {
  const patches = loadOverlayPatches('muse-compaction-defaults', fileURLToPath(new URL(
    '../config/defaults.cordis.patch.yml', import.meta.url,
  )))
  const entry = patches.find(patch => patch.id === 'compaction-basic')
  expect(entry).toBeDefined()
  return entry?.config as BasicCompactionConfig
}

function assertSmallWindowBudget(config: BasicCompactionConfig): void {
  const resolved = resolveConfig(config)
  for (const model of smallModels) {
    const policy = resolveTargetPolicy(resolved, { provider: 'muse-cloud-yunying', model })
    const spec = resolveCompactSpec(policy, 128_000, 32_768)
    expect(spec.thresholdTokens, model).toBeGreaterThan(42_093)
    expect(spec.thresholdTokens, model).toBe(78_848)
    expect(spec.maxTokens, model).toBe(8192)
    expect(spec.retainTokens, model).toBe(15_237)
  }
  const personal = resolveTargetPolicy(resolved, { provider: 'personal', model: 'gpt-6-sol' })
  expect(personal.headroomTokens).toBe(65_536)
  expect(personal.maxTokens).toBe(65_536)
  expect(personal).not.toHaveProperty('workingTokenLimit')
  expect(resolved).not.toHaveProperty('workingTokenLimit')
  const large = resolveTargetPolicy(resolved, { provider: 'muse-cloud-yunying', model: 'claude-opus-5-5' })
  expect(large.headroomTokens).toBe(16_384)
  expect(large.maxTokens).toBe(8192)
  for (const [provider, model, context, output] of [
    ['yunying', 'gpt-6-sol', 1050000, 128000], ['yunying', 'gpt-6-astra', 1050000, 128000],
    ['yunying', 'claude-opus-5-5', 1000000, 128000], ['yunying', 'claude-fable-5-1', 1000000, 128000],
    ['yunying', 'claude-sonnet-5-5', 1000000, 128000], ['yunying', 'gemini-3.1-pro', 1048576, 65536],
    ['yunying', 'glm-5.3-flash', 1048576, 128000],
    ['zhipu-official', 'glm-5.3-flashx', 1048576, 128000],
    ['zhipu-official', 'glm-5.3-flash', 1048576, 128000],
    ['deepseek-official', 'deepseek-flash', 1000000, 393216], ['deepseek-official', 'deepseek-v4-pro', 1048576, 393216],
  ] as const) {
    const spec = resolveCompactSpec(resolveTargetPolicy(resolved, { provider: `muse-cloud-${provider}`, model }), context, output)
    if (provider === 'deepseek-official' && model === 'deepseek-flash') {
      expect(spec.thresholdTokens).toBe(450_000)
      expect(spec.maxTokens).toBe(16_384)
    } else {
      expect(spec.thresholdTokens).toBeGreaterThan(600000)
      expect(spec.maxTokens).toBe(8192)
      expect(spec).not.toHaveProperty('workingTokenLimit')
    }
  }
}

it.each(presets)('keeps the observed 42k request below automatic compaction pressure in the %s preset', (preset) => {
  assertSmallWindowBudget(presetConfig(preset))
})

it('uses the same cloud budgets in the desktop Host defaults', () => {
  assertSmallWindowBudget(hostDefaultsConfig())
})

it.each([...presets, 'host-defaults'])('keeps Flash at a 1M physical window with a 475k working budget in %s', (preset) => {
  const config = resolveConfig(preset === 'host-defaults' ? hostDefaultsConfig() : presetConfig(preset))
  for (const model of ['deepseek-flash', 'deepseek-v4.1-flash-261017']) {
    const policy = resolveTargetPolicy(config, { provider: 'muse-cloud-deepseek-official', model })
    expect(policy.workingTokenLimit, model).toBe(475_000)
    expect(policy.thresholdRatio, model).toBe(0.45)
    expect(policy.headroomTokens, model).toBe(16_384)
    expect(policy).not.toHaveProperty('retainRatio')
    for (const output of [8192, 65_536, 131_072, 393_216]) {
      const spec = resolveCompactSpec(policy, 1_000_000, output)
      expect(spec.contextWindow, model).toBe(1_000_000)
      expect(spec.workingTokenLimit, model).toBe(475_000)
      expect(spec.thresholdTokens, model).toBe(450_000)
      expect(spec.maxTokens, model).toBe(16_384)
      expect(spec.retainTokens, model).toBe(65_536)
    }
  }
})

it('keeps Bot coordinator policy overrides limited to the current and historical Flash routes', () => {
  const config = presetConfig('bot-coordinator')
  const isFlash = (policy: { provider: string; model: string }) => policy.provider === 'muse-cloud-deepseek-official'
    && ['deepseek-flash', 'deepseek-v4.1-flash-261017'].includes(policy.model)
  expect(config.modelPolicies?.filter(isFlash)).toEqual(['deepseek-flash', 'deepseek-v4.1-flash-261017'].map(model => ({
    provider: 'muse-cloud-deepseek-official', model, thresholdRatio: 0.45, workingTokenLimit: 475_000,
    headroomTokens: 16_384, retainTokens: 65_536, maxTokens: 16_384,
  })))
  expect(config.modelPolicies?.filter(policy => !isFlash(policy))).toEqual(
    presetConfig('standard').modelPolicies?.filter(policy => !isFlash(policy)),
  )
})

it('leaves the minimal preset without an automatic compaction backend', () => {
  const source = readFileSync(new URL('../presets/minimal/agent.cordis.yml', import.meta.url), 'utf8')
  expect(source).not.toContain('dsh-compaction-basic')
})
