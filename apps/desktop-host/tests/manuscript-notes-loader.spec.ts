/** The shipped profile preserves actual Word annotations and supplies them to real isolated reviewers. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleMode } from '@deepseek-ai/dsh-loader-smoke'

it.each([resolveExampleMode()])('retains Word comments and earlier requirements through %s tools and independent review', async (mode) => {
  const patch = fileURLToPath(new URL('./fixtures/manuscript-notes/cordis.yml', import.meta.url))
  const result = await runLoaderSmoke({ label: 'manuscript notes', tempDirPrefix: 'manuscript-notes-loader-',
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json', '只读检查 current.docx 与 candidate.md；保留批注和完整要求，第三集不要动。'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode,
    env: { DSH_EXAMPLE_MODE: mode },
    inspect: async (cwd) => {
      const actual: unknown = JSON.parse(await readFile(join(cwd, '_notes-probe.json'), 'utf8'))
      const expected: unknown = JSON.parse(await readFile(new URL('./expected/manuscript-notes.json', import.meta.url), 'utf8'))
      expect(actual).toEqual(expected)
    } })
  expect(result.stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
