/** Screenplay deliveries use real tool calls, spawned reviews and durable present events. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it('requires current review evidence or an explicit draft label before presenting screenplay files', async () => {
  const patch = fileURLToPath(new URL('./fixtures/manuscript-final-delivery/cordis.yml', import.meta.url))
  const { stderr } = await runLoaderSmoke({
    label: 'manuscript final delivery', tempDirPrefix: 'manuscript-final-delivery-loader-',
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json', '按认可稿写四集短剧并交付 Markdown 和 Word。新稿须核对剧情衔接；有待修问题时明确交付草稿。'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode: 'src',
    inspect: async (cwd) => {
      const actual: unknown = JSON.parse(await readFile(join(cwd, '_delivery-probe.json'), 'utf8'))
      const expected: unknown = JSON.parse(await readFile(new URL('./expected/manuscript-final-delivery.json', import.meta.url), 'utf8'))
      expect(actual).toEqual(expected)
      const names = (await readdir(join(cwd, '.sessions'), { recursive: true })).filter(name => name.endsWith('.jsonl'))
      expect(names).toHaveLength(5)
    },
  })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
