/** Shipped-profile repetition review distinguishes literal candidates from grounded repeated events and legitimate recall. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, resolveExampleMode, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it.each([resolveExampleMode()])('reviews repeated events and legitimate recall while refusing incomplete checks through %s', async (mode) => {
  const patch = fileURLToPath(new URL('./fixtures/manuscript-repetition/cordis.yml', import.meta.url))
  const result = await runLoaderSmoke({ label: 'manuscript repetition', tempDirPrefix: 'manuscript-repetition-loader-',
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json',
      '只读检查 current.md 与 candidate.md、recap.md 的重复剧情；区分同一已完成事件重演与明确回忆带出新信息，不修改文件。'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode,
    env: { DSH_EXAMPLE_MODE: mode },
    inspect: async (cwd) => {
      const actual: unknown = JSON.parse(await readFile(join(cwd, '_repetition-probe.json'), 'utf8'))
      const expected: unknown = JSON.parse(await readFile(new URL('./expected/manuscript-repetition.json', import.meta.url), 'utf8'))
      expect(actual).toEqual(expected)
    } })
  expect(result.stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
