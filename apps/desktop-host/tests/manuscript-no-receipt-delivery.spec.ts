/** Real execution receipts distinguish requested file deliveries from tutorial or inline code. */
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it.each([
  ['main', '帮我写四集短剧并交付真实本地 Markdown 文件。'],
  ['tutorial', '讲解 Python 代码如何生成短剧文档，只讲原理与示例，不运行代码，也不交付文件。'],
  ['chat', '只聊这份短剧的剧情，不需要文件；code_stdout 和 code_reference 只是示例标签。'],
  ['no-file', '先讨论怎么改写四集短剧，直接在聊天里说明，不要生成或提供文件。'],
] as const)('handles absent execution receipts for %s', async (mode, task) => {
  const patch = fileURLToPath(new URL('./fixtures/manuscript-no-receipt/cordis.yml', import.meta.url))
  const { stderr } = await runLoaderSmoke({
    label: `manuscript no-receipt ${mode}`, tempDirPrefix: `manuscript-no-receipt-${mode}-`,
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json', task], env: { MUSE_NO_RECEIPT_CASE: mode },
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode: 'src',
    inspect: async (cwd) => {
      const actual: unknown = JSON.parse(await readFile(join(cwd, '_no-receipt-probe.json'), 'utf8'))
      const expected: unknown = JSON.parse(await readFile(new URL('./expected/manuscript-no-receipt.json', import.meta.url), 'utf8'))
      expect(actual).toEqual(z.record(z.string(), z.unknown()).parse(expected)[mode])
      await expect(access(join(cwd, 'pretend-output.md'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(join(cwd, 'download-fake.docx'))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
