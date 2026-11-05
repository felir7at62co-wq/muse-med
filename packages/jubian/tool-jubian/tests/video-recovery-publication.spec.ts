/** Concurrent file publication retains approved bytes and rejects foreign receipts. */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import { downloadMedia } from '@deepseek-ai/dsh-jubian-api'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { adoptRecoveredVideo, materializeApprovedProviderVideo, publishApprovedVideo, recoverApprovedVideoDelivery, readApprovedVideoDelivery, reviewRecoveredVideo } from '../src/video-recovery.ts'
import { observe } from '../src/watch.ts'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))
vi.mock('@deepseek-ai/dsh-jubian-api', async (importOriginal) => {
  const api = await importOriginal<typeof import('@deepseek-ai/dsh-jubian-api')>()
  return { ...api, downloadMedia: vi.fn(), MEDIA_LIMITS: { ...api.MEDIA_LIMITS, video: 32 } }
})
vi.mock('../src/watch.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/watch.ts')>(), observe: vi.fn(),
}))

const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex')

beforeEach(() => {
  vi.mocked(observe).mockReset().mockResolvedValue({ status: 'completed', detail: 'verified',
    result: JSON.stringify({ outputs: [{ video_url: 'https://example.test/video.mp4' }] }) })
  vi.mocked(downloadMedia).mockReset().mockResolvedValue({ bytes: Buffer.from('reviewed bytes'),
    media_type: 'video/mp4', kind: 'video', sha256: 'sha256:' + hash('reviewed bytes') })
})

async function fixture() {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'jubian-review-publish-')))
  onTestFinished(async () => { await rm(project, { recursive: true, force: true, maxRetries: 3 }) })
  const review = join(project, 'video_tasks', 'review')
  await mkdir(review, { recursive: true })
  const key = 'review-original'
  const evidence = JSON.stringify({ idempotency_key: key, task_id: 42, status: 'awaiting_review',
    media_checks: [{ sha256: 'sha256:' + hash('reviewed bytes'), video: true, audio: true }] })
  const report = join(review, hash(key) + '.json')
  await writeFile(report, evidence)
  const digest = hash(evidence)
  const source = join(project, 'video_tasks', 'edited.mp4')
  await writeFile(source, 'reviewed bytes')
  const controller = new AbortController()
  const client = new JubianClient({ credential: async () => 'fixture', fetch: async () => { throw new Error('Unexpected provider request') } })
  return { project, review, key, report, digest, source, controller, client,
    cache: () => writeFile(join(review, 'original-' + hash('reviewed bytes') + '.mp4'), 'reviewed bytes'),
    output: join(project, 'exports', 'Muse-approved-42-' + digest + '.mp4'),
    receipt: join(review, digest + '.direct-delivery.json'),
    deliver: () => publishApprovedVideo(project, 42, digest, source, hash('reviewed bytes'), controller.signal),
    materialize: () => materializeApprovedProviderVideo(project, 42, hash('reviewed bytes'), () => client, controller.signal) }
}

it.each([undefined, '{}', '{"outputs":[]}'])('refuses completed provider evidence without valid outputs %s', async (result) => {
  const f = await fixture()
  vi.mocked(observe).mockResolvedValue({ status: 'completed', detail: 'verified', ...(result === undefined ? {} : { result }) })
  await expect(f.materialize()).rejects.toThrow('no media outputs')
  expect(downloadMedia).not.toHaveBeenCalled()
})

it.each(['pending', 'failed'] as const)('does not materialize %s provider operations', async (status) => {
  const f = await fixture()
  vi.mocked(observe).mockResolvedValue(status === 'pending' ? undefined : { status: 'failed', detail: 'provider failed' })
  await expect(f.materialize()).rejects.toThrow('could not be verified')
})

it.each(['wrong-entry', 'link-race', 'link-denied', 'link-string', 'link-no-code'] as const)
('verifies materialized cache publication after %s', async (kind) => {
  const f = await fixture()
  const target = join(f.review, 'original-' + hash('reviewed bytes') + '.mp4')
  if (kind === 'wrong-entry') {
    await mkdir(target)
    await expect(f.materialize()).rejects.toThrow('regular report')
    return
  }
  const publish = vi.spyOn(files, 'link').mockImplementationOnce(async () => {
    if (kind === 'link-race') {
      await writeFile(target, 'reviewed bytes')
      throw Object.assign(new Error('Concurrent cache writer'), { code: 'EEXIST' })
    }
    if (kind === 'link-string') throw 'Link failed'
    if (kind === 'link-no-code') throw new Error('Link failed')
    throw Object.assign(new Error('Link denied'), { code: 'EACCES' })
  })
  onTestFinished(() => { publish.mockRestore() })
  if (kind === 'link-race') await expect(f.materialize()).resolves.toBe(target)
  else await expect(f.materialize()).rejects.toBeDefined()
})

