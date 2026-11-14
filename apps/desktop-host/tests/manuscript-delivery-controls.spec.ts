/** Real Loader controls keep screenplay delivery checks within the active request and Session. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

const cases = [
  ['report', '整理本季采购情况，生成普通 Word 报告，不涉及剧本创作。'],
  ['translation', '仅翻译已有四集剧本的对白，保留全部人物、剧情和顺序，不新增情节，输出 Word。'],
  ['format', '仅把已有四集剧本转换为 Word，正文逐字不变，不创作或修订剧情。'],
  ['mixed', '重写剧本第2集，并翻译对白和导出 Word，保留剧情衔接。'],
  ['shell', '按认可稿重写四集短剧，直接用 Python 生成 Word 并交付，保持剧情衔接。'],
  ['session-isolation', '完成新写的四集短剧 Word，并明确按草稿状态交付。'],
  ['cancel-followup', '重写四集短剧并生成最终稿，保持剧情衔接。'],
  ['new-input', '重写四集短剧并生成最终稿，保持剧情衔接。'],
] as const

it.each(cases)('keeps delivery checks scoped for %s', async (mode, task) => {
  const patch = fileURLToPath(new URL('./fixtures/manuscript-final-delivery/controls.cordis.yml', import.meta.url))
  const { stderr } = await runLoaderSmoke({
    label: `manuscript delivery ${mode}`, tempDirPrefix: `manuscript-delivery-${mode}-`,
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json', task],
    env: { MUSE_DELIVERY_CONTROL: mode },
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode: 'src',
    inspect: async (cwd) => {
      const actual: unknown = JSON.parse(await readFile(join(cwd, '_controls-probe.json'), 'utf8'))
      const expectedText = await readFile(new URL('./expected/manuscript-delivery-controls.json', import.meta.url), 'utf8')
      const expected: unknown = JSON.parse(expectedText.replaceAll('{{nativeShell}}', process.platform === 'win32' ? 'pwsh' : 'bash'))
      expect(actual).toEqual(z.record(z.string(), z.unknown()).parse(expected)[mode])
    },
  })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
