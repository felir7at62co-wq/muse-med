/** Review evidence and managed derivatives retain exact bytes across decisions. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { adoptRecoveredVideo, artifactHash, publishApprovedVideo, readApprovedVideoDelivery,
  reviewRecoveredVideo } from '../src/video-recovery.ts'

vi.mock('@deepseek-ai/dsh-jubian-api', async (importOriginal) => {
  const api = await importOriginal<typeof import('@deepseek-ai/dsh-jubian-api')>()
  return { ...api, MEDIA_LIMITS: { ...api.MEDIA_LIMITS, video: 32 } }
})

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

async function fixture(evidence: Record<string, unknown> = {}) {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'jubian-review-artifact-')))
  onTestFinished(async () => { await rm(project, { recursive: true, force: true, maxRetries: 3 }) })
  const key = 'review-original'
  const directory = join(project, 'video_tasks', 'review')
  await mkdir(directory, { recursive: true })
  const report = JSON.stringify({ idempotency_key: key, task_id: 42, status: 'awaiting_review',
    media_checks: [{ sha256: 'sha256:' + hash('provider'), video: true, audio: true }], ...evidence })
  const path = join(directory, hash(key) + '.json')
  await writeFile(path, report)
  const derivative = 'video_tasks/derivatives/edited.mp4'
  await mkdir(join(project, 'video_tasks', 'derivatives'))
  const source = join(project, derivative)
  await writeFile(source, 'edited video')
  const signal = new AbortController().signal
  const inspect = vi.fn<(path: string) => Promise<{ video: boolean; audio: boolean }>>(
    async () => ({ video: true, audio: true }))
  return { project, key, directory, path, digest: hash(report), derivative, source, signal, inspect,
    adopt: () => adoptRecoveredVideo(project, key, hash(report), derivative, inspect, signal) }
}

it.each([true, false])('captures one derivative with audio=%s and keeps the provider report unchanged', async (audio) => {
  const f = await fixture()
  f.inspect.mockResolvedValue({ video: true, audio })
  const original = await readFile(f.path)
  const adopted = await f.adopt()
  expect(adopted).toMatchObject({ decision: null, derivative: { sha256: hash('edited video'), video: true, audio } })
  expect(adopted.digest).not.toBe(f.digest)
  expect(f.inspect).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('artifact-'))
  await expect(readFile(f.path)).resolves.toEqual(original)
  expect(await artifactHash(f.source)).toBe(hash('edited video'))
  const digest = adopted.digest
  if (typeof digest !== 'string') throw new Error('Expected review digest')
  await reviewRecoveredVideo(f.project, f.key, { action: 'approve', digest })
  await expect(reviewRecoveredVideo(f.project, f.key, { action: 'approve', digest }))
    .resolves.toMatchObject({ decision: { action: 'approve', digest } })
  await expect(reviewRecoveredVideo(f.project, f.key, { action: 'reject', digest }))
    .rejects.toThrow('different video review decision')
  await expect(f.adopt()).rejects.toThrow('undecided provider report')
})

it.each([{ status: 'provider_failed' }, { idempotency_key: 'other-key' }])
('refuses adoption for a report with %j', async (evidence) => {
  const f = await fixture(evidence)
  await expect(f.adopt()).rejects.toThrow('undecided provider report')
})

it.each(['video_tasks/review/hidden.mp4', 'video_tasks/../edited.mp4', 'exports/edited.mp4',
  'video_tasks/con.mp4', 'video_tasks/bad?/edited.mp4', 'video_tasks/edited.mov'])
('refuses unmanaged derivative path %s', async (path) => {
  const f = await fixture()
  await expect(adoptRecoveredVideo(f.project, f.key, f.digest, path, f.inspect, f.signal)).rejects.toThrow()
  expect(f.inspect).not.toHaveBeenCalled()
})

it.each(['file-parent', 'linked-parent', 'directory-source', 'linked-source', 'empty-source', 'large-source'] as const)
('refuses a %s derivative before decoding', async (kind) => {
  const f = await fixture()
  const parent = join(f.project, 'video_tasks', 'derivatives')
  if (kind === 'file-parent' || kind === 'linked-parent') {
    await rm(parent, { recursive: true })
    if (kind === 'file-parent') await writeFile(parent, 'replaced')
    else await symlink(f.directory, parent, process.platform === 'win32' ? 'junction' : 'dir')
  } else {
    await rm(f.source)
    if (kind === 'directory-source') await mkdir(f.source)
    if (kind === 'linked-source') await symlink(f.path, f.source, 'file')
    if (kind === 'empty-source') await writeFile(f.source, '')
    if (kind === 'large-source') await writeFile(f.source, 'x'.repeat(33))
  }
  await expect(f.adopt()).rejects.toThrow()
  expect(f.inspect).not.toHaveBeenCalled()
  expect((await readdir(f.directory)).filter(name => name.startsWith('artifact-'))).toEqual([])
})

it.each(['decode', 'altered-managed', 'decision', 'changed-report', 'abort'] as const)
('removes an unpublished managed derivative after %s', async (failure) => {
  const f = await fixture()
  const controller = new AbortController()
  f.inspect.mockImplementation(async (managed) => {
    if (failure === 'altered-managed') await writeFile(managed, 'changed')
    if (failure === 'decision') await reviewRecoveredVideo(f.project, f.key, { action: 'reject', digest: f.digest })
    if (failure === 'changed-report') await writeFile(f.path, JSON.stringify({ changed: true }))
    if (failure === 'abort') controller.abort(new Error('Host stopped'))
    return { video: failure !== 'decode', audio: true }
  })
  await expect(adoptRecoveredVideo(f.project, f.key, f.digest, f.derivative, f.inspect, controller.signal))
    .rejects.toThrow()
  expect((await readdir(f.directory)).filter(name => name.startsWith('artifact-'))).toEqual([])
})

it('detects changes to the adopted bytes and original evidence', async () => {
  const f = await fixture()
  const adopted = await f.adopt()
  const derivative = adopted.derivative
  if (derivative === null || typeof derivative !== 'object' || Array.isArray(derivative)
    || typeof derivative.path !== 'string') throw new Error('Expected managed derivative path')
  const path = join(f.project, derivative.path)
  await writeFile(path, 'changed')
  await expect(reviewRecoveredVideo(f.project, f.key)).rejects.toThrow('derivative or original report changed')
  await writeFile(path, 'edited video')
  await writeFile(f.path, (await readFile(f.path, 'utf8')) + '\n')
  await expect(reviewRecoveredVideo(f.project, f.key)).rejects.toThrow('derivative or original report changed')
})

it.each(['tasks-file', 'review-file', 'report-directory', 'report-link', 'decision-directory'] as const)
('rejects replaced %s entries while reading review evidence', async (kind) => {
  const f = await fixture()
  if (kind === 'tasks-file') {
    await rm(join(f.project, 'video_tasks'), { recursive: true })
    await writeFile(join(f.project, 'video_tasks'), 'replaced')
  } else if (kind === 'review-file') {
    await rm(f.directory, { recursive: true })
    await writeFile(f.directory, 'replaced')
  } else if (kind === 'decision-directory') await mkdir(f.path + '.decision.json')
  else {
    await rm(f.path)
    if (kind === 'report-directory') await mkdir(f.path)
    else await symlink(f.source, f.path, 'file')
  }
  await expect(reviewRecoveredVideo(f.project, f.key)).rejects.toThrow()
})

it('rejects oversized, linked and cancelled managed artifact reads', async () => {
  const f = await fixture()
  await writeFile(f.source, 'x'.repeat(33))
  await expect(artifactHash(f.source)).rejects.toThrow('Could not verify')
  await rm(f.source)
  await symlink(f.path, f.source, 'file')
  await expect(artifactHash(f.source)).rejects.toThrow('Could not verify')
  const controller = new AbortController()
  controller.abort()
  await expect(artifactHash(f.path, controller.signal)).rejects.toThrow('Could not verify')
})

it.each(['path', 'sha256'] as const)('rejects a direct delivery receipt with a different %s', async (field) => {
  const f = await fixture()
  await writeFile(join(f.directory, f.digest + '.direct-delivery.json'), JSON.stringify({
    path: 'exports/Muse-approved-42-' + f.digest + '.mp4', sha256: hash('edited video'),
    [field]: field === 'path' ? 'exports/another.mp4' : 'b'.repeat(64),
  }))
  await expect(readApprovedVideoDelivery(f.project, 42, f.digest, hash('edited video')))
    .rejects.toThrow('does not match')
})

it.each(['file', 'link', 'occupied-directory'] as const)('preserves unsafe export destination %s', async (kind) => {
  const f = await fixture()
  const exports = join(f.project, 'exports')
  if (kind === 'file') await writeFile(exports, 'existing')
  if (kind === 'link') await symlink(f.directory, exports, process.platform === 'win32' ? 'junction' : 'dir')
  if (kind === 'occupied-directory') await mkdir(join(exports, 'Muse-approved-42-' + f.digest + '.mp4'), { recursive: true })
  await expect(publishApprovedVideo(f.project, 42, f.digest, f.source, hash('edited video'), f.signal)).rejects.toThrow()
})