it.each(['string', 'no-code', 'denied'] as const)('preserves report creation failure %s', async (kind) => {
  const f = await fixture()
  await f.cache()
  const create = vi.spyOn(files, 'link').mockRejectedValueOnce(kind === 'string' ? 'Publication denied'
    : kind === 'no-code' ? new Error('Publication denied') : Object.assign(new Error('Publication denied'), { code: 'EACCES' }))
  onTestFinished(() => { create.mockRestore() })
  await expect(reviewRecoveredVideo(f.project, f.key, { action: 'approve', digest: f.digest })).rejects.toBeDefined()
})

it('rejects an undecidable persisted null decision', async () => {
  const f = await fixture()
  await f.cache()
  await writeFile(f.report + '.decision.json', 'null')
  await expect(reviewRecoveredVideo(f.project, f.key, { action: 'approve', digest: f.digest }))
    .rejects.toThrow('different video review decision')
})

it('refuses a concurrently claimed decision that disappears before its read', async () => {
  const f = await fixture()
  await f.cache()
  const publish = vi.spyOn(files, 'link').mockRejectedValueOnce(Object.assign(new Error('Decision claimed'), { code: 'EEXIST' }))
  onTestFinished(() => { publish.mockRestore() })
  await expect(reviewRecoveredVideo(f.project, f.key, { action: 'approve', digest: f.digest }))
    .rejects.toThrow('different video review decision')
})

it('rejects adoption when another writer publishes the decision during the atomic link', async () => {
  const f = await fixture()
  const publish = vi.spyOn(files, 'link').mockImplementationOnce(async () => {
    await writeFile(f.report + '.decision.json', JSON.stringify({ action: 'reject', digest: f.digest }))
    throw Object.assign(new Error('Decision claimed'), { code: 'EEXIST' })
  })
  onTestFinished(() => { publish.mockRestore() })
  await expect(adoptRecoveredVideo(f.project, f.key, f.digest, 'video_tasks/edited.mp4',
    async () => ({ video: true, audio: true }), f.controller.signal)).rejects.toThrow('review changed before')
})

it('rejects a derivative that grows after the opened file was measured', async () => {
  const f = await fixture()
  const handle = await open(f.source, 'r')
  const stat = handle.stat.bind(handle)
  const measure = vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
    const before = await stat()
    await appendFile(f.source, 'x'.repeat(33))
    return before
  })
  const capture = vi.spyOn(files, 'open').mockResolvedValueOnce(handle)
  onTestFinished(async () => { measure.mockRestore(); capture.mockRestore(); await handle.close() })
  await expect(adoptRecoveredVideo(f.project, f.key, f.digest, 'video_tasks/edited.mp4',
    async () => ({ video: true, audio: true }), f.controller.signal)).rejects.toThrow('exceeds the media limit')
})

it.each(['changed-copy', 'destination-race', 'link-denied', 'link-no-code', 'link-string'] as const)
('retains delivery validation after %s', async (kind) => {
  const f = await fixture()
  const originalLink = files.link
  const publish = vi.spyOn(files, 'link').mockImplementationOnce(async (source, target) => {
    if (kind === 'changed-copy') {
      await writeFile(source, 'changed bytes')
      await originalLink(source, target)
      return
    }
    if (kind === 'destination-race') {
      await writeFile(f.output, 'reviewed bytes')
      throw Object.assign(new Error('Output claimed'), { code: 'EEXIST' })
    }
    if (kind === 'link-no-code') throw new Error('Link failed')
    if (kind === 'link-string') throw 'Link failed'
    throw Object.assign(new Error('Link denied'), { code: 'EACCES' })
  })
  onTestFinished(() => { publish.mockRestore() })
  if (kind === 'destination-race') await expect(f.deliver()).resolves.toMatchObject({ sha256: hash('reviewed bytes') })
  else await expect(f.deliver()).rejects.toBeDefined()
})

it('compares a temporary copy changed before its digest is read', async () => {
  const f = await fixture()
  const originalStat = files.lstat
  const inspect = vi.spyOn(files, 'lstat').mockImplementation(async (path, options) => {
    if (typeof path === 'string' && path.startsWith(f.output + '.') && path.endsWith('.tmp')) {
      await writeFile(path, 'changed bytes')
    }
    return await originalStat(path, options)
  })
  onTestFinished(() => { inspect.mockRestore() })
  await expect(f.deliver()).rejects.toThrow('Approved media changed during direct delivery')
})

