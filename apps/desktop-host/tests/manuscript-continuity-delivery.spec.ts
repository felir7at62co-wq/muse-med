/** Real spawned read-only reviewer sessions return validated evidence to the calling model. */
import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it('spawns the selected model with read-only tools and rejects fabricated or stale review evidence', async () => {
  const patch = fileURLToPath(new URL('./fixtures/manuscript-continuity/cordis.yml', import.meta.url))
  const { stderr } = await runLoaderSmoke({
    label: 'manuscript continuity', tempDirPrefix: 'manuscript-continuity-loader-',
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json', '对显式选中的候选稿执行只读衔接审校，保留实际证据和未知项。'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode: 'src',
    inspect: async (cwd) => {
      const actual: unknown = JSON.parse(await readFile(join(cwd, '_continuity-probe.json'), 'utf8'))
      const expected: unknown = JSON.parse(await readFile(new URL('./expected/manuscript-continuity.json', import.meta.url), 'utf8'))
      expect(actual).toEqual(expected)
      await expect(access(join(cwd, 'forbidden-child-write.md'))).rejects.toMatchObject({ code: 'ENOENT' })
      const names = (await readdir(join(cwd, '.sessions'), { recursive: true })).filter(name => name.endsWith('.jsonl'))
      expect(names).toHaveLength(4)
      const logs = await Promise.all(names.map(name => readFile(join(cwd, '.sessions', name), 'utf8')))
      const header = z.object({ type: z.literal('session'), id: z.string(), parentSession: z.string().optional() })
      const sessions = logs.map(text => ({ header: header.parse(JSON.parse(text.split('\n')[0]!)), text }))
      const parent = sessions.find(session => session.header.parentSession === undefined)
      expect(parent).toBeDefined()
      const children = sessions.filter(session => session.header.parentSession === parent?.header.id)
      expect(children).toHaveLength(3)
      const events = children.flatMap(session => session.text.trim().split('\n').slice(1).map(line =>
        z.object({ type: z.string(), data: z.unknown().optional() }).parse(JSON.parse(line))))
      const calls = events.filter(event => event.type === 'tool/call').map(event =>
        z.object({ data: z.object({ name: z.string() }) }).parse(event).data.name)
      expect(calls.filter(name => name === 'structured_output')).toHaveLength(3)
      expect(calls.filter(name => name === 'write')).toHaveLength(1)
    },
  })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
