/**
 * `drama_render`: the short-drama pipeline's episode renderer, as one
 * model-facing tool.
 *
 * Project medium and timeline delivery geometry determine output treatment.
 * Explicit 3D animation omits added marks and endings. Photorealistic and
 * unclassified legacy projects retain the marked two-second ending; missing
 * classification is reported. Explicit project subtitle and linear mix settings
 * override the existing delivery defaults; rate control is unchanged.
 *
 * `subtitles`, `prepare`, and `render` write; `verify` only reads. Everything that makes a
 * render impossible throws with a Chinese repair instruction. The delivered
 * file's own properties do not throw: `render` and `verify` report them as
 * checks, so one call tells the operator everything that needs fixing while
 * still handing back the file and its measurements.
 *
 * @module @deepseek-ai/dsh-tool-episode-render
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AUDIO_MIX_RESULT_SCHEMA, previewAudio } from './audio.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { FONT_FAMILY_PATTERN, deliveryRenderSettings } from './delivery.ts'
import { deliveryPolicyFor, resolveDeliveryPolicy } from './delivery-policy.ts'
import { readBgmPlan } from './bgm.ts'
import { BGM_LICENSE_RECORD_TOOL_SCHEMA, LICENSE_INFO_TOOL_SCHEMA } from '@deepseek-ai/dsh-bgm-license-info'
import { createMediaToolkit } from './ffmpeg.ts'
import { buildEpisodeCues } from './cues.ts'
import type { BuiltCues } from './cues.ts'
import { episodeNumberOf, episodePaths } from './paths.ts'
import { parseShotManifest, prepareEpisode, readJsonDocument } from './prepare.ts'
import { buildRenderPreview, renderPreviewWarnings } from './preview.ts'
import { buildReport, NO_MEDIA, NO_TAIL_FRAME, type ReportInput } from './report.ts'
import { renderEpisode } from './render.ts'
import type { BgmPlanReport, DeliverySubtitleVisual, DramaRenderMethod, DramaRenderReport, EndingEffectFit, RenderCheck, RenderSettings } from './types.ts'
import { verifyEpisode } from './verify.ts'
import { registerDramaVideo } from './video.ts'
import { resolveSubtitleOverlay } from './subtitle-plan.ts'
import { readTimeline } from './timeline.ts'
import { reviewSpeechCoverage, type SpeechCoverageReport } from './speech-coverage.ts'
import { measureSubtitleLayout } from './subtitle-layout.ts'
import { fitSubtitleCues } from './subtitle-fit.ts'
import { formatSrtDocument, normalizeSubtitleDisplay, readSubtitleCues, subtitleDisplayWarnings } from './subtitles.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-episode-render'

/** The tool registry this plugin contributes `drama_render` to. */
export const inject = ['tools']

/** ffmpeg executable used when the deployment does not name one. */
const DEFAULT_FFMPEG = 'ffmpeg'

/** ffprobe executable used when the deployment does not name one. */
const DEFAULT_FFPROBE = 'ffprobe'

/** Gain applied to the episode's own master audio, as the operator approved it. */
const DEFAULT_MASTER_VOLUME = 1.45

/** Gain applied to the BGM bed, as the operator approved it. */
const DEFAULT_BGM_VOLUME = 0.24

/** Font directory used when the deployment does not name one. */
const DEFAULT_FONTS_DIR = 'C:/Windows/Fonts'

/** Default ASS font families for deployments without overrides. */
const DEFAULT_SUBTITLE_FONT_FAMILY = 'SimHei'
const DEFAULT_WATERMARK_FONT_FAMILY = 'Microsoft YaHei'

/**
 * Plugin config. Every field is a deployment-varying choice: where the media
 * binaries are, the two audio gains the operator approved, whether the GPU
 * encoder is probed, and the font directory and families. The delivery
 * geometry and frame rate are captured from the project into the timeline;
 * ending and watermark treatment are selected by the explicit visual medium.
 */
export interface Config {
  /** Optional deployment fallback for timelines without an ending-effect fit. */
  defaultEndingEffectFit?: EndingEffectFit
  /** Optional deployment fallback for projects without an explicit subtitle style. */
  defaultSubtitleVisual?: DeliverySubtitleVisual | undefined
  /** Enforce the product subtitle target for old projects and timelines. */
  enforceSubtitleVisual?: boolean
  /** Normalize dialogue display punctuation and line breaks during rendering. */
  normalizeSubtitleText?: boolean
  /** ffmpeg executable; defaults to `ffmpeg` from `PATH`. */
  ffmpegPath?: string
  /** ffprobe executable; defaults to `ffprobe` from `PATH`. */
  ffprobePath?: string
  /** Gain applied to the episode's own master audio; defaults to 1.45. */
  masterVolume?: number
  /** Gain applied to the BGM bed; defaults to 0.24. */
  bgmVolume?: number
  /** Maximum final BGM multiplier; default 8, independent of original-dialogue gain. */
  maxBgmVolume?: number
  /** Whether the GPU encoder is probed before each render; defaults to true. */
  preferNvenc?: boolean
  /** Directory libass resolves the subtitle font from; defaults to `C:/Windows/Fonts`. */
  fontsDir?: string
  /** ASS subtitle font family; nonblank, no commas or line breaks; defaults to SimHei. */
  subtitleFontFamily?: string
  /** ASS watermark font family; nonblank, no commas or line breaks; defaults to Microsoft YaHei. */
  watermarkFontFamily?: string
}

/** Validated deployment config, including gain ranges and ASS-safe font families. */
export const Config: z<Config> = z.object({
  defaultEndingEffectFit: z.union(['source_once', 'stretch_to_window']),
  normalizeSubtitleText: z.boolean().default(false),
  enforceSubtitleVisual: z.boolean().default(false),
  defaultSubtitleVisual: z.union([z.const(undefined), z.object({
    schema_version: z.const(1).required(),
    reference_width: z.number().min(1).max(16384).required(),
    reference_height: z.number().min(1).max(16384).required(),
    font_size_px: z.number().min(0.001).max(16384).required(),
    outline_px: z.number().min(0).max(100).required(),
    center_y_ratio: z.number().min(0).max(1).required(),
    max_width_ratio: z.number().min(0.001).max(1).required(),
    font_family: z.string().pattern(FONT_FAMILY_PATTERN),
  })]),
  ffmpegPath: z.string().default(DEFAULT_FFMPEG),
  ffprobePath: z.string().default(DEFAULT_FFPROBE),
  masterVolume: z.number().min(0).max(8).default(DEFAULT_MASTER_VOLUME),
  bgmVolume: z.number().min(0).max(8).default(DEFAULT_BGM_VOLUME),
  maxBgmVolume: z.number().min(0).max(8).default(8),
  preferNvenc: z.boolean().default(true),
  fontsDir: z.string().default(DEFAULT_FONTS_DIR),
  subtitleFontFamily: z.string().pattern(FONT_FAMILY_PATTERN).default(DEFAULT_SUBTITLE_FONT_FAMILY),
  watermarkFontFamily: z.string().pattern(FONT_FAMILY_PATTERN).default(DEFAULT_WATERMARK_FONT_FAMILY),
})

/** Internal call arguments after the tool's snake_case parameters are mapped. */
interface DramaRenderArguments {
  /** The operation to run. */
  method: DramaRenderMethod
  /** Project root holding `video/`, `audio/`, `editing/`, and `exports/`. */
  project: string
  /** Episode number. */
  episode: number
  /** Path of the shot-sources manifest; required by `prepare`. */
  shots?: string
  /** Path of the per-shot line plan; required by `subtitles`. */
  lines?: string
  /** Optional recognition alignment for `subtitles`, whose times replace the measured ones. */
  alignment?: string
  /** Path of the episode timeline; required by `render` and `verify`. */
  timeline?: string
  /** Path of the subtitle to install, burn, or check. */
  subtitleSrt?: string
  /** Optional explicit decisions for dialogue already burned into source pictures. */
  subtitlePlan?: string
  /** Existing cloud-receipt mapping for the read-only speech comparison. */
  speechTranscripts?: string
  /** Optional source-bound caller listening statements. */
  speechDecisions?: string
  /** Last body shot this render delivers; required by `render`. */
  lastShot?: number
  /** BGM bed; required by `render`. */
  bgm?: string
  /** Optional episode/segments music plan to report, not a listening verdict. */
  bgmPlan?: string
  /** Composer receipt for exact-bed gain evidence in audio_preview. */
  bgmGeneration?: string
  /** Explicit project-owned audio profile. */
  mixProfile?: string
  /** Original sound for an audio audition; defaults to the episode master. */
  audio?: string
  /** Audio audition offset on the body timeline. */
  startSeconds?: number
  /** Audio audition duration, at most 60 seconds. */
  durationSeconds?: number
  /** Explicit intended use for an audio preview's advisory music license report. */
  intendedUse?: 'commercial' | 'non_commercial' | 'unknown'
  /** Ending sound; required only for photorealistic or legacy marked delivery. */
  endingAudio?: string
  /** Ending effect video; required only for photorealistic or legacy marked delivery. */
  endingEffect?: string
  /** Delivered file; required by `verify`, defaulted for `render`. */
  output?: string
  /** Whether `render` ignores its per-shot cache. */
  force?: boolean
}

