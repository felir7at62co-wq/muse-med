/** Actual creation programs wait for durable review receipts and recover them after plugin HMR. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it.each(['src', 'lib'] as const)('delivers through actual PTC bindings in %s while review logging is delayed, then rebuilds its projection', async (mode) => {
  const patch = fileURLToPath(new URL('./fixtures/manuscript-final-delivery/ptc.cordis.yml', import.meta.url))
  const { stderr } = await runLoaderSmoke({
    label: `manuscript creation PTC delivery ${mode}`, tempDirPrefix: 'manuscript-ptc-delivery-',
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json', '用创作模式完成四集短剧，核对最终稿后交付文件。'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    ...mode === 'src' ? { sourceImport: 'tsx/esm' } : {},
    mode, env: { DSH_EXAMPLE_MODE: mode },
    inspect: async (cwd) => {
      const actual: unknown = JSON.parse(await readFile(join(cwd, '_ptc-delivery-probe.json'), 'utf8'))
      const expected: unknown = JSON.parse(await readFile(new URL('./expected/manuscript-ptc-delivery.json', import.meta.url), 'utf8'))
      expect(actual).toEqual(expected)
    },
  })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
