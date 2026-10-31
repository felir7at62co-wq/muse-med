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

function assertUnifiedPolicy(config: BasicCompactionConfig): void {
  const resolved = resolveConfig(config)
  for (const [provider, model, window, output, threshold] of [
    ['muse-cloud-deepseek-official', 'deepseek-v4.1-flash-261017', 1_000_000, 393_216, 450_000],
    ['muse-cloud-volcengine-ark', 'glm-5.3-flash-260828', 475_000, 128_000, 213_750],
    ['muse-cloud-yunying', 'gpt-6.1-sol', 1_050_000, 128_000, 472_500],
    ['muse-cloud-yunying', 'gemini-3.1-pro', 1_048_576, 65_536, 471_859],
    ['personal', 'small', 8_192, 2_048, 3_380],
  ] as const) {
    const policy = resolveTargetPolicy(resolved, { provider, model })
    expect(policy).toMatchObject({ adaptiveBudget: true, workingTokenLimit: 475_000, thresholdRatio: 0.45 })
    const spec = resolveCompactSpec(policy, window, output)
    expect(spec.contextWindow).toBe(window)
    expect(spec.thresholdTokens).toBe(threshold)
    expect(spec.retainTokens).toBeLessThan(threshold)
    expect(spec.maxTokens).toBeLessThanOrEqual(16_384)
  }
}

it.each([...presets, 'host-defaults'])('uses the shared adaptive policy in %s', (preset) => {
  assertUnifiedPolicy(preset === 'host-defaults' ? hostDefaultsConfig() : presetConfig(preset))
})

it('leaves the minimal preset without an automatic compaction backend', () => {
  const source = readFileSync(new URL('../presets/minimal/agent.cordis.yml', import.meta.url), 'utf8')
  expect(source).not.toContain('dsh-compaction-basic')
})
