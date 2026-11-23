import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

describe('real app and Loader composition of the shipped Desktop guard row', () => {
  it.each(['recover', 'exhausted'] as const)('%s: discards dropped-lane replies and retries them under the shipped policy', {
    timeout: LOADER_SMOKE_TEST_TIMEOUT_MS,
  }, async (scenario) => {
    const fixture = new URL('./fixtures/', import.meta.url)
    const recover = scenario === 'recover'
    const result = await runLoaderSmoke({
      label: 'prompt usage guard',
      binScript: fileURLToPath(new URL('driver.ts', fixture)),
      libBinScript: fileURLToPath(new URL('driver.ts', fixture)),
      configPath: fileURLToPath(new URL('cordis.yml', fixture)),
      binArgs: [fileURLToPath(new URL('cordis.yml', fixture)), scenario],
      tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url)),
      tempDirPrefix: 'dsh-prompt-usage-loader-',
      inspect: async (cwd) => {
        expect(JSON.parse(await readFile(join(cwd, 'result.json'), 'utf8'))).toEqual({
          passed: true, scenario,
          requests: 2,
          rejected_attempts: recover ? 1 : 2,
          retry_events: 1,
          retry_codes: ['PROMPT_USAGE_SHORTFALL'],
          committed_messages: recover ? 1 : 0,
          final_text_recovered: recover,
          rejected_text_in_later_requests: false,
          turn_end: recover ? 'completed' : 'PROMPT_USAGE_SHORTFALL',
          actual_desktop_rows_loaded: true,
          plugin_disposal_completed: true,
        })
      },
    })
    expect(result.stdout).toContain('"passed":true')
  })
})
