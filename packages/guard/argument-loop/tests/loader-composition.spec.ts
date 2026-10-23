import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

describe('real app and Loader composition', () => {
  it.each(['first', 'prior'] as const)('settles %s-response failure without provider retry, continuation, tool replay, or repeated cost', {
    timeout: LOADER_SMOKE_TEST_TIMEOUT_MS,
  }, async (scenario) => {
    const fixture = new URL('./fixtures/', import.meta.url)
    const result = await runLoaderSmoke({
      label: 'tool argument loop local failure',
      binScript: fileURLToPath(new URL('driver.ts', fixture)),
      // The fixture is plain Node type-strippable in built mode; its bare
      // imports resolve the built package exports just like an installed app.
      libBinScript: fileURLToPath(new URL('driver.ts', fixture)),
      configPath: fileURLToPath(new URL('cordis.yml', fixture)),
      binArgs: [fileURLToPath(new URL('cordis.yml', fixture)), scenario],
      tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url)),
      tempDirPrefix: 'dsh-argument-loop-loader-',
      inspect: async (cwd) => {
        expect(JSON.parse(await readFile(join(cwd, 'result.json'), 'utf8'))).toMatchObject({
          passed: true, requests: scenario === 'prior' ? 2 : 1, repeated_members_produced: 64, upstream_exits: scenario === 'prior' ? 2 : 1,
          successful_writes: scenario === 'prior' ? 1 : 0, simulated_paid_calls: scenario === 'prior' ? 1 : 0, failed_response_tool_calls: 0,
          retry_events: 0, attempt_deltas_retained: 64,
          goal_activation: 'disarmed', goal_rounds_started: 1, plugin_disposal_completed: true,
          actual_muse_defaults_loaded: true,
        })
      },
    })
    expect(result.stdout).toContain('"passed":true')
  })
})
