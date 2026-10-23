/**
 * Build one episode's subtitle from a recognition alignment.
 *
 * `prepare` consumes an SRT and `render` burns it; this module is the step that
 * produces that SRT. The line plan says what each shot says and the alignment
 * document says when — the two are checked against each other, and only then do
 * the cues land on the episode clock. The words in a cue are always the script's.
 *
 * A shot whose alignment speaks while the plan declares no line for it is
 * reported rather than silently dropped, because that is how a delivery loses a
 * line. Missing alignment is returned for Muse to review without inventing timing.
 * An incomplete attempt with no usable cues writes only its review, preserving
 * existing subtitles and candidates rather than publishing an empty replacement.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/cues
 */

import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { parseShotManifest, readJsonDocument, resolveShots } from './prepare.ts'
import type { ResolvedShot } from './prepare.ts'
import { ALIGNED_STRATEGY, cueRateFindings, effectiveCharacterCount, parseAlignment, parseLinePlan,
  placeAlignedCues } from './speech.ts'
import type { CueRateFinding, ShotPlacement } from './speech.ts'
import { formatSrtDocument, subtitleBlockPath, subtitleTextWarnings } from './subtitles.ts'
import { deliveryPolicyFor, readProjectDelivery } from './delivery-policy.ts'
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
  /** Absolute path of the per-shot alignment document. */
  readonly alignmentPath: string
  /** Absolute path of the SRT to write. */
  readonly subtitleSrt: string
}

/** One alignment observation: which check it belongs to, what is wrong, and what to do. */
export interface CueDefect {
  /** The report check this defect fails. */
  readonly id: 'subtitle_line_coverage' | 'subtitle_timing'
  /** What was measured and why it needs review. */
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
  /** One entry per advisory finding: the delivery would lose, invent, or mistime a line. */
  readonly failures: readonly CueDefect[]
  /** One Chinese line per non-blocking observation. */
  readonly warnings: readonly string[]
}

/**
 * Place every shot's declared lines on the episode clock and write the SRT.
 *
 * The plan is read rather than composed: a line's text and its split into cues
 * are the shot script's decisions, and the alignment only says when they happen.
 * @param input - The resolved call.
 * @returns The timeline, the per-shot placements, the written cues, and the reported defects.
 * @throws {Error} When the manifest, the plan, or the alignment document is unusable.
 */
