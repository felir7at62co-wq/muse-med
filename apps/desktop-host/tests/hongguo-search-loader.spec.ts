/** Current public JSON search and failure pages exercise shipped source and built tool execution. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, resolveExampleMode, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it.each([resolveExampleMode()])('distinguishes public search results from restricted responses through %s tools', async (mode) => {
  const patch = fileURLToPath(new URL('../../../snapshots/session/muse-hongguo-search-public-api/cordis.yml', import.meta.url))
  const result = await runLoaderSmoke({ label: 'Hongguo public search', tempDirPrefix: 'hongguo-search-loader-',
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json',
      '通过红果搜索工具核对公开首屏、缓存切片、合法空窗口及错误页面；不要访问其他来源，不把受限页面称为没有结果。'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode,
    env: { DSH_EXAMPLE_MODE: mode } })
  expect(result.stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
