/** The shipped profile invokes snapshot/history without network or source replacement. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it('retains both versions through real model-visible tool calls', async () => {
  const patch = fileURLToPath(new URL('./fixtures/manuscript-versions/cordis.yml', import.meta.url))
  const { stderr } = await runLoaderSmoke({ label: 'manuscript versions', tempDirPrefix: 'manuscript-versions-loader-',
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json', '为 current.md 保留完整原件并查询历史，按实际版本报告。'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode: 'src',
    inspect: async (cwd) => {
      const actual: unknown = JSON.parse(await readFile(join(cwd, '_versions-probe.json'), 'utf8'))
      const expected: unknown = JSON.parse(await readFile(new URL('./expected/manuscript-versions.json', import.meta.url), 'utf8'))
      expect(actual).toEqual(expected)
    } })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