export async function buildEpisodeCues(input: CueBuildInput): Promise<BuiltCues> {
  const review = `${input.subtitleSrt}.review.txt`
  await mkdir(dirname(input.subtitleSrt), { recursive: true })
  await writeFileAtomic(review, '本次自动对齐尚未完成；旧字幕可能不适用于当前视频。\n', { mode: 0o600, dirMode: 0o700 })
  const delivery = await readProjectDelivery(input.project)
  const rows = parseShotManifest(await readJsonDocument(input.shotsPath, '成片清单'), input.shotsPath)
  const plan = parseLinePlan(await readJsonDocument(input.linesPath, '台词计划'), input.linesPath)
  const aligned = new Map(parseAlignment(await readJsonDocument(input.alignmentPath, '对齐文档'),
    input.alignmentPath).map(row => [row.shot, row]))
  const shots = await resolveShots(input.toolkit, input.project, rows)
  const timeline = { ...appendClips(shots.map(shot => shot.durationUs)), delivery }
  const planned = new Map(plan.map(row => [row.shot, row.lines]))

  const placements: ShotPlacement[] = []
  const failures: CueDefect[] = []
  const warnings: string[] = [...deliveryPolicyFor(delivery).warnings]
  let cursorUs = 0
  for (const shot of shots) {
    const durationSeconds = shot.durationUs / 1_000_000
    const startSeconds = cursorUs / 1_000_000
    cursorUs += shot.durationUs
    const lines = planned.get(shot.source.shot) ?? []
    const recognized = aligned.get(shot.source.shot)
    const recognizedCues = recognized?.cues ?? []
    if (lines.length === 0) {
      if (recognized === undefined) {
        failures.push({
          id: 'subtitle_line_coverage',
          detail: `镜头 ${String(shot.source.shot)} 没有声明台词，但对齐文档缺少无发声核对结果。`,
          fix: '对该镜选定原视频取得同源转写或无发声收据，再用 align_subtitles.py 生成 no_lines 对齐记录。',
        })
        continue
      }
      if (recognized.strategy === 'unmapped_speech') {
        failures.push({
          id: 'subtitle_line_coverage',
          detail: `镜头 ${String(shot.source.shot)} 没有声明台词，但对齐文档识别到未映射发声。`,
          fix: '人工核对该镜声音与剧本；若有台词，补齐计划并对同版成片重新对齐。',
        })
        continue
      }
      if (recognizedCues.length === 0 && recognized.strategy === 'no_lines') continue
      if (recognizedCues.length === 0) {
        failures.push({
          id: 'subtitle_line_coverage',
          detail: `镜头 ${String(shot.source.shot)} 没有声明台词，但对齐文档没有可信的 no_lines 标记。`,
          fix: '对该镜选定原视频取得同源转写或无发声收据，再用 align_subtitles.py 生成 no_lines 对齐记录。',
        })
        continue
      }
      failures.push({
        id: 'subtitle_line_coverage',
        detail: `镜头 ${String(shot.source.shot)} 的对齐文档里有 ${String(recognizedCues.length)} 段识别结果，`
          + '但台词计划里没有它的台词，这一镜说的话会变成没有字幕的语音。',
        fix: `把该镜的台词补进 ${input.linesPath}，或确认这一镜本就不该有台词。`,
      })
      continue
    }
    if (recognized === undefined) {
      failures.push({
        id: 'subtitle_line_coverage',
        detail: `镜头 ${String(shot.source.shot)} 声明了 ${String(lines.length)} 条台词，`
          + '但对齐文档里没有这一镜的时间。',
        fix: `对 ${shot.video} 重跑一次语音识别，把这一镜的结果补进 ${input.alignmentPath}；`
          + '不要用估算时间给这一镜排字幕。',
      })
      continue
    }
    if (recognized.strategy !== ALIGNED_STRATEGY) {
      // A missing label is not a verified one: the only document this pass trusts is
      // the one the aligner writes, and that one always states the strategy it placed
      // each shot with. Absence means the file came from somewhere else, so its times
      // are reported as unverified instead of being taken as recognition output.
      failures.push({
        id: 'subtitle_line_coverage',
        detail: `镜头 ${String(shot.source.shot)} 的对齐来源未验证：`
          + `${recognized.strategy === undefined ? '文档没有标 strategy' : `标着 ${recognized.strategy}`}，`
          + '不是 align_subtitles.py 写出的整镜锚定结果。',
        fix: '用 align_subtitles.py 对该镜重跑识别，并把整份对齐文档换成它写出的那一份；'
          + '保留可核对的时间与疑点；asr_aligned 提供实测锚点，由 Muse 决定是否重跑。',
      })
      continue
    }
    const placement = placeAlignedCues(shot.source.shot, lines, recognized.cues, startSeconds, durationSeconds)
    placements.push(placement)
    if (placement.defect !== '') {
      failures.push({
        id: 'subtitle_line_coverage',
        detail: placement.defect,
        fix: '复核该镜成片是否真的读了这句台词；确认后重跑识别，让对齐与台词计划指向同一版台词。',
      })
    }
  }

  const unknown = plan
    .filter(row => !shots.some(shot => shot.source.shot === row.shot))
    .map(row => row.shot)
  if (unknown.length > 0) {
    failures.push({
      id: 'subtitle_line_coverage',
      detail: `台词计划里的镜头 ${unknown.join('、')} 不在成片清单里。`,
      fix: '请确认镜头号写对，或把这些镜头补进成片清单后重跑。',
    })
  }
  const unknownAligned = [...aligned.keys()].filter(shot => !shots.some(row => row.source.shot === shot))
  if (unknownAligned.length > 0) {
    warnings.push(`对齐文档里的镜头 ${unknownAligned.join('、')} 不在成片清单里，已忽略。`)
  }

  const placed = placements.flatMap(placement => placement.cues)
  const clipStarts = new Map(timeline.clips.map(clip => [clip.shot, clip.startUs / 1_000_000]))
  const findings: CueRateFinding[] = cueRateFindings(placed, clipStarts)
  for (const finding of findings) {
    const detail = `镜头 ${String(finding.shot)} 的“${finding.text}”要求 ${finding.charactersPerSecond.toFixed(1)} 字/秒`
      + `（${String(effectiveCharacterCount(finding.text))} 字），`
    if (finding.impossible) {
      failures.push({
        id: 'subtitle_timing',
        detail: `${detail}超过可读上限，观众来不及看。`,
        fix: '请复核该镜时长与台词切分：把这条台词拆到更多镜头，或延长该镜后重做。',
      })
    } else {
      warnings.push(`${detail}偏快，请试听复核。`)
    }
  }
  const cues: SubtitleCue[] = placed.map((cue, index) => ({
    index: index + 1,
    startSeconds: cue.startSeconds,
    endSeconds: cue.endSeconds,
    text: cue.text,
  }))
  const textWarnings = subtitleTextWarnings(cues)
  warnings.push(...textWarnings)
  const draft = failures.length > 0 || textWarnings.length > 0
  const target = draft ? `${input.subtitleSrt}.draft.srt` : input.subtitleSrt
  const observations = [...failures.map(item => `${item.detail} ${item.fix}`), ...textWarnings]
  const emptyCandidate = draft && cues.length === 0
  const written = [review]
  if (emptyCandidate) {
    const notice = '未生成字幕候选：本次没有可用的字幕条目；原字幕、已有候选及其说明均保留，'
      + '请核对本次对齐诊断后再选择后续使用的版本。'
    warnings.push(notice)
    observations.unshift(notice)
  } else {
    if (draft) warnings.push(`字幕存在待核项，候选已写入 ${target}，没有覆盖原字幕；由 Muse 核听并选择后续使用的版本。`)
    await writeFileAtomic(target, formatSrtDocument(cues), { mode: 0o600, dirMode: 0o700 })
    written.unshift(target)
  }
  await writeFileAtomic(review, observations.join('\n'), { mode: 0o600, dirMode: 0o700 })
  if (draft && !emptyCandidate) {
    await writeFileAtomic(`${target}.review.txt`, observations.join('\n'), { mode: 0o600, dirMode: 0o700 })
    written.push(`${target}.review.txt`)
  } else if (!draft) await rm(subtitleBlockPath(input.subtitleSrt), { force: true })
  return {
    shots,
    timeline,
    placements,
    cues,
    written,
    failures,
    warnings,
  }
}
