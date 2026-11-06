import { join } from 'node:path'
import { copyFile, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { verifySourceQa } from '../src/source-qa.ts'
import { fileSha256 } from '../src/cache.ts'
import { cleanup, tempProject, writePlaceholder } from './harness.ts'
import { sourceQaFixture, sourceQaOcrLine, verifiedSourceQaFixture } from './source-qa-fixture.ts'

const projects: string[] = []
afterEach(async () => { await Promise.all(projects.splice(0).map(cleanup)) })

async function fixture(clean = false) {
  const project = await tempProject()
  projects.push(project)
  const videoPath = join(project, 'selected.mp4'), originalPath = clean ? join(project, 'original.mp4') : videoPath
  await writePlaceholder(videoPath, 'selected test media')
  if (clean) await writePlaceholder(originalPath, 'original test media')
  const selected = await sourceQaFixture(project, videoPath)
  const original = clean ? await sourceQaFixture(project, originalPath, 'original') : undefined
  const qa = { version: 1, selected: selected.declaration,
    ...(original === undefined ? {} : { original: original.declaration, affected_intervals: [{ start_seconds: 2, end_seconds: 3 }] }) }
  const input = { project, review: { subtitle_cleanup: clean ? 'clean' : 'not_required', source_qa: qa },
    videoPath, videoSha256: await fileSha256(videoPath), originalPath, originalSha256: await fileSha256(originalPath),
    verifier: verifiedSourceQaFixture }
  return { input, selected, original, qa }
}

it('accepts a fully inspected unchanged original without unnecessary before/after comparisons', async () => {
  const f = await fixture()
  const verifier = vi.fn(verifiedSourceQaFixture)
  const qa = await verifySourceQa({ ...f.input, verifier })
  expect(qa.sha256).toMatch(/^[a-f0-9]{64}$/u)
  expect(qa.files).toHaveLength(3)
  expect(verifier).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    mediaPath: await realpath(f.input.videoPath), mediaSha256: f.input.videoSha256, reviewId: 'review-selected' }))
})

it('requires an independent execution verifier even when every declared artifact looks complete', async () => {
  const f = await fixture()
  const { verifier: _verifier, ...input } = f.input
  await expect(verifySourceQa(input)).rejects.toThrow(/真实OCR执行/u)
  await expect(verifySourceQa({ ...input, verifier: async () => { throw Error('No real successful OCR tool result') } }))
    .rejects.toThrow('No real successful OCR tool result')
})

it('accepts exact Host-proven Session cache paths for a nested production project', async () => {
  const workspace = await tempProject()
  projects.push(workspace)
  const project = join(workspace, 'nested-project')
  await mkdir(project)
  const media = join(project, 'original.mp4')
  await writePlaceholder(media, 'nested current source')
  const selected = await sourceQaFixture(workspace, media)
  const qa = await verifySourceQa({ project, videoPath: media, videoSha256: await fileSha256(media),
    originalPath: media, originalSha256: await fileSha256(media), verifier: verifiedSourceQaFixture,
    review: { subtitle_cleanup: 'not_required', source_qa: { version: 1, selected: selected.declaration } } })
  expect(qa.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: await realpath(selected.declaration.ocr.path) })]))
})

it.runIf(process.platform === 'win32')('accepts the same source through case and junction aliases without accepting another same-byte file', async () => {
  const f = await fixture()
  const alias = join(f.input.project, 'same-source-alias')
  await symlink(f.input.project, alias, 'junction')
  const toolPath = join(alias, 'selected.mp4').toUpperCase()
  f.selected.ocr.path = toolPath
  f.selected.inspection.path = toolPath
  f.selected.declaration.media_path = toolPath
  await f.selected.save()
  await expect(verifySourceQa(f.input)).resolves.toHaveProperty('sha256')
  const copy = join(f.input.project, 'same-byte-copy.mp4')
  await copyFile(f.input.videoPath, copy)
  f.selected.ocr.path = copy
  f.selected.inspection.path = copy
  await f.selected.save()
  await expect(verifySourceQa(f.input)).rejects.toThrow(/属于另一份源片/u)
})

it.each(['residual dialogue', 'partial OCR', 'OCR gap', 'sparse OCR', 'unseen image', 'old source', 'artifact mutation', 'fake text decision'])
('rejects %s despite declared approved source status', async (kind) => {
  const f = await fixture()
  if (kind === 'residual dialogue' || kind === 'fake text decision') {
    f.selected.ocr.frames[0]!.lines = [sourceQaOcrLine('再添半碗')]
    f.selected.ocr.segments = [{ text: '再添半碗', start_seconds: 2, end_seconds: 3, evidence_frame_ids: ['ocr-frame-1'] }]
    f.selected.ocr.text_status = 'candidate_text_detected'
    if (kind === 'fake text decision') f.selected.declaration.text_decisions = [{ segment_index: 0, text: '招牌',
      start_seconds: 2, end_seconds: 3, kind: 'non_dialogue_text', reason: '店门招牌', observation_frame_ids: ['F00001'] }]
  }
  if (kind === 'partial OCR') f.selected.ocr.scan_status = 'partial'
  if (kind === 'OCR gap') f.selected.ocr.coverage.scanned_ranges[0]!.start_seconds = 1
  if (kind === 'sparse OCR') f.selected.ocr.coverage.frame_interval_seconds = 5
  if (kind === 'unseen image') f.selected.inspection.frames[0]!.exposed = false
  if (kind === 'old source') f.selected.ocr.source_version = 'old-source'
  await f.selected.save()
  if (kind === 'artifact mutation') await writeFile(f.selected.declaration.ocr.path, '{}')
  await expect(verifySourceQa(f.input)).rejects.toThrow(/源画面复验未完成/u)
})

