/** Public download lookup and refusal paths run through shipped source and built tools without network access. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleMode } from '@deepseek-ai/dsh-loader-smoke'

it.each([resolveExampleMode()])('publishes only an opened public episode through %s tools', async (mode) => {
  const patch = fileURLToPath(new URL('../../../snapshots/session/muse-hongguo-public-download/cordis.yml', import.meta.url))
  const result = await runLoaderSmoke({ label: 'Hongguo public download', tempDirPrefix: 'hongguo-public-download-loader-',
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json',
      '使用红果公开模式检查目录、下载已开放集，并核对越界和接口业务失败；不要将试看称为全剧，不要显示临时媒体地址。'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode,
    env: { DSH_EXAMPLE_MODE: mode } })
  expect(result.stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
