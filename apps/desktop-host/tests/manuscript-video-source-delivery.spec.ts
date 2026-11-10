/** Source samples and invalidation pass through the real dsh profile and persisted child Sessions. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'
import { z } from 'zod'

const task = '检查视频转剧本的已映射来源材料，验证遗漏、伪造引用和材料变化不能获得已通过结论。'
const headerSchema = z.object({ type: z.literal('session'), id: z.string(), parentSession: z.string().optional() })
const eventSchema = z.object({ type: z.string(), data: z.unknown().optional() })
const promptSchema = z.object({ type: z.literal('user/message'), data: z.object({
  content: z.array(z.union([z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('image'), attachment: z.object({ attachmentId: z.string() }) })])),
}) })

it.each(['src', 'lib'] as const)('carries cached originals to real reviewers in %s and rejects incomplete, invented or changed source evidence', async (mode) => {
  const patch = fileURLToPath(new URL('./fixtures/manuscript-video-source/cordis.yml', import.meta.url))
  const { stderr } = await runLoaderSmoke({
    label: `manuscript video source ${mode}`, tempDirPrefix: 'manuscript-video-source-',
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json', task],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    ...mode === 'src' ? { sourceImport: 'tsx/esm' } : {}, mode, env: { DSH_EXAMPLE_MODE: mode },
    inspect: async (cwd) => {
      const actual: unknown = JSON.parse(await readFile(join(cwd, '_video-source-probe.json'), 'utf8'))
      const expected: unknown = JSON.parse(await readFile(new URL('./fixtures/manuscript-video-source/expected.json', import.meta.url), 'utf8'))
      expect(actual).toEqual(expected)
      const files = (await readdir(join(cwd, '.sessions'), { recursive: true })).filter(name => name.endsWith('.jsonl'))
      expect(files).toHaveLength(9)
      const logs = await Promise.all(files.map(name => readFile(join(cwd, '.sessions', name), 'utf8')))
      const sessions = logs.map((log) => {
        const lines = log.trim().split('\n')
        return { header: headerSchema.parse(JSON.parse(lines[0]!)),
          events: lines.slice(1).map(line => eventSchema.parse(JSON.parse(line))) }
      })
      const parent = sessions.find(session => session.header.parentSession === undefined)
      expect(parent).toBeDefined()
      const children = sessions.filter(session => session.header.parentSession === parent?.header.id)
      expect(children).toHaveLength(8)
      for (const child of children) {
        const prompts = child.events.filter(event => event.type === 'user/message').map(event => promptSchema.parse(event))
        const blocks = prompts.flatMap(event => event.data.content)
        expect(blocks.filter(block => block.type === 'image')).toHaveLength(2)
        const text = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        expect(text).toContain('preserve raw row A')
        expect(text).toContain('preserve raw row B')
        expect(text).not.toContain('UNTRUSTED_OLD_OBSERVATION_ALREADY_DEMOLISHED')
        const calls = child.events.filter(event => event.type === 'tool/call').map(event =>
          z.object({ data: z.object({ name: z.string() }) }).parse(event).data.name)
        expect(calls).toEqual(['structured_output'])
      }
    },
  })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
