/**
 * Build one episode's subtitle from the shots' own audio.
 *
 * `prepare` consumes an SRT and `render` burns it; this module is the step that
 * produces that SRT. Each shot's own audio is analysed for silence, the silent
 * stretches are inverted into the moments the shot speaks, and the lines the
 * shot script already declared are placed on the episode clock. No speech
 * recognition runs: the text is known, only its times are missing.
 *
 * A shot whose audio speaks while the plan declares no line for it is reported
 * rather than silently dropped, because that is how a delivery loses a line.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/cues
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseShotManifest, readJsonDocument, resolveShots } from './prepare.ts'
import type { ResolvedShot } from './prepare.ts'
import { detectSpeechRegions, parseLinePlan, placeShotCues } from './speech.ts'
import type { ShotPlacement } from './speech.ts'
import { formatSrtDocument } from './subtitles.ts'
import { appendClips } from './timeline.ts'
import type { MediaToolkit, SubtitleCue, Timeline } from './types.ts'

/** Everything one cue build needs. */
export interface CueBuildInput {
  /** The binaries and channel to use, or a stub in tests. */
  readonly toolkit: MediaToolkit
  /** Absolute project root. */
  readonly project: string
  /** Two-digit episode number. */
  readonly episode: string
  /** Absolute path of the shot-sources manifest. */
  readonly shotsPath: string
  /** Absolute path of the per-shot line plan. */
  readonly linesPath: string
  /** Absolute path of the SRT to write. */
  readonly subtitleSrt: string
}

/** One blocking defect: what is wrong and what to do about it. */
export interface CueDefect {
  /** What was measured and why it blocks. */
  readonly detail: string
  /** The correction the caller should make. */
  readonly fix: string
}

/** What one cue build produced. */
export interface BuiltCues {
  /** The shots the timing came from, in shot order. */
  readonly shots: readonly ResolvedShot[]
  /** The timeline the cues were placed on, laid out from probed durations. */
  readonly timeline: Timeline
  /** One placement per shot, in shot order. */
  readonly placements: readonly ShotPlacement[]
  /** The cues written, numbered from 1. */
  readonly cues: readonly SubtitleCue[]
  /** Absolute paths this call created or overwrote, in write order. */
  readonly written: readonly string[]
  /** One entry per blocking defect: the delivery would lose or invent a line. */
  readonly failures: readonly CueDefect[]
  /** One Chinese line per non-blocking observation. */
  readonly warnings: readonly string[]
}

/**
 * Measure every shot's speech and write the episode's SRT.
 *
 * The plan is read rather than composed: a line's text and its split into cues
 * are the shot script's decisions, and this call only gives them times.
 * @param input - The resolved call.
 * @returns The timeline, the per-shot placements, the written cues, and the reported defects.
 * @throws {Error} When the manifest, the plan, or a shot's audio is unusable.
 */
export async function buildEpisodeCues(input: CueBuildInput): Promise<BuiltCues> {
  const rows = parseShotManifest(await readJsonDocument(input.shotsPath, '成片清单'), input.shotsPath)
  const plan = parseLinePlan(await readJsonDocument(input.linesPath, '台词计划'), input.linesPath)
  const shots = await resolveShots(input.toolkit, input.project, rows)
  const timeline = appendClips(shots.map(shot => shot.durationUs))
  const planned = new Map(plan.map(row => [row.shot, row.lines]))

  const placements: ShotPlacement[] = []
  const failures: CueDefect[] = []
  const warnings: string[] = []
  for (const [index, shot] of shots.entries()) {
    const clip = timeline.clips[index]
    const durationSeconds = shot.durationUs / 1_000_000
    const startSeconds = clip === undefined ? 0 : clip.startUs / 1_000_000
    const lines = planned.get(shot.source.shot) ?? []
    const regions = await detectSpeechRegions(input.toolkit, shot.audio, durationSeconds)
    if (lines.length === 0) {
      if (regions.length === 0) continue
      failures.push({
        detail: `镜头 ${String(shot.source.shot)} 的音频里有 ${String(regions.length)} 段发声，`
          + '但台词计划里没有它的台词，这一镜说的话会变成没有字幕的语音。',
        fix: `把该镜的台词补进 ${input.linesPath}，或确认这一镜本就不该有台词。`,
      })
      continue
    }
    const placement = placeShotCues(shot.source.shot, lines, regions, startSeconds, durationSeconds)
    placements.push(placement)
    if (placement.defect !== '') {
      failures.push({
        detail: placement.defect,
        fix: '复核该镜成片是否真的读了这句台词；确认无声后重做该镜，不要给它排字幕。',
      })
    }
    warnings.push(...placement.warnings)
  }

  const unknown = plan
    .filter(row => !shots.some(shot => shot.source.shot === row.shot))
    .map(row => row.shot)
  if (unknown.length > 0) {
    failures.push({
      detail: `台词计划里的镜头 ${unknown.join('、')} 不在成片清单里。`,
      fix: '请确认镜头号写对，或把这些镜头补进成片清单后重跑。',
    })
  }

  const cues: SubtitleCue[] = placements
    .flatMap(placement => placement.cues)
    .map((cue, index) => ({
      index: index + 1,
      startSeconds: cue.startSeconds,
      endSeconds: cue.endSeconds,
      text: cue.text,
    }))
  await mkdir(dirname(input.subtitleSrt), { recursive: true })
  await writeFile(input.subtitleSrt, formatSrtDocument(cues), 'utf8')
  return {
    shots,
    timeline,
    placements,
    cues,
    written: [input.subtitleSrt],
    failures,
    warnings,
  }
}