it('allows an exact observed non-dialogue mark and invalidates a changed decision', async () => {
  const f = await fixture()
  f.selected.ocr.frames[0]!.lines = [sourceQaOcrLine('内容由AI生成')]
  f.selected.ocr.segments = [{ text: '内容由AI生成', start_seconds: 0, end_seconds: 5, evidence_frame_ids: ['ocr-frame-1'] }]
  f.selected.ocr.text_status = 'candidate_text_detected'
  f.selected.declaration.text_decisions = [{ segment_index: 0, text: '内容由AI生成', start_seconds: 0, end_seconds: 5,
    kind: 'disclosure_watermark', reason: '审看F00001显示右下角为AI内容标识', observation_frame_ids: ['F00001'] }]
  await f.selected.save()
  const first = await verifySourceQa(f.input)
  f.selected.declaration.text_decisions[0]!.reason = '已观察的右下角合规标识'
  expect((await verifySourceQa(f.input)).sha256).not.toBe(first.sha256)
  f.selected.declaration.text_decisions[0]!.observation_frame_ids = ['other-review-frame']
  await expect(verifySourceQa(f.input)).rejects.toThrow(/其他审看的帧/u)
})

it('uses actual OCR equivalence for whitespace and NFKC forms but refuses changed characters', async () => {
  const f = await fixture()
  f.selected.ocr.frames[0]!.lines = [sourceQaOcrLine('内容由 ＡＩ 生成')]
  f.selected.ocr.frames[1]!.lines = [sourceQaOcrLine(' 内容由AI生成 ')]
  f.selected.ocr.segments = [{ text: '内容由 ＡＩ 生成', start_seconds: 0, end_seconds: 5,
    evidence_frame_ids: ['ocr-frame-1', 'ocr-frame-2'] }]
  f.selected.ocr.text_status = 'candidate_text_detected'
  f.selected.declaration.text_decisions = [{ segment_index: 0, text: '内容由 ＡＩ 生成', start_seconds: 0, end_seconds: 5,
    kind: 'disclosure_watermark', reason: '实际观察右下角AI合规标识', observation_frame_ids: ['F00001'] }]
  await f.selected.save()
  await expect(verifySourceQa(f.input)).resolves.toHaveProperty('sha256')
  f.selected.ocr.frames[1]!.lines = [sourceQaOcrLine('内容由AI改编')]
  await f.selected.save()
  await expect(verifySourceQa(f.input)).rejects.toThrow(/未经逐时段判定/u)
})

it('binds cleaned media and its original to paired observations inside the actual affected interval', async () => {
  const f = await fixture(true)
  const verifier = vi.fn(verifiedSourceQaFixture)
  expect((await verifySourceQa({ ...f.input, verifier })).files).toHaveLength(6)
  expect(verifier).toHaveBeenCalledTimes(2)
  f.original!.inspection.frames[0]!.time = 1
  f.original!.inspection.frames[0]!.decoded_time = 1
  await f.original!.save()
  await expect(verifySourceQa(f.input)).rejects.toThrow(/处理时段缺少/u)
})

it.each([3, 3.1])('rejects requested-time coverage when decoded time %s lies outside the cleanup interval', async (decoded) => {
  const f = await fixture(true)
  f.original!.inspection.frames[0]!.time = 2.5
  f.original!.inspection.frames[0]!.decoded_time = decoded
  await f.original!.save()
  await expect(verifySourceQa(f.input)).rejects.toThrow(/处理时段缺少/u)
})

it.each([undefined, -0.1, Number.NaN, 5])('requires a finite decoded timestamp inside the actual source: %s', async (decoded) => {
  const f = await fixture()
  const frame = f.selected.inspection.frames[0]!
  if (decoded === undefined) delete (frame as { decoded_time?: number }).decoded_time
  else frame.decoded_time = decoded
  await f.selected.save()
  await expect(verifySourceQa(f.input)).rejects.toThrow(/实际解码时码/u)
})

it.each([3, 3.1])('rejects non-dialogue text decisions outside decoded time %s', async (decoded) => {
  const f = await fixture()
  f.selected.ocr.frames[4]!.lines = [sourceQaOcrLine('内容由AI生成')]
  f.selected.ocr.segments = [{ text: '内容由AI生成', start_seconds: 2, end_seconds: 3, evidence_frame_ids: ['ocr-frame-5'] }]
  f.selected.ocr.text_status = 'candidate_text_detected'
  f.selected.declaration.text_decisions = [{ segment_index: 0, text: '内容由AI生成', start_seconds: 2, end_seconds: 3,
    kind: 'disclosure_watermark', reason: '观察到的合规标识', observation_frame_ids: ['F00001'] }]
  f.selected.inspection.frames[0]!.time = 2.5
  f.selected.inspection.frames[0]!.decoded_time = decoded
  await f.selected.save()
  await expect(verifySourceQa(f.input)).rejects.toThrow(/没有对应的已观察画面/u)
})

it('rejects media changed while successful tool evidence is being resolved', async () => {
  const f = await fixture()
  await expect(verifySourceQa({ ...f.input, verifier: async () => {
    await writeFile(f.input.videoPath, 'new current media')
  } })).rejects.toThrow(/核实执行记录期间/u)
})
