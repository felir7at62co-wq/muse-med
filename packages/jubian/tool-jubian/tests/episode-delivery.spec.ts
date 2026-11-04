/** Explicit episode plans require contiguous approved reports and digest-bound inputs. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { parseEpisodeDelivery, readApprovedEpisodePlan, summarizeApprovedEpisode } from '../src/episode-delivery.ts'
import type { VideoRecoveryReview } from '../src/types.ts'

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

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
  const { project, plan, report } = await fixture()
  const first = await readApprovedEpisodePlan(project, 1)
  const timeline = await readFile(first.timelinePath)
  const subtitle = await readFile(first.subtitlePath)
  const mix = await readFile(first.mixProfilePath)
  expect(first.digest).toBe(sha256(Buffer.concat([Buffer.from(JSON.stringify(plan)), timeline, subtitle, mix])))
  expect(first.inputHashes).toEqual({
    projectConfig: sha256('{}\n'), timeline: sha256(timeline), subtitle: sha256(subtitle), mixProfile: sha256(mix),
  })
  const reports = [report('shot-one', '1'.repeat(64)), report('shot-two', '2'.repeat(64))]
  expect(await summarizeApprovedEpisode(project, 1, reports)).toMatchObject({
    readiness: 'ready', approvedShots: 2, totalShots: 2, digest: first.digest, missing: [],
  })

  const revisedConfig = '{"ending":true}\n'
  await writeFile(join(project, 'project_config.json'), revisedConfig)
  const configured = await readApprovedEpisodePlan(project, 1)
  expect(configured.digest).toBe(first.digest)
  expect(configured.inputHashes).toEqual({ ...first.inputHashes, projectConfig: sha256(revisedConfig) })

  const revisedSubtitle = '1\n00:00:00,000 --> 00:00:01,000\n更新字幕\n'
  await writeFile(first.subtitlePath, revisedSubtitle)
  const changed = await readApprovedEpisodePlan(project, 1)
  expect(changed.digest).not.toBe(first.digest)
  expect(changed.inputHashes).toEqual({ ...configured.inputHashes, subtitle: sha256(revisedSubtitle) })
})

it('keeps the existing digest when hashing a streamed BGM input', async () => {
  const { project, plan, planPath } = await fixture()
  const bgmPath = 'editing/01-bgm.mp3'
  const bgm = Buffer.alloc(160 * 1024, 0xa5)
  const withBgm = { ...plan, bgm: bgmPath }
  await writeFile(join(project, bgmPath), bgm)
  await writeFile(join(project, plan.mix_profile), '{"schema_version":1,"mode":"ducking"}\n')
  await writeFile(planPath, JSON.stringify(withBgm) + '\n')
  const result = await readApprovedEpisodePlan(project, 1)
  expect(result.digest).toBe(sha256(Buffer.concat([
    Buffer.from(JSON.stringify(withBgm)),
    await readFile(result.timelinePath), await readFile(result.subtitlePath), await readFile(result.mixProfilePath), bgm,
  ])))
  expect(result.inputHashes.bgm).toBe(sha256(bgm))
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

it('reads old receipts and checks each input hash when present', () => {
  const planDigest = 'a'.repeat(64)
  const receipt = {
    path: `exports/Supermuse-episode-01-${planDigest}.mp4`,
    sha256: 'b'.repeat(64), durationSeconds: 2, checks: [],
  }
  expect(parseEpisodeDelivery(receipt)).toEqual(receipt)
  const inputHashes = {
    projectConfig: 'c'.repeat(64), timeline: 'd'.repeat(64),
    subtitle: 'e'.repeat(64), mixProfile: 'f'.repeat(64),
  }
  expect(parseEpisodeDelivery({ ...receipt, inputHashes })).toEqual({ ...receipt, inputHashes })
  const withBgm = { ...inputHashes, bgm: '1'.repeat(64) }
  expect(parseEpisodeDelivery({ ...receipt, inputHashes: withBgm })).toEqual({ ...receipt, inputHashes: withBgm })
  expect(() => parseEpisodeDelivery({ ...receipt, inputHashes: { ...inputHashes, bgm: 'bad' } })).toThrow()
  expect(() => parseEpisodeDelivery({ ...receipt, inputHashes: { ...inputHashes, extra: planDigest } })).toThrow()
  expect(() => parseEpisodeDelivery({ ...receipt, inputHashes: { timeline: inputHashes.timeline } })).toThrow()
})