/** What every resolved call carries. */
interface CallBase {
  /** Absolute project root. */
  readonly project: string
  /** Two-digit episode number. */
  readonly episode: string
}

/** A resolved `prepare` call: the manifest and the subtitle it installs. */
interface PrepareCall extends CallBase {
  /** The operation to run. */
  readonly method: 'prepare'
  /** Absolute path of the shot-sources manifest. */
  readonly shotsPath: string
  /** Absolute path of the subtitle to install. */
  readonly subtitleSrt: string
  /** Optional existing source-bound recognition receipts for measuring and splitting long cues. */
  readonly transcriptsPath?: string
  /** Optional BGM bed selected for the later render preview. */
  readonly bgm?: string
  /** Optional plan selected for the later render preview. */
  readonly bgmPlan?: string
  /** Optional absolute authored subtitle-overlay plan. */
  readonly subtitlePlan?: string
}

/** A resolved `subtitles` call: the manifest, the declared lines, and the SRT to write. */
interface SubtitlesCall extends CallBase {
  /** The operation to run. */
  readonly method: 'subtitles'
  /** Absolute path of the shot-sources manifest. */
  readonly shotsPath: string
  /** Absolute path of the per-shot line plan. */
  readonly linesPath: string
  /** Absolute path of the per-shot alignment document. */
  readonly alignmentPath: string
  /** Absolute path of the SRT to write. */
  readonly subtitleSrt: string
}

/** A resolved `render` call: every input the delivery is built from. */
interface RenderCall extends CallBase {
  /** The operation to run. */
  readonly method: 'render'
  /** Absolute path of the timeline to render. */
  readonly timelinePath: string
  /** Absolute path of the subtitle to burn. */
  readonly subtitleSrt: string
  /** Optional absolute authored subtitle-overlay plan. */
  readonly subtitlePlan?: string
  /** The last body shot this render delivers. */
  readonly lastShot: number
  /** Absolute path of the BGM bed. */
  readonly bgm?: string
  /** Optional absolute path of the declared BGM plan. */
  readonly bgmPlan?: string
  /** Explicit project-owned audio profile. */
  readonly mixProfile?: string
  /** Absolute path of the ending sound. */
  readonly endingAudio?: string
  /** Absolute path of the ending effect video. */
  readonly endingEffect?: string
  /** Absolute path of the file to write. */
  readonly output: string
  /** Whether the per-shot cache is ignored. */
  readonly force: boolean
}

/** A resolved `verify` call: the delivered file and the two inputs it claims to follow. */
interface VerifyCall extends CallBase {
  /** The operation to run. */
  readonly method: 'verify'
  /** Absolute path of the delivered file to check. */
  readonly output: string
  /** Absolute path of the timeline the delivery claims to follow. */
  readonly timelinePath: string
  /** Absolute path of the subtitle the delivery claims to burn. */
  readonly subtitleSrt: string
}

/** One call with every path it needs already resolved. */
interface AudioPreviewCall extends CallBase {
  readonly method: 'audio_preview'
  readonly timelinePath: string
  readonly audio: string
  readonly bgm?: string
  readonly bgmPlan?: string
  readonly bgmGeneration?: string
  readonly intendedUse?: 'commercial' | 'non_commercial' | 'unknown'
  readonly profilePath: string
  readonly startSeconds: number
  readonly durationSeconds: number
}

interface SubtitleOverlayCall extends CallBase {
  readonly method: 'subtitle_overlay'
  readonly timelinePath: string
  readonly subtitleSrt: string
  readonly subtitlePlan: string
  readonly outputSrt?: string
}

interface SpeechCoverageCall extends CallBase {
  readonly method: 'speech_coverage'
  readonly shotsPath: string
  readonly timelinePath: string
  readonly subtitleSrt: string
  readonly transcriptsPath: string
  readonly decisionsPath?: string
}

/** A standalone glyph probe reads the current visual profile without rendering an episode. */
interface SubtitleLayoutCall extends CallBase {
  readonly method: 'subtitle_layout'
  readonly timelinePath: string
  readonly subtitleSrt: string
}

type ResolvedCall = PrepareCall | RenderCall | VerifyCall | SubtitlesCall | AudioPreviewCall | SubtitleOverlayCall
  | SpeechCoverageCall | SubtitleLayoutCall

/**
 * Resolve one call's configuration into the settings every method takes.
 * @param config - The validated plugin config.
 * @returns The binaries, gains, encoder preference, font directory and families.
 */
export function resolveSettings(config: Config = {}): RenderSettings {
  if (config.enforceSubtitleVisual && config.defaultSubtitleVisual === undefined) {
    throw new Error('产品字幕视觉配置缺失。')
  }
  return {
    ...(config.defaultEndingEffectFit === undefined ? {} : { defaultEndingEffectFit: config.defaultEndingEffectFit }),
    ...(config.normalizeSubtitleText ? { normalizeSubtitleText: true } : {}),
    ...(config.defaultSubtitleVisual === undefined ? {} : { defaultSubtitleVisual: config.defaultSubtitleVisual }),
    ...(config.enforceSubtitleVisual ? { enforceSubtitleVisual: true } : {}),
    ffmpeg: config.ffmpegPath ?? DEFAULT_FFMPEG,
    ffprobe: config.ffprobePath ?? DEFAULT_FFPROBE,
    masterVolume: config.masterVolume ?? DEFAULT_MASTER_VOLUME,
    bgmVolume: config.bgmVolume ?? DEFAULT_BGM_VOLUME,
    maxBgmVolume: config.maxBgmVolume ?? 8,
    preferNvenc: config.preferNvenc ?? true,
    fontsDir: config.fontsDir ?? DEFAULT_FONTS_DIR,
    subtitleFontFamily: config.subtitleFontFamily ?? DEFAULT_SUBTITLE_FONT_FAMILY,
    watermarkFontFamily: config.watermarkFontFamily ?? DEFAULT_WATERMARK_FONT_FAMILY,
  }
}

/** Demand one argument a method cannot run without. */
function required<T>(value: T | undefined, method: DramaRenderMethod, field: string, fix: string): T {
  if (value === undefined) throw new Error(`drama_render ${method} 需要 ${field}：${fix}`)
  return value
}

/**
 * Narrow one call's arguments to the paths its method cannot run without.
 *
 * Common requirements are checked before files are opened. Ending paths are
 * required asynchronously by render only after resolving the delivery medium.
 * @param args - The dispatched arguments; relative input and output paths are based on `project`.
 * @returns The resolved call, with every path absolute.
 * @throws {Error} When the method's required arguments are missing or the episode number is not a positive integer.
 */
