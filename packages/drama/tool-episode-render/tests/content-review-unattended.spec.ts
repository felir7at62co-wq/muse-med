/** Unattended runs archive open review findings for a person instead of refusing; attended runs keep refusing. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { LISTENING_PENDING, UNATTENDED_PICTURE_PENDING_LIMIT, unattendedReviewMode, verifyEpisodeContentReview, type ContentReviewVerifier } from '../src/content-review.ts'
import { contentReviewFixture } from './content-review-fixture.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(verifier: ContentReviewVerifier = async () => {}) {
  const project = await mkdtemp(join(tmpdir(), 'content-unattended-')); roots.push(project)
  const output = join(project, 'output.mp4'), source = join(project, 'source.mp4')
  await writeFile(source, 'source'); await writeFile(output, 'output')
  const saved = await contentReviewFixture({ project, episode: '21', output, duration: 5,
    sources: [{ shot: 1, path: source, duration: 5 }] })
  const input = { project, episode: '21', output, outputSha256: await fileSha256(output), duration: 5,
    sources: [{ shot: 1, sha256: await fileSha256(source), duration: 5 }], cuts: [], verifier }
  const save = async () => { await saved.json(saved.path, saved.document) }
  const report = async (value: object) => {
    saved.entry.content_review.output.inspection.sha256 = await saved.json(saved.entry.content_review.output.inspection.path, value)
    await save()
  }
  return { input, saved, save, report }
}

/** Nobody listened: no answered question and no machine pronunciation ranges. */
function unlistened(f: Awaited<ReturnType<typeof fixture>>) {
  const audio = f.saved.entry.content_review.audio as Record<string, unknown>
  audio.status = 'unverified'
  audio.question_call_id = ''
  Reflect.deleteProperty(audio, 'ranges')
}

const listeningRefused: ContentReviewVerifier = async (binding) => {
  if (binding.kind === 'listening') throw Error('CONTENT_REVIEW_PENDING: 没有当前成片的真实已完成试听回答。')
}

