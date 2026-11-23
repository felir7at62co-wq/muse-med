/** Existing Muse transcript receipts follow the exact reviewed video and interval. */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import fileSystem from '@deepseek-ai/dsh-fs-local'
import { expect, it, onTestFinished, vi } from 'vitest'
import { reviewDialogue } from '../src/review-dialogue.ts'

async function fixture(fileName = 'episode.mp4', stem = 'episode') {
  const root = await mkdtemp(join(tmpdir(), 'muse-dialogue-review-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(fileSystem, { cwd: root }).await()
  const file = join(root, fileName)
  const media = Buffer.from('original video')
  await writeFile(file, media)
  const target = await ctx.fs.resolve(file)
  const initial = await ctx.fs.stat(target)
  if (initial === undefined) throw Error('Missing test video')
  const jobs = join(root, 'transcript', 'jobs'), raw = join(root, 'transcript', 'raw')
  await Promise.all([mkdir(jobs, { recursive: true }), mkdir(raw, { recursive: true })])
  const sourceSha256 = createHash('sha256').update(media).digest('hex')
  const speech = [{ start: 4, end: 5, text: '你好。' }]
  const seal = async (version: number, segments: readonly object[] = speech, overrides: object = {}) => {
    const name = `${stem}-v${version}.json`
    const receiptPath = join(jobs, name), transcriptPath = join(raw, name)
    await writeFile(receiptPath, JSON.stringify({ id: '1ea43b83-d258-46c0-9cbf-ef788bde49d1', source: file, sourceSha256,
      sha256: '0'.repeat(64), stem, version, status: 'complete', ...overrides }))
    await writeFile(transcriptPath, JSON.stringify(segments))
    return { receiptPath, transcriptPath }
  }
  const read = (receipt?: string, options?: {
    byteLimit?: number
    maxReadBytes?: number
    signal?: AbortSignal
    workspace?: boolean
  }) => reviewDialogue(
    ctx, target,
    initial.version, 1000, options?.byteLimit ?? 10000, options?.workspace === false ? undefined : root,
    4, 8, options?.signal ?? new AbortController().signal,
    receipt, options?.maxReadBytes)
  return { root, ctx, file, media, jobs, raw, seal, read }
}

it('uses the newest matching saved receipt and includes only speech wholly inside the selected interval', async () => {
  const f = await fixture()
  await f.seal(1, [{ start: 4, end: 5, text: 'Older transcript.' }])
  const speech = [
    { start: 0, end: 4, text: 'Earlier shot.' },
    { start: 3, end: 4.5, text: 'Enters from previous shot.' },
    { start: 4, end: 5, text: '把茶杯给我。', speaker_id: 'anonymous-provider-id-a' },
    { start: 5, end: 6, text: '给你。', speaker_id: 'anonymous-provider-id-b' },
    { start: 6, end: 7, text: '谢谢。', speaker_id: 'anonymous-provider-id-a' },
    { start: 6.9, end: 8.1, text: 'Exits into next shot.' },
    { start: 8, end: 9, text: 'Next shot.' },
  ]
  const latest = await f.seal(2, speech)
  expect(await f.read()).toEqual({ status: 'available', source: 'saved_muse_transcription', speaker_identity_verified: false,
    boundary_segments_omitted: 2, segments: [
      { start_seconds: 4, end_seconds: 5, text: '把茶杯给我。', speaker_group: 1 },
      { start_seconds: 5, end_seconds: 6, text: '给你。', speaker_group: 2 },
      { start_seconds: 6, end_seconds: 7, text: '谢谢。', speaker_group: 1 },
    ] })
  expect(await readFile(latest.transcriptPath, 'utf8')).toBe(JSON.stringify(speech))
  expect(await readFile(f.file)).toEqual(f.media)
  expect(await f.read('transcript/jobs/episode-v1.json')).toMatchObject({ status: 'available',
    segments: [{ text: 'Older transcript.' }] })
})

it('refuses a receipt outside the project, stale source digests, and media changed after review began', async () => {
  const f = await fixture()
  const { receiptPath } = await f.seal(1)
  const unscoped = join(f.root, 'episode-v1.json')
  await writeFile(unscoped, await readFile(receiptPath))
  expect(await f.read(unscoped)).toEqual({ status: 'unavailable', reason: 'receipt_invalid' })
  await f.seal(2, undefined, { source: join(f.root, 'other.mp4') })
  expect(await f.read()).toEqual({ status: 'unavailable', reason: 'source_mismatch' })
  await f.seal(3, undefined, { sourceSha256: '0'.repeat(64) })
  expect(await f.read()).toEqual({ status: 'unavailable', reason: 'source_mismatch' })
  await writeFile(f.file, 'changed video')
  expect(await f.read(receiptPath)).toEqual({ status: 'unavailable', reason: 'evidence_changed' })
})

it('distinguishes missing, incomplete, silent, invalid, and size-limited dialogue evidence', async () => {
  const f = await fixture()
  expect(await f.read()).toEqual({ status: 'unavailable', reason: 'receipt_unavailable' })
  await f.seal(1, undefined, { status: 'processing' })
  expect(await f.read()).toEqual({ status: 'unavailable', reason: 'receipt_incomplete' })
  await f.seal(2, undefined, { status: 'silent' })
  expect(await f.read()).toEqual({ status: 'unavailable', reason: 'receipt_reported_silent' })
  await f.seal(3, undefined, { sourceSha256: undefined })
  expect(await f.read()).toEqual({ status: 'unavailable', reason: 'source_hash_unavailable' })
  const current = await f.seal(4, [{ start: 5, end: 4, text: 'Bad timing' }])
  expect(await f.read()).toEqual({ status: 'unavailable', reason: 'transcript_invalid' })
  await rm(current.transcriptPath)
  expect(await f.read()).toEqual({ status: 'unavailable', reason: 'transcript_unavailable' })
  await f.seal(5, [{ start: 4, end: 5, text: '字'.repeat(500) }])
  expect(await f.read(undefined, { byteLimit: 1024 })).toEqual({ status: 'unavailable', reason: 'limit_exceeded' })
  await expect(f.read(undefined, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled')
})

it('bounds input evidence independently from the smaller selected dialogue report', async () => {
  const f = await fixture()
  await f.seal(1, [
    { start: 0, end: 3, text: '较早镜头。', words: Array.from({ length: 100 }, () => ({ start: 1, end: 2, text: '词' })) },
    { start: 5, end: 6, text: '请坐。' },
  ])
  const limits = { byteLimit: 1024, maxReadBytes: 10000 }
  expect(await f.read(undefined, limits)).toMatchObject({ status: 'available',
    segments: [{ text: '请坐。' }] })
  await f.seal(2, [{ start: 5, end: 6, text: '字'.repeat(500) }])
  expect(await f.read(undefined, limits)).toEqual({ status: 'unavailable', reason: 'limit_exceeded' })
})

it('distinguishes an absent workspace, missing evidence directories and an invalid receipt', async () => {
  const f = await fixture()
  expect(await f.read(undefined, { workspace: false })).toEqual({ status: 'unavailable', reason: 'workspace_unavailable' })
  await rmdir(f.jobs)
  expect(await f.read()).toEqual({ status: 'unavailable', reason: 'receipt_unavailable' })
  await rmdir(f.raw)
  await rmdir(join(f.root, 'transcript'))
  expect(await f.read()).toEqual({ status: 'unavailable', reason: 'receipt_unavailable' })
  await mkdir(f.jobs, { recursive: true })
  await mkdir(f.raw)
  const { receiptPath, transcriptPath } = await f.seal(1, undefined, { version: 2 })
  expect(await f.read(receiptPath)).toEqual({ status: 'unavailable', reason: 'receipt_invalid' })
  await writeFile(receiptPath, '{')
  expect(await f.read(receiptPath)).toEqual({ status: 'unavailable', reason: 'receipt_invalid' })
  await f.seal(1)
  await rm(transcriptPath)
  await rmdir(f.raw)
  expect(await f.read(receiptPath)).toEqual({ status: 'unavailable', reason: 'transcript_unavailable' })
  expect(await f.read(join(f.jobs, 'missing-v1.json'))).toEqual({ status: 'unavailable', reason: 'receipt_unavailable' })
  expect(await f.read(join(f.jobs, 'broken.json'))).toEqual({ status: 'unavailable', reason: 'receipt_invalid' })
})

it('uses the standard media stem for a source without a stem and skips unrelated or unsafe receipt names', async () => {
  const f = await fixture('.mp4', 'media')
  await f.seal(1)
  await Promise.all([
    mkdir(join(f.jobs, 'media-v3.json')),
    writeFile(join(f.jobs, 'older-v7.json'), 'unrelated'),
    writeFile(join(f.jobs, 'media-v9007199254740993.json'), 'unsafe version'),
  ])
  expect(await f.read()).toMatchObject({ status: 'available', segments: [{ text: '你好。' }] })
})

it('reports an evidence file that vanishes during its real filesystem read and preserves unexpected failures', async () => {
  const f = await fixture()
  await f.seal(1)
  const limits = { byteLimit: 1024, maxReadBytes: 10 }
  expect(await f.read(undefined, limits)).toEqual({ status: 'unavailable', reason: 'limit_exceeded' })
  const read = vi.spyOn(f.ctx.fs, 'readBytes')
  try {
    read.mockRejectedValueOnce(new FsError('receipt disappeared', 'FS_NOT_FOUND'))
    expect(await f.read()).toEqual({ status: 'unavailable', reason: 'receipt_unavailable' })
    const failure = Error('filesystem provider failed')
    read.mockRejectedValueOnce(failure)
    await expect(f.read()).rejects.toBe(failure)
  } finally { read.mockRestore() }
})

it.each(['same-directory alias', 'outside directory', 'changed version'])('does not follow a receipt with a %s', async (kind) => {
  const f = await fixture()
  const { receiptPath } = await f.seal(1)
  const resolve = f.ctx.fs.resolve.bind(f.ctx.fs)
  const spy = vi.spyOn(f.ctx.fs, 'resolve').mockImplementation(async (path, options) => {
    if (path !== 'episode-v1.json') return resolve(path, options)
    if (kind === 'same-directory alias') return resolve(f.jobs, options)
    if (kind === 'outside directory') return resolve(f.file, options)
    await appendFile(receiptPath, ' ')
    return resolve(path, options)
  })
  try { expect(await f.read(receiptPath)).toEqual({ status: 'unavailable', reason: 'receipt_unavailable' }) }
  finally { spy.mockRestore() }
})

it.each([
  { observed: 'video', changed: 'receipt' },
  { observed: 'transcript', changed: 'video' },
  { observed: 'transcript', changed: 'receipt' },
  { observed: 'transcript', changed: 'transcript' },
] as const)('discards evidence when $changed changes during the $observed read', async ({ observed, changed }) => {
  const f = await fixture()
  const { receiptPath, transcriptPath } = await f.seal(1)
  const paths = { video: f.file, receipt: receiptPath, transcript: transcriptPath }
  const read = f.ctx.fs.readBytes.bind(f.ctx.fs)
  const spy = vi.spyOn(f.ctx.fs, 'readBytes').mockImplementation(async (...args) => {
    const bytes = await read(...args)
    if (args[0].displayPath === paths[observed]) await appendFile(paths[changed], ' ')
    return bytes
  })
  try { expect(await f.read(receiptPath)).toEqual({ status: 'unavailable', reason: 'evidence_changed' }) }
  finally { spy.mockRestore() }
})
