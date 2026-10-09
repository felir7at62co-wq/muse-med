/** Screenplay conversion preserves source order and never replaces an existing deliverable. */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { exportScreenplayDocx } from '../src/screenplay-docx.ts'
import { validateVideoDelivery } from '../src/video-delivery.ts'
import { sha256 } from '@deepseek-ai/dsh-screenplay-project'
import { resolvePrimaryRuntime } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { acceptedVideo } from './fixtures/video-delivery/accepted-video.ts'

const deliveryConfig = { source: process.env.MUSE_TEST_PRIMARY_RUNTIME ?? 'unused', maxProjectBytes: 1000000, maxInputBytes: 10000, timeoutMs: 30000 }


it.skipIf(!process.env.MUSE_TEST_PRIMARY_RUNTIME).each(['replace', 'table', 'footer'])(
  'rejects a generic Python %s body with a forged receipt pointing to a genuinely accepted candidate', async (change) => {
    const root = await mkdtemp(join(tmpdir(), 'forged-video-receipt-'))
    try {
      const fixture = await acceptedVideo(root), output = join(root, 'final', 'forged.docx')
      await exportScreenplayDocx({ inputs: [fixture.input], output }, {
        source: process.env.MUSE_TEST_PRIMARY_RUNTIME!, maxProjectBytes: 1000000, maxInputBytes: 10000, timeoutMs: 30000,
      })
      const runtime = await resolvePrimaryRuntime(process.env.MUSE_TEST_PRIMARY_RUNTIME!)
      await promisify(execFile)(runtime.python, ['-c', [
        'from docx import Document', 'import sys',
        'doc = Document() if sys.argv[2] == "replace" else Document(sys.argv[1])',
        'if sys.argv[2] == "replace": doc.add_paragraph("Unaccepted invented scene")',
        'if sys.argv[2] == "table": doc.add_table(rows=1, cols=1).cell(0, 0).text = "Unaccepted invented scene"',
        'if sys.argv[2] == "footer": doc.sections[0].footer.add_paragraph("Unaccepted invented scene")',
        'doc.save(sys.argv[1])',
      ].join('\n'), output, change], { windowsHide: true, timeout: 30000 })
      const receiptPath = `${output}.screenplay.json`
      const originalReceipt = z.object({ version: z.literal(1), output_sha256: z.string(), episodes: z.array(z.unknown()) })
        .parse(JSON.parse(await readFile(receiptPath, 'utf8')))
      const forgedBytes = await readFile(output)
      await writeFile(receiptPath, JSON.stringify({ ...originalReceipt, output_sha256: sha256(forgedBytes) }))
      await expect(validateVideoDelivery([output], deliveryConfig, new AbortController().signal)).rejects.toThrow('video_delivery_body_changed')
      expect(await readFile(output)).toEqual(forgedBytes)
      expect(await readFile(fixture.projectPath, 'utf8')).toBe(JSON.stringify(fixture.project))
    } finally { await rm(root, { recursive: true, force: true }) }
  },
)

