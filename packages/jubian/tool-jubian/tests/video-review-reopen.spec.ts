import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { reviewRecoveredVideo } from '../src/video-recovery.ts'

const key = 'submitted-video'
let project: string
let rejectionPath: string
let digest: string

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'jubian-video-reopen-'))
  const review = join(project, 'video_tasks', 'review')
  await mkdir(review, { recursive: true })
  const reportPath = join(review, createHash('sha256').update(key).digest('hex') + '.json')
  const report = JSON.stringify({ idempotency_key: key, task_id: 42, status: 'awaiting_review',
    media_checks: [{ sha256: 'sha256:' + 'a'.repeat(64), video: true, audio: true }] })
  await writeFile(reportPath, report)
  rejectionPath = reportPath + '.decision.json'
  digest = createHash('sha256').update(report).digest('hex')
})

afterEach(async () => { await rm(project, { recursive: true, force: true }) })

it('reopens the exact rejection and stores the new decision beside the original', async () => {
  await reviewRecoveredVideo(project, key, { action: 'reject', digest, reason: 'Check lip sync' })
  const original = await readFile(rejectionPath, 'utf8')
  await expect(reviewRecoveredVideo(project, key, { action: 'reopen', digest: 'stale', reason: 'Action only' }))
    .rejects.toThrow('current rejected review')
  await expect(reviewRecoveredVideo(project, key, { action: 'reopen', digest, reason: '   ' }))
    .rejects.toThrow()
  const reopened = await reviewRecoveredVideo(project, key, { action: 'reopen', digest, reason: 'Action only' })
  const current = reopened.digest
  if (typeof current !== 'string') throw new Error('Expected the reopened review digest')
  expect(current).not.toBe(digest)
  expect(reopened).toMatchObject({ decision: null,
    reopened_from: { digest, rejectionReason: 'Check lip sync', reason: 'Action only' } })
  await expect(reviewRecoveredVideo(project, key, { action: 'approve', digest })).rejects.toThrow('report changed')
  await expect(reviewRecoveredVideo(project, key, { action: 'reopen', digest: current, reason: 'Again' }))
    .rejects.toThrow('current rejected review')
  await reviewRecoveredVideo(project, key, { action: 'approve', digest: current })
  await expect(reviewRecoveredVideo(project, key)).resolves.toMatchObject({
    digest: current, decision: { action: 'approve', digest: current },
    reopened_from: { digest, rejectionReason: 'Check lip sync', reason: 'Action only' },
  })
  await expect(readFile(rejectionPath, 'utf8')).resolves.toBe(original)
  await writeFile(rejectionPath, original + '\n')
  await expect(reviewRecoveredVideo(project, key)).rejects.toThrow('original video rejection changed')
})

it('requires a rejection and publishes only one concurrent reopening', async () => {
  const reopening = { action: 'reopen', digest, reason: 'Checked audio' } as const
  await expect(reviewRecoveredVideo(project, key, reopening)).rejects.toThrow('current rejected review')
  await reviewRecoveredVideo(project, key, { action: 'reject', digest })
  const results = await Promise.allSettled([
    reviewRecoveredVideo(project, key, reopening), reviewRecoveredVideo(project, key, reopening),
  ])
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
})
