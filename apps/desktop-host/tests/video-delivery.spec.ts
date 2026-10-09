/** Managed delivery gates run in the shipped Headless composition without a model API. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { resolvePrimaryRuntime } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { exportScreenplayDocx } from '../src/screenplay-docx.ts'
import { sha256 } from '@deepseek-ai/dsh-screenplay-project'
import { acceptedVideo } from './fixtures/video-delivery/accepted-video.ts'

it('blocks generic Word, Markdown and Office bypasses at the actual present executor while allowing an ordinary document', async () => {
  const patch = fileURLToPath(new URL('./fixtures/video-delivery/cordis.yml', import.meta.url))
  const { stderr } = await runLoaderSmoke({
    label: 'managed video delivery', tempDirPrefix: 'video-delivery-loader-',
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)),
    configPath: patch, binArgs: ['--profile', 'headless', '--patch', patch, '--patch', './runtime.patch.yml', '--json', '验证受管视频交付。'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    sourceImport: 'tsx/esm', mode: 'src',
    prepare: async (cwd) => {
      await writeFile(join(cwd, 'runtime.patch.yml'), `- id: screenplay-docx\n  config:\n    source: ${JSON.stringify(process.env.MUSE_TEST_PRIMARY_RUNTIME ?? './unused-runtime')}\n`)
      if (process.env.MUSE_TEST_PRIMARY_RUNTIME) {
        const fixture = await acceptedVideo(cwd), output = join(cwd, 'final', 'forged.docx')
        await exportScreenplayDocx({ inputs: [fixture.input], output }, {
          source: process.env.MUSE_TEST_PRIMARY_RUNTIME, maxInputBytes: 1000000, maxProjectBytes: 1000000, timeoutMs: 30000,
        })
        const runtime = await resolvePrimaryRuntime(process.env.MUSE_TEST_PRIMARY_RUNTIME)
        await promisify(execFile)(runtime.python, ['-c',
          'import sys\nfrom docx import Document\nd = Document()\nd.add_paragraph("Unaccepted scene")\nd.save(sys.argv[1])', output],
        { windowsHide: true, timeout: 30000 })
        const record = z.object({ version: z.literal(1), output_sha256: z.string(), episodes: z.array(z.unknown()) })
          .parse(JSON.parse(await readFile(`${output}.screenplay.json`, 'utf8')))
        await writeFile(`${output}.screenplay.json`, JSON.stringify({ ...record, output_sha256: sha256(await readFile(output)) }))
      } else {
        await mkdir(join(cwd, 'qa')); await mkdir(join(cwd, 'final'))
        const now = '2026-10-09T00:00:00.000Z'
        await writeFile(join(cwd, 'qa', 'screenplay-project.json'), JSON.stringify({
          format_version: 1, id: 'p:fixture-video', revision: 0, mode: 'faithful', workflow: 'video_to_screenplay',
          instructions: '固定离线交付输入。', created_at: now, updated_at: now, sources: [], facts: [], candidates: [], accepted: [],
        }))
      }
      // These are external converter outputs, never application-issued accepted exports.
      const unacceptedWord = join(cwd, 'final', 'unaccepted.docx')
      if (process.env.MUSE_TEST_PRIMARY_RUNTIME) {
        const runtime = await resolvePrimaryRuntime(process.env.MUSE_TEST_PRIMARY_RUNTIME)
        await promisify(execFile)(runtime.python, ['-c',
          'import sys\nfrom docx import Document\nd = Document()\nd.add_paragraph("Generic Word output")\nd.save(sys.argv[1])', unacceptedWord],
        { windowsHide: true, timeout: 30000, env: { ...process.env, PYTHONUTF8: '1' } })
      } else await writeFile(unacceptedWord, 'Generic Word output')
      await writeFile(join(cwd, 'final', 'unaccepted.md'), '第1集\n甲：你好。\n')
      await writeFile(join(cwd, 'final', 'unaccepted.xlsx'), 'A screenplay copied into an Office spreadsheet')
      await writeFile(join(cwd, 'ordinary.docx'), 'Ordinary document')
    },
    inspect: async (cwd) => {
      const names = await readdir(join(cwd, '.sessions'), { recursive: true })
      const logs = await Promise.all(names.filter(value => value.endsWith('.jsonl')).map(value => readFile(join(cwd, '.sessions', value), 'utf8')))
      const events = logs.flatMap(text => text.trim().split('\n')
        .map(line => z.object({ type: z.string(), data: z.unknown().optional() }).parse(JSON.parse(line))))
      const delivered = events.filter(value => value.type === 'deliverables/presented')
        .map(value => z.object({ data: z.object({ files: z.array(z.object({ path: z.string() })) }) }).parse(value))
      expect(delivered, logs.join('\n').split('\n').filter(line => /tools\/result|tool\/result|tool\/call/.test(line)).join('\n')).toHaveLength(1)
      expect(delivered[0]?.data.files).toEqual([{ path: 'ordinary.docx' }])
      const results = events.filter(value => value.type === 'tool/result')
        .map(value => z.object({ data: z.object({
          message: z.object({ content: z.array(z.object({ text: z.string() })) }) }) }).parse(value))
      expect(results.slice(0, 3).map(value => value.data.message.content[0]?.text)).toEqual([
        expect.stringContaining('video_delivery_unaccepted'), expect.stringContaining('video_delivery_unaccepted'),
        expect.stringContaining('video_delivery_unaccepted'),
      ])
      if (process.env.MUSE_TEST_PRIMARY_RUNTIME) {
        expect(results[3]?.data.message.content[0]?.text).toContain('video_delivery_body_changed')
      }
    },
  })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
