/** Shipped-profile reviews require grounded evidence and complete Host-scheduled episode pairs. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleMode } from '@deepseek-ai/dsh-loader-smoke'

it.each([resolveExampleMode()])('reviews every scheduled episode pair and rejects missing coverage through %s', async (mode) => {
  const patch = fileURLToPath(new URL('./fixtures/manuscript-cross-episode/cordis.yml', import.meta.url))
  const result = await runLoaderSmoke({ label: 'manuscript cross-episode', tempDirPrefix: 'manuscript-cross-episode-loader-',
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json',
      '只读核对 current.md 与 candidate.md 的跨集衔接，逐对检查铜钱计数、人物知情和尾钩承接；普通切场本身不算矛盾，不修改文件。'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode,
    env: { DSH_EXAMPLE_MODE: mode },
    inspect: async (cwd) => {
      const actual: unknown = JSON.parse(await readFile(join(cwd, '_cross-episode-probe.json'), 'utf8'))
      const expected: unknown = JSON.parse(await readFile(new URL('./expected/manuscript-cross-episode.json', import.meta.url), 'utf8'))
      expect(actual).toEqual(expected)
    } })
  expect(result.stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