export function resolveCall(args: DramaRenderArguments): ResolvedCall {
  if (!Number.isInteger(args.episode) || args.episode < 1) {
    throw new Error(`drama_render 的 episode 必须是正整数集号，收到 ${JSON.stringify(args.episode)}。`
      + '请填 1、2、3 这样的集号，工具会补成两位（01、02、03）。')
  }
  const project = resolve(args.project)
  const episode = episodeNumberOf(args.episode)
  const paths = episodePaths(project, episode)
  if ((args.method !== 'speech_coverage' && args.method !== 'prepare' && args.speechTranscripts !== undefined)
    || (args.method !== 'speech_coverage' && args.speechDecisions !== undefined)) {
    throw new Error('speech_transcripts 仅用于 prepare 或 speech_coverage；speech_decisions 仅用于 speech_coverage。')
  }
  if (args.method === 'speech_coverage') {
    if (args.subtitlePlan !== undefined) throw new Error('speech_coverage 需要最终完整显示的 SRT，不接受删减外加字幕的 subtitle_plan。')
    return { method: 'speech_coverage', project, episode,
      shotsPath: resolve(project, required(args.shots, 'speech_coverage', 'shots', '需要声明实际画面源及可选独立 audio 的成片清单。')),
      timelinePath: resolve(project, required(args.timeline, 'speech_coverage', 'timeline', '需要当前镜头起点和时长。')),
      subtitleSrt: resolve(project, required(args.subtitleSrt, 'speech_coverage', 'subtitle_srt', '需要最终完整显示的 SRT，不是删减后的 overlay。')),
      transcriptsPath: resolve(project, required(args.speechTranscripts, 'speech_coverage', 'speech_transcripts',
        '需要现有云转写映射 {"shots":[{"shot":1,"receipt":"transcript/jobs/clip-v1.json"}]}。')),
      ...(args.speechDecisions === undefined ? {} : { decisionsPath: resolve(project, args.speechDecisions) }) }
  }
  if (args.subtitlePlan !== undefined && (args.method === 'verify' || args.method === 'subtitles' || args.method === 'subtitle_layout')) {
    throw new Error('subtitle_plan 仅用于 prepare、render 或 subtitle_overlay；verify 请传实际 resolved-overlay.srt。')
  }
  if (args.method === 'subtitle_layout') {
    return { method: 'subtitle_layout', project, episode,
      timelinePath: resolve(project, required(args.timeline, 'subtitle_layout', 'timeline', '需要已准备的项目交付样式和分辨率。')),
      subtitleSrt: resolve(project, required(args.subtitleSrt, 'subtitle_layout', 'subtitle_srt', '需要原始待检查的 SRT，不猜字幕文字。')) }
  }
  if (args.method === 'prepare') {
    return {
      method: 'prepare',
      project,
      episode,
      shotsPath: resolve(project, required(args.shots, 'prepare', 'shots',
        '成片清单的路径，内容形如 {"shots":[{"shot":1,"video":"media/02/p1-clean.mp4"}]}。')),
      subtitleSrt: resolve(project, required(args.subtitleSrt, 'prepare', 'subtitleSrt',
        '本集 SRT 字幕的路径，prepare 会把它装到 editing/<集>.srt 供烧录。')),
      ...(args.speechTranscripts === undefined ? {} : { transcriptsPath: resolve(project, args.speechTranscripts) }),
      ...(args.bgm === undefined ? {} : { bgm: resolve(project, args.bgm) }),
      ...(args.bgmPlan === undefined ? {} : { bgmPlan: resolve(project, args.bgmPlan) }),
      ...(args.subtitlePlan === undefined ? {} : { subtitlePlan: resolve(project, args.subtitlePlan) }),
    }
  }
  if (args.method === 'subtitles') {
    return {
      method: 'subtitles',
      project,
      episode,
      shotsPath: resolve(project, required(args.shots, 'subtitles', 'shots',
        '成片清单的路径，内容形如 {"shots":[{"shot":1,"video":"media/02/p1-clean.mp4"}]}。')),
      linesPath: resolve(project, required(args.lines, 'subtitles', 'lines',
        '台词计划的路径，内容形如 {"shots":[{"shot":1,"lines":["第一句","第二句"]}]}；'
        + '每镜按原文顺序去标点、按语义切成单行字幕；每条不超过 14 个有效字，长句须分别取得发声时间。')),
      alignmentPath: resolve(project, required(args.alignment, 'subtitles', 'alignment',
        '语音识别对齐文档的路径，内容形如 {"shots":[{"shot":1,"cues":[{"text":"识别文本","start":0.0,"end":0.8}]}]}；'
        + '每镜的时间必须来自对该镜成片的识别，镜内相对秒数；字幕显示文字取 lines 中按原文切分的无标点文本。')),
      subtitleSrt: resolve(project, args.subtitleSrt ?? paths.subtitle),
    }
  }
  if (args.method === 'audio_preview') {
    return {
      method: 'audio_preview', project, episode,
      timelinePath: resolve(project, required(args.timeline, 'audio_preview', 'timeline', '正文时间线 JSON。')),
      audio: resolve(project, args.audio ?? paths.masterAudio),
      ...(args.bgm === undefined ? {} : { bgm: resolve(project, args.bgm) }),
      ...(args.bgmPlan === undefined ? {} : { bgmPlan: resolve(project, args.bgmPlan) }),
      ...(args.bgmGeneration === undefined ? {} : { bgmGeneration: resolve(project, args.bgmGeneration) }),
      ...(args.intendedUse === undefined ? {} : { intendedUse: args.intendedUse }),
      profilePath: resolve(project, required(args.mixProfile, 'audio_preview', 'mixProfile', '项目内显式音频配置 JSON。')),
      startSeconds: required(args.startSeconds, 'audio_preview', 'startSeconds', '正文起点，秒。'),
      durationSeconds: required(args.durationSeconds, 'audio_preview', 'durationSeconds', '试听时长，大于 0 且最多 60 秒。'),
    }
  }
  if (args.method === 'render') {
    const lastShot = required(args.lastShot, 'render', 'lastShot',
      '本集最后一个镜头号，例如 9；时间线里 shot <= lastShot 的镜头数必须正好等于它。')
    if (!Number.isInteger(lastShot) || lastShot < 1) {
      throw new Error(`drama_render render 的 lastShot 必须是正整数镜头号，收到 ${JSON.stringify(lastShot)}。`)
    }
    const timelinePath = resolve(project, required(args.timeline, 'render', 'timeline',
      '时间线 JSON 的路径，通常是 prepare 写出的 editing/<集>-timeline.json。'))
    const subtitleSrt = resolve(project, required(args.subtitleSrt, 'render', 'subtitleSrt',
      '本集 SRT 字幕的路径，通常是 prepare 装好的 editing/<集>.srt。'))
    const bgm = args.mixProfile === undefined
      ? required(args.bgm, 'render', 'bgm', '本集实际使用的 BGM 文件路径。') : args.bgm
    return {
      method: 'render',
      project,
      episode,
      timelinePath,
      subtitleSrt,
      ...(args.subtitlePlan === undefined ? {} : { subtitlePlan: resolve(project, args.subtitlePlan) }),
      lastShot,
      ...(bgm === undefined ? {} : { bgm: resolve(project, bgm) }),
      ...(args.mixProfile === undefined ? {} : { mixProfile: resolve(project, args.mixProfile) }),
      ...(args.bgmPlan === undefined ? {} : { bgmPlan: resolve(project, args.bgmPlan) }),
      ...(args.endingAudio === undefined ? {} : { endingAudio: resolve(project, args.endingAudio) }),
      ...(args.endingEffect === undefined ? {} : { endingEffect: resolve(project, args.endingEffect) }),
      output: resolve(project, args.output ?? paths.output),
      force: args.force ?? false,
    }
  }
  if (args.method === 'subtitle_overlay') {
    return { method: 'subtitle_overlay', project, episode,
      timelinePath: resolve(project, required(args.timeline, 'subtitle_overlay', 'timeline', '需要 prepare 的时间线。')),
      subtitleSrt: resolve(project, required(args.subtitleSrt, 'subtitle_overlay', 'subtitle_srt', '需要保留的原始 SRT。')),
      subtitlePlan: resolve(project, required(args.subtitlePlan, 'subtitle_overlay', 'subtitle_plan', '需要明确的已有字幕决定文件。')),
      ...(args.output === undefined ? {} : { outputSrt: resolve(project, args.output) }) }
  }
  return {
    method: 'verify',
    project,
    episode,
    timelinePath: resolve(project, required(args.timeline, 'verify', 'timeline',
      '被检查成片所依据的时间线 JSON 路径。')),
    subtitleSrt: resolve(project, required(args.subtitleSrt, 'verify', 'subtitleSrt',
      '被检查成片所烧录的 SRT 字幕路径。')),
    output: resolve(project, required(args.output, 'verify', 'output',
      '要检查的成片文件路径，例如 export/<剧名>_第02集_成片.mp4。')),
  }
}

/** The result of a `prepare` call that wrote nothing but its own layout. */
async function prepareReport(call: PrepareCall, prepared: Awaited<ReturnType<typeof prepareEpisode>>,
  settings: RenderSettings, overlay?: Awaited<ReturnType<typeof resolveSubtitleOverlay>>): Promise<DramaRenderReport> {
  const sources = new Map(prepared.shots.map(shot => [shot.source.shot, shot.video]))
  const policy = deliveryPolicyFor(prepared.timeline.delivery)
  let subtitle = overlay?.report.resolved_srt ?? episodePaths(call.project, call.episode).subtitle
  const displayWritten: string[] = []
  const fitWarnings: string[] = []
  if (settings.normalizeSubtitleText && overlay === undefined) {
    const displayWarnings = subtitleDisplayWarnings(prepared.cues)
    fitWarnings.push(...displayWarnings)
    let cues = normalizeSubtitleDisplay(prepared.cues)
    if (call.transcriptsPath !== undefined) {
      try {
        const coverage = await reviewSpeechCoverage({ project: call.project, timeline: prepared.timeline,
          sources: new Map(prepared.shots.map(shot => [shot.source.shot, shot.audio])),
          subtitleSrt: episodePaths(call.project, call.episode).subtitle, transcriptsPath: call.transcriptsPath })
        const toolkit = createMediaToolkit({ ffmpeg: settings.ffmpeg, ffprobe: settings.ffprobe, channel: settings.channel })
        const widths = new Map<string, boolean | null>()
        const fit = await fitSubtitleCues(cues, coverage, async (text) => {
          if (widths.has(text)) return widths.get(text) ?? null
          const measured = await measureSubtitleLayout({ toolkit, settings: deliveryRenderSettings(settings, policy.delivery),
            delivery: policy.delivery, cues: [{ index: 1, startSeconds: 0, endSeconds: 1, text }],
            directory: episodePaths(call.project, call.episode).cacheDir })
          displayWritten.push(...measured.written)
          const value = measured.report.entries[0]?.fits_available_width ?? null
          widths.set(text, value)
          return value
        })
        cues = fit.cues
        fitWarnings.push(...fit.warnings)
      } catch (error) {
        fitWarnings.push(`现有词级转写或字形测量不可用，未自动拆分长句：${String(error)}；请核对实际发声与字幕宽度。`)
      }
    } else {
      fitWarnings.push('未提供现有词级转写，长句不会猜测时间自动拆分；请测量宽度并按真实发声核对。')
    }
    const dir = await mkdtemp(resolve(call.project, 'editing', '.subtitle-display-'))
    subtitle = resolve(dir, `${call.episode}.srt`)
    await writeFile(subtitle, formatSrtDocument(cues), 'utf8')
    displayWritten.push(subtitle)
    if (displayWarnings.length) {
      await writeFile(`${subtitle}.review.txt`, displayWarnings.join('\n'), 'utf8')
      displayWritten.push(`${subtitle}.review.txt`)
    }
  } else if (call.transcriptsPath !== undefined && overlay !== undefined) {
    fitWarnings.push('已有烧录字幕的覆盖计划未自动重新切分；请核对外加字幕的实际宽度及发声时间。')
  }
  const preview = buildRenderPreview({ settings, delivery: policy.delivery,
    subtitle,
    master: episodePaths(call.project, call.episode).masterAudio,
    ...(call.bgm === undefined ? {} : { bgm: call.bgm }), ...(call.bgmPlan === undefined ? {} : { bgmPlan: call.bgmPlan }) })
  const warnings = [...prepared.warnings, ...renderPreviewWarnings(preview), ...overlay?.warnings ?? [], ...fitWarnings]
  let bgmPlan: BgmPlanReport | undefined
  if (call.bgm !== undefined && call.bgmPlan !== undefined) {
    try {
      bgmPlan = await readBgmPlan(call.bgmPlan, call.episode, prepared.timeline.bodyEndSeconds, call.bgm, call.project)
    } catch (error) {
      warnings.push(`prepare 已完成；可选 BGM 计划未核对：${call.bgmPlan}；${String(error)}；render 将重新校验。`)
    }
  }
  const reportInput: ReportInput = {
    method: 'prepare',
    renderPreview: preview,
    ...(bgmPlan === undefined ? {} : { bgmPlan }),
    project: call.project,
    episode: call.episode,
    timeline: prepared.timeline,
    sources,
    expectedDurationSeconds: Number(
      (prepared.timeline.bodyEndSeconds + deliveryPolicyFor(prepared.timeline.delivery).endingSeconds).toFixed(6),
    ),
    written: [...prepared.written, ...overlay?.written ?? [], ...displayWritten],
    ...(overlay === undefined ? {} : { subtitleOverlay: overlay.report }),
    output: '',
    encoder: '',
    gpuRequested: false,
    gpuUsed: false,
    encoderFallbackReason: '',
    encodedShots: [],
    reusedShots: [],
    tailFrame: NO_TAIL_FRAME,
    media: NO_MEDIA,
    checks: [],
    warnings,
    logPath: '',
  }
  return buildReport(reportInput)
}

