/** Preview, compose, and verify one episode's planned BGM bed. */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  createMediaToolkit,
  probeAudio,
  publishNoClobber,
  renderBgm,
} from './media.ts'
import {
  appliedGain,
  buildMixFilter,
  resolveOutputPath,
  auditBgmBatch,
  validateEpisodePlan,
} from './plan.ts'
import type { BgmBatchPolicy, BgmBatchRow } from './plan.ts'
import type {
  BgmEpisodePlan,
  BgmMediaReport,
  BgmSegmentReport,
  DramaBgmArguments,
  DramaBgmReport,
  ProcessChannel,
  ProbedAudio,
} from './types.ts'

const EMPTY_MEDIA: BgmMediaReport = {
  codec: '', sample_rate: 0, channels: 0, duration_seconds: 0, size_bytes: 0, sha256: '',
}

const SegmentSchema = z.object({
  track: z.string().required(),
  source: z.string().required(),
  start_seconds: z.number().required(),
  end_seconds: z.number().required(),
  reason: z.string().required(),
  source_start_seconds: z.number(),
  source_sha256: z.string(),
  valence: z.number(),
  arousal: z.number(),
})

const EpisodeSchema = z.object({
  episode: z.string().required(),
  body_duration_seconds: z.number().required(),
  crossfade_seconds: z.number(),
  segments: z.array(SegmentSchema).required(),
})

const PlanSchema = z.object({
  episodes: z.array(EpisodeSchema).required(),
})

/** Runtime settings after Cordis config and the subprocess service are resolved. */
export interface DramaBgmSettings {
  /** FFmpeg executable or command name. */
  readonly ffmpegPath: string
  /** ffprobe executable or command name. */
  readonly ffprobePath: string
  /** Injectable process channel. */
  readonly channel: ProcessChannel
  /** Caller cancellation signal. */
  readonly signal?: AbortSignal
  /** Batch limits the plan's reuse rules are held to. */
  readonly policy?: BgmBatchPolicy | undefined
}

interface LoadedPlan {
  readonly selected: BgmEpisodePlan
  readonly repeated: string[]
  /** Every episode row the batch gate read, including this one. */
  readonly batch: BgmBatchRow[]
  /** Episodes the gate found in the same directory as this plan. */
  readonly batchEpisodes: string[]
}

/** Calculate one file's SHA-256 without loading it into one buffer. */
async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path) as AsyncIterable<Uint8Array>) hash.update(chunk)
  return hash.digest('hex')
}

/** Require one path to name an existing regular, non-empty file. */
async function requireFile(path: string, label: string, displayPath = path): Promise<void> {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${label}不存在：${displayPath}`, { cause: error })
    throw error
  }
  if (!info.isFile() || info.size === 0) throw new Error(`${label}不是非空文件：${displayPath}`)
}

/** Reject a real path outside the project's real root. */
function assertProjectOwned(project: string, path: string, label: string): void {
  const relation = relative(project, path)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label}必须位于项目目录内：${path}`)
  }
}

/** Require an existing project-owned file, including after symlink resolution. */
async function requireProjectFile(project: string, path: string, label: string, displayPath = path): Promise<void> {
  await requireFile(path, label, displayPath)
  assertProjectOwned(project, await realpath(path), label)
}

