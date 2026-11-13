import { join } from 'node:path'
import { copyFile, mkdir, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createSourceQaStagedAccess, verifySourceQa } from '../src/source-qa.ts'
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

async function savedReview(f: Awaited<ReturnType<typeof fixture>>, qa: Record<string, unknown>) {
  const path = join(f.input.project, 'review-declaration.json')
  await writeFile(path, JSON.stringify({ ...f.input.review, source_qa: qa }))
  return z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path, 'utf8')))
}

async function evidenceBytes(f: Awaited<ReturnType<typeof fixture>>) {
  const paths = [f.input.videoPath, f.input.originalPath, f.selected.declaration.ocr.path, f.selected.declaration.inspection.path,
    ...f.original === undefined ? [] : [f.original.declaration.ocr.path, f.original.declaration.inspection.path]]
  return await Promise.all([...new Set(paths)].map(async path => ({ path, bytes: await readFile(path) })))
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

it('accepts an omitted text decision list when complete OCR found no text', async () => {
  const f = await fixture()
  const { text_decisions: _decisions, ...selected } = f.qa.selected
  const verifier = vi.fn(verifiedSourceQaFixture)
  const result = await verifySourceQa({ ...f.input, verifier,
    review: { ...f.input.review, source_qa: { ...f.qa, selected } } })
  expect(result.files).toHaveLength(3)
  expect(verifier).toHaveBeenCalledOnce()
})

it('rejects an empty OCR inventory before accepting Host execution evidence', async () => {
  const f = await fixture(), verifier = vi.fn(verifiedSourceQaFixture)
  await expect(verifySourceQa({ ...f.input, verifier,
    review: { ...f.input.review, source_qa: { ...f.qa, selected: { ...f.qa.selected, ocr: [] } } } }))
    .rejects.toThrow('复验缺少OCR文件')
  expect(verifier).not.toHaveBeenCalled()
})

it('rejects cleaned footage without the original source evidence', async () => {
  const f = await fixture(true)
  await expect(verifySourceQa({ ...f.input,
    review: { ...f.input.review, source_qa: { ...f.qa, original: null } } }))
    .rejects.toThrow('复验没有绑定本次实际源片')
})

it('reads only captured directory inventories and rejects evidence from another project', async () => {
  const f = await fixture(), project = await realpath(f.input.project)
  const staged = createSourceQaStagedAccess(project, join(project, 'private-stage'), [], new AbortController().signal,
    [{ originalPath: project, entries: ['selected-ocr.json', 'selected-observation.json'] }])
  expect(staged.list(project)).toEqual(['selected-ocr.json', 'selected-observation.json'])
  expect(() => staged.list('not-captured')).toThrow('no captured directory snapshot')
  await expect(verifySourceQa({ ...f.input, project: join(project, 'another-project'), staged }))
    .rejects.toThrow('暂存证据属于另一项目')
})

it('rejects relative or noncanonical stage roots before building any file mapping', async () => {
  const f = await fixture(), project = await realpath(f.input.project)
  const stage = join(project, 'private-stage'), signal = new AbortController().signal
  for (const [root, privateRoot] of [
    ['relative-project', stage], [project + '/./', stage],
    [project, 'relative-stage'], [project, stage + '/./'],
  ] as const) {
    expect(() => createSourceQaStagedAccess(root, privateRoot, [], signal))
      .toThrow('canonical absolute roots')
  }
})

it('rejects malformed captured directory inventories before making a reader', async () => {
  const f = await fixture(), project = await realpath(f.input.project)
  const stage = join(project, 'private-stage'), signal = new AbortController().signal
  const invalid = [
    [{ originalPath: 'relative-directory', entries: [] }],
    [{ originalPath: project + '/./', entries: [] }],
    [{ originalPath: project, entries: [] }, { originalPath: project, entries: [] }],
    ...[['entry', 'entry'], [''], ['.'], ['..'], ['parent/child'], ['parent\\child']]
      .map(entries => [{ originalPath: project, entries }]),
  ]
  for (const directories of invalid) {
    expect(() => createSourceQaStagedAccess(project, stage, [], signal, directories))
      .toThrow('invalid directory snapshot')
  }
})

it.each(['selected', 'original'] as const)('rejects saved source QA with an empty %s OCR declaration', async (source) => {
  const f = await fixture(source === 'original'), before = await evidenceBytes(f)
  const declaration = source === 'selected' ? f.qa.selected : f.qa.original
  if (declaration === undefined) throw new Error('Expected the selected fixture source')
  const review = await savedReview(f, { ...f.qa, [source]: { ...declaration, ocr: [] } })
  const verifier = vi.fn(verifiedSourceQaFixture)
  await expect(verifySourceQa({ ...f.input, review, verifier })).rejects.toThrow('复验缺少OCR文件。')
  expect(verifier).toHaveBeenCalledTimes(source === 'selected' ? 0 : 1)
  expect(await evidenceBytes(f)).toEqual(before)
})

it('rejects saved source QA without the original evidence for cleaned media', async () => {
  const f = await fixture(true), before = await evidenceBytes(f)
  const { original: _original, ...qa } = f.qa
  const review = await savedReview(f, qa), verifier = vi.fn(verifiedSourceQaFixture)
  await expect(verifySourceQa({ ...f.input, review, verifier })).rejects.toThrow('复验没有绑定本次实际源片。')
  expect(verifier).toHaveBeenCalledOnce()
  expect(await evidenceBytes(f)).toEqual(before)
})

it.each([
  { label: 'no affected intervals', intervals: [], error: '清理片缺少实际处理时段。' },
  { label: 'missing start', intervals: [{ end_seconds: 3 }], error: '处理时段超出当前源片。' },
  { label: 'negative start', intervals: [{ start_seconds: -1, end_seconds: 3 }], error: '处理时段超出当前源片。' },
  { label: 'nonpositive end', intervals: [{ start_seconds: 0, end_seconds: 0 }], error: '处理时段超出当前源片。' },
  { label: 'empty interval', intervals: [{ start_seconds: 2, end_seconds: 2 }], error: '处理时段超出当前源片。' },
  { label: 'reversed interval', intervals: [{ start_seconds: 3, end_seconds: 2 }], error: '处理时段超出当前源片。' },
  { label: 'end beyond source', intervals: [{ start_seconds: 2, end_seconds: 6 }], error: '处理时段超出当前源片。' },
])('rejects saved source QA with $label', async ({ intervals, error }) => {
  const f = await fixture(true), before = await evidenceBytes(f)
  const review = await savedReview(f, { ...f.qa, affected_intervals: intervals })
  const verifier = vi.fn(verifiedSourceQaFixture)
  await expect(verifySourceQa({ ...f.input, review, verifier })).rejects.toThrow(error)
  expect(verifier).toHaveBeenCalledTimes(2)
  expect(await evidenceBytes(f)).toEqual(before)
})

it('validates unmodified staged copies against original identities without treating the map as authorization', async () => {
  const f = await fixture(), stage = join(f.input.project, 'private-stage')
  await mkdir(stage)
  const project = await realpath(f.input.project), stageRoot = await realpath(stage)
  const originals = [f.input.videoPath, f.selected.declaration.ocr.path, f.selected.declaration.inspection.path]
  const files = await Promise.all(originals.map(async (spelling, index) => {
    const originalPath = await realpath(spelling), stagedPath = join(stageRoot, `${index}.data`), data = await readFile(spelling)
    await copyFile(spelling, stagedPath)
    return { originalPath, stagedPath, aliases: [spelling], sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length }
  }))
  const staged = createSourceQaStagedAccess(project, stageRoot, files, new AbortController().signal)
  const media = files[0]
  if (media === undefined) throw new Error('Fixture media was not captured')
  expect(staged.stagedPath(media.originalPath)).toBe(media.stagedPath)
  expect(() => { staged.stagedPath(join(project, 'uncaptured-video.mp4')) }).toThrow('no captured mapping')
  await expect(staged.read(media.originalPath)).resolves.toEqual(await readFile(media.stagedPath))
  await expect(staged.read(join(project, 'uncaptured-video.mp4'))).rejects.toThrow('no captured mapping')
  await expect(staged.hash(join(project, 'uncaptured-video.mp4'))).rejects.toThrow('no captured mapping')
  const verifier = vi.fn(verifiedSourceQaFixture)
  const original = await verifySourceQa({ ...f.input, verifier })
  const stagedResult = await verifySourceQa({ ...f.input, project, verifier, staged })
  expect(stagedResult).toEqual(original)
  expect(verifier).toHaveBeenLastCalledWith(expect.objectContaining({ mediaPath: files[0]!.originalPath,
    ocrPath: files[1]!.originalPath, inspectionPath: files[2]!.originalPath }))
  await expect(verifySourceQa({ ...f.input, project, staged, verifier: async () => { throw Error('Session not authorized') } }))
    .rejects.toThrow('Session not authorized')
  await writeFile(files[0]!.stagedPath, 'replacement media bytes')
  await expect(verifySourceQa({ ...f.input, project, staged })).rejects.toThrow('Source QA stage file changed')
})

it('refuses ambiguous, missing, escaped or cancelled stage mappings', async () => {
  const f = await fixture(), stage = join(f.input.project, 'private-stage')
  await mkdir(stage)
  const data = await readFile(f.input.videoPath), stagedPath = join(stage, 'media')
  await writeFile(stagedPath, data)
  const file = { originalPath: f.input.videoPath, stagedPath, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length }
  const controller = new AbortController()
  expect(() => createSourceQaStagedAccess(f.input.project, stage, [file, file], controller.signal)).toThrow('ambiguous mapping')
  expect(() => createSourceQaStagedAccess(f.input.project, stage, [{ ...file, stagedPath: f.input.videoPath }], controller.signal))
    .toThrow('ambiguous mapping')
  expect(() => createSourceQaStagedAccess(f.input.project, stage, [{ ...file, aliases: [file.stagedPath] }], controller.signal))
    .toThrow('invalid alias')
  const access = createSourceQaStagedAccess(f.input.project, stage, [file], controller.signal)
  expect(() => access.logical(f.selected.declaration.ocr.path)).toThrow('no captured mapping')
  controller.abort()
  await expect(access.hash(file.originalPath)).rejects.toThrow()
})

it('refuses a staged file replaced by a symlink even when it names the original bytes', async () => {
  const f = await fixture(), project = await realpath(f.input.project), stage = join(project, 'private-stage')
  await mkdir(stage)
  const originalPath = await realpath(f.input.videoPath), data = await readFile(originalPath), stagedPath = join(stage, 'media')
  await writeFile(stagedPath, data)
  const access = createSourceQaStagedAccess(project, stage, [{ originalPath, stagedPath,
    sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length }], new AbortController().signal)
  await unlink(stagedPath)
  await symlink(originalPath, stagedPath)
  await expect(access.hash(originalPath)).rejects.toThrow('not canonical')
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

it('accepts a complete fractional OCR plan without inventing an endpoint frame', async () => {
  const f = await fixture()
  const ocr = f.selected.ocr
  ocr.duration_seconds = 2.1
  ocr.interval.end_seconds = 2.1
  ocr.coverage.frame_interval_seconds = 0.3
  ocr.coverage.planned_frame_count = 7
  ocr.coverage.processed_frame_count = 7
  ocr.coverage.scanned_ranges[0]!.end_seconds = 2.1
  ocr.frames = ocr.frames.slice(0, 7).map((frame, index) => ({ ...frame,
    requested_seconds: index * 0.3, timestamp_seconds: index * 0.3 }))
  f.selected.inspection.duration = 2.1
  f.selected.inspection.scanned_until = 2.1
  f.selected.inspection.frames[0]!.time = 1.5
  f.selected.inspection.frames[0]!.decoded_time = 1.5
  await f.selected.save()
  await expect(verifySourceQa(f.input)).resolves.toHaveProperty('sha256')
})

it('requires a new OCR execution for evidence with legacy retimed timestamps', async () => {
  const f = await fixture()
  Reflect.deleteProperty(f.selected.ocr, 'evidence_algorithm')
  await f.selected.save()
  await expect(verifySourceQa(f.input)).rejects.toThrow(/当前版本重新扫描/u)
})

async function segmentedFixture() {
  const f = await fixture()
  const second = await sourceQaFixture(f.input.project, f.input.videoPath, 'second')
  f.selected.ocr.interval.end_seconds = 2
  f.selected.ocr.scan_status = 'partial'
  f.selected.ocr.text_status = 'indeterminate'
  f.selected.ocr.coverage.planned_frame_count = 4
  f.selected.ocr.coverage.processed_frame_count = 4
  f.selected.ocr.coverage.scanned_ranges[0]!.end_seconds = 2
  f.selected.ocr.coverage.unscanned_ranges = [{ start_seconds: 2, end_seconds: 5, reason: 'deployment_limit' }]
  f.selected.ocr.frames = f.selected.ocr.frames.slice(0, 4)
  second.ocr.interval.start_seconds = 2
  second.ocr.coverage.planned_frame_count = 6
  second.ocr.coverage.processed_frame_count = 6
  second.ocr.coverage.scanned_ranges[0]!.start_seconds = 2
  second.ocr.frames = second.ocr.frames.slice(4)
  await f.selected.save()
  await second.save()
  const refs = [f.selected.declaration.ocr, second.declaration.ocr]
  Reflect.set(f.selected.declaration, 'ocr', refs)
  return { ...f, second, refs }
}

it('verifies every separately issued OCR part covering a source in order', async () => {
  const f = await segmentedFixture()
  const verifier = vi.fn(verifiedSourceQaFixture)
  const result = await verifySourceQa({ ...f.input, verifier })
  expect(verifier).toHaveBeenCalledTimes(2)
  expect(result.files).toHaveLength(4)
})

it.each(['gap', 'overlap', 'reversed', 'missing', 'different source', 'unissued', 'unscoped decision'])
('rejects segmented OCR with %s', async (variant) => {
  const f = await segmentedFixture()
  const refs = f.refs
  if (variant === 'gap') f.second.ocr.interval.start_seconds = 2.5
  if (variant === 'overlap') f.second.ocr.interval.start_seconds = 1.5
  if (variant === 'different source') f.second.ocr.source_version = 'other-version'
  if (variant === 'gap' || variant === 'overlap' || variant === 'different source') {
    f.second.ocr.coverage.scanned_ranges[0]!.start_seconds = f.second.ocr.interval.start_seconds
    f.second.ocr.frames = f.second.ocr.frames.map((frame, index) => ({ ...frame,
      requested_seconds: f.second.ocr.interval.start_seconds + index * 0.5,
      timestamp_seconds: f.second.ocr.interval.start_seconds + index * 0.5 }))
    await f.second.save()
    refs[1]!.sha256 = f.second.declaration.ocr.sha256
  }
  if (variant === 'reversed') refs.reverse()
  if (variant === 'missing') refs.pop()
  if (variant === 'unscoped decision') Reflect.set(f.selected.declaration, 'text_decisions', [{ segment_index: 0 }])
  const verifier = variant === 'unissued' ? async (binding: Parameters<typeof verifiedSourceQaFixture>[0]) => {
    if (binding.ocrPath === await realpath(f.second.declaration.ocr.path)) throw Error('not issued')
  } : verifiedSourceQaFixture
  await expect(verifySourceQa({ ...f.input, verifier })).rejects.toThrow()
})


it('requires independently scoped text decisions for every OCR part', async () => {
  const f = await segmentedFixture()
  f.selected.ocr.frames[0]!.lines = [sourceQaOcrLine('场景标识')]
  f.selected.ocr.segments = [{ text: '场景标识', start_seconds: 0, end_seconds: 1, evidence_frame_ids: ['ocr-frame-1'] }]
  f.selected.ocr.text_status = 'candidate_text_detected'
  f.second.ocr.frames[0]!.lines = [sourceQaOcrLine('字幕样例')]
  f.second.ocr.segments = [{ text: '字幕样例', start_seconds: 2, end_seconds: 3, evidence_frame_ids: ['ocr-frame-5'] }]
  f.second.ocr.text_status = 'candidate_text_detected'
  f.selected.inspection.frames.push({ ...f.selected.inspection.frames[0]!, id: 'F00002', time: 0.5, decoded_time: 0.5 })
  await f.selected.save()
  await f.second.save()
  const refs = f.refs
  refs[0]!.sha256 = (await fileSha256(refs[0]!.path))
  refs[1]!.sha256 = f.second.declaration.ocr.sha256
  Reflect.set(f.selected.declaration, 'text_decisions', [{ ocr_index: 0, segment_index: 0, text: '场景标识',
    start_seconds: 0, end_seconds: 1, kind: 'non_dialogue_text', reason: '画面标识', observation_frame_ids: ['F00002'] },
  { ocr_index: 1, segment_index: 0, text: '字幕样例', start_seconds: 2, end_seconds: 3,
    kind: 'non_dialogue_text', reason: '画面标识', observation_frame_ids: ['F00001'] }])
  await expect(verifySourceQa(f.input)).resolves.toHaveProperty('sha256')
  ;(Reflect.get(f.selected.declaration, 'text_decisions') as object[]).pop()
  await expect(verifySourceQa(f.input)).rejects.toThrow(/待判断文字/u)
})

it('accepts a 501-second source through separately verified bounded scans', async () => {
  const f = await fixture()
  const refs: { path: string; sha256: string }[] = []
  for (let start = 0; start < 501; start += 120) {
    const part = start === 0 ? f.selected : await sourceQaFixture(f.input.project, f.input.videoPath, `part-${start}`)
    const end = Math.min(start + 120, 501), count = (end - start) / 0.5
    part.ocr.duration_seconds = 501
    part.ocr.interval = { start_seconds: start, end_seconds: end }
    part.ocr.scan_status = end < 501 ? 'partial' : 'complete'
    part.ocr.text_status = end < 501 ? 'indeterminate' : 'no_text_detected'
    part.ocr.coverage.planned_frame_count = count
    part.ocr.coverage.processed_frame_count = count
    part.ocr.coverage.scanned_ranges = [{ start_seconds: start, end_seconds: end }]
    part.ocr.coverage.unscanned_ranges = end < 501 ? [{ start_seconds: end, end_seconds: 501, reason: 'deployment_limit' }] : []
    const frame = part.ocr.frames[0]!
    part.ocr.frames = Array.from({ length: count }, (_, index) => ({ ...frame, id: `frame-${start}-${index}`,
      requested_seconds: start + index * 0.5, timestamp_seconds: start + index * 0.5 }))
    if (start === 0) {
      part.inspection.duration = 501
      part.inspection.scanned_until = 501
    }
    await part.save()
    refs.push({ ...part.declaration.ocr })
  }
  Reflect.set(f.selected.declaration, 'ocr', refs)
  const verifier = vi.fn(verifiedSourceQaFixture)
  const result = await verifySourceQa({ ...f.input, verifier })
  expect(verifier).toHaveBeenCalledTimes(5)
  expect(result.files).toHaveLength(7)
})


it('accepts a bounded partial call whose requested end is before the source end', async () => {
  const f = await segmentedFixture()
  f.selected.ocr.coverage.unscanned_ranges[0]!.end_seconds = 4
  await f.selected.save()
  f.refs[0]!.sha256 = await fileSha256(f.refs[0]!.path)
  await expect(verifySourceQa(f.input)).resolves.toHaveProperty('sha256')
})
