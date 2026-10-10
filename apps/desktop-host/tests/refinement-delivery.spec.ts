/** Final-bound precision-edit notes remain separate from screenplay and Word bodies. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { sha256 } from '@deepseek-ai/dsh-screenplay-project'
import { resolvePrimaryRuntime } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { approveVideoMarkdown, validateVideoDelivery } from '../src/video-delivery.ts'
import { exportScreenplayDocx } from '../src/screenplay-docx.ts'
import { acceptedRefinement } from './fixtures/video-delivery/accepted-refinement.ts'

const config = { source: process.env.MUSE_TEST_PRIMARY_RUNTIME ?? 'unused', maxProjectBytes: 1000000, maxInputBytes: 10000, timeoutMs: 30000 }

it.each([true, false])('accepts a separate final report and pure screenplay, with video marker %s', async (video) => {
  const root = await mkdtemp(join(tmpdir(), 'refinement-delivery-'))
  try {
    const fixture = await acceptedRefinement(root, video)
    await expect(validateVideoDelivery([fixture.input, fixture.report], config, new AbortController().signal)).resolves.toBeUndefined()
    await expect(validateVideoDelivery([fixture.input], config, new AbortController().signal)).rejects.toThrow('refinement_delivery_pair')
    await expect(validateVideoDelivery([fixture.report], config, new AbortController().signal)).resolves.toBeUndefined()
    expect(await readFile(fixture.input, 'utf8')).not.toContain('修改说明')
    const report = await readFile(fixture.report, 'utf8')
    expect(report).toContain(fixture.project.candidates[0]!.sha256)
    expect(report).toContain('not_run')
    expect(report).toContain('你好。')
    expect(report).toContain('你好呀。')
    await expect(approveVideoMarkdown([fixture.report], join(root, 'out.docx'), config.maxProjectBytes, fixture.projectPath))
      .rejects.toThrow('video_delivery_unaccepted')
    const approved = await approveVideoMarkdown([fixture.input], join(root, 'out.docx'), config.maxProjectBytes, fixture.projectPath)
    expect(approved?.contents).toEqual([fixture.rendered.script])
    expect(approved?.episodes[0]?.modification_notes_sha256).toBe(sha256(report))
    await writeFile(fixture.report, `${report}\n所有检查已通过。`)
    await expect(validateVideoDelivery([fixture.report], config, new AbortController().signal)).rejects.toThrow('video_delivery_unaccepted')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('requires the matching current candidate report, not another accepted precision-edit report', async () => {
  const first = await mkdtemp(join(tmpdir(), 'refinement-first-')), second = await mkdtemp(join(tmpdir(), 'refinement-second-'))
  try {
    const a = await acceptedRefinement(first), b = await acceptedRefinement(second)
    await expect(validateVideoDelivery([a.input, b.report], config, new AbortController().signal)).rejects.toThrow('refinement_delivery_pair')
    await expect(validateVideoDelivery([a.input, b.report, a.report], config, new AbortController().signal)).resolves.toBeUndefined()
  } finally { await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }) }
})

it('rejects a stale accepted report or edited candidate and preserves the original source project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refinement-report-binding-'))
  try {
    const fixture = await acceptedRefinement(root)
    const sourceBytes = await readFile(fixture.original.projectPath), project = structuredClone(fixture.project)
    project.candidates[0]!.refinement!.notes.changes[0]!.reason = '另一份尚未复检的说明。'
    await writeFile(fixture.projectPath, JSON.stringify(project))
    await expect(validateVideoDelivery([fixture.input, fixture.report], config, new AbortController().signal)).rejects.toThrow('invalid_candidate_digest')
    project.candidates[0]!.scenes[0]!.beats[0]!.text = '新剧情。'
    await writeFile(fixture.projectPath, JSON.stringify(project))
    await expect(validateVideoDelivery([fixture.report], config, new AbortController().signal)).rejects.toThrow('invalid_candidate_digest')
    expect(await readFile(fixture.original.projectPath)).toEqual(sourceBytes)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('presents actual screenplay_project exported body and report, and rejects a changed report in the shipped Host', async () => {
  const patch = fileURLToPath(new URL('./fixtures/video-delivery/refinement.cordis.yml', import.meta.url))
  const { stderr } = await runLoaderSmoke({
    label: 'precision-edit export delivery', tempDirPrefix: 'refinement-delivery-loader-',
    binScript: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)),
    configPath: patch, binArgs: ['--profile', 'headless', '--patch', patch, '--patch', './runtime.patch.yml', '--json', '验证精修说明独立交付。'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode: 'src',
    prepare: async (cwd) => {
      await acceptedRefinement(cwd, false)
      await writeFile(join(cwd, 'runtime.patch.yml'), `- id: screenplay-docx\n  config:\n    source: ${JSON.stringify(config.source)}\n    maxInputBytes: 1000000\n    maxProjectBytes: 1000000\n    timeoutMs: 30000\n`)
    },
    inspect: async (cwd) => {
      const stem = 'episode-1-22222222-2222-4222-8222-222222222222'
      const directory = join(cwd, 'refined', 'final', 'exported')
      const source = await readFile(join(directory, `${stem}.md`), 'utf8')
      const report = await readFile(join(cwd, 'fixture-exported-report.md'), 'utf8')
      expect(source).not.toContain('修改说明'); expect(report).toContain('《修改说明》'); expect(report.endsWith('\n')).toBe(true)
      const sidecar = z.object({ modification_notes: z.object({ file: z.string(), sha256: z.string() }) })
        .parse(JSON.parse(await readFile(join(directory, `${stem}.sources.json`), 'utf8')))
      expect(sidecar.modification_notes.sha256).toBe(sha256(report))
      const logs = await readFile(join(cwd, 'fixture-tool-results.json'), 'utf8')
      const results = z.array(z.object({ name: z.string(), isError: z.boolean() })).parse(JSON.parse(logs))
      expect(results.slice(0, 2)).toEqual([{ name: 'screenplay_project', isError: false }, { name: 'present', isError: false }])
      const errors = await readFile(join(cwd, 'fixture-errors.txt'), 'utf8')
      if (process.env.MUSE_TEST_PRIMARY_RUNTIME) {
        expect(results.slice(2, 5), errors).toEqual([
          { name: 'screenplay_export_docx', isError: false }, { name: 'present', isError: true }, { name: 'present', isError: false },
        ])
        expect(errors).toContain('refinement_delivery_pair')
      }
      expect(results.at(-1)).toEqual({ name: 'present', isError: true })
    },
  })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it.skipIf(!process.env.MUSE_TEST_PRIMARY_RUNTIME)('exports a pure Word body and binds the separate notes in its receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refinement-word-body-'))
  try {
    const fixture = await acceptedRefinement(root, false), output = join(root, 'accepted.docx')
    await exportScreenplayDocx({ inputs: [fixture.input], output, project: fixture.projectPath }, config)
    await expect(validateVideoDelivery([output, fixture.report], config, new AbortController().signal)).resolves.toBeUndefined()
    await expect(validateVideoDelivery([output], config, new AbortController().signal)).resolves.toBeUndefined()
    const runtime = await resolvePrimaryRuntime(config.source)
    const body = await promisify(execFile)(runtime.python, ['-c',
      'from docx import Document\nimport sys\nprint("\\n".join(p.text for p in Document(sys.argv[1]).paragraphs))', output],
    { windowsHide: true, timeout: 30000, env: { ...process.env, PYTHONUTF8: '1' } })
    expect(body.stdout).toContain('你好呀。'); expect(body.stdout).not.toContain('修改说明')
    const receiptPath = `${output}.screenplay.json`
    const receipt = z.object({ episodes: z.array(z.object({ modification_notes_sha256: z.string().optional() }).loose()) }).loose()
      .parse(JSON.parse(await readFile(receiptPath, 'utf8')))
    expect(receipt.episodes[0]!.modification_notes_sha256).toBe(sha256(fixture.rendered.modification_notes!))
    delete receipt.episodes[0]!.modification_notes_sha256
    await writeFile(receiptPath, JSON.stringify(receipt))
    await expect(validateVideoDelivery([output], config, new AbortController().signal)).rejects.toThrow('video_delivery_unaccepted')
    await expect(exportScreenplayDocx({ inputs: [fixture.report], output: join(root, 'notes.docx'), project: fixture.projectPath }, config))
      .rejects.toThrow('video_delivery_unaccepted')
  } finally { await rm(root, { recursive: true, force: true }) }
})