/** Create an output directory only when its nearest existing ancestor is project-owned. */
async function ensureProjectDirectory(project: string, path: string): Promise<void> {
  let ancestor = path
  while (true) {
    try {
      assertProjectOwned(project, await realpath(ancestor), 'BGM 输出目录')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
  await mkdir(path, { recursive: true })
  assertProjectOwned(project, await realpath(path), 'BGM 输出目录')
}

/** Return whether a path already exists without swallowing other filesystem errors. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Read the timeline's measured body end and its package boundaries. */
async function readTimeline(path: string): Promise<{ bodyEndSeconds: number; boundaries: number[] }> {
  let document: unknown
  try {
    document = JSON.parse((await readFile(path, 'utf8')).replace(/^\ufeff/u, ''))
  } catch (error) {
    throw new Error(`时间线不可读：${path}`, { cause: error })
  }
  const body = typeof document === 'object' && document !== null
    ? Number((document as { body_end?: unknown }).body_end)
    : Number.NaN
  if (!Number.isFinite(body) || body <= 0) throw new Error(`时间线缺少有效 body_end：${path}`)
  const clips = (document as { clips?: unknown }).clips
  const boundaries = (Array.isArray(clips) ? clips : [])
    .map(clip => Number((clip as { start_us?: unknown }).start_us) / 1_000_000)
    .filter(seconds => Number.isFinite(seconds) && seconds > 0)
  return { bodyEndSeconds: body, boundaries: [...new Set(boundaries)].sort((left, right) => left - right) }
}

/**
 * Read every plan in one directory.
 *
 * A batch is the plan directory's own contents, which is how the pipeline lays
 * episodes out (`episodes/segments/<集>.json`). A JSON file that parses but
 * carries no `episodes` array is not a plan and is ignored, so a timeline may
 * sit beside the plans. A file that cannot be parsed at all is a failure: it
 * might be a plan, and a batch quietly missing one member would let a track
 * exceed its limit with nothing reporting it.
 * @param directory - The directory holding the selected plan.
 * @returns Every episode row found, in directory order.
 * @throws {Error} When a JSON file in the directory cannot be read as JSON.
 */
async function loadBatch(directory: string): Promise<BgmBatchRow[]> {
  const rows: BgmBatchRow[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.json') continue
    const path = join(directory, entry.name)
    let document: unknown
    try {
      document = JSON.parse((await readFile(path, 'utf8')).replace(/^\ufeff/u, ''))
    } catch (error) {
      throw new Error(`${directory} 里的 ${entry.name} 不是可读的 JSON：`
        + '同一目录的 JSON 可能属于同一批，读不出来就无法判断跨集复用。'
        + '请把不相关的文件移出该目录，或修好它后重试。', { cause: error })
    }
    if (typeof document !== 'object' || document === null
      || !Array.isArray((document as { episodes?: unknown }).episodes)) continue
    let parsed: { episodes: BgmEpisodePlan[] }
    try {
      parsed = PlanSchema(document)
    } catch (error) {
      throw new Error(`${directory} 里的 ${entry.name} 有 episodes 数组但不是合法的 BGM 计划：`
        + '请修好它的字段后重试。', { cause: error })
    }
    for (const row of parsed.episodes) rows.push({ episode: row.episode, segments: [...row.segments] })
  }
  return rows
}

/** Read and select one episode while reporting repeated ordered source sequences. */
async function loadPlan(path: string, episode: string, project: string): Promise<LoadedPlan> {
  let plan: { episodes: BgmEpisodePlan[] }
  try {
    const document: unknown = JSON.parse((await readFile(path, 'utf8')).replace(/^\ufeff/u, ''))
    plan = PlanSchema(document as Parameters<typeof PlanSchema>[0])
  } catch (error) {
    throw new Error(`BGM 计划不可读：${path}`, { cause: error })
  }
  const ids = plan.episodes.map(row => row.episode.padStart(2, '0'))
  if (ids.some(id => !/^\d+$/u.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('BGM 计划集号重复或无效。')
  }
  const selected = plan.episodes.find(row => row.episode.padStart(2, '0') === episode)
  if (selected === undefined) throw new Error(`BGM 计划缺少第 ${episode} 集。`)
  const signature = (row: BgmEpisodePlan): string => JSON.stringify(row.segments.map(segment =>
    isAbsolute(segment.source) ? resolve(segment.source) : resolve(project, segment.source)))
  const selectedSignature = signature(selected)
  const batch = await loadBatch(dirname(path))
  return {
    selected,
    repeated: plan.episodes
      .filter(row => row !== selected && signature(row) === selectedSignature)
      .map(row => row.episode.padStart(2, '0')),
    batch,
    batchEpisodes: [...new Set(batch.map(row => row.episode.padStart(2, '0')))].sort(),
  }
}

/** Convert an ffprobe result and digest into the public media report. */
async function mediaReport(path: string, probe: ProbedAudio): Promise<BgmMediaReport> {
  return {
    codec: probe.codec,
    sample_rate: probe.sampleRate,
    channels: probe.channels,
    duration_seconds: probe.durationSeconds,
    size_bytes: probe.sizeBytes,
    sha256: await sha256File(path),
  }
}

/** Enforce the composer's fixed WAV format and exact body duration. */
function validateOutput(probe: ProbedAudio, bodyDurationSeconds: number): void {
  if (!probe.formatName.split(',').includes('wav') || probe.codec !== 'pcm_s16le'
    || probe.sampleRate !== 48_000 || probe.channels !== 2
    || Math.abs(probe.durationSeconds - bodyDurationSeconds) > 0.02) {
    throw new Error('BGM 输出必须是 WAV 容器、pcm_s16le、48kHz、双声道，且时长与正文误差不超过 0.02 秒。')
  }
}

/** Resolve one plan source relative to the project. */
function sourcePath(project: string, source: string): string {
  return isAbsolute(source) ? resolve(source) : resolve(project, source)
}

/** Analyze every source contribution and preserve its story and matcher evidence. */
async function analyzeSegments(
  project: string,
  plan: ReturnType<typeof validateEpisodePlan>,
  settings: DramaBgmSettings,
): Promise<BgmSegmentReport[]> {
  const media = createMediaToolkit(settings.ffmpegPath, settings.ffprobePath, settings.channel)
  const reports: BgmSegmentReport[] = []
  for (const segment of plan.segments) {
    const source = sourcePath(project, segment.source)
    await requireFile(source, 'BGM 源曲')
    const digest = await sha256File(source)
    if (segment.source_sha256 !== undefined
      && segment.source_sha256.replace(/^sha256:/u, '').toLowerCase() !== digest) {
      throw new Error(`BGM 源曲摘要已变化：${source}`)
    }
    const start = segment.source_start_seconds === undefined
      ? await media.detectSourceStart(source, settings.signal)
      : { seconds: segment.source_start_seconds, kind: 'explicit' as const }
    const sourceProbe = await probeAudio(settings.ffprobePath, settings.channel, source, settings.signal)
    if (start.seconds + segment.inputDurationSeconds > sourceProbe.durationSeconds + 0.001) {
      throw new Error(`BGM 源曲不足以覆盖剧情段：${source}`)
    }
    const mean = await media.meanVolume(source, start.seconds, segment.inputDurationSeconds, settings.signal)
    reports.push({
      track: segment.track,
      source,
      source_sha256: digest,
      start_seconds: segment.start_seconds,
      end_seconds: segment.end_seconds,
      reason: segment.reason,
      input_duration_seconds: segment.inputDurationSeconds,
      source_start_seconds: start.seconds,
      source_start_kind: start.kind,
      source_mean_db: mean,
      applied_gain_db: appliedGain(mean),
      ...(segment.valence === undefined ? {} : { valence: segment.valence }),
      ...(segment.arousal === undefined ? {} : { arousal: segment.arousal }),
    })
  }
  return reports
}

/**
 * Preview, compose, or verify an episode BGM bed.
 * @param args - Model-facing operation arguments.
 * @param settings - Resolved executables, process channel, and cancellation.
 * @returns Canonical analysis and output report.
 */
export async function runDramaBgm(
  args: DramaBgmArguments,
  settings: DramaBgmSettings,
): Promise<DramaBgmReport> {
  if (!Number.isSafeInteger(args.episode) || args.episode <= 0) throw new Error('episode 必须是正安全整数。')
  const project = resolve(args.project)
  const projectRoot = await realpath(project)
  const timeline = resolveOutputPath(project, args.timeline)
  const planPath = resolveOutputPath(project, args.plan)
  await requireProjectFile(projectRoot, timeline, '时间线', args.timeline)
  await requireProjectFile(projectRoot, planPath, 'BGM 计划', args.plan)
  const episode = String(args.episode).padStart(2, '0')
  const { bodyEndSeconds, boundaries } = await readTimeline(timeline)
  const loaded = await loadPlan(planPath, episode, project)
  const plan = validateEpisodePlan(loaded.selected, bodyEndSeconds)
  // The reuse rules are reported, not enforced: the agent reads them in this
  // call's own result and changes the selection, and a delivery that still
  // breaks them is the agent's decision to make, not this tool's to block.
  const policyFindings = auditBgmBatch({ episode, segments: loaded.selected.segments }, {
    project,
    batch: loaded.batch,
    boundaries,
    ...(settings.policy === undefined ? {} : { limits: settings.policy }),
  })
  const output = resolveOutputPath(project, args.output ?? `audio/bgm/${episode}.wav`)
  if (extname(output).toLowerCase() !== '.wav') throw new Error('BGM 输出必须使用 .wav 扩展名。')
  const parsed = parse(output)
  const reportPath = resolve(parsed.dir, `${parsed.name}.generation.json`)
  const base = {
    episode,
    project,
    plan: planPath,
    timeline,
    output,
    body_duration_seconds: bodyEndSeconds,
    crossfade_seconds: plan.crossfadeSeconds,
    repeated_sequence_episodes: loaded.repeated,
    batch_episodes: loaded.batchEpisodes,
    policy_findings: policyFindings,
  }
  if (args.method === 'verify') {
    await requireProjectFile(projectRoot, output, 'BGM 输出', args.output ?? `audio/bgm/${episode}.wav`)
    const probe = await probeAudio(settings.ffprobePath, settings.channel, output, settings.signal)
    validateOutput(probe, bodyEndSeconds)
    return { method: 'verify', ...base, segments: [], report: '', media: await mediaReport(output, probe) }
  }
  const segments = await analyzeSegments(project, plan, settings)
  const analyzed = { ...base, segments }
  if (args.method === 'preview') return { method: 'preview', ...analyzed, report: '', media: EMPTY_MEDIA }
  if (await exists(output)) throw new Error(`BGM 输出已存在，不会覆盖：${output}`)
  if (await exists(reportPath)) throw new Error(`BGM 报告已存在，不会覆盖：${reportPath}`)
  await ensureProjectDirectory(projectRoot, dirname(output))
  const wavTemporary = resolve(dirname(output), `.${parsed.name}-${randomUUID()}.wav`)
  const reportTemporary = resolve(dirname(reportPath), `.${parsed.name}-${randomUUID()}.json`)
  try {
    await (await open(wavTemporary, 'wx')).close()
    const graph = buildMixFilter(
      segments.map(segment => segment.input_duration_seconds),
      segments.map(segment => segment.source_start_seconds),
      segments.map(segment => segment.applied_gain_db),
      bodyEndSeconds,
      plan.crossfadeSeconds,
    )
    await renderBgm(settings.ffmpegPath, settings.channel, segments.map(segment => segment.source),
      graph, wavTemporary, settings.signal)
    const probe = await probeAudio(settings.ffprobePath, settings.channel, wavTemporary, settings.signal)
    validateOutput(probe, bodyEndSeconds)
    const report: DramaBgmReport = {
      method: 'compose', ...analyzed, report: reportPath, media: await mediaReport(wavTemporary, probe),
    }
    const reportHandle = await open(reportTemporary, 'wx')
    try {
      await reportHandle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
    } finally {
      await reportHandle.close()
    }
    settings.signal?.throwIfAborted()
    await publishNoClobber([[wavTemporary, output], [reportTemporary, reportPath]])
    return report
  } finally {
    await Promise.all([wavTemporary, reportTemporary].map(async (path) => {
      try {
        await unlink(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }))
  }
}
