/** Strict authored episode plans and exact current local input snapshots. */
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { assertEpisodeFileVersion, hashEpisodeFile, readEpisodeBytes } from './episode-delivery.ts'
import type { ApprovedEpisodeCaptureInput, ApprovedEpisodeInputFile, EpisodeFileVersion, Sha256 } from './episode-delivery.ts'
import type { ApprovedClipDeliveryInput, VideoRecoveryDigest } from './types.ts'

const shotSchema = z.strictObject({ shot: z.number().int().min(1).max(500), idempotency_key: z.string().min(1),
  review_digest: z.string().regex(/^[a-f0-9]{64}$/u) })
const planSchema = z.strictObject({ schema_version: z.literal(1), episode: z.number().int().min(1).max(99),
  total_shots: z.number().int().min(1).max(500), shots: z.array(shotSchema).min(1).max(500),
  timeline: z.string().min(1), subtitle_srt: z.string().min(1), mix_profile: z.string().min(1), bgm: z.string().min(1).optional() })
const timelineSchema = z.object({ clips: z.array(z.object({ shot: z.number().int().positive(),
  start_us: z.number().int().nonnegative(), duration_us: z.number().int().positive() })), body_end: z.number().positive() })
const mixSchema = z.object({ schema_version: z.literal(1), mode: z.enum(['legacy', 'no_bgm', 'ducking']) })

/** Fully measured editable inputs; digest excludes renderer configuration and provider generation. */
export interface ApprovedEpisodePlan extends ApprovedEpisodeCaptureInput {
  readonly projectSha256: Sha256
  readonly shots: readonly { readonly shot: number; readonly input: ApprovedClipDeliveryInput }[]
  readonly versions: readonly EpisodeFileVersion[]
  readonly bansPath: string
  readonly bansPresent: boolean
}

async function projectFile(project: string, value: string): Promise<string> {
  if (isAbsolute(value)) throw new Error('Episode inputs require project-relative paths')
  const path = resolve(project, value), rel = relative(project, path)
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Episode input escapes the project')
  if (await realpath(path) !== path || !(await lstat(path)).isFile()) throw new Error('Episode input must be a canonical regular file')
  return path
}

async function bytes(path: string, budget: number, signal: AbortSignal): Promise<Buffer> {
  const value = await readEpisodeBytes(path, budget, signal)
  if (value === undefined) throw new Error('Episode input is missing')
  return value
}

/**
 * Read a version-one plan and measure its current authored inputs without provider calls.
 * @param projectDir - Selected canonical project directory.
 * @param episode - Integer episode number 1..99.
 * @param metadataMaxBytes - Validated deployment budget for each editing metadata file.
 * @param signal - Owned preparation cancellation.
 * @returns Strict shot order, exact input hashes and a pre-renderer digest.
 */
