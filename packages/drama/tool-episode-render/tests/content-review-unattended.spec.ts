/** Unattended runs archive open review findings for a person instead of refusing; attended runs keep refusing. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { LISTENING_PENDING, unattendedReviewMode, verifyEpisodeContentReview, type ContentReviewVerifier } from '../src/content-review.ts'
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
    ;(f.saved.entry.issues as unknown[]).push('P3 裸手待返工')
    await f.report({ duration: 5, frames: [{ id: 'first', decoded_time: 0.1 }, { id: 'last', decoded_time: 4.9 }],
      event_groups: [{ uncertainty: '陆知宁是否戴手套看不清' }] })
    await expect(verifyEpisodeContentReview(f.input)).rejects.toThrow('CONTENT_REVIEW_PENDING')
    const receipt = await verifyEpisodeContentReview({ ...f.input, unattended: true })
    const pending = receipt.pending ?? []
    expect(pending.some(item => item.includes('白手套消失'))).toBe(true)
    expect(pending.some(item => item.includes('看不清'))).toBe(true)
    expect(pending.some(item => item.includes('P3 裸手待返工'))).toBe(true)
    expect(pending.some(item => item.includes('画面'))).toBe(true)
    expect(pending).not.toContain(LISTENING_PENDING)
  })

  it.each<{ name: string; mutate: (f: Awaited<ReturnType<typeof fixture>>) => void | Promise<void> }>([
    { name: 'subtitle verdict not ok', mutate: (f) => { f.saved.entry.subtitle = 'issue' } },
    { name: 'spec verdict not ok', mutate: (f) => { f.saved.entry.spec = 'unverified' } },
    { name: 'unreviewed film', mutate: (f) => { f.saved.entry.reviewed = false } },
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
