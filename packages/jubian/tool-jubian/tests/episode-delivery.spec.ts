/** Explicit episode plans require contiguous approved reports and digest-bound inputs. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { readApprovedEpisodePlan, summarizeApprovedEpisode } from '../src/episode-delivery.ts'
import type { VideoRecoveryReview } from '../src/types.ts'

async function fixture() {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'muse-episode-delivery-')))
  onTestFinished(async () => { await rm(project, { recursive: true, force: true, maxRetries: 3 }) })
  await mkdir(join(project, 'editing'))
  await writeFile(join(project, 'project_config.json'), '{}\n')
  await writeFile(join(project, 'editing', '01-timeline.json'), JSON.stringify({
    clips: [{ shot: 1, start_us: 0, duration_us: 1_000_000 }, { shot: 2, start_us: 1_000_000, duration_us: 1_000_000 }],
    body_end: 2,
  }) + '\n')
  await writeFile(join(project, 'editing', '01.srt'), '1\n00:00:00,000 --> 00:00:01,000\n测试字幕\n')
  await writeFile(join(project, 'editing', '01-mix.json'), '{"schema_version":1,"mode":"no_bgm"}\n')
  const plan = {
    schema_version: 1, episode: 1, total_shots: 2,
    shots: [
      { shot: 1, idempotency_key: 'shot-one', review_digest: '1'.repeat(64) },
      { shot: 2, idempotency_key: 'shot-two', review_digest: '2'.repeat(64) },
    ],
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', mix_profile: 'editing/01-mix.json',
  }
  const planPath = join(project, 'editing', '01-episode-delivery.json')
  await writeFile(planPath, JSON.stringify(plan) + '\n')
  const report = (idempotencyKey: string, digest: string): VideoRecoveryReview => ({
    idempotencyKey, taskId: idempotencyKey === 'shot-one' ? 1 : 2, status: 'awaiting_review', digest,
    mediaChecks: [{ sha256: digest, video: true, audio: true }], decision: 'approve',
  })
  return { project, plan, planPath, report }
}

it('binds the plan digest to its ordered approvals and all editing inputs', async () => {
  const { project, report } = await fixture()
  const first = await readApprovedEpisodePlan(project, 1)
  const reports = [report('shot-one', '1'.repeat(64)), report('shot-two', '2'.repeat(64))]
  expect(await summarizeApprovedEpisode(project, 1, reports)).toMatchObject({
    readiness: 'ready', approvedShots: 2, totalShots: 2, digest: first.digest, missing: [],
  })

  await writeFile(join(project, 'editing', '01.srt'), '1\n00:00:00,000 --> 00:00:01,000\n更新字幕\n')
  const changed = await readApprovedEpisodePlan(project, 1)
  expect(changed.digest).not.toBe(first.digest)
})

it('keeps the episode unavailable until every exact report is approved with passing media checks', async () => {
  const { project, report } = await fixture()
  const awaiting: VideoRecoveryReview = { ...report('shot-two', '2'.repeat(64)), decision: null }
  expect(await summarizeApprovedEpisode(project, 1, [report('shot-one', '1'.repeat(64)), awaiting]))
    .toMatchObject({ readiness: 'incomplete', approvedShots: 1, totalShots: 2, missing: ['2'] })
  expect(await summarizeApprovedEpisode(project, 1, [
    report('shot-one', '1'.repeat(64)), { ...report('shot-two', '2'.repeat(64)), mediaChecks: [{ sha256: '2'.repeat(64), video: true, audio: false }] },
  ])).toMatchObject({ readiness: 'incomplete', missing: ['2'] })
})

it('rejects noncontiguous plans and paths that escape the selected project', async () => {
  const { project, plan, planPath } = await fixture()
  await writeFile(planPath, JSON.stringify({ ...plan, shots: [{ ...plan.shots[0], shot: 2 }, plan.shots[1]] }))
  expect(await summarizeApprovedEpisode(project, 1, [])).toMatchObject({ readiness: 'invalid' })
  await writeFile(planPath, JSON.stringify({ ...plan, timeline: '../outside.json' }))
  await expect(readApprovedEpisodePlan(project, 1)).rejects.toThrow('escapes the selected project')
})