it.skipIf(!process.env.MUSE_TEST_PRIMARY_RUNTIME)('exports an accepted video version, checks its receipt outside final, and rejects edited Word or revoked acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'accepted-video-docx-'))
  try {
    const fixture = await acceptedVideo(root), output = join(root, 'accepted.docx')
    await exportScreenplayDocx({ inputs: [fixture.input], output, project: fixture.projectPath }, {
      source: process.env.MUSE_TEST_PRIMARY_RUNTIME!, maxProjectBytes: 1000000, maxInputBytes: 10000, timeoutMs: 30000,
    })
    await expect(validateVideoDelivery([fixture.input, output], deliveryConfig, new AbortController().signal)).resolves.toBeUndefined()
    const original = await readFile(output)
    await writeFile(output, 'Edited Word output')
    await expect(validateVideoDelivery([output], deliveryConfig, new AbortController().signal)).rejects.toThrow('video_delivery_changed')
    await writeFile(output, original)
    await writeFile(fixture.projectPath, JSON.stringify({ ...fixture.project, accepted: [] }))
    await expect(validateVideoDelivery([output], deliveryConfig, new AbortController().signal)).rejects.toThrow('video_delivery_unaccepted')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses changed managed sources and an explicit missing project without restricting ordinary final folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-source-check-'))
  try {
    const fixture = await acceptedVideo(root)
    await writeFile(fixture.source, 'changed')
    await expect(validateVideoDelivery([fixture.input], deliveryConfig, new AbortController().signal)).rejects.toThrow('source_changed')
    await expect(exportScreenplayDocx({ inputs: [fixture.input], output: join(root, 'out.docx'), project: join(root, 'missing.json') },
      { source: 'unused', maxProjectBytes: 1000000, maxInputBytes: 10000, timeoutMs: 1000 })).rejects.toThrow('video_delivery_project')
    await writeFile(fixture.projectPath, JSON.stringify({ purpose: 'Ordinary document conversion' }))
    await expect(validateVideoDelivery([fixture.input], deliveryConfig, new AbortController().signal)).resolves.toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses a missing source before resolving the bundled runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'screenplay-docx-'))
  try {
    await expect(exportScreenplayDocx({ inputs: [join(root, 'missing.md')], output: join(root, '剧本.docx') },
      { source: join(root, 'runtime'), maxProjectBytes: 1000000, maxInputBytes: 1000, timeoutMs: 1000 })).rejects.toThrow()
    await writeFile(join(root, '剧本.docx'), 'existing')
    await writeFile(join(root, '剧本.md'), '第1集')
    await expect(exportScreenplayDocx({ inputs: [join(root, '剧本.md')], output: join(root, '剧本.docx') },
      { source: join(root, 'runtime'), maxProjectBytes: 1000000, maxInputBytes: 1000, timeoutMs: 1000 })).rejects.toThrow('already exists')
    expect(await readFile(join(root, '剧本.docx'), 'utf8')).toBe('existing')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(!process.env.MUSE_TEST_PRIMARY_RUNTIME)('refuses unaccepted Markdown in a managed video project through the direct exporter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-screenplay-docx-'))
  try {
    await mkdir(join(root, 'qa'));await mkdir(join(root, 'final'))
    const now = new Date().toISOString()
    await writeFile(join(root, 'qa', 'screenplay-project.json'), JSON.stringify({
      format_version: 1, id: 'p:fixed-video', revision: 0, mode: 'faithful', workflow: 'video_to_screenplay',
      instructions: '忠实视频整理。', created_at: now, updated_at: now, sources: [], facts: [], candidates: [], accepted: [],
    }))
    const input = join(root, 'final', 'unaccepted.md'), output = join(root, 'final', 'unaccepted.docx')
    await writeFile(input, '第1集\n1-1 门口 日 内\n人物：甲\n甲：你好。\n')
    await expect(exportScreenplayDocx({ inputs: [input], output }, {
      source: process.env.MUSE_TEST_PRIMARY_RUNTIME!, maxProjectBytes: 1000000, maxInputBytes: 10000, timeoutMs: 30000,
    })).rejects.toThrow('video_delivery_unaccepted')
    await expect(readFile(output)).rejects.toThrow()
    await writeFile(output, 'Word made through a generic Python conversion')
    await expect(validateVideoDelivery([output], deliveryConfig, new AbortController().signal)).rejects.toThrow('video_delivery_unaccepted')
    await expect(validateVideoDelivery([input], deliveryConfig, new AbortController().signal)).rejects.toThrow('video_delivery_unaccepted')
    await writeFile(join(root, 'ordinary.docx'), 'Ordinary document outside managed final scope')
    await expect(validateVideoDelivery([join(root, 'ordinary.docx')], deliveryConfig, new AbortController().signal)).resolves.toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


it.skipIf(!process.env.MUSE_TEST_PRIMARY_RUNTIME)('exports ordered Chinese Markdown using the packaged runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'screenplay-docx-runtime-'))
  try {
    const first = join(root, '第1集.md')
    const second = join(root, '第2集.md')
    const output = join(root, '完整剧本.docx')
    await writeFile(first, '# 第1集\n1-1 老屋 夜 内\n人物：林遥、周宁\n▲林遥放下信。\n林遥 OS：不能告诉他。\n周宁：你怎么了？\n林遥：没事。\n')
    await writeFile(second, '# 第2集\n2-1 门口 日 外\n人物：林遥\n▲林遥推开门。\n**【下集钩子】**\n林遥：是你？\n')
    expect(await exportScreenplayDocx({ inputs: [first, second], output }, {
      source: process.env.MUSE_TEST_PRIMARY_RUNTIME!, maxProjectBytes: 1000000, maxInputBytes: 10000, timeoutMs: 30000,
    })).toEqual({ output })
    const bytes = await readFile(output)
    expect(bytes.subarray(0, 2).toString()).toBe('PK')
    expect(bytes.length).toBeGreaterThan(1000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


it.skipIf(!process.env.MUSE_TEST_PRIMARY_RUNTIME)('accepts a directory alias for the same project but rejects a different project receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-project-alias-'))
  try {
    const original = join(root, 'original'), alias = join(root, 'alias'), other = join(root, 'other')
    await mkdir(original); await mkdir(other)
    const fixture = await acceptedVideo(original), otherFixture = await acceptedVideo(other)
    await symlink(original, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const output = join(original, 'final', 'accepted.docx')
    await exportScreenplayDocx({ inputs: [fixture.input], output }, deliveryConfig)
    const receiptPath = `${output}.screenplay.json`
    const receipt = z.object({ episodes: z.array(z.object({ project: z.string() }).loose()) }).loose()
      .parse(JSON.parse(await readFile(receiptPath, 'utf8')))
    receipt.episodes[0]!.project = join(alias, 'qa', 'screenplay-project.json')
    await writeFile(receiptPath, JSON.stringify(receipt))
    await expect(validateVideoDelivery([output], deliveryConfig, new AbortController().signal)).resolves.toBeUndefined()
    await expect(validateVideoDelivery([join(alias, 'final', 'accepted.docx')], deliveryConfig, new AbortController().signal)).resolves.toBeUndefined()
    receipt.episodes[0]!.project = otherFixture.projectPath
    await writeFile(receiptPath, JSON.stringify(receipt))
    await expect(validateVideoDelivery([output], deliveryConfig, new AbortController().signal)).rejects.toThrow('video_delivery_project')
  } finally { await rm(root, { recursive: true, force: true }) }
})