/**
 * The result of a `subtitles` call.
 *
 * Line coverage and timing findings remain advisory. Partial candidates use a
 * separate SRT path so reviewing them does not overwrite an existing subtitle. How accurate the recognizer's own times are is
 * not judged here, so `speech_alignment` stays in `not_checked`.
 * @param call - The resolved call.
 * @param built - What the cue build read and wrote.
 * @returns The canonical report.
 */
function subtitlesReport(call: SubtitlesCall, built: BuiltCues): DramaRenderReport {
  const sources = new Map(built.shots.map(shot => [shot.source.shot, shot.video]))
  const checks: RenderCheck[] = built.failures.map(failure => ({
    id: failure.id,
    severity: 'warning',
    ok: false,
    detail: failure.detail,
    fix: failure.fix,
  }))
  const reportInput: ReportInput = {
    method: 'subtitles',
    project: call.project,
    episode: call.episode,
    timeline: built.timeline,
    sources,
    expectedDurationSeconds: Number((built.timeline.bodyEndSeconds + deliveryPolicyFor(built.timeline.delivery).endingSeconds).toFixed(6)),
    written: built.written,
    output: '',
    encoder: '',
    gpuRequested: false,
    gpuUsed: false,
    encoderFallbackReason: '',
    encodedShots: [],
    reusedShots: [],
    tailFrame: NO_TAIL_FRAME,
    media: NO_MEDIA,
    checks,
    warnings: built.warnings,
    logPath: '',
  }
  return buildReport(reportInput)
}

/**
 * Run one `drama_render` call.
 * @param args - The dispatched arguments.
 * @param settings - The resolved binaries, gains, and encoder preference.
 * @returns The canonical result; `ok` is false when a delivery check failed.
 * @throws {Error} When an argument is missing, an input is unusable, or a media command fails.
 */
export async function runDramaRender(
  args: DramaRenderArguments,
  settings: RenderSettings,
): Promise<DramaRenderReport> {
  const call = resolveCall(args)
  const toolkit = createMediaToolkit({ ffmpeg: settings.ffmpeg, ffprobe: settings.ffprobe, channel: settings.channel })
  if (call.method === 'subtitle_layout') {
    const timeline = await readTimeline(call.timelinePath, settings.enforceSubtitleVisual)
    const policy = await resolveDeliveryPolicy(
      call.project, timeline.delivery, settings.defaultSubtitleVisual, settings.enforceSubtitleVisual,
    )
    const originalCues = await readSubtitleCues(call.subtitleSrt)
    const cues = settings.normalizeSubtitleText ? normalizeSubtitleDisplay(originalCues) : originalCues
    const layout = await measureSubtitleLayout({ toolkit, settings: deliveryRenderSettings(settings, policy.delivery),
      delivery: policy.delivery, cues, directory: episodePaths(call.project, call.episode).cacheDir })
    return buildReport({ method: 'subtitle_layout', project: call.project, episode: call.episode, timeline,
      sources: new Map(), expectedDurationSeconds: timeline.bodyEndSeconds + policy.endingSeconds,
      subtitleLayout: layout.report, written: layout.written, output: '', encoder: '', gpuRequested: false, gpuUsed: false,
      encoderFallbackReason: '', encodedShots: [], reusedShots: [], tailFrame: NO_TAIL_FRAME, media: NO_MEDIA,
      checks: [], logPath: '', warnings: [...policy.warnings, ...layout.warnings,
        ...(settings.normalizeSubtitleText ? subtitleDisplayWarnings(originalCues) : []),
        ...(layout.report.status === 'not_requested' ? ['当前交付未启用 subtitle_visual，未生成字形探针；旧样式不变。'] : []),
        '字形探针只测白字与描边估量，不代表剪映外观、字幕同步或人工视觉验收通过。'] })
  }
  if (call.method === 'speech_coverage') {
    const timeline = await readTimeline(call.timelinePath, settings.enforceSubtitleVisual)
    const rows = parseShotManifest(await readJsonDocument(call.shotsPath, '成片清单'), call.shotsPath)
    const sources = new Map(rows.map(row => [row.shot, resolve(call.project, row.audio)]))
    const coverage = await reviewSpeechCoverage({ project: call.project, timeline, sources,
      subtitleSrt: call.subtitleSrt, transcriptsPath: call.transcriptsPath,
      ...(call.decisionsPath === undefined ? {} : { decisionsPath: call.decisionsPath }) })
    return { ...buildReport({ method: 'speech_coverage', project: call.project, episode: call.episode, timeline,
      sources: new Map(rows.map(row => [row.shot, resolve(call.project, row.video)])),
      expectedDurationSeconds: timeline.bodyEndSeconds, written: [], output: '', encoder: '',
      gpuRequested: false, gpuUsed: false, encoderFallbackReason: '', encodedShots: [], reusedShots: [],
      tailFrame: NO_TAIL_FRAME, media: NO_MEDIA, checks: [{ id: 'subtitle_speech_candidates', severity: 'warning',
        ok: coverage.evidence_complete && coverage.findings.length === 0,
        detail: `${String(coverage.words.length)} 个识别词；${String(coverage.findings.length)} 项声文或词边界待核；同源证据完整=${String(coverage.evidence_complete)}。`,
        fix: '逐项核听引用的实际声音与最终完整显示 SRT，保留具体 reason；识别候选不等于真实发声，不能自动补字或猜时码。' }],
      warnings: [...coverage.warnings, '本次仅比较词级转写候选与最终完整显示 SRT；未执行听感或画面烧字验收，核听声明也不是 Host 声学证明。'],
      logPath: '' }), speech_coverage: coverage }
  }
  if (call.method === 'audio_preview') {
    const preview = await previewAudio({ ...call, toolkit, settings })
    return buildReport({ method: 'audio_preview', project: call.project, episode: call.episode,
      timeline: preview.timeline, sources: new Map(), expectedDurationSeconds: call.durationSeconds,
      written: preview.written, output: preview.output, encoder: '', gpuRequested: false, gpuUsed: false,
      encoderFallbackReason: '', encodedShots: [], reusedShots: [], tailFrame: NO_TAIL_FRAME,
      media: NO_MEDIA, checks: [], audioMix: preview.mix, bgmPlan: preview.bgmPlan, logPath: '',
      warnings: ['短时 RMS/采样峰值不是人工听感验收；原声可能已有音乐和音效。',
        ...(preview.mix.music_audio && !preview.bgmPlan.path ? ['未提供配乐计划，曲目来源、使用时段与许可未知。'] : []),
        ...(preview.mix.music_audio && preview.mix.composition_gain_status === 'not_provided'
          ? ['未提供匹配的配乐合成收据，各源曲作曲增益未测得；不能只凭总 music_gain 推断。'] : []),
        ...(preview.mix.mode === 'ducking' ? ['压低由原声能量触发，不是语义 VAD 或纯对白分离。'] : [])] })
  }
  if (call.method === 'prepare') {
    const prepared = await prepareEpisode({
      toolkit,
      ...(settings.defaultEndingEffectFit === undefined ? {} : { defaultEndingEffectFit: settings.defaultEndingEffectFit }),
      ...(settings.defaultSubtitleVisual === undefined ? {} : { defaultSubtitleVisual: settings.defaultSubtitleVisual }),
      ...(settings.enforceSubtitleVisual ? { enforceSubtitleVisual: true } : {}),
      project: call.project,
      episode: call.episode,
      shotsPath: call.shotsPath,
      subtitleSrt: call.subtitleSrt,
    })
    const overlay = call.subtitlePlan === undefined ? undefined : await resolveSubtitleOverlay({
      project: call.project, episode: call.episode, timeline: prepared.timeline,
      subtitleSrt: episodePaths(call.project, call.episode).subtitle, planPath: call.subtitlePlan,
      ...(settings.normalizeSubtitleText ? { normalizeDisplay: true } : {}),
    })
    return await prepareReport(call, prepared, settings, overlay)
  }
  if (call.method === 'subtitles') {
    return subtitlesReport(call, await buildEpisodeCues({
      toolkit,
      project: call.project,
      episode: call.episode,
      shotsPath: call.shotsPath,
      linesPath: call.linesPath,
      alignmentPath: call.alignmentPath,
      subtitleSrt: call.subtitleSrt,
    }))
  }
  if (call.method === 'render') {
    return await renderEpisode({
      toolkit,
      settings,
      project: call.project,
      episode: call.episode,
      timelinePath: call.timelinePath,
      subtitleSrt: call.subtitleSrt,
      ...(call.subtitlePlan === undefined ? {} : { subtitlePlan: call.subtitlePlan }),
      lastShot: call.lastShot,
      ...(call.bgm === undefined ? {} : { bgm: call.bgm }),
      ...(call.mixProfile === undefined ? {} : { mixProfile: call.mixProfile }),
      ...(call.bgmPlan === undefined ? {} : { bgmPlan: call.bgmPlan }),
      ...(call.endingAudio === undefined ? {} : { endingAudio: call.endingAudio }),
      ...(call.endingEffect === undefined ? {} : { endingEffect: call.endingEffect }),
      output: call.output,
      force: call.force,
    })
  }
  if (call.method === 'subtitle_overlay') {
    const timeline = await readTimeline(call.timelinePath, settings.enforceSubtitleVisual)
    const overlay = await resolveSubtitleOverlay({ project: call.project, episode: call.episode,
      timeline, subtitleSrt: call.subtitleSrt, planPath: call.subtitlePlan,
      ...(settings.normalizeSubtitleText ? { normalizeDisplay: true } : {}),
      ...(call.outputSrt === undefined ? {} : { outputSrt: call.outputSrt }) })
    return buildReport({ method: 'subtitle_overlay', project: call.project, episode: call.episode,
      timeline, sources: new Map(overlay.report.sources.map(source => [source.shot, source.path])),
      expectedDurationSeconds: timeline.bodyEndSeconds + deliveryPolicyFor(timeline.delivery).endingSeconds,
      subtitleOverlay: overlay.report, written: overlay.written, warnings: overlay.warnings,
      output: '', encoder: '', gpuRequested: false, gpuUsed: false, encoderFallbackReason: '',
      encodedShots: [], reusedShots: [], tailFrame: NO_TAIL_FRAME, media: NO_MEDIA, checks: [], logPath: '',
    })
  }
  return await verifyEpisode({
    toolkit,
    settings,
    project: call.project,
    episode: call.episode,
    output: call.output,
    timelinePath: call.timelinePath,
    subtitleSrt: call.subtitleSrt,
  })
}