it('drains a copy when its destination directory disappears before output opens', async () => {
  const f = await fixture()
  const originalStat = files.lstat
  const inspect = vi.spyOn(files, 'lstat').mockImplementation(async (path, options) => {
    if (path === f.output) await rm(join(f.project, 'exports'), { recursive: true })
    return await originalStat(path, options)
  })
  onTestFinished(() => { inspect.mockRestore() })
  await expect(f.deliver()).rejects.toThrow()
})

it.each([true, false])('reconciles a concurrent direct delivery receipt present=%s', async (present) => {
  const f = await fixture()
  const originalLink = files.link
  const publish = vi.spyOn(files, 'link').mockImplementation(async (source, target) => {
    if (target !== f.receipt) { await originalLink(source, target); return }
    if (present) await writeFile(f.receipt, JSON.stringify({ path: 'exports/Muse-approved-42-' + f.digest + '.mp4',
      sha256: hash('reviewed bytes') }))
    throw Object.assign(new Error('Receipt claimed'), { code: 'EEXIST' })
  })
  onTestFinished(() => { publish.mockRestore() })
  if (present) await expect(f.deliver()).resolves.toMatchObject({ sha256: hash('reviewed bytes') })
  else await expect(f.deliver()).rejects.toThrow('receipt changed during publication')
})


it.each(['two outputs', 'changed bytes'] as const)('refuses materialization with %s without publishing a cache', async (kind) => {
  const f = await fixture()
  if (kind === 'two outputs') vi.mocked(observe).mockResolvedValueOnce({ status: 'completed', detail: 'verified',
    result: JSON.stringify({ outputs: [{ video_url: 'https://example.test/a.mp4' }, { video_url: 'https://example.test/b.mp4' }] }) })
  else vi.mocked(downloadMedia).mockResolvedValueOnce({ bytes: Buffer.from('foreign'), sha256: 'sha256:' + hash('foreign'), kind: 'video', media_type: 'video/mp4' })
  await expect(f.materialize()).rejects.toThrow(kind === 'two outputs' ? 'one verified' : 'differ from')
})

it('refuses a provider cache changed by another publisher after download', async () => {
  const f = await fixture(), target = join(f.review, 'original-' + hash('reviewed bytes') + '.mp4')
  const publish = vi.spyOn(files, 'link').mockImplementationOnce(async () => {
    await writeFile(target, 'foreign')
    throw Object.assign(new Error('Cache claimed'), { code: 'EEXIST' })
  })
  onTestFinished(() => { publish.mockRestore() })
  await expect(f.materialize()).rejects.toThrow('Managed video bytes differ')
  expect(await files.readFile(target, 'utf8')).toBe('foreign')
})

it.each([true, false])('repairs an offline receipt claimed concurrently, present=%s', async (present) => {
  const f = await fixture(), result = await f.deliver()
  const receipt = join(f.review, f.digest + '.direct-delivery.json')
  await files.unlink(receipt)
  const publish = vi.spyOn(files, 'link').mockImplementationOnce(async () => {
    if (present) await writeFile(receipt, JSON.stringify(result))
    throw Object.assign(new Error('Receipt claimed'), { code: 'EEXIST' })
  })
  onTestFinished(() => { publish.mockRestore() })
  const repair = recoverApprovedVideoDelivery(f.project, 42, f.digest, hash('reviewed bytes'), f.controller.signal)
  if (present) expect(await repair).toEqual(result)
  else await expect(repair).rejects.toThrow('receipt changed during publication')
})


it('does not reopen an unreviewed artifact or an already reopened rejection', async () => {
  const f = await fixture()
  await expect(reviewRecoveredVideo(f.project, f.key, { action: 'reopen', digest: f.digest, reason: '核对原片' })).rejects.toThrow('Only the current rejected')
  await reviewRecoveredVideo(f.project, f.key, { action: 'reject', digest: f.digest })
  await reviewRecoveredVideo(f.project, f.key, { action: 'reopen', digest: f.digest, reason: '核对原片' })
  await expect(reviewRecoveredVideo(f.project, f.key, { action: 'reopen', digest: f.digest, reason: '核对原片' })).rejects.toThrow('Only the current rejected')
})

it('does not replace a reopening concurrently claimed by another writer', async () => {
  const f = await fixture()
  await reviewRecoveredVideo(f.project, f.key, { action: 'reject', digest: f.digest })
  const publish = vi.spyOn(files, 'link').mockRejectedValueOnce(Object.assign(new Error('Reopening claimed'), { code: 'EEXIST' }))
  onTestFinished(() => { publish.mockRestore() })
  await expect(reviewRecoveredVideo(f.project, f.key, { action: 'reopen', digest: f.digest, reason: '核对原片' })).rejects.toThrow('already been reopened')
})

