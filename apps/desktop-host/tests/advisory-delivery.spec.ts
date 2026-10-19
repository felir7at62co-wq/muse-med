/** Advisory delivery reads actual files without requiring creative approval records. */
import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { PROJECT_FILE } from '@deepseek-ai/dsh-screenplay-project'
import { ProjectCommands } from '../../../packages/drama/screenplay-project/src/project.ts'
import * as screenplayDocx from '../src/screenplay-docx.ts'
import { approveVideoMarkdown, validateVideoDelivery, verifyWordBody } from '../src/video-delivery.ts'
import { acceptedVideo } from './fixtures/video-delivery/accepted-video.ts'

const roots: string[] = [], contexts: Context[] = []
const signal = new AbortController().signal
const config: screenplayDocx.Config = { source: process.env.MUSE_TEST_PRIMARY_RUNTIME ?? 'unused',
  maxProjectBytes: 1_000_000, maxInputBytes: 10_000, timeoutMs: 30_000, reviewMode: 'advisory' }
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'advisory-delivery-')); roots.push(root)
  const fixture = await acceptedVideo(root)
  await writeFile(fixture.projectPath, JSON.stringify({ ...fixture.project, accepted: [] }))
  return { root, ...fixture }
}

function word(text: string): Uint8Array {
  return zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="urn:test"><w:body>'
    + `<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`) })
}

it('allows the current draft in a managed final directory without accepting its candidates or requiring notes', async () => {
  const f = await workspace()
  await writeFile(f.input, '第1集\n甲：这是Agent决定交付的新稿。\n')
  await expect(validateVideoDelivery([f.input], config, signal)).resolves.toBeUndefined()
  await expect(validateVideoDelivery([f.input], { ...config, reviewMode: 'strict' }, signal)).rejects.toThrow('video_delivery_unaccepted')
  await expect(approveVideoMarkdown([f.input], join(f.root, 'final/new.docx'), config.maxProjectBytes,
    f.projectPath, undefined, 'advisory')).resolves.toBeUndefined()
  expect(JSON.parse(await readFile(f.projectPath, 'utf8'))).toMatchObject({ accepted: [] })
})

it('does not revive historical approval, stale hash, missing project or malformed receipt requirements for a readable Word', async () => {
  const f = await workspace(), output = join(f.root, 'final/returned.docx')
  const bytes = word('用户已经修改的正文。')
  await writeFile(output, bytes)
  for (const previous of ['not JSON', JSON.stringify({ version: 1, output_sha256: '0'.repeat(64),
    episodes: [{ project: join(f.root, 'missing.json'), candidate_id: 'unreviewed' }] })]) {
    await writeFile(`${output}.screenplay.json`, previous)
    await expect(validateVideoDelivery([output], config, signal)).resolves.toBeUndefined()
  }
  await writeFile(f.projectPath, 'old project metadata cannot be decoded')
  await expect(validateVideoDelivery([f.input, output], config, signal)).resolves.toBeUndefined()
  expect(await readFile(output)).toEqual(Buffer.from(bytes))
})

it('uses the registered delivery validator for both GUI declarations and IM file handoffs', async () => {
  const f = await workspace(), ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(screenplayDocx, config)
  const output = join(f.root, 'final/external.docx')
  await writeFile(output, word('无审批记录的外部Word。'))
  for (const file of [f.input, output]) await expect(ctx.serial('deliverables/validate', [file], signal)).resolves.toBeUndefined()
  await writeFile(output, 'not a Word archive')
  await expect(ctx.serial('deliverables/validate', [output], signal)).rejects.toThrow()
})

it('retains current-file existence, readable Word, budget and cancellation checks', async () => {
  const f = await workspace(), output = join(f.root, 'final/broken.docx')
  await expect(validateVideoDelivery([join(f.root, 'missing.md')], config, signal)).rejects.toThrow()
  await writeFile(output, 'invalid Word')
  await expect(validateVideoDelivery([output], config, signal)).rejects.toThrow()
  await writeFile(f.input, 'oversized actual input')
  await expect(validateVideoDelivery([f.input], { ...config, maxInputBytes: 3 }, signal)).rejects.toThrow('MANUSCRIPT_FILE')
  const abort = new AbortController(); abort.abort()
  await expect(validateVideoDelivery([f.input], config, abort.signal)).rejects.toThrow()
})