/** One sentence every check field repeats. */
const CHECK_SHAPE = 'severity=failure 表示交付不可用（ok=false），warning 只记录不阻塞。'

/** Model-facing base report and optional evidence for explicit audio profiles. */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    method: {
      type: 'string', required: true,
      enum: ['prepare', 'render', 'verify', 'subtitles', 'audio_preview', 'subtitle_overlay', 'speech_coverage', 'subtitle_layout'],
      description: '产生本结果的操作。',
    },
    subtitle_layout: { type: 'object', additionalProperties: false,
      description: '显式 subtitle_visual 的真实 libass 字形摘要；逐文本像素、PNG、字体选择与完整错误日志在 report_path，非剪映或人工验收。',
      properties: {
        schema_version: { type: 'integer', required: true, enum: [1] },
        status: { type: 'string', required: true, enum: ['not_requested', 'measured', 'partial', 'not_measured'] },
        report_path: { type: 'string', required: true },
        distinct_texts: { type: 'integer', required: true }, measured_texts: { type: 'integer', required: true },
        overwidth_cue_indexes: { type: 'array', required: true, items: { type: 'integer' } },
        uncertain_cue_indexes: { type: 'array', required: true, items: { type: 'integer' } },
        preview_paths: { type: 'array', required: true, items: { type: 'string' } },
        stderr_paths: { type: 'array', required: true, items: { type: 'string' } },
      } },
    speech_coverage: { type: 'object', additionalProperties: false, properties: {
      schema_version: { type: 'integer', required: true, enum: [1] },
      assessment: { type: 'string', required: true, enum: ['asr_candidate_comparison'] },
      listening_verified: { type: 'boolean', required: true, enum: [false] },
      subtitle_path: { type: 'string', required: true }, subtitle_sha256: { type: 'string', required: true },
      evidence_sha256: { type: 'string', required: true }, evidence_complete: { type: 'boolean', required: true },
      sources: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        shot: { type: 'integer', required: true }, clip_index: { type: 'integer', required: true },
        path: { type: 'string', required: true }, sha256: { type: 'string', required: true },
        receipt_path: { type: 'string', required: true }, receipt_sha256: { type: 'string', required: true },
        transcript_path: { type: 'string', required: true }, transcript_sha256: { type: 'string', required: true },
      } } },
      words: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, shot: { type: 'integer', required: true },
        clip_index: { type: 'integer', required: true }, word_index: { type: 'integer', required: true },
        text: { type: 'string', required: true }, source_start_seconds: { type: 'number', required: true },
        source_end_seconds: { type: 'number', required: true }, start_seconds: { type: 'number', required: true },
        end_seconds: { type: 'number', required: true },
      } } },
      matches: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        word_id: { type: 'string', required: true }, cue_index: { type: 'integer', required: true },
        text: { type: 'string', required: true }, precision: { type: 'string', required: true, enum: ['word'] },
      } } },
      findings: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, text: { type: 'string', required: true },
        kind: { type: 'string', required: true, enum: ['recognized_without_subtitle', 'subtitle_without_recognition', 'timing_mismatch'] },
        start_seconds: { type: 'number', required: true }, end_seconds: { type: 'number', required: true },
        word_ids: { type: 'array', required: true, items: { type: 'string' } },
        cue_indexes: { type: 'array', required: true, items: { type: 'integer' } },
        review: { type: 'object', additionalProperties: false, properties: {
          decision: { type: 'string', required: true, enum: ['keep', 'adjust_subtitle', 'asr_error', 'unresolved'] },
          reason: { type: 'string', required: true }, observed_text: { type: 'string', required: true },
          reviewed_start_seconds: { type: 'number', required: true }, reviewed_end_seconds: { type: 'number', required: true },
        } },
      } } },
      warnings: { type: 'array', required: true, items: { type: 'string' } },
    } },
    subtitle_overlay: { type: 'object', additionalProperties: false,
      description: '明确决定后的实际外加字幕及绑定摘要；不证明 OCR 或人工验收，不可把保留原片字称为可编辑字幕。',
      properties: {
        episode: { type: 'string', required: true },
        plan_path: { type: 'string', required: true }, plan_sha256: { type: 'string', required: true },
        original_srt: { type: 'string', required: true }, original_srt_sha256: { type: 'string', required: true },
        resolved_srt: { type: 'string', required: true }, resolved_srt_sha256: { type: 'string', required: true },
        decision_report: { type: 'string', required: true },
        sources: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          shot: { type: 'integer', required: true }, path: { type: 'string', required: true }, sha256: { type: 'string', required: true },
        } } },
        timeline_clips: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          shot: { type: 'integer', required: true }, start_us: { type: 'integer', required: true }, duration_us: { type: 'integer', required: true },
        } } },
        retained_cue_indexes: { type: 'array', required: true, items: { type: 'integer' } },
        retained_embedded: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          cue_index: { type: 'integer', required: true }, shot: { type: 'integer', required: true }, text: { type: 'string', required: true },
          start_seconds: { type: 'number', required: true }, end_seconds: { type: 'number', required: true },
          source_sha256: { type: 'string', required: true }, editable: { type: 'boolean', required: true },
        } } },
        original_cue_count: { type: 'integer', required: true }, overlay_cue_count: { type: 'integer', required: true },
        evidence_kind: { type: 'string', required: true, enum: ['caller_declared'] },
        retained_text_editable: { type: 'boolean', required: true }, retained_text_style_adjustable: { type: 'boolean', required: true },
      } },
    ending_effect: { type: 'object', additionalProperties: false, properties: {
      fit: { type: 'string', required: true, enum: ['source_once', 'stretch_to_window'] },
      source_duration_seconds: { type: 'number', required: true }, target_duration_seconds: { type: 'number', required: true },
      speed: { type: 'number', required: true },
    } },
    ok: { type: 'boolean', required: true,
      description: '是否成功且没有任何 failure 级检查失败；false 时交付不可用，看 failures 里的修法。' },
    project: { type: 'string', required: true, description: '项目根目录的绝对路径。' },
    episode: { type: 'string', required: true, description: '两位集号。' },
    clips: { type: 'array', required: true, description: '本次使用的时间线镜头，按镜头号顺序。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          shot: { type: 'integer', required: true, description: '镜头号。' },
          source: { type: 'string', required: true,
            description: '该镜对应的成片路径：prepare 报清单里声明的源文件；render 报 video/<集>/shot_00N.mp4；'
              + 'verify 不解析素材路径，为空串。' },
          start_us: { type: 'integer', required: true, description: '相对整集起点的微秒偏移。' },
          duration_us: { type: 'integer', required: true, description: '该镜占用的微秒数。' },
        },
      } },
    body_end_seconds: { type: 'number', required: true,
      description: '正片（不含片尾）结束时刻，秒。' },
    expected_duration_seconds: { type: 'number', required: true,
      description: '按明确媒介计算的交付时长：3D 动画等于正片结束；写实或未声明媒介的旧项目再加片尾 2 秒。' },
    written: { type: 'array', required: true, items: { type: 'string' },
      description: '本次写入的绝对路径；verify 不写任何文件。' },
    output: { type: 'string', required: true,
      description: '成片绝对路径；prepare 与 verify 之外的场合为空串。' },
    encoder: { type: 'string', required: true,
      description: '本次使用的编码器：h264_nvenc 或 libx264；没渲染时为空串。' },
    gpu_requested: { type: 'boolean', required: true, description: '本次是否请求了 GPU 编码器。' },
    gpu_used: { type: 'boolean', required: true, description: 'GPU 编码器是否真的用上了。' },
    encoder_fallback_reason: { type: 'string', required: true,
      description: '回退到 CPU 编码器的原因（探测失败原文）；用上 GPU 或没渲染时为空串。' },
    encoded_shots: { type: 'array', required: true, items: { type: 'integer' },
      description: '本次实际重编的镜头号。' },
    reused_shots: { type: 'array', required: true, items: { type: 'integer' },
      description: '本次复用渲染缓存的镜头号。' },
    tail_frame: { type: 'object', required: true,
      description: '片尾定格帧的来源与校验证据；没做片尾时各字段为空值。',
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true, description: '抽出的尾帧 PNG 绝对路径。' },
        frame_md5: { type: 'string', required: true, description: '实际写入帧的 framemd5。' },
        sequential_tail_md5: { type: 'string', required: true,
          description: '顺序解码后最后一帧的 framemd5，即真实尾帧的指纹。' },
        from_sequential_decode: { type: 'boolean', required: true,
          description: '是否因为 -sseof 抽到的不是尾帧而改用顺序解码取帧。' },
        matches_sequential_tail: { type: 'boolean', required: true,
          description: '写入的帧是否与顺序解码的最后一帧逐像素一致。' },
      } },
    media: { type: 'object', required: true,
      description: '成片的实测参数；没测量时各字段为空值。',
      additionalProperties: false,
      properties: {
        duration_seconds: { type: 'number', required: true, description: '实测总时长，秒。' },
        size_bytes: { type: 'integer', required: true, description: '文件字节数。' },
        bitrate_bps: { type: 'number', required: true, description: '实测总码率，bit/s。' },
        video_codec: { type: 'string', required: true, description: '视频编码器名。' },
        width: { type: 'integer', required: true, description: '画面宽度。' },
        height: { type: 'integer', required: true, description: '画面高度。' },
        fps: { type: 'number', required: true, description: '实测帧率。' },
        has_audio: { type: 'boolean', required: true, description: '是否带音轨。' },
        audio_codec: { type: 'string', required: true, description: '音频编码器名。' },
        audio_sample_rate: { type: 'integer', required: true, description: '音频采样率，Hz。' },
      } },
    checks: { type: 'array', required: true, description: `本次跑过的检查。${CHECK_SHAPE}`,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true,
            description: '稳定的检查名：duration、video_stream、frame_rate、audio_stream、bitrate_floor、'
              + 'decode_probe、black_frames、fade_to_black、silence、long_pauses、subtitle_bounds、subtitle_present。' },
          severity: { type: 'string', required: true, enum: ['failure', 'warning'], description: CHECK_SHAPE },
          ok: { type: 'boolean', required: true, description: '该检查是否通过。' },
          detail: { type: 'string', required: true, description: '判定所依据的实测值。' },
          fix: { type: 'string', required: true, description: '中文修法；通过时为空串。' },
        },
      } },
    audio_mix: AUDIO_MIX_RESULT_SCHEMA,
    bgm_plan: { type: 'object', required: true, additionalProperties: false,
      description: '声明的配乐段落、音频许可事实、用途风险和同序复用提醒；不是试听或版权核验结论。未读取计划时许可与用途为 unknown。',
      properties: {
        path: { type: 'string', required: true },
        bed_sha256: { type: 'string', required: true },
        intended_use: { type: 'string', required: true, enum: ['commercial', 'non_commercial', 'unknown'] },
        license_records: { type: 'array', required: true, items: BGM_LICENSE_RECORD_TOOL_SCHEMA },
        repeated_sequence_episodes: { type: 'array', required: true, items: { type: 'string' } },
        segments: { type: 'array', required: true, items: {
          type: 'object', additionalProperties: false, properties: {
            track: { type: 'string', required: true }, source: { type: 'string', required: true },
            start_seconds: { type: 'number', required: true }, end_seconds: { type: 'number', required: true },
            reason: { type: 'string', required: true },
            track_id: { type: 'string' },
            source_sha256: { type: 'string', description: '计划声明的源曲摘要，渲染器未重新核验源曲。' },
            license_info: { ...LICENSE_INFO_TOOL_SCHEMA, required: true },
          },
        } },
      } },
    render_preview: { required: true,
      description: 'prepare/render 的最终交付规格、字幕设计值与名义输出像素、实际音轨路径及增益；非字形实测、试听或验收结论。其它方法为 null。',
      oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
        delivery: { type: 'object', required: true, additionalProperties: false, properties: {
          visual_medium: { type: 'string', enum: ['animation_3d', 'photorealistic'] },
          width: { type: 'integer', required: true }, height: { type: 'integer', required: true }, fps: { type: 'integer', required: true },
        } },
        subtitle: { type: 'object', required: true, additionalProperties: false, properties: {
          path: { type: 'string', required: true }, font_family: { type: 'string', required: true },
          design_width: { type: 'number', required: true }, design_height: { type: 'number', required: true },
          font_size_design: { type: 'number', required: true }, spacing_design: { type: 'number', required: true },
          outline_design: { type: 'number', required: true }, margin_bottom_design: { type: 'number', required: true },
          font_size_output_px: { type: 'number', required: true }, outline_output_px: { type: 'number', required: true },
          margin_bottom_output_px: { type: 'number', required: true },
          center_y_output_px: { type: 'number' }, max_width_output_px: { type: 'number' },
        } },
        audio: { type: 'object', required: true, additionalProperties: false, properties: {
          master_path: { type: 'string', required: true }, bgm_path: { type: 'string', required: true },
          bgm_plan_path: { type: 'string', required: true }, master_gain: { type: 'number', required: true }, bgm_gain: { type: 'number', required: true },
        } },
      } }],
    },
    not_checked: { type: 'array', required: true, items: { type: 'string' },
      description: '本次未测量的 QA 项；ok=true 只表示已执行检查通过，不代表内容、字幕或配乐全部通过。' },
    failures: { type: 'array', required: true, items: { type: 'string' },
      description: '每条 failure 级失败一行中文说明与修法。' },
    warnings: { type: 'array', required: true, items: { type: 'string' },
      description: '每条不阻塞的提醒一行中文说明。' },
    log_path: { type: 'string', required: true,
      description: '渲染日志绝对路径（含编码器回退原因与逐项检查结论）；没写日志时为空串。' },
    summary: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        shots: { type: 'integer', required: true, description: '时间线镜头数。' },
        encoded: { type: 'integer', required: true, description: '本次重编的镜头数。' },
        reused: { type: 'integer', required: true, description: '本次复用缓存的镜头数。' },
        checks: { type: 'integer', required: true, description: '检查数。' },
        failed_checks: { type: 'integer', required: true, description: '未通过的检查数（含 warning）。' },
        warnings: { type: 'integer', required: true, description: '提醒条数。' },
      },
    },
  },
} as const

