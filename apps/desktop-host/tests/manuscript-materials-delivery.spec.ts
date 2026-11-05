/** Manuscript roles, hashes and read coverage survive the real Loader-to-model tool round trip. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it('returns current, reference and candidate text with exact hashes and explicit unread ranges', async () => {
  const patch = fileURLToPath(new URL('./fixtures/manuscript-materials/cordis.yml', import.meta.url))
  const { stderr } = await runLoaderSmoke({
    label: 'manuscript materials', tempDirPrefix: 'manuscript-materials-loader-',
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json', '读取当前认可稿，分别列出参考稿与候选稿的实际内容和未读范围，不执行语义审校或覆盖稿件。'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode: 'src',
    inspect: async (cwd) => {
      const actual: unknown = JSON.parse(await readFile(join(cwd, '_materials-probe.json'), 'utf8'))
      const expected: unknown = JSON.parse(await readFile(new URL('./expected/manuscript-materials.json', import.meta.url), 'utf8'))
      expect(actual).toEqual(expected)
      const names = await readdir(join(cwd, '.sessions'), { recursive: true })
      const sessions = await Promise.all(names.filter(name => name.endsWith('.jsonl')).map(name => readFile(join(cwd, '.sessions', name), 'utf8')))
      const events = sessions.flatMap(text => text.trim().split('\n').map(line =>
        z.object({ type: z.string(), data: z.unknown().optional() }).parse(JSON.parse(line))))
      const calls = events.filter(event => event.type === 'tool/call').map(event =>
        z.object({ data: z.object({ name: z.literal('manuscript_revision'), arguments: z.string() }) }).parse(event))
      expect(calls).toHaveLength(6)
      expect(calls.map(call => z.object({ action: z.literal('materials') }).parse(JSON.parse(call.data.arguments)).action))
        .toEqual(Array(6).fill('materials'))
      expect(events.some(event => event.type === 'deliverables/presented')).toBe(false)
    },
  })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