it('detects a rejected decision modified after it was reopened', async () => {
  const f = await fixture()
  await reviewRecoveredVideo(f.project, f.key, { action: 'reject', digest: f.digest })
  await reviewRecoveredVideo(f.project, f.key, { action: 'reopen', digest: f.digest, reason: '核对原片' })
  await writeFile(f.report + '.decision.json', JSON.stringify({ action: 'reject', digest: f.digest, reason: 'foreign change' }))
  await expect(reviewRecoveredVideo(f.project, f.key)).rejects.toThrow('rejection changed after reopening')
})

it('rejects a stale approval after reopening without modifying the active decision', async () => {
  const f = await fixture()
  await reviewRecoveredVideo(f.project, f.key, { action: 'reject', digest: f.digest })
  const current = await reviewRecoveredVideo(f.project, f.key, { action: 'reopen', digest: f.digest, reason: '核对原片' })
  await expect(reviewRecoveredVideo(f.project, f.key, { action: 'approve', digest: f.digest })).rejects.toThrow('report changed')
  expect((await reviewRecoveredVideo(f.project, f.key)).digest).toBe(current.digest)
  expect((await reviewRecoveredVideo(f.project, f.key)).decision).toBeNull()
})


it('refuses an altered source before first publication', async () => {
  const f = await fixture()
  await writeFile(f.source, 'foreign')
  await expect(f.deliver()).rejects.toThrow('Approved media changed before direct delivery')
})

it.each(['missing', 'unreadable'] as const)('reports a current %s delivery without an invocation signal', async (problem) => {
  const f = await fixture(), delivery = await f.deliver()
  await files.unlink(join(f.project, delivery.path))
  if (problem === 'unreadable') await files.mkdir(join(f.project, delivery.path))
  await expect(readApprovedVideoDelivery(f.project, 42, f.digest, hash('reviewed bytes'))).rejects.toThrow(problem)
})

it('retains the inode of a same-byte output published after its first existence check', async () => {
  const f = await fixture()
  const directory = join(f.project, 'exports')
  const target = join(directory, 'Muse-approved-42-' + f.digest + '.mp4')
  const mkdir = files.mkdir
  const create = vi.spyOn(files, 'mkdir').mockImplementation(async (...args: Parameters<typeof files.mkdir>) => {
    const result = await mkdir(...args)
    if (args[0] === directory) await writeFile(target, 'reviewed bytes', { flag: 'wx' })
    return result
  })
  onTestFinished(() => { create.mockRestore() })
  const delivered = await f.deliver()
  expect(delivered.path).toBe('exports/Muse-approved-42-' + f.digest + '.mp4')
  expect(await files.readFile(target, 'utf8')).toBe('reviewed bytes')
})


it('requires the actual current provider source even when a low-level caller supplies only recorded checks', async () => {
  const f = await fixture()
  const unavailable = await reviewRecoveredVideo(f.project, f.key)
  expect(unavailable).toMatchObject({ digest: f.digest, decision: null, source: { kind: 'provider', state: 'unmaterialized' } })
  await expect(reviewRecoveredVideo(f.project, f.key, { action: 'approve', digest: f.digest })).rejects.toThrow('verified current source')
  expect((await reviewRecoveredVideo(f.project, f.key)).decision).toBeNull()
  await f.cache()
  expect(await reviewRecoveredVideo(f.project, f.key, { action: 'approve', digest: f.digest })).toMatchObject({
    digest: f.digest, source: { state: 'verified' }, decision: { action: 'approve', digest: f.digest },
  })
  await files.unlink(join(f.review, 'original-' + hash('reviewed bytes') + '.mp4'))
  expect(await reviewRecoveredVideo(f.project, f.key, { action: 'approve', digest: f.digest })).toMatchObject({
    digest: f.digest, source: { state: 'unmaterialized' }, decision: { action: 'approve', digest: f.digest },
  })
})


it('refuses explicit provider acquisition without an owning cancellation signal', async () => {
  const f = await fixture(), factory = vi.fn(() => f.client)
  await expect(reviewRecoveredVideo(f.project, f.key, { action: 'approve', digest: f.digest }, undefined, factory))
    .rejects.toThrow('operation cancellation')
  expect(factory).not.toHaveBeenCalled()
  expect((await reviewRecoveredVideo(f.project, f.key)).decision).toBeNull()
})
