/** Actual creation programs retain source bindings through compaction, HMR and final dispatch. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke, resolveExampleMode, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'
import { z } from 'zod'

const task = '请依据这段视频新写一集短剧并交付Markdown文件；仅对实际抽样画面和保存ASR声明来源范围。'

it.each([resolveExampleMode()])('binds sampled sources to real PTC delivery in %s and rejects stale declarations and dispatches', async (mode) => {
  const patch = fileURLToPath(new URL('./fixtures/manuscript-video-source-binding/cordis.yml', import.meta.url))
  const { stderr } = await runLoaderSmoke({
    label: `manuscript video source binding ${mode}`, tempDirPrefix: 'manuscript-video-binding-',
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json', task],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    ...mode === 'src' ? { sourceImport: 'tsx/esm' } : {}, mode, env: { DSH_EXAMPLE_MODE: mode },
    inspect: async (cwd) => {
      const actual: unknown = JSON.parse(await readFile(join(cwd, '_source-binding-probe.json'), 'utf8'))
      const expected: unknown = JSON.parse(await readFile(new URL('./fixtures/manuscript-video-source-binding/expected.json', import.meta.url), 'utf8'))
      expect(actual).toEqual(expected)
      const files = (await readdir(join(cwd, '.sessions'), { recursive: true })).filter(name => name.endsWith('.jsonl'))
      expect(files).toHaveLength(8)
      const logs = await Promise.all(files.map(name => readFile(join(cwd, '.sessions', name), 'utf8')))
      const session = z.object({ type: z.literal('session'), parentSession: z.string().optional() })
      const parent = logs.find(log => session.parse(JSON.parse(log.split('\n')[0]!)).parentSession === undefined)
      expect(parent).toBeDefined()
      const events = parent!.trim().split('\n').slice(1).map(line =>
        z.object({ type: z.string(), data: z.unknown() }).parse(JSON.parse(line)))
      const dispatches = events.filter(event => event.type === 'tool/ptc-dispatch').map(event =>
        z.object({ data: z.object({ name: z.string(), isError: z.boolean(), content: z.array(z.object({
          type: z.literal('text'), text: z.string() })), meta: z.record(z.string(), z.unknown()).optional() }) }).parse(event).data)
      const sourceFacts = dispatches.filter(dispatch => dispatch.name === 'manuscript_revision'
        && (JSON.stringify(dispatch.meta) ?? '').includes('"state":"video_source_review"'))
      expect(sourceFacts).toHaveLength(3)
      for (const fact of sourceFacts) {
        expect(fact.content).toEqual([{ type: 'text', text: '[compact manuscript fact; authoritative metadata retained]' }])
        expect(JSON.stringify(fact.meta)).toContain('source_manifest')
      }
      expect(events.filter(event => event.type === 'deliverables/presented')).toHaveLength(3)
    },
  })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
