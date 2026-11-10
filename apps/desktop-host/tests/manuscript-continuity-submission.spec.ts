/** Actual structured-output denial permits correction without spending a separate reviewer budget. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleMode } from '@deepseek-ai/dsh-loader-smoke'

it.each([resolveExampleMode()])('rejects consistent plus unknowns in %s, then preserves those unknowns in the same reviewer', async (mode) => {
  const patch = fileURLToPath(new URL('./fixtures/manuscript-submission-retry/cordis.yml', import.meta.url))
  const { stderr } = await runLoaderSmoke({
    label: `manuscript structured submission correction ${mode}`, tempDirPrefix: 'manuscript-submission-retry-',
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json', '审校当前稿的剧情承接，保留未证实事项，不修改文件。'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    ...mode === 'src' ? { sourceImport: 'tsx/esm' } : {},
    mode, env: { DSH_EXAMPLE_MODE: mode },
    inspect: async (cwd) => {
      const actual: unknown = JSON.parse(await readFile(join(cwd, '_submission-retry-probe.json'), 'utf8'))
      const expected: unknown = JSON.parse(await readFile(new URL('./expected/manuscript-submission-retry.json', import.meta.url), 'utf8'))
      expect(actual).toEqual(expected)
    },
  })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
