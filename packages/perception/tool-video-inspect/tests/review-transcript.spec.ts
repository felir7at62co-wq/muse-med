/** Successful-read candidates retain explicit source priority, canonical identity and current-file evidence. */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveReviewTranscript, type VideoTranscriptReadReceipt } from '../src/review-transcript.ts'
import { reviewSpeech } from '../src/review-speech.ts'
import { VideoReviewId, type VideoReview } from '../src/review-state.ts'

const fixtures: { ctx: Context; root: string }[] = []
afterEach(async () => {
  for (const { ctx, root } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-transcript-candidate-')), ctx = new Context()
  fixtures.push({ ctx, root })
  await ctx.plugin(LocalFileSystem, { cwd: root }).await()
  const path = join(root, 'source.mp4')
  await writeFile(path, 'video source')
  const source = await ctx.fs.resolve(path)
  const review: VideoReview = { id: VideoReviewId('review-1'), episode: '第4集', path,
    source_version: (await ctx.fs.stat(source))!.version, duration: 30,
    scan_complete: true, scanned_until: 30, frames: [] }
  const receipt = (name: string, seq = 4): VideoTranscriptReadReceipt => ({ path: join(root, name),
    readCallId: ToolCallId(`read-${name}`), readResultSeq: SessionSeq(seq) })
  const saved = async (name: string, text = '先把茶杯放下。') => {
    const path = join(root, name), body = JSON.stringify([{ start: 10, end: 12, text, speaker_id: 1 }])
    await writeFile(path, body)
    return path
  }
  const resolve = (reads: VideoTranscriptReadReceipt[], maxTranscriptBytes = 4096) => resolveReviewTranscript(ctx, review,
    source, { maxTranscriptBytes, transcriptCandidates: { taskStartSeq: SessionSeq(3), reads } }, root,
    new AbortController().signal)
  return { root, ctx, source, review, receipt, saved, resolve }
}

it('offers a unique current-task same-directory successful JSON read as a candidate without storing an association', async () => {
  const h = await fixture()
  await h.saved('asr.json')
  await writeFile(join(h.root, 'other.json'), '{}')
  const before = JSON.stringify(h.review), receipts = [h.receipt('asr.json'), h.receipt('other.json')]
  const result = await h.resolve(receipts)
  expect(result.link.speech?.segments[0]).toMatchObject({ start_seconds: 10, text: '先把茶杯放下。' })
  expect(result.resolution).toMatchObject({ kind: 'successful_read_candidate', same_source_verified: false,
    read_receipts: [receipts[0]], diagnostics: [{ status: 'valid' }, { status: 'unavailable' }] })
  expect(result.reference?.sha256).toBe(result.link.speech?.source.sha256)
  expect(await result.stillCurrent?.()).toBe(true)
  await writeFile(join(h.root, 'asr.json'), 'changed')
  expect(await result.stillCurrent?.()).toBe(false)
  expect(JSON.stringify(h.review)).toBe(before)
})

it('retains ambiguity between distinct valid ASR files without selecting by read order or modification time', async () => {
  const h = await fixture()
  await h.saved('one.json', '原句一。')
  await h.saved('two.json', '原句二。')
  for (const reads of [[h.receipt('one.json'), h.receipt('two.json')], [h.receipt('two.json'), h.receipt('one.json')]]) {
    const result = await h.resolve(reads)
    expect(result.resolution).toMatchObject({ kind: 'ambiguous', diagnostics: [{ status: 'valid' }, { status: 'valid' }] })
    expect(result.link.speech).toBeUndefined()
    expect(result.reference).toBeUndefined()
  }
})

it('deduplicates canonical aliases while keeping the actual successful-read receipts', async () => {
  const h = await fixture()
  const path = await h.saved('asr.json')
  await symlink(path, join(h.root, 'alias.json'))
  const receipts = [h.receipt('asr.json'), h.receipt('alias.json')]
  const result = await h.resolve(receipts)
  expect(result.resolution).toMatchObject({ kind: 'successful_read_candidate', read_receipts: receipts })
  expect(result.resolution?.diagnostics).toHaveLength(1)
})

it('excludes previous-task reads, plain text and canonical files in another source directory', async () => {
  const h = await fixture()
  await h.saved('old.json')
  await h.saved('asr.txt')
  await mkdir(join(h.root, 'other'))
  const other = await h.saved('other/asr.json')
  await symlink(other, join(h.root, 'linked.json'))
  const result = await h.resolve([h.receipt('old.json', 2), h.receipt('asr.txt'), h.receipt('other/asr.json'), h.receipt('linked.json')])
  expect(result.resolution).toMatchObject({ kind: 'unavailable', diagnostics: [
    { status: 'not_current_task' }, { status: 'not_json' }, { status: 'outside_source_directory' }, { status: 'outside_source_directory' },
  ] })
  expect(result.link.speech).toBeUndefined()
})

it.each(['invalid', 'outside_time', 'oversized', 'missing'])('keeps %s candidate ASR unavailable without replacement', async (kind) => {
  const h = await fixture(), receipt = h.receipt('asr.json')
  if (kind !== 'missing') await writeFile(receipt.path, kind === 'invalid' ? '{'
    : JSON.stringify([{ start: 0, end: kind === 'outside_time' ? 31 : 1, text: '原台词。' }]))
  const result = await h.resolve([receipt], kind === 'oversized' ? 1 : 4096)
  expect(result.resolution).toMatchObject({ kind: 'unavailable', diagnostics: [{ status: 'unavailable' }] })
  expect(result.link.speech).toBeUndefined()
  expect(h.review.transcript_reference).toBeUndefined()
})

it('prioritizes the explicit reference even when it becomes stale and a valid candidate is available', async () => {
  const h = await fixture(), path = await h.saved('explicit.json', '显式原句。')
  const target = await h.ctx.fs.resolve(path), version = (await h.ctx.fs.stat(target))!.version
  const parsed = reviewSpeech({ path, version, text: await h.ctx.fs.readText(target) }, h.review.duration)
  h.review.transcript_reference = { path, version, sha256: parsed.source.sha256 }
  await h.saved('candidate.json', '不应替换原来源。')
  const fresh = await h.resolve([h.receipt('candidate.json')])
  expect(fresh.resolution?.kind).toBe('explicit_reference')
  expect(fresh.link.speech?.segments[0]?.text).toBe('显式原句。')
  await h.saved('explicit.json', '显式来源发生变化。')
  const stale = await h.resolve([h.receipt('candidate.json')])
  expect(stale.resolution?.kind).toBe('explicit_reference')
  expect(stale.link.speech).toBeUndefined()
  expect(stale.link.speech_unavailable?.reference).toEqual(h.review.transcript_reference)
  expect(JSON.stringify(stale)).not.toContain('不应替换原来源')
})

it('rejects a changed explicit ASR digest and reports a missing referenced file without substituting candidates', async () => {
  const h = await fixture(), path = await h.saved('explicit.json')
  const target = await h.ctx.fs.resolve(path), version = (await h.ctx.fs.stat(target))!.version
  h.review.transcript_reference = { path, version, sha256: 'wrong-digest' }
  const changed = await h.resolve([h.receipt('explicit.json')])
  expect(changed.link.speech).toBeUndefined()
  expect(changed.link.speech_unavailable?.current_version).toBe(version)
  expect(changed.link.speech_unavailable?.reason).toContain('VIDEO_TRANSCRIPT_CHANGED')
  h.review.transcript_reference = { path: join(h.root, 'missing.json'), version: 'old', sha256: 'old' }
  const missing = await h.resolve([h.receipt('explicit.json')])
  expect(missing.link.speech_unavailable?.current_version).toBeUndefined()
  expect(missing.resolution?.kind).toBe('explicit_reference')
})

it('leaves speech unlinked without read receipts and diagnoses filesystem resolution failures', async () => {
  const h = await fixture()
  expect(await resolveReviewTranscript(h.ctx, h.review, h.source, { maxTranscriptBytes: 4096 }, h.root,
    new AbortController().signal)).toEqual({ link: {} })
  const failure = vi.spyOn(h.ctx.fs, 'resolve').mockRejectedValueOnce('provider unavailable')
  try {
    const result = await h.resolve([h.receipt('asr.json')])
    expect(result.resolution).toMatchObject({ kind: 'unavailable', diagnostics: [
      { status: 'unavailable', reason: 'provider unavailable' },
    ] })
  } finally {
    failure.mockRestore()
  }
})
