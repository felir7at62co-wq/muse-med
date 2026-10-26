/** Source reads must fail closed when saved video, ASR or cached frames change. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { readVideoSourceTimeline, videoReviewSummaries } from '../src/review-source.ts'
import { VideoReviewId, type VideoReview } from '../src/review-state.ts'

const observed = { visible: '一位人物站在桌边，手中拿着信封。', change: '人物伸手拿起信封。', uncertainty: '' }

function fixture(linkTranscript = false) {
  const sourcePath = '/workspace/source.mp4', transcriptPath = '/workspace/asr.json'
  const transcriptText = JSON.stringify([{ start: 0, end: 1, text: '原句。', speaker_id: '1' }])
  const reference = { path: transcriptPath, version: 'asr-v1',
    sha256: createHash('sha256').update(transcriptText).digest('hex') }
  const review: VideoReview = { id: VideoReviewId('review-1'), episode: '第1集', path: sourcePath,
    source_version: 'video-v1', duration: 2, scanned_until: 2, scan_complete: true,
    frames: [{ id: 'F00001', time: 0, reasons: ['opening'], exposed: true, observation: observed,
      image: { attachmentId: 'image-1', mediaType: 'image/png', bytes: 4, width: 1, height: 1 } },
    { id: 'F00002', time: 1, reasons: ['change'], exposed: false }],
    ...(linkTranscript ? { transcript_reference: reference } : {}) }
  let currentReview = review, sourceVersion = 'video-v1', transcriptVersion = 'asr-v1'
  let imageRead: () => Promise<void> = async () => {}, transcriptStatFailure: unknown
  const ctx = { get: (name: string) => name === 'sessionProjections'
    ? { stateOf: () => ({ [sourcePath]: currentReview }) } : undefined,
  sandboxPolicy: { resolve: () => ({ workspaceRoot: '/workspace' }) },
  fs: { resolve: async (path: string) => ({ displayPath: path, targetKey: path }),
    fileUrl: (target: { displayPath: string }) => `file://${target.displayPath}`,
    stat: async (target: { displayPath: string }) => {
      if (target.displayPath === sourcePath) return { version: sourceVersion }
      if (transcriptStatFailure !== undefined) throw transcriptStatFailure
      return { version: transcriptVersion, type: 'file', size: Buffer.byteLength(transcriptText) }
    },
    readBytes: async () => Buffer.from(transcriptText) },
  attachments: { readImage: async () => imageRead() } } as unknown as Context
  const session = {} as Session, signal = new AbortController().signal
  const options = { windowSeconds: 1, maxTranscriptBytes: 4096, maxBytes: 100_000, maxFrames: 2 }
  const read = (extra: Record<string, unknown> = {}) => readVideoSourceTimeline(ctx, session, review.id,
    { ...options, ...extra }, signal)
  return { ctx, session, review, reference, read, setSourceVersion: (version: string) => { sourceVersion = version },
    setTranscriptVersion: (version: string) => { transcriptVersion = version },
    failTranscriptStat: (reason: unknown) => { transcriptStatFailure = reason },
    setReview: (value: VideoReview) => { currentReview = value },
    onImageRead: (callback: () => Promise<void>) => { imageRead = callback } }
}

it('lists explicit ASR associations but refuses an unknown or changed video revision', async () => {
  const h = fixture(true)
  expect(videoReviewSummaries(h.ctx, h.session)).toMatchObject([{ review_id: 'review-1',
    transcript_reference: h.reference }])
  await expect(readVideoSourceTimeline(h.ctx, h.session, VideoReviewId('other'),
    { windowSeconds: 1, maxTranscriptBytes: 4096, maxBytes: 100_000, maxFrames: 1 },
    new AbortController().signal)).rejects.toThrow('VIDEO_TIMELINE_REVIEW')
  h.setSourceVersion('video-v2')
  await expect(h.read()).rejects.toThrow('VIDEO_REVIEW_SOURCE_CHANGED')
})

it('rejects excess, duplicate, unrecorded and uncached frame selections before returning images', async () => {
  const h = fixture()
  expect(videoReviewSummaries(h.ctx, h.session)).toMatchObject([{ review_id: 'review-1', path: h.review.path }])
  expect((await h.read()).content).toHaveLength(1)
  await expect(h.read({ maxFrames: 0, frameIds: ['F00001'] })).rejects.toThrow('VIDEO_TIMELINE_IMAGES')
  await expect(h.read({ frameIds: ['F00001', 'F00001'] })).rejects.toThrow('VIDEO_TIMELINE_IMAGES')
  await expect(h.read({ frameIds: ['F00002'] })).rejects.toThrow('VIDEO_TIMELINE_FRAME')
  await expect(h.read({ frameIds: ['missing'] })).rejects.toThrow('VIDEO_TIMELINE_FRAME')
  const changedDuringSelection = [...h.review.frames]
  changedDuringSelection.find = () => undefined
  h.setReview({ ...h.review, frames: changedDuringSelection })
  await expect(h.read({ frameIds: ['F00001'] })).rejects.toThrow('VIDEO_TIMELINE_FRAME')
  h.setReview({ ...h.review, frames: [{ ...h.review.frames[0]!, image: undefined }, h.review.frames[1]!] })
  await expect(h.read({ frameIds: ['F00001'] })).rejects.toThrow('VIDEO_REVISIT_IMAGE_MISSING')
})

it('keeps cache errors, changed ASR and late video revisions out of the returned source material', async () => {
  const h = fixture(true)
  h.onImageRead(async () => { throw 'cache inaccessible' })
  await expect(h.read({ frameIds: ['F00001'] })).rejects.toThrow('cache inaccessible')
  h.onImageRead(async () => { throw Error('cached image removed') })
  await expect(h.read({ frameIds: ['F00001'] })).rejects.toThrow('cached image removed')
  h.onImageRead(async () => { h.setTranscriptVersion('asr-v2') })
  const staleSpeech = await h.read({ frameIds: ['F00001'] })
  expect(staleSpeech.timeline.speech).toBeUndefined()
  expect(staleSpeech.timeline.speech_unavailable?.reason).toContain('VIDEO_TRANSCRIPT_CHANGED')
  h.onImageRead(async () => { h.setSourceVersion('video-v2') })
  await expect(h.read({ frameIds: ['F00001'] })).rejects.toThrow('VIDEO_REVIEW_SOURCE_CHANGED')
})

it('refuses a changed review projection and complete-result overflow after a valid cache read', async () => {
  const h = fixture()
  await expect(h.read({ maxBytes: 1 })).rejects.toThrow('VIDEO_TIMELINE_SIZE')
  h.onImageRead(async () => { h.setReview({ ...h.review }) })
  await expect(h.read({ frameIds: ['F00001'] })).rejects.toThrow('VIDEO_REVIEW_SOURCE_CHANGED')
})

it('downgrades an unreadable associated ASR after image retrieval while retaining picture evidence', async () => {
  const h = fixture(true)
  h.onImageRead(async () => { h.failTranscriptStat('ASR storage disappeared') })
  const material = await h.read({ frameIds: ['F00001'] })
  expect(material.timeline.speech).toBeUndefined()
  expect(material.timeline.speech_unavailable?.reason).toBe('ASR storage disappeared')
  expect(material.content.filter(block => block.type === 'image')).toHaveLength(1)
  const errorCase = fixture(true)
  errorCase.onImageRead(async () => { errorCase.failTranscriptStat(Error('ASR read failed')) })
  expect((await errorCase.read({ frameIds: ['F00001'] })).timeline.speech_unavailable?.reason).toBe('ASR read failed')
})

it('invalidates a current-task ASR candidate after cache read without discarding other diagnostics', async () => {
  const h = fixture()
  h.onImageRead(async () => { h.setTranscriptVersion('asr-v2') })
  const material = await h.read({ frameIds: ['F00001'], transcriptCandidates: {
    taskStartSeq: SessionSeq(1), reads: [
      { path: '/workspace/asr.json', readCallId: ToolCallId('read-asr'), readResultSeq: SessionSeq(2) },
      { path: '/workspace/notes.txt', readCallId: ToolCallId('read-note'), readResultSeq: SessionSeq(2) },
    ],
  } })
  expect(material.timeline.speech).toBeUndefined()
  expect(material.timeline.transcript_resolution).toMatchObject({ kind: 'unavailable', diagnostics: [
    { path: '/workspace/notes.txt', status: 'not_json' },
    { path: '/workspace/asr.json', status: 'unavailable', reason: 'VIDEO_TRANSCRIPT_CHANGED: ASR在读取缓存图片期间变化。' },
  ] })
})