describe('unattended content review', () => {
  it('archives an unlistened episode with listening pending for a person', async () => {
    const f = await fixture()
    unlistened(f); await f.save()
    await expect(verifyEpisodeContentReview(f.input)).rejects.toThrow('CONTENT_REVIEW_PENDING')
    const receipt = await verifyEpisodeContentReview({ ...f.input, unattended: true })
    expect(receipt.pending).toEqual([LISTENING_PENDING])
    expect(receipt.files.length).toBeGreaterThan(0)
  })

  it('treats a claimed answer that does not verify as pending listening, not a pass', async () => {
    const f = await fixture(listeningRefused)
    await expect(verifyEpisodeContentReview(f.input)).rejects.toThrow('CONTENT_REVIEW_PENDING')
    const receipt = await verifyEpisodeContentReview({ ...f.input, unattended: true })
    expect(receipt.pending?.[0]).toBe(LISTENING_PENDING)
  })

  it('records nothing pending when a real listening answer verifies', async () => {
    const f = await fixture()
    const receipt = await verifyEpisodeContentReview({ ...f.input, unattended: true })
    expect(receipt.pending).toBeUndefined()
  })

  it('keeps open picture findings and uncertain events as pending items', async () => {
    const f = await fixture()
    f.saved.entry.content_review.output.checks[0]!.status = 'issue'
    f.saved.entry.content_review.output.checks[0]!.reason = '第3秒白手套消失'
    f.saved.entry.picture = 'unverified'
    f.saved.entry.audio = 'unverified'
    ;(f.saved.entry.issues as unknown[]).push('P3 裸手待返工', 'P3 裸手待返工', { note: '声画同步待复核' })
    const observed = { duration: 5, frames: [{ id: 'first', decoded_time: 0.1 }, { id: 'last', decoded_time: 4.9 }] }
    const source = f.saved.entry.content_review.sources[0]!
    source.inspection.sha256 = await f.saved.json(source.inspection.path, { ...observed,
      event_groups: [{ uncertainty: '分包里的茶杯仍看不清' }] })
    await f.report({ ...observed, event_groups: [{ uncertainty: '无' }, { uncertainty: '陆知宁是否戴手套看不清' }] })
    await expect(verifyEpisodeContentReview(f.input)).rejects.toThrow('CONTENT_REVIEW_PENDING')
    // Six distinct picture findings exceed the unattended limit; the refusal lists them for repair.
    const refused = await verifyEpisodeContentReview({ ...f.input, unattended: true })
      .then(() => '', (error: unknown) => String(error))
    expect(refused).toContain('超过上限')
    expect(refused).toContain('白手套消失')
    expect(refused).toContain('陆知宁是否戴手套看不清')
    expect(refused.split('P3 裸手待返工')).toHaveLength(2)
    expect(refused).toContain('成片审查问题：{"note":"声画同步待复核"}')
    expect(refused).toContain('第1镜分包已观察动作事件仍有未决疑点：分包里的茶杯仍看不清')
    expect(refused).not.toContain('成片已观察动作事件仍有未决疑点：无')
    expect(refused).not.toContain('声音审查为unverified')
  })

  it('refuses to defer more picture findings than the episode limit', async () => {
    const f = await fixture()
    unlistened(f)
    const issues = f.saved.entry.issues as unknown[]
    for (let index = 1; index <= UNATTENDED_PICTURE_PENDING_LIMIT; index++) issues.push(`第${index}镜道具跳变`)
    await f.save()
    const receipt = await verifyEpisodeContentReview({ ...f.input, unattended: true })
    expect(receipt.pending).toHaveLength(UNATTENDED_PICTURE_PENDING_LIMIT + 1)
    issues.push('第9镜手套消失')
    await f.save()
    await expect(verifyEpisodeContentReview({ ...f.input, unattended: true })).rejects.toThrow('超过上限')
  })

  it('does not count sound findings toward the picture limit', async () => {
    const f = await fixture()
    unlistened(f)
    f.saved.entry.audio = 'unverified'
    const issues = f.saved.entry.issues as unknown[]
    for (let index = 1; index <= UNATTENDED_PICTURE_PENDING_LIMIT; index++) issues.push(`第${index}镜构图偏移`)
    await f.save()
    const receipt = await verifyEpisodeContentReview({ ...f.input, unattended: true })
    expect(receipt.pending?.some(item => item.includes('声音'))).toBe(true)
  })


  it.each(['absent audio evidence', 'empty machine ranges'] as const)('leaves listening pending with %s', async (kind) => {
    const f = await fixture()
    if (kind === 'absent audio evidence') Reflect.deleteProperty(f.saved.entry.content_review, 'audio')
    else {
      unlistened(f)
      f.saved.entry.content_review.audio.ranges = []
    }
    await f.save()
    await expect(verifyEpisodeContentReview({ ...f.input, unattended: true })).resolves.toMatchObject({ pending: [LISTENING_PENDING] })
  })

  it('records invalid machine pronunciation evidence for review', async () => {
    const f = await fixture()
    f.saved.entry.content_review.audio.ranges[0]!.dimension = 'continuity'
    await f.save()
    const receipt = await verifyEpisodeContentReview({ ...f.input, unattended: true })
    expect(receipt.pending).toEqual([expect.stringContaining('机器读音检查：声音范围必须明确核对实际发音。')])
  })

  it.each<{ name: string; mutate: (f: Awaited<ReturnType<typeof fixture>>) => void | Promise<void> }>([
    { name: 'subtitle verdict not ok', mutate: (f) => { f.saved.entry.subtitle = 'issue' } },
    { name: 'spec verdict not ok', mutate: (f) => { f.saved.entry.spec = 'unverified' } },
    { name: 'unreviewed film', mutate: (f) => { f.saved.entry.reviewed = false } },
    { name: 'missing issue list', mutate: (f) => { Reflect.deleteProperty(f.saved.entry, 'issues') } },
    { name: 'picture coverage gap', mutate: (f) => { f.saved.entry.content_review.output.checks[0]!.start_seconds = 1 } },
    { name: 'range without a reason', mutate: (f) => { f.saved.entry.content_review.output.checks[0]!.reason = '' } },
    { name: 'missing observation identity', mutate: (f) => { f.saved.entry.content_review.output.inspection.review_id = '' } },
    { name: 'event without an uncertainty note', mutate: f => f.report({ duration: 5,
      frames: [{ id: 'first', decoded_time: 0.1 }, { id: 'last', decoded_time: 4.9 }], event_groups: [{}] }) },
  ])('still refuses $name', async ({ mutate }) => {
    const f = await fixture()
    await mutate(f); await f.save()
    await expect(verifyEpisodeContentReview({ ...f.input, unattended: true })).rejects.toThrow('CONTENT_REVIEW_PENDING')
  })

  it('still requires the Host to verify real observations', async () => {
    const f = await fixture(async (binding) => { if (binding.kind === 'video') throw Error('observation not issued') })
    await expect(verifyEpisodeContentReview({ ...f.input, unattended: true })).rejects.toThrow('observation not issued')
  })
})

describe('unattendedReviewMode', () => {
  const host = (service: unknown) => ({ get: (name: string) => name === 'sessionCoordinator' ? service : undefined })
  it('follows only a mounted coordinator that reports unattended', () => {
    expect(unattendedReviewMode(host(undefined) as never)).toBe(false)
    expect(unattendedReviewMode(host({ mode: { unattended: false } }) as never)).toBe(false)
    expect(unattendedReviewMode(host({ mode: { unattended: 'yes' } }) as never)).toBe(false)
    expect(unattendedReviewMode(host({ mode: { unattended: true } }) as never)).toBe(true)
  })
})
