/** A continued revision task needs source comparison; a new creation keeps final-file internal review. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

const cases = [
  ['revision', '请修复 original.md 的剧情前后混乱，保留原稿第4集新增对白“陈岚：旧床已经拆好，新床垫也送到了。”及四集顺序，只修改必要的因果承接。先说明处理方式。'],
  ['creation', '新写四集短剧，人物为林青和陈岚，完成后交付 final.md，并核对剧情衔接。'],
] as const

describe.each(['src', 'lib'] as const)('manuscript review in %s', (launchMode) => {
  it.each(cases)('keeps original-review requirements for %s', async (mode, task) => {
    const patch = fileURLToPath(new URL('./fixtures/manuscript-revision-basis/cordis.yml', import.meta.url))
    const { stderr } = await runLoaderSmoke({
      label: `manuscript source review ${mode}`, tempDirPrefix: 'manuscript-revision-basis-',
      binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
      binArgs: ['--profile', 'headless', '--patch', patch, '--json', task],
      env: { MUSE_REVISION_BASIS_CASE: mode, DSH_EXAMPLE_MODE: launchMode },
      tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
      ...launchMode === 'src' ? { sourceImport: 'tsx/esm' } : {},
      mode: launchMode,
      inspect: async (cwd) => {
        const actual: unknown = JSON.parse(await readFile(join(cwd, '_revision-basis-probe.json'), 'utf8'))
        const expected: unknown = JSON.parse(await readFile(new URL('./expected/manuscript-revision-basis.json', import.meta.url), 'utf8'))
        expect(actual).toEqual(z.record(z.string(), z.unknown()).parse(expected)[mode])
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