export async function readApprovedEpisodePlan(projectDir: string, episode: number, metadataMaxBytes: number,
  signal: AbortSignal): Promise<ApprovedEpisodePlan> {
  if (!Number.isInteger(episode) || episode < 1 || episode > 99) throw new Error('Episode must be an integer 1..99')
  if (!isAbsolute(projectDir) || await realpath(projectDir) !== projectDir || !(await lstat(projectDir)).isDirectory()) {
    throw new Error('Episode project must be canonical and absolute')
  }
  const metadata = new Map<string, string>()
  const read = async (path: string): Promise<Buffer> => {
    const content = await bytes(path, metadataMaxBytes, signal)
    metadata.set(path, createHash('sha256').update(content).digest('hex'))
    return content
  }
  const planPath = await projectFile(projectDir, join('editing', String(episode).padStart(2, '0') + '-episode-delivery.json'))
  const plan = planSchema.parse(JSON.parse((await read(planPath)).toString('utf8')))
  if (plan.episode !== episode || plan.total_shots !== plan.shots.length
    || plan.shots.some((shot, index) => shot.shot !== index + 1)
    || new Set(plan.shots.map(shot => shot.idempotency_key)).size !== plan.shots.length) {
    throw new Error('Episode plan must list each unique original approved shot once in contiguous order')
  }
  const timelinePath = await projectFile(projectDir, plan.timeline), subtitlePath = await projectFile(projectDir, plan.subtitle_srt)
  const mixProfilePath = await projectFile(projectDir, plan.mix_profile)
  const timeline = timelineSchema.parse(JSON.parse((await read(timelinePath)).toString('utf8')))
  let end = 0
  if (timeline.clips.length !== plan.shots.length || timeline.clips.some((clip, index) => {
    const valid = clip.shot === index + 1 && clip.start_us === end
    end = clip.start_us + clip.duration_us
    return !valid
  }) || Math.abs(timeline.body_end - end / 1_000_000) > 0.000001) throw new Error('Episode timeline must match contiguous planned shots and body_end')
  const mix = mixSchema.parse(JSON.parse((await read(mixProfilePath)).toString('utf8')))
  if ((mix.mode === 'no_bgm') !== (plan.bgm === undefined)) throw new Error('Episode mix profile and BGM disagree')
  const subtitle = (await read(subtitlePath)).toString('utf8')
  if (!/^\s*\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}\s*\r?\n\S/mu.test(subtitle)) {
    throw new Error('Episode subtitles require a timed nonempty cue')
  }
  const bgmPath = plan.bgm === undefined ? undefined : await projectFile(projectDir, plan.bgm)
  const projectPath = await projectFile(projectDir, 'project_config.json'), bansPath = join(projectDir, 'video-bans.json')
  const projectBytes = await read(projectPath)
  const projectSha256 = brandString<Sha256>(createHash('sha256').update(projectBytes).digest('hex'))
  const bans = await readEpisodeBytes(bansPath, metadataMaxBytes, signal), bansPresent = bans !== undefined
  if (bans !== undefined) metadata.set(bansPath, createHash('sha256').update(bans).digest('hex'))
  const files: { role: ApprovedEpisodeInputFile['role']; path: string }[] = [
    { role: 'project', path: projectPath }, { role: 'plan', path: planPath }, { role: 'timeline', path: timelinePath },
    { role: 'subtitle', path: subtitlePath }, { role: 'mix-profile', path: mixProfilePath },
    ...(bgmPath === undefined ? [] : [{ role: 'bgm' as const, path: bgmPath }]),
    ...(bansPresent ? [{ role: 'project' as const, path: await projectFile(projectDir, 'video-bans.json') }] : []),
  ]
  const measured = await Promise.all(files.map(async file => ({ file, version: await hashEpisodeFile(file.path, signal) })))
  const versions = measured.map(row => row.version)
  for (const version of versions) {
    const parsed = metadata.get(version.path)
    if (parsed !== undefined && parsed !== version.sha256) throw new Error('Episode metadata changed after parsing')
  }
  const inputHashes = measured.map(({ file, version }): ApprovedEpisodeInputFile => ({
    ...file, sha256: version.sha256, bytes: version.bytes,
  }))
  const digest = episodePlanDigest(projectDir, inputHashes)
  return { projectDir, episode, projectSha256, planPath, timelinePath, subtitlePath, mixProfilePath,
    ...(bgmPath === undefined ? {} : { bgmPath }), inputHashes, digest, versions, bansPath, bansPresent,
    shots: plan.shots.map(shot => ({ shot: shot.shot, input: { idempotencyKey: shot.idempotency_key,
      digest: brandString<VideoRecoveryDigest>(shot.review_digest) } })) }
}

/**
 * Compute the editing-input digest using canonical project-relative names and exact measured facts.
 * @param projectDir - Captured canonical project.
 * @param files - Ordered project, plan, editing and optional policy/media facts.
 * @returns Pre-renderer digest, independent of the current provider lifetime.
 */
export function episodePlanDigest(projectDir: string, files: readonly ApprovedEpisodeInputFile[]): Sha256 {
  return brandString<Sha256>(createHash('sha256').update(JSON.stringify(files.map(file => ({
    role: file.role, path: relative(projectDir, file.path), sha256: file.sha256, bytes: file.bytes,
  })))).digest('hex'))
}

/**
 * Recheck a fully measured plan with short file-version reads, including an absent bans file.
 * @param plan - Same-process captured plan.
 * @param signal - Current consumer lifetime.
 */
export async function assertApprovedEpisodePlan(plan: ApprovedEpisodePlan, signal: AbortSignal): Promise<void> {
  await Promise.all(plan.versions.map(version => assertEpisodeFileVersion(version, signal)))
  if (!plan.bansPresent) {
    try { await lstat(plan.bansPath) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    throw new Error('Episode bans changed since plan capture')
  }
}
