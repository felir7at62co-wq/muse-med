import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { verifyEpisodeContentReview, type ContentReviewVerifier } from '../src/content-review.ts'
import { contentReviewFixture } from './content-review-fixture.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'content-review-')); roots.push(project)
  const output = join(project, 'output.mp4'), source = join(project, 'source.mp4')
  await mkdir(project, { recursive: true }); await writeFile(source, 'source'); await writeFile(output, 'output')
  const saved = await contentReviewFixture({ project, episode: '50', output, duration: 5,
    sources: [{ shot: 1, path: source, duration: 5 }] })
  const input = { project, episode: '50', output, outputSha256: await fileSha256(output), duration: 5,
    sources: [{ shot: 1, sha256: await fileSha256(source), duration: 5 }], cuts: [] }
  const verifier = vi.fn<ContentReviewVerifier>(async () => {})
  return { project, output, source, saved, input, verifier,
    save: async () => { await saved.json(saved.path, saved.document) } }
}

it('binds both pre-concatenation sources and current output to real observation and listening verification', async () => {
  const f = await fixture()
  const result = await verifyEpisodeContentReview({ ...f.input, verifier: f.verifier })
  expect(result.sha256).toBe(await fileSha256(f.saved.path))
  expect(f.verifier.mock.calls.map(([binding]) => binding.kind)).toEqual(['video', 'video', 'listening'])
  expect(result.files).toHaveLength(5)
  expect(result.files).toContainEqual({ path: f.output, sha256: f.input.outputSha256 })
  expect(result.files).toContainEqual({ path: f.source, sha256: f.input.sources[0]!.sha256 })
})

it('rejects self-written pass flags without an actual Host evidence verifier', async () => {
  const f = await fixture()
  await expect(verifyEpisodeContentReview(f.input)).rejects.toThrow('真实观察和试听')
})

it.each(['issues', 'unverified'])('does not promote %s content after successful technical checks', async (status) => {
  const f = await fixture(); f.saved.entry.content_review.output.checks[0]!.status = status; await f.save()
  await expect(verifyEpisodeContentReview({ ...f.input, verifier: f.verifier })).rejects.toThrow('仍有问题或未核实')
})

it('rejects a known issue even when top-level dimensions say ok', async () => {
  const f = await fixture()
  const document = f.saved.document
  Object.assign(f.saved.entry, { issues: [{ time: '2–3', detail: '开关位于玻璃上' }] })
  await f.saved.json(f.saved.path, document)
  await expect(verifyEpisodeContentReview({ ...f.input, verifier: f.verifier })).rejects.toThrow('issues或unverified')
})

it('rejects incomplete ranges and duplicate frames masquerading as before/after evidence', async () => {
  const f = await fixture(); const checks = f.saved.entry.content_review.output.checks
  checks[0]!.end_seconds = 4; await f.save()
  await expect(verifyEpisodeContentReview({ ...f.input, verifier: f.verifier })).rejects.toThrow('未覆盖完整')
  checks[0]!.end_seconds = 5; checks[0]!.frame_ids = ['first', 'first']; await f.save()
  await expect(verifyEpisodeContentReview({ ...f.input, verifier: f.verifier })).rejects.toThrow('不同实际观察帧')
})

it('rejects unresolved event uncertainty despite passing frame and summary fields', async () => {
  const f = await fixture(), target = f.saved.entry.content_review.output
  target.inspection.sha256 = await f.saved.json(target.inspection.path, { duration: 5,
    frames: [{ id: 'first', decoded_time: 0.1 }, { id: 'last', decoded_time: 4.9 }],
    event_groups: [{ uncertainty: '无法确认开关是在墙上还是玻璃上' }] })
  await f.save()
  await expect(verifyEpisodeContentReview({ ...f.input, verifier: f.verifier })).rejects.toThrow('动作事件仍有未决疑点')
})

it('does not let opening and closing frames hide an observed internal glass-panel defect', async () => {
  const f = await fixture(), target = f.saved.entry.content_review.output
  target.inspection.sha256 = await f.saved.json(target.inspection.path, { duration: 5,
    frames: [{ id: 'first', decoded_time: 0.1 }, { id: 'internal-cut', decoded_time: 2.5 }, { id: 'last', decoded_time: 4.9 }] })
  await f.save()
  await expect(verifyEpisodeContentReview({ ...f.input, verifier: f.verifier })).rejects.toThrow('跳过了已检测的切镜')
})

it('rejects stale P3 or output versions instead of reusing old review', async () => {
  const f = await fixture()
  await writeFile(f.source, 'repaired P3')
  await expect(verifyEpisodeContentReview({ ...f.input, verifier: f.verifier })).rejects.toThrow('媒体字节已变化')
  await writeFile(f.source, 'source'); await writeFile(f.output, 'new cut')
  await expect(verifyEpisodeContentReview({ ...f.input, verifier: f.verifier })).rejects.toThrow('媒体字节已变化')
})

it.each(['source', 'output'] as const)('rechecks %s bytes after the final listening verification', async (target) => {
  const f = await fixture()
  const verifier: ContentReviewVerifier = async (binding) => {
    if (binding.kind === 'listening') await writeFile(f[target], 'changed during final verification')
  }
  await expect(verifyEpisodeContentReview({ ...f.input, verifier })).rejects.toThrow('核验期间内容证据已变化')
})

it('requires both sides of actual package joins in the output observation', async () => {
  const f = await fixture()
  await expect(verifyEpisodeContentReview({ ...f.input, cuts: [2.5], verifier: f.verifier })).rejects.toThrow('接缝缺少两侧')
})

it('rejects omitted pronunciation checks even when transcript and subtitle text match', async () => {
  const f = await fixture(); f.saved.entry.content_review.audio.ranges = []; await f.save()
  await expect(verifyEpisodeContentReview({ ...f.input, verifier: f.verifier })).rejects.toThrow('pronunciation未覆盖')
})

it('propagates Host rejection instead of trusting a report copied from another Session', async () => {
  const f = await fixture()
  f.verifier.mockRejectedValue(new Error('SOURCE_QA_SESSION'))
  await expect(verifyEpisodeContentReview({ ...f.input, verifier: f.verifier })).rejects.toThrow('SOURCE_QA_SESSION')
})

it('allows Host-issued observations in the owning Session cache outside a nested episode project', async () => {
  const f = await fixture(), cache = await mkdtemp(join(tmpdir(), 'content-review-session-')); roots.push(cache)
  const target = f.saved.entry.content_review.output, path = join(cache, 'observations.json')
  await writeFile(path, await readFile(target.inspection.path))
  target.inspection.path = path
  await f.save()
  await expect(verifyEpisodeContentReview({ ...f.input, verifier: f.verifier })).resolves.toHaveProperty('files')
  expect(f.verifier).toHaveBeenCalledWith(expect.objectContaining({ kind: 'video', inspectionPath: path }))
})
