/** Concurrent file publication retains approved bytes and rejects foreign receipts. */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import { downloadMedia } from '@deepseek-ai/dsh-jubian-api'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { adoptRecoveredVideo, materializeApprovedProviderVideo, publishApprovedVideo, reviewRecoveredVideo } from '../src/video-recovery.ts'
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
  const evidence = JSON.stringify({ idempotency_key: key, task_id: 42, status: 'awaiting_review', media_checks: [] })
  const report = join(review, hash(key) + '.json')
  await writeFile(report, evidence)
  const digest = hash(evidence)
  const source = join(project, 'video_tasks', 'edited.mp4')
  await writeFile(source, 'reviewed bytes')
  const controller = new AbortController()
  const client = new JubianClient({ credential: async () => 'fixture', fetch: async () => { throw new Error('Unexpected provider request') } })
  return { project, review, key, report, digest, source, controller,
    output: join(project, 'exports', 'Supermuse-approved-42-' + digest + '.mp4'),
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
  const create = vi.spyOn(files, 'link').mockRejectedValueOnce(kind === 'string' ? 'Publication denied'
    : kind === 'no-code' ? new Error('Publication denied') : Object.assign(new Error('Publication denied'), { code: 'EACCES' }))
  onTestFinished(() => { create.mockRestore() })
  await expect(reviewRecoveredVideo(f.project, f.key, { action: 'approve', digest: f.digest })).rejects.toBeDefined()
})

it('rejects an undecidable persisted null decision', async () => {
  const f = await fixture()
  await writeFile(f.report + '.decision.json', 'null')
  await expect(reviewRecoveredVideo(f.project, f.key, { action: 'approve', digest: f.digest }))
    .rejects.toThrow('different video review decision')
})

it('refuses a concurrently claimed decision that disappears before its read', async () => {
  const f = await fixture()
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
    if (present) await writeFile(f.receipt, JSON.stringify({ path: 'exports/Supermuse-approved-42-' + f.digest + '.mp4',
      sha256: hash('reviewed bytes') }))
    throw Object.assign(new Error('Receipt claimed'), { code: 'EEXIST' })
  })
  onTestFinished(() => { publish.mockRestore() })
  if (present) await expect(f.deliver()).resolves.toMatchObject({ sha256: hash('reviewed bytes') })
  else await expect(f.deliver()).rejects.toThrow('receipt changed during publication')
})