/** What the model reads before calling: the methods, medium-specific delivery, and known traps. */
const DESCRIPTION = '短剧整集渲染编排（剧变流水线）。'
  + 'subtitle_layout=按 timeline 与 subtitle_srt 预览已启用的 subtitle_visual：逐种文本用实际字体、libass 和正式烧录链测白字宽高，'
  + '返回 PNG、完整字体/错误日志路径及超宽 cue；黑描边另作估量。render 在显式启用时也执行同一检查。'
  + '按部署和项目配置选择样式，不按字数猜宽、不自动缩字；超宽与探针失败只提醒，不要求用户审批。'
  + 'speech_coverage=只读双向比较现有同源词级转写与最终完整显示的 SRT（含保留原片烧字对应文字），'
  + '需要 shots、timeline、subtitle_srt、speech_transcripts；speech_decisions 可记录本次证据绑定的逐项核听理由。'
  + '包含单字、尾音和剧本外识别内容；不跨时间借词、不重复使用字符、多字词保留整词时间，不猜字级时间。'
  + '结果是 ASR 待核候选，不是已证实真声或听感通过；不得自动补词、猜时码或把未识别认定为静音。'
  + '源片可能已烧录文字：先用 video_ocr/video_inspect 预览并作明确决定，不能把无识别结果当作无字幕。'
  + 'subtitle_overlay=读取 subtitle_plan 的 shot/source_sha256/镜内时间/text/retain_embedded/reason 决定，'
  + '只对完整覆盖且同文的 cue 导出不重复叠加的新 SRT 与摘要报告；部分重叠或文字不符只提示，不自动切句。'
  + 'prepare/render 可传同一 subtitle_plan；原始 SRT 不改写，草稿复用返回的 resolved_srt 和 decision_report。'
  + '原片字不可编辑、无法由外加样式统一字号位置；evidence_paths 只是调用方声明，不是可信验收凭据。'
  + 'subtitles=按语音识别对齐写出 SRT：对齐文档（alignment）给出每一镜每一句的说话时间，'
  + '建议单行、无标点、每条不超过 14 个有效字；工具保留传入文字和原台词，样式只作提示。'
  + '长句要逐条取得同源字词时间，不得把整句时长均分；cue 时间 = 该镜在时间线上的起点 + 镜内偏移。'
  + '**本工具不做识别、不测能量、不估算时间**：能量门限分不出具体哪句在哪里，'
  + '估算出来的时间正是字幕压在错句上的原因。'
  + '缺对齐、段数或声文不符均按 warning 返回（subtitle_line_coverage），保留原字幕；有可用条目时写出独立候选，由你判断下一步。'
  + '没有可用条目时只写本次检查说明，明确提示未生成字幕候选，不覆盖已有候选及其说明。'
  + '提示具体镜号与证据缺口；有识别结果却没声明台词，同样返回 warning。'
  + '时长、重叠、越界和阅读速度问题也作提示；无效时间不编造替代区间，候选不覆盖原字幕。'
  + '对齐时间本身的准确度不由本工具判断，识别模型与语言选择由调用方负责。'
  + 'prepare=按成片清单构建渲染输入：把每镜成片复制到 video/<集>/shot_00N.mp4，'
  + '按 ffprobe 实测时长铺时间线（editing/<集>-timeline.json），把每镜自己的声音按各自起点拼成整集原声 master'
  + '（audio/<集>.wav，48kHz 无损、不加增益、不逐镜重采样），并安装 SRT 到 editing/<集>.srt；不编码画面。'
  + '已有同源词级转写时向 prepare 传 speech_transcripts：实际测宽后仅在完整匹配且不重叠的词界切分超宽字幕，'
  + '缺证据则保留原句并核查，不猜时码；成片和草稿复用返回的 render_preview.subtitle.path。'
  + 'prepare 将 project_bible 的明确 visual_medium（animation_3d 或 photorealistic）与 delivery 宽高/帧率写入时间线快照。'
  + 'project_bible.delivery 可显式配置 subtitle.{font_family,font_size_px,margin_bottom_px}（字号和底距为成片像素）'
  + '与 audio.{master_gain,bgm_gain}（0..8 线性增益，0 为静音）；prepare 同时快照已配 section。'
  + 'Muse 短剧产品竖版输出强制使用部署配置的统一正文字幕视觉，不继承旧项目及时间线字幕样式；横版和方形沿用原布局规则，音频等其他 section 仍按时间线、项目、部署默认顺序选择。'
  + '非产品部署继续按 section 优先用时间线，再用项目显式 section，最后沿用部署/旧样式默认；已快照的 section 不逐字段继承后改项目。'
  + 'prepare/render 的 render_preview 明示最终规格、字幕设计字号与名义输出像素、实际 BGM 路径及增益；'
  + '请与已认可审查版核对，SRT 不携带审查片的字体样式。prepare 可附 bgm/bgm_plan 预览选曲，未附只提示，不阻塞。'
  + 'render/verify 优先使用快照，未含媒介时读取项目明确媒介；两者明确值冲突须重跑 prepare，不从 style 或宽高比猜测。'
  + '3D 动画不加水印、不追加片尾、不读取 ending 素材，只混整集原声与 BGM；未声明媒介的旧项目报警并保留旧样式。'
  + 'render=出片：按快照宽高/帧率（旧时间线默认 1440x2560@60）、24M 目标码率 / 30M 上限 / 48M 缓冲、H.264 high@5.1。'
  + '以下片尾与 AI 标记仅适用于 photorealistic 或未声明媒介的旧项目：'
  + '片尾用最后一镜的真实尾帧定格 2 秒：timeline 的 ending_effect_fit 优先，缺省使用部署配置，未配置时沿用 source_once。'
  + 'stretch_to_window 把完整源特效变速铺满这 2 秒，不循环、不补黑场；source_once 按原速播放一次，余下是定格帧。'
  + '只有 ending_audio 的前 2 秒在正片结束处进入混音；'
  + '这两份素材按 SHA-256 校验，只接受随包字节；source_once 拒绝长于两秒的特效。'
  + '拼接后烧录 ASS 字幕'
  + '（未配置项目样式时默认 SimHei 40，字体服从部署配置，40 为设计字号而非成片像素；字间距 -2、黑描边按成片宽度推导（1440px 宽目标 7px）、底部居中，'
  + '烧录链最后是 fps=F,setpts=N/(F*TB)，F 取时间线 delivery.fps（旧时间线默认 60）；'
  + '把帧率与时间基准固定在字幕之后，手写链把 fps 放在 subtitles 之前会让成片只剩少量帧；'
  + '右下角唯一的「内容由AI生成」标记——这条标记由写出的 ASS 携带一次，另加 drawtext 或 overlay 就会重复），'
  + '再把整集原声（默认增益 1.45）+ BGM（默认增益 0.24，到正片结束）+ 片尾音 amix 后 alimiter=0.95，项目显式增益不改变此混音算法，'
  + 'AAC 192k/48kHz、+faststart 输出，并回读实测分辨率/帧率/码率/时长/大小/编码器。'
  + 'GPU 编码先探测 h264_nvenc（用 256x256 探针，太小会被 NVENC 拒绝），失败就按设计回退 libx264，'
  + '回退原因写进 encoder_fallback_reason 与渲染日志。'
  + 'verify=渲染后检查：总时长、音视频流、总码率下限 4.6 Mbps、首/中/尾抽帧真实解码、黑帧、静音、字幕 cue 是否越界，'
  + '逐项给实测值与中文修法。**不许只看元数据**：容器里的时长、帧率、码率在一份大量丢帧的成片上照样正常，'
  + 'decode_probe 会在首、中、尾各解一帧，任何一处解不出画面就按 failure 报出。'
  + '抽尾帧固定用 -sseof -0.1：-sseof -0.05 在部分片子上不写文件却返回 0，'
  + '所以每次都用 framemd5 与顺序解码的最后一帧比对，证明抽到的是真实尾帧，比对不上就改用顺序解码取帧。'
  + '只有让渲染无法进行的问题（缺参数、缺文件、命令失败、尾帧无法证明）才会报错；'
  + '成片本身的问题按 checks 返回，ok=false 并在 failures 里给出中文修法，成片与实测参数照常返回。'