it.skipIf(!process.env.MUSE_TEST_PRIMARY_RUNTIME)('converts current Markdown to real Word without adding an approval receipt or overwriting output', async () => {
  const f = await workspace(), output = join(f.root, 'final/unreviewed.docx')
  const text = '# 第1集\n1-1 门口 日 内\n人物：甲\n甲：这份正文尚无独立审校。\n'
  await writeFile(f.input, text)
  expect(await screenplayDocx.exportScreenplayDocx({ inputs: [f.input], output, project: f.projectPath }, config, signal))
    .toEqual({ output })
  const bytes = await readFile(output)
  expect(bytes.subarray(0, 2).toString()).toBe('PK')
  await expect(readFile(`${output}.screenplay.json`)).rejects.toThrow()
  await expect(validateVideoDelivery([output], config, signal)).resolves.toBeUndefined()
  expect(await readFile(f.input, 'utf8')).toBe(text)
  await expect(screenplayDocx.exportScreenplayDocx({ inputs: [f.input], output }, config, signal)).rejects.toThrow('already exists')
  expect(await readFile(output)).toEqual(bytes)
})

it.skipIf(!process.env.MUSE_TEST_PRIMARY_RUNTIME)('checks an advisory Word against the complete pinned Markdown even without managed project metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advisory-ordinary-word-')); roots.push(root)
  const input = join(root, 'ordinary.md'), output = join(root, 'ordinary.docx')
  await mkdir(join(root, 'final'))
  await writeFile(input, '第1集\n甲：普通稿件。\n')
  await expect(screenplayDocx.exportScreenplayDocx({ inputs: [input], output }, config, signal)).resolves.toEqual({ output })
  await expect(validateVideoDelivery([output], config, signal)).resolves.toBeUndefined()
  await expect(verifyWordBody(output, ['第1集\n甲：被替换成另一份正文。\n'], config, signal)).rejects.toThrow('video_delivery_body_changed')
})

it.skipIf(!process.env.MUSE_TEST_PRIMARY_RUNTIME)('converts an actual unadopted third-episode export and delivers its Word without requiring earlier episodes', async () => {
  const f = await workspace(), ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: f.root })
  await ctx.plugin(LocalAttachmentStore, { dshHome: f.root })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(screenplayDocx, config)
  const commands = new ProjectCommands(ctx.fs, { maxSourceBytes: 100_000, maxProjectBytes: config.maxProjectBytes,
    maxReadUnits: 30, maxReadBytes: 100_000, maxFactBatch: 20 }, ctx.attachments, 'advisory')
  const execution = { actor: f.project.candidates[0]!.author, cwd: f.root, signal }
  const current = async () => PROJECT_FILE.parse(JSON.parse(await readFile(f.projectPath, 'utf8')))
  await rm(f.projectPath)
  await commands.execute({ method: 'init', project: f.projectPath, mode: 'faithful', instructions: '先写第3集，由Agent决定交付。' }, execution)
  await commands.execute({ method: 'import_source', project: f.projectPath, expected_revision: (await current()).revision,
    path: f.source, source_kind: 'text' }, execution)
  const unit = (await current()).sources[0]!.units[0]!
  await commands.execute({ method: 'propose_fact', project: f.projectPath, expected_revision: (await current()).revision,
    fact: { kind: 'speech', actor: '甲', origin: 'source', layer: 'present', summary: unit.text,
      anchors: [{ unit_id: unit.id, quote: unit.text }] } }, execution)
  const fact = (await current()).facts[0]!
  await commands.execute({ method: 'stage', project: f.projectPath, expected_revision: (await current()).revision,
    episode: 3, scenes: [{ location: '门口', time: '日', setting: '内', layer: 'present', transition: 'opening',
      characters: ['甲'], beats: [{ kind: 'dialogue', actor: '甲', text: '你好。', fact_ids: [fact.id],
        requires_knowledge: [], witnesses: [] }] }] }, execution)
  const stagedBytes = await readFile(f.projectPath), staged = PROJECT_FILE.parse(JSON.parse(stagedBytes.toString()))
  const candidate = staged.candidates[0]!
  expect(candidate).toMatchObject({ episode: 3 })
  expect(candidate.committed_at).toBeUndefined()
  expect(candidate.review).toBeUndefined()
  const directory = join(f.root, 'final'), input = join(directory, `episode-3-${candidate.id.slice(2)}.md`)
  expect(await commands.execute({ method: 'export', project: f.projectPath, candidate_id: candidate.id,
    directory }, execution)).toMatchObject({ adoption: { episode: 3, adopted: false, committed_at: null, review: null } })
  expect(await readFile(f.projectPath)).toEqual(stagedBytes)
  const text = await readFile(input, 'utf8'), output = join(directory, 'episode-3-draft.docx')
  expect(text).toContain('第3集')
  expect(text).toContain('甲：你好。')
  await expect(screenplayDocx.exportScreenplayDocx({ inputs: [input], output, project: f.projectPath }, config, signal))
    .resolves.toEqual({ output })
  await expect(verifyWordBody(output, [text], config, signal)).resolves.toBeUndefined()
  await expect(ctx.serial('deliverables/validate', [input, output], signal)).resolves.toBeUndefined()
  await expect(readFile(`${output}.screenplay.json`)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(f.projectPath)).toEqual(stagedBytes)
})
