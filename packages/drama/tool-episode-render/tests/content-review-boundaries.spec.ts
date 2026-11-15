/** Invalid durable reviews must not turn technical output into a delivery approval. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { verifyEpisodeContentReview, type ContentReviewVerifier } from '../src/content-review.ts'
import { contentReviewFixture } from './content-review-fixture.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'content-boundaries-')); roots.push(project)
  const output = join(project, 'output.mp4'), source = join(project, 'source.mp4')
  await writeFile(source, 'source'); await writeFile(output, 'output')
  const saved = await contentReviewFixture({ project, episode: '50', output, duration: 5,
    sources: [{ shot: 1, path: source, duration: 5 }] })
  const verifier: ContentReviewVerifier = async () => {}
  const input = { project, episode: '50', output, outputSha256: await fileSha256(output), duration: 5,
    sources: [{ shot: 1, sha256: await fileSha256(source), duration: 5 }], cuts: [], verifier }
  const save = async () => { await saved.json(saved.path, saved.document) }
  const report = async (value: object) => {
    saved.entry.content_review.output.inspection.sha256 = await saved.json(saved.entry.content_review.output.inspection.path, value)
    await save()
  }
  return { project, input, saved, save, report }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

it.each<{ name: string; mutate: (f: Fixture) => void | Promise<void> }>([
  { name: 'missing film collection', mutate: (f) => { Reflect.deleteProperty(f.saved.document, 'films') } },
  { name: 'different output name', mutate: (f) => { f.saved.entry.source = 'other.mp4' } },
  { name: 'different output digest', mutate: (f) => { f.saved.entry.sha256 = '0'.repeat(64) } },
  { name: 'unreviewed film', mutate: (f) => { f.saved.entry.reviewed = false } },
  { name: 'pending picture', mutate: (f) => { f.saved.entry.picture = 'unverified' } },
  { name: 'missing content', mutate: (f) => { Reflect.deleteProperty(f.saved.entry, 'content_review') } },
  { name: 'unsupported content version', mutate: (f) => { f.saved.entry.content_review.version = 2 } },
  { name: 'source table absent', mutate: (f) => { Reflect.deleteProperty(f.saved.entry.content_review, 'sources') } },
  { name: 'source table incomplete', mutate: (f) => { f.saved.entry.content_review.sources.pop() } },
  { name: 'wrong source shot', mutate: (f) => { f.saved.entry.content_review.sources[0]!.shot = 2 } },
  { name: 'wrong source digest', mutate: (f) => { f.saved.entry.content_review.sources[0]!.sha256 = 'x' } },
  { name: 'media outside project', mutate: (f) => { f.saved.entry.content_review.output.source = f.project } },
  { name: 'missing observation identity', mutate: (f) => { f.saved.entry.content_review.output.inspection.review_id = '' } },
  { name: 'changed report digest', mutate: (f) => { f.saved.entry.content_review.output.inspection.sha256 = '0'.repeat(64) } },
  { name: 'no report path', mutate: (f) => { f.saved.entry.content_review.output.inspection.path = '' } },
  { name: 'pronunciation still unresolved', mutate: (f) => { f.saved.entry.content_review.audio.status = 'unverified' } },
  { name: 'missing listening call', mutate: (f) => { f.saved.entry.content_review.audio.question_call_id = '' } },
  { name: 'wrong listening dimension', mutate: (f) => { f.saved.entry.content_review.audio.ranges[0]!.dimension = 'asr_text' } },
  { name: 'invalid interval order', mutate: (f) => { f.saved.entry.content_review.output.checks[0]!.end_seconds = -1 } },
  { name: 'invalid interval start', mutate: (f) => { f.saved.entry.content_review.output.checks[0]!.start_seconds = -1 } },
  { name: 'interval starts after uncovered opening', mutate: (f) => { f.saved.entry.content_review.output.checks[0]!.start_seconds = 1 } },
  { name: 'interval past media end', mutate: (f) => { f.saved.entry.content_review.output.checks[0]!.end_seconds = 7 } },
  { name: 'no reason for pass', mutate: (f) => { f.saved.entry.content_review.output.checks[0]!.reason = '' } },
  { name: 'no intended action', mutate: (f) => { f.saved.entry.content_review.output.checks[0]!.expected = '' } },
  { name: 'unknown dimension', mutate: (f) => { f.saved.entry.content_review.output.checks[0]!.dimension = 'duration_only' } },
  { name: 'unknown frame reference', mutate: (f) => { f.saved.entry.content_review.output.checks[0]!.frame_ids = ['first', 'absent'] } },
  { name: 'frame beyond stated range', mutate: (f) => {
    const checks = f.saved.entry.content_review.output.checks
    checks[0]!.end_seconds = 2.5
    checks.push({ ...checks[0]!, start_seconds: 2.5, end_seconds: 5 })
  } },
  { name: 'missing frame list', mutate: f => f.report({ duration: 5 }) },
  { name: 'empty frame list', mutate: f => f.report({ duration: 5, frames: [] }) },
  { name: 'duplicate observed frame', mutate: f => f.report({ duration: 5, frames: [
    { id: 'first', decoded_time: 0.1 }, { id: 'first', decoded_time: 4.9 }] }) },
  { name: 'invalid observed time', mutate: f => f.report({ duration: 5, frames: [{ id: 'first', decoded_time: -0.1 }] }) },
  { name: 'short observation coverage', mutate: f => f.report({ duration: 4, frames: [] }) },
])('rejects $name', async ({ mutate }) => {
  const f = await fixture()
  await mutate(f); await f.save()
  await expect(verifyEpisodeContentReview(f.input)).rejects.toThrow('CONTENT_REVIEW_PENDING')
})

it('keeps the review index project-owned and requires ordinary bounded JSON files', async () => {
  const f = await fixture(), outside = await mkdtemp(join(tmpdir(), 'outside-content-')); roots.push(outside)
  const outsideFile = join(outside, 'review.json')
  await writeFile(outsideFile, await readFile(f.saved.path))
  await expect(verifyEpisodeContentReview({ ...f.input, path: outsideFile })).rejects.toThrow('当前项目')
  await expect(verifyEpisodeContentReview({ ...f.input, path: '' })).rejects.toThrow('缺少路径')
  const directory = join(f.project, 'directory'); await mkdir(directory)
  await expect(verifyEpisodeContentReview({ ...f.input, path: directory })).rejects.toThrow('普通文件')
  const oversized = join(f.project, 'oversized.json'); await writeFile(oversized, Buffer.alloc(8 * 1024 * 1024 + 1))
  await expect(verifyEpisodeContentReview({ ...f.input, path: oversized })).rejects.toThrow('8MiB')
  await writeFile(f.saved.path, '[]')
  await expect(verifyEpisodeContentReview(f.input)).rejects.toThrow('JSON对象')
})

it('covers every segment using ordered ranges and requires observations on both sides of a real join', async () => {
  const f = await fixture(), target = f.saved.entry.content_review.output
  target.checks = ['physical_logic', 'continuity'].flatMap(dimension => [
    { dimension, start_seconds: 0, end_seconds: 2.5, status: 'ok', expected: '杯子在窗台上', reason: '手已离开', frame_ids: ['first', 'before'] },
    { dimension, start_seconds: 2.5, end_seconds: 5, status: 'ok', expected: '人物走向电梯', reason: '方向保持', frame_ids: ['after', 'last'] },
  ]).reverse()
  await f.report({ duration: 5, frames: [{ id: 'first', decoded_time: 0.1 }, { id: 'before', decoded_time: 2.4 },
    { id: 'after', decoded_time: 2.6 }, { id: 'last', decoded_time: 4.9 }], event_groups: [] })
  await expect(verifyEpisodeContentReview({ ...f.input, cuts: [2.5] })).resolves.toHaveProperty('sha256')
})

it('rejects review content that changes while the independent verifier is running', async () => {
  const f = await fixture()
  let changed = false
  const verifier: ContentReviewVerifier = async () => {
    if (changed) return
    changed = true
    await writeFile(f.saved.path, '{}')
  }
  await expect(verifyEpisodeContentReview({ ...f.input, verifier })).rejects.toThrow('核验期间内容证据已变化')
})

it('supports a differently padded episode key without borrowing another episode review', async () => {
  const f = await fixture()
  await expect(verifyEpisodeContentReview({ ...f.input, episode: '050' })).resolves.toHaveProperty('sha256')
  await expect(verifyEpisodeContentReview({ ...f.input, episode: '51' })).rejects.toThrow('当前成片SHA-256')
})

it('uses case-sensitive file identity on Unix and does not allow an outside source with identical bytes', async () => {
  const f = await fixture()
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  await expect(verifyEpisodeContentReview(f.input)).resolves.toHaveProperty('sha256')
  vi.unstubAllGlobals()
  const directory = await mkdtemp(join(tmpdir(), 'content-outside-source-')); roots.push(directory)
  const outside = join(directory, 'copy.mp4'); await writeFile(outside, 'source')
  f.saved.entry.content_review.sources[0]!.source = outside
  await f.save()
  await expect(verifyEpisodeContentReview(f.input)).rejects.toThrow('审查媒体必须在当前项目')
})