/** Copy immutable review collections into the tool's mutable JSON output types without changing the internal report. */
function toolSpeechCoverage(report: SpeechCoverageReport) {
  return { ...report,
    sources: report.sources.map(source => ({ ...source })),
    words: report.words.map(word => ({ ...word })),
    matches: report.matches.map(match => ({ ...match })),
    findings: report.findings.map(finding => ({ ...finding,
      word_ids: [...finding.word_ids], cue_indexes: [...finding.cue_indexes],
      ...(finding.review === undefined ? {} : { review: { ...finding.review } }) })),
    warnings: [...report.warnings] }
}

/**
 * Register the `drama_render` tool.
 * @param ctx - Host context carrying the tool registry.
 * @param config - The deployment-varying binaries, gains, and encoder preference.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = resolveSettings(config)
  registerDramaVideo(ctx)
  ctx.tools.register(defineTool({
    name: 'drama_render',
    description: DESCRIPTION,
    parameters: {
      method: {
        type: 'string', required: true,
        enum: ['prepare', 'render', 'verify', 'subtitles', 'audio_preview', 'subtitle_overlay', 'speech_coverage', 'subtitle_layout'],
        description: 'prepare=构建渲染输入（不编码）；render=出片并回读实测参数；verify=渲染后检查；'
          + 'subtitles=按语音识别对齐文档给台词定时并写出 SRT（不编码、不做识别）；audio_preview=同最终混音滤镜的短音频 A/B 与短时 RMS/峰值分析；'
          + 'subtitle_overlay=导出已有烧录字的外加字幕决定；speech_coverage=现有词级转写与最终完整显示 SRT 的只读双向比较（不编码、不做识别）；'
          + 'subtitle_layout=显式统一样式的真实字形探针与PNG，不渲染整集。',
      },
      project: { type: 'string', required: true,
        description: '项目根目录（含 video/、audio/、editing/、exports/）；所有方法都必填。优先传绝对路径；相对 project 只按进程工作目录解析一次，其余相对输入与输出都以它为基准。' },
      episode: { type: 'integer', required: true, description: '集号（正整数，如 2）；写入时补成两位，如 02。' },
      shots: { type: 'string',
        description: '成片清单 JSON 路径，形如 {"shots":[{"shot":1,"video":"media/02/p1-clean.mp4","audio":"可选"}]}；'
          + 'prepare、subtitles 与 speech_coverage 必填。相对路径以 project 为基准，绝对路径保持不变。'
          + 'video 缺音轨时必须给 audio；speech_coverage 按实际 audio（缺省 video）绑定转写来源。' },
      lines: { type: 'string',
        description: '台词计划 JSON 路径，形如 {"shots":[{"shot":1,"lines":["第一句","第二句"]}]}；subtitles 必填。'
          + '相对路径以 project 为基准，绝对路径保持不变。每镜按原文顺序去标点并按语义切成单行显示字幕，'
          + '建议每条不超过 14 个有效字；工具不改文字，样式和覆盖问题只作提示。' },
      alignment: { type: 'string',
        description: '语音识别对齐文档 JSON 路径，subtitles 必填，形如'
          + ' {"shots":[{"shot":1,"cues":[{"text":"识别文本","start":0.0,"end":0.8}]}]}（镜内、相对该镜起点，秒）。'
          + '文件相对路径以 project 为基准，绝对路径保持不变。'
          + '只取它的时间：字幕显示文字仍来自 lines，识别文本仅用于核对是不是同一段表演。'
          + '缺某一镜、段数不符或文本对不上只作提示；不会要求清零或用户审批。' },
      timeline: { type: 'string',
        description: '时间线 JSON 路径；render、verify、subtitle_overlay、speech_coverage、subtitle_layout 必填，相对路径以 project 为基准；'
          + '可显式声明 ending_effect_fit=source_once（旧行为）或 stretch_to_window（完整特效变速铺满两秒）。'
          + '跨工具调用优先传 prepare 或 drama_bgm 返回的绝对路径。' },
      subtitle_srt: { type: 'string',
        description: '本集 SRT 字幕路径；subtitles 写出它（省略时写 editing/<集>.srt），'
          + 'prepare 装到 editing/<集>.srt，render 烧录它，verify 检查它的 cue 是否越界。'
          + 'speech_coverage 必填最终完整显示的字幕（含保留原片烧字），不能拿删减 overlay 当完整对白；'
          + 'subtitle_layout 必填待预览SRT，不更改其文本和时间。相对路径以 project 为基准。' },
      speech_transcripts: { type: 'string', description: 'speech_coverage 必填、prepare 可选：项目内现有映射 {shots:[{shot,receipt}]}，'
        + 'receipt 相对映射文件，指向 audio_transcribe 原 transcript/jobs/<stem>-vN.json；读取同源 SHA 与 raw 实际 word 时间，不提交转写。' },
      speech_decisions: { type: 'string', description: 'speech_coverage 可选：项目内核听声明 JSON，'
        + '{schema_version:1,evidence_sha256,decisions:[{item_id,decision,reason,observed_text,reviewed_start_seconds,reviewed_end_seconds}]}。'
        + 'decision=keep|adjust_subtitle|asr_error|unresolved；需本次逐项 id、非空理由及覆盖该项的核听区间；不是 Host 声学证明。' },
      subtitle_plan: { type: 'string', description: 'prepare/render 可选、subtitle_overlay 必填的 JSON 路径。'
        + '{schema_version:1,decisions:[{shot,source_sha256,start_seconds,end_seconds,text,action:"retain_embedded",reason,evidence_paths:[]}]}。'
        + '时间是该 shot 内局部秒，SHA 绑定实际 video/<集>/shot_00N.mp4；只去掉完整覆盖的同文外加 cue，不删除原片字。'
          + '相对路径以 project 为基准。缺省保持旧叠字行为；不确定只提醒预览，不要求审批或付费去字。' },
      last_shot: { type: 'integer',
        description: '本次交付的最后一个镜头号（如 9）；render 必填，时间线里 shot <= last_shot 的镜头数必须正好等于它。' },
      bgm: { type: 'string', description: '本集实际使用的纯 BGM 文件路径，不是含对白的混音审查件；render 除显式 no_bgm 外必填，prepare 可选用于预览。相对路径以 project 为基准；'
        + '优先传 drama_bgm 返回的绝对 output，会循环铺到正片结束；工具不从文件名判断内容是否纯音乐。' },
      bgm_plan: { type: 'string', description: 'prepare/render 可选：现有 episodes/segments 配乐计划 JSON；prepare 同时传 bgm 时读取段落，'
        + '读取或校验失败只提示并保留准备成果；render 仍拒绝不可读或与时间线不符的计划。'
        + '相对路径以 project 为基准，优先传 drama_bgm 返回的绝对 plan；保留 intended_use 和每段 track_id/license_info，'
        + '校验时间、记录曲目、许可用途风险与复用提醒，不代替试听或版权核验；风险不阻断渲染。' },
      mix_profile: { type: 'string', description: 'render 可选、audio_preview 必填：项目内 schema_version=1 音频配置 JSON。'
        + 'mode=legacy|no_bgm|ducking，analysis_window_ms=10..1000；可选 original_gain/music_gain=0..8。'
        + 'ducking 必须显式给 threshold_db(-60..0)、ratio(1..20)、attack_ms(0.01..2000)、release_ms(0.01..9000)、knee(1..8)。'
        + 'no_bgm 不要求或读取 bgm/bgm_plan，只省略新增配乐，保留源内声音；ducking 由原声能量驱动，不是纯对白分离。'
        + '未传配置保留旧默认；显式配置交付使用新路径，绝不覆盖已有成片或音乐 stem。' },
      bgm_generation: { type: 'string', description: 'audio_preview 可选：项目内 drama_bgm generation.json，SHA-256 须匹配本次BGM；展示每源曲 source_mean_db/applied_gain_db，缺收据明确标未提供。' },
      audio: { type: 'string', description: 'audio_preview 可选：项目内原声音频，默认 audio/<集>.wav；可能含源内音乐或音效。' },
      start_seconds: { type: 'number', description: 'audio_preview 必填：正文试听起点，非负秒数。' },
      duration_seconds: { type: 'number', description: 'audio_preview 必填：试听长度，大于 0、最多 60 秒且不越正文结束。输出在新建 audio/previews/ 目录，不覆盖旧试听。' },
      intended_use: { type: 'string', enum: ['commercial', 'non_commercial', 'unknown'], description: 'audio_preview 可选：音乐实际用途，用于许可风险提示；不代表已经获得授权。' },
      ending_audio: { type: 'string',
        description: '片尾音文件路径；写实或旧版 render 必填，animation_3d 不读取且无需提供。相对路径以 project 为基准，绝对路径保持不变。只能用随包素材 tweet-drama-background-render/assets/ending_audio.mp3'
          + '（SHA-256 d1649e9c9231283a93ee3d28816c741ac3d389528654fca5ac69d75139943c0f，全长 3.474 秒）：'
          + '只有前 2 秒延迟到正片结束处进入混音，其余不进成片；换成别的文件 render 直接报错。' },
      ending_effect: { type: 'string',
        description: '片尾特效视频路径；写实或旧版 render 必填，animation_3d 不读取且无需提供。相对路径以 project 为基准，绝对路径保持不变。只能用随包素材 tweet-drama-background-render/assets/ending_effect.mp4'
          + '（SHA-256 49308bce84b964c5ec6768655e84920731dcaabe14509a0d84b4c92aea590010，实测 1.020 秒）：'
          + 'timeline 的 ending_effect_fit 优先，缺省使用部署配置；stretch_to_window 时以 speed=0.51 铺满两秒，source_once 按原速播放一次。'
          + '换成别的文件会报错；source_once 拒绝长于两秒的素材，不做截断。' },
      output: { type: 'string',
        description: 'render 成片输出（省略写 exports/<集>.mp4），verify 必填；subtitle_overlay 可指定项目内全新 SRT 导出路径，'
          + '配套报告为 <output>.decision-report.json，两者不覆盖已有文件；省略则独立唯一目录。相对路径以 project 为基准。' },
      force: { type: 'boolean',
        description: 'render 是否忽略 exports/.render_cache 里的逐镜缓存并全部重编；默认 false。' },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async ({ subtitle_srt, subtitle_plan, last_shot, ending_audio, ending_effect, bgm_plan,
      mix_profile, start_seconds, duration_seconds, intended_use, bgm_generation,
      speech_transcripts, speech_decisions, ...args }) => {
      const { speech_coverage: coverage, ...report } = await runDramaRender({
        ...args,
        ...(subtitle_srt === undefined ? {} : { subtitleSrt: subtitle_srt }),
        ...(subtitle_plan === undefined ? {} : { subtitlePlan: subtitle_plan }),
        ...(speech_transcripts === undefined ? {} : { speechTranscripts: speech_transcripts }),
        ...(speech_decisions === undefined ? {} : { speechDecisions: speech_decisions }),
        ...(bgm_plan === undefined ? {} : { bgmPlan: bgm_plan }),
        ...(mix_profile === undefined ? {} : { mixProfile: mix_profile }),
        ...(bgm_generation === undefined ? {} : { bgmGeneration: bgm_generation }),
        ...(start_seconds === undefined ? {} : { startSeconds: start_seconds }),
        ...(duration_seconds === undefined ? {} : { durationSeconds: duration_seconds }),
        ...(intended_use === undefined ? {} : { intendedUse: intended_use }),
        ...(last_shot === undefined ? {} : { lastShot: last_shot }),
        ...(ending_audio === undefined ? {} : { endingAudio: ending_audio }),
        ...(ending_effect === undefined ? {} : { endingEffect: ending_effect }),
      }, settings)
      return coverage === undefined ? report : { ...report, speech_coverage: toolSpeechCoverage(coverage) }
    },
  }))
}
