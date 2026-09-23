/**
 * `drama_render`: the short-drama pipeline's episode renderer, as one
 * model-facing tool.
 *
 * The delivery style used to be encoded in a skill script the model launched
 * with a shell. The style itself is a fixed specification — 1440x2560 at 60 fps,
 * 24M target with a 30M ceiling and a 4.6 Mbps floor, 68px subtitles with -2 spacing
 * and a 7px outline, the bottom-right `内容由AI生成` mark, and a two-second ending
 * frozen from the last body shot's real tail frame — so it lives here as
 * constants, and the operation that produces the delivery is the operation that
 * enforces it.
 *
 * `subtitles`, `prepare`, and `render` write; `verify` only reads. Everything that makes a
 * render impossible throws with a Chinese repair instruction. The delivered
 * file's own properties do not throw: `render` and `verify` report them as
 * checks, so one call tells the operator everything that needs fixing while
 * still handing back the file and its measurements.
 *
 * @module @deepseek-ai/dsh-tool-episode-render
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { createMediaToolkit } from './ffmpeg.ts'
import { buildEpisodeCues } from './cues.ts'
import type { BuiltCues } from './cues.ts'
import { episodeNumberOf, episodePaths } from './paths.ts'
import { prepareEpisode } from './prepare.ts'
import { buildReport, NO_MEDIA, NO_TAIL_FRAME, type ReportInput } from './report.ts'
import { renderEpisode } from './render.ts'
import type { DramaRenderMethod, DramaRenderReport, RenderCheck, RenderSettings } from './types.ts'
import { verifyEpisode } from './verify.ts'
import { registerDramaVideo } from './video.ts'

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

/** ASS font names must contain visible text and cannot inject fields or lines. */
const FONT_FAMILY_PATTERN = /^(?=[^,\r\n]*\S)[^,\r\n]+$/u

/**
 * Plugin config. Every field is a deployment-varying choice: where the media
 * binaries are, the two audio gains the operator approved, whether the GPU
 * encoder is probed, and the font directory and families. The delivery
 * specification itself — geometry, frame rate, bitrates, subtitle layout, ending
 * length — is not configurable.
 */
export interface Config {
  /** ffmpeg executable; defaults to `ffmpeg` from `PATH`. */
  ffmpegPath?: string
  /** ffprobe executable; defaults to `ffprobe` from `PATH`. */
  ffprobePath?: string
  /** Gain applied to the episode's own master audio; defaults to 1.45. */
  masterVolume?: number
  /** Gain applied to the BGM bed; defaults to 0.24. */
  bgmVolume?: number
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
  ffmpegPath: z.string().default(DEFAULT_FFMPEG),
  ffprobePath: z.string().default(DEFAULT_FFPROBE),
  masterVolume: z.number().min(0).max(8).default(DEFAULT_MASTER_VOLUME),
  bgmVolume: z.number().min(0).max(8).default(DEFAULT_BGM_VOLUME),
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
  /** Last body shot this render delivers; required by `render`. */
  lastShot?: number
  /** BGM bed; required by `render`. */
  bgm?: string
  /** Optional episode/segments music plan to report, not a listening verdict. */
  bgmPlan?: string
  /** Ending sound; required by `render`. */
  endingAudio?: string
  /** Ending effect video; required by `render`. */
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
  /** The last body shot this render delivers. */
  readonly lastShot: number
  /** Absolute path of the BGM bed. */
  readonly bgm: string
  /** Optional absolute path of the declared BGM plan. */
  readonly bgmPlan?: string
  /** Absolute path of the ending sound. */
  readonly endingAudio: string
  /** Absolute path of the ending effect video. */
  readonly endingEffect: string
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
type ResolvedCall = PrepareCall | RenderCall | VerifyCall | SubtitlesCall

/**
 * Resolve one call's configuration into the settings every method takes.
 * @param config - The validated plugin config.
 * @returns The binaries, gains, encoder preference, font directory and families.
 */
export function resolveSettings(config: Config = {}): RenderSettings {
  return {
    ffmpeg: config.ffmpegPath ?? DEFAULT_FFMPEG,
    ffprobe: config.ffprobePath ?? DEFAULT_FFPROBE,
    masterVolume: config.masterVolume ?? DEFAULT_MASTER_VOLUME,
    bgmVolume: config.bgmVolume ?? DEFAULT_BGM_VOLUME,
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
 * Each method's own requirements are checked before any file is opened, so a
 * missing argument is one readable message rather than a failed command later.
 * @param args - The dispatched arguments.
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
  if (args.method === 'prepare') {
    return {
      method: 'prepare',
      project,
      episode,
      shotsPath: resolve(required(args.shots, 'prepare', 'shots',
        '成片清单的路径，内容形如 {"shots":[{"shot":1,"video":"media/02/p1-clean.mp4"}]}。')),
      subtitleSrt: resolve(required(args.subtitleSrt, 'prepare', 'subtitleSrt',
        '本集 SRT 字幕的路径，prepare 会把它装到 editing/<集>.srt 供烧录。')),
    }
  }
  if (args.method === 'subtitles') {
    return {
      method: 'subtitles',
      project,
      episode,
      shotsPath: resolve(required(args.shots, 'subtitles', 'shots',
        '成片清单的路径，内容形如 {"shots":[{"shot":1,"video":"media/02/p1-clean.mp4"}]}。')),
      linesPath: resolve(required(args.lines, 'subtitles', 'lines',
        '台词计划的路径，内容形如 {"shots":[{"shot":1,"lines":["第一句","第二句"]}]}；'
        + '每镜的台词要在这里按字幕条切好。')),
      alignmentPath: resolve(required(args.alignment, 'subtitles', 'alignment',
        '语音识别对齐文档的路径，内容形如 {"shots":[{"shot":1,"cues":[{"text":"识别文本","start":0.0,"end":0.8}]}]}；'
        + '每镜的时间必须来自对该镜成片的识别，镜内相对秒数；字幕文字仍取 lines 里的剧本原文。')),
      subtitleSrt: resolve(args.subtitleSrt ?? paths.subtitle),
    }
  }
  if (args.method === 'render') {
    const lastShot = required(args.lastShot, 'render', 'lastShot',
      '本集最后一个镜头号，例如 9；时间线里 shot <= lastShot 的镜头数必须正好等于它。')
    if (!Number.isInteger(lastShot) || lastShot < 1) {
      throw new Error(`drama_render render 的 lastShot 必须是正整数镜头号，收到 ${JSON.stringify(lastShot)}。`)
    }
    return {
      method: 'render',
      project,
      episode,
      timelinePath: resolve(required(args.timeline, 'render', 'timeline',
        '时间线 JSON 的路径，通常是 prepare 写出的 editing/<集>-timeline.json。')),
      subtitleSrt: resolve(required(args.subtitleSrt, 'render', 'subtitleSrt',
        '本集 SRT 字幕的路径，通常是 prepare 装好的 editing/<集>.srt。')),
      lastShot,
      bgm: resolve(required(args.bgm, 'render', 'bgm', '本集实际使用的 BGM 文件路径。')),
      ...(args.bgmPlan === undefined ? {} : { bgmPlan: resolve(args.bgmPlan) }),
      endingAudio: resolve(required(args.endingAudio, 'render', 'endingAudio',
        '片尾音文件路径（技能的 assets/ending_audio.mp3）。')),
      endingEffect: resolve(required(args.endingEffect, 'render', 'endingEffect',
        '片尾特效文件路径（技能的 assets/ending_effect.mp4）。')),
      output: resolve(args.output ?? paths.output),
      force: args.force ?? false,
    }
  }
  return {
    method: 'verify',
    project,
    episode,
    timelinePath: resolve(required(args.timeline, 'verify', 'timeline',
      '被检查成片所依据的时间线 JSON 路径。')),
    subtitleSrt: resolve(required(args.subtitleSrt, 'verify', 'subtitleSrt',
      '被检查成片所烧录的 SRT 字幕路径。')),
    output: resolve(required(args.output, 'verify', 'output',
      '要检查的成片文件路径，例如 export/<剧名>_第02集_成片.mp4。')),
  }
}

/** The result of a `prepare` call that wrote nothing but its own layout. */
function prepareReport(call: PrepareCall, prepared: Awaited<ReturnType<typeof prepareEpisode>>): DramaRenderReport {
  const sources = new Map(prepared.shots.map(shot => [shot.source.shot, shot.video]))
  const reportInput: ReportInput = {
    method: 'prepare',
    project: call.project,
    episode: call.episode,
    timeline: prepared.timeline,
    sources,
    expectedDurationSeconds: prepared.timeline.bodyEndSeconds,
    written: prepared.written,
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
    warnings: prepared.warnings,
    logPath: '',
  }
  return buildReport(reportInput)
}

/**
 * The result of a `subtitles` call.
 *
 * The line-coverage and timing defects become failure checks so `ok` states
 * plainly whether every declared line found its alignment and whether the
 * written cues fit the episode. How accurate the recognizer's own times are is
 * not judged here, so `speech_alignment` stays in `not_checked`.
 * @param call - The resolved call.
 * @param built - What the cue build read and wrote.
 * @returns The canonical report.
 */
function subtitlesReport(call: SubtitlesCall, built: BuiltCues): DramaRenderReport {
  const sources = new Map(built.shots.map(shot => [shot.source.shot, shot.video]))
  const checks: RenderCheck[] = built.failures.map(failure => ({
    id: failure.id,
    severity: 'failure',
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
    expectedDurationSeconds: built.timeline.bodyEndSeconds,
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
  if (call.method === 'prepare') {
    return prepareReport(call, await prepareEpisode({
      toolkit,
      project: call.project,
      episode: call.episode,
      shotsPath: call.shotsPath,
      subtitleSrt: call.subtitleSrt,
    }))
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
      lastShot: call.lastShot,
      bgm: call.bgm,
      ...(call.bgmPlan === undefined ? {} : { bgmPlan: call.bgmPlan }),
      endingAudio: call.endingAudio,
      endingEffect: call.endingEffect,
      output: call.output,
      force: call.force,
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

/** Model-facing result schema: every field of the canonical report, all of them always present. */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    method: { type: 'string', required: true, enum: ['prepare', 'render', 'verify', 'subtitles'],
      description: '产生本结果的操作。' },
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
      description: '正片结束 + 片尾 2 秒，成片必须达到的时长。' },
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
              + 'black_frames、fade_to_black、silence、long_pauses、subtitle_bounds、subtitle_present。' },
          severity: { type: 'string', required: true, enum: ['failure', 'warning'], description: CHECK_SHAPE },
          ok: { type: 'boolean', required: true, description: '该检查是否通过。' },
          detail: { type: 'string', required: true, description: '判定所依据的实测值。' },
          fix: { type: 'string', required: true, description: '中文修法；通过时为空串。' },
        },
      } },
    bgm_plan: { type: 'object', required: true, additionalProperties: false,
      description: '声明的配乐段落和同序曲目复用提醒；不是试听结论。未提供计划时为空值。',
      properties: {
        path: { type: 'string', required: true },
        bed_sha256: { type: 'string', required: true },
        repeated_sequence_episodes: { type: 'array', required: true, items: { type: 'string' } },
        segments: { type: 'array', required: true, items: {
          type: 'object', additionalProperties: false, properties: {
            track: { type: 'string', required: true }, source: { type: 'string', required: true },
            start_seconds: { type: 'number', required: true }, end_seconds: { type: 'number', required: true },
            reason: { type: 'string', required: true },
          },
        } },
      } },
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

/** What the model reads before calling: the four methods, the fixed style, and the two known traps. */
const DESCRIPTION = '短剧整集渲染编排（剧变流水线）。'
  + 'subtitles=按语音识别对齐写出 SRT：对齐文档（alignment）给出每一镜每一句的说话时间，'
  + '字幕文字只取 lines 里的剧本原文，cue 时间 = 该镜在时间线上的起点 + 镜内偏移。'
  + '**本工具不做识别、不测能量、不估算时间**：能量门限分不出具体哪句在哪里，'
  + '估算出来的时间正是字幕压在错句上的原因。'
  + '缺某一镜的对齐、段数与台词条数不符、识别文本与剧本对不上，都按 failure 报出（subtitle_line_coverage），'
  + '并指出该对哪一镜重跑识别；有识别结果却没声明台词，同样报 failure。'
  + '写出的每条字幕还会检查时长、重叠、越界与阅读速度（超过 20 字/秒按 failure，超过 12 字/秒按 warning）。'
  + '对齐时间本身的准确度不由本工具判断，识别模型与语言选择由调用方负责。'
  + 'prepare=按成片清单构建渲染输入：把每镜成片复制到 video/<集>/shot_00N.mp4，'
  + '按 ffprobe 实测时长铺时间线（editing/<集>-timeline.json），把每镜自己的声音按各自起点拼成整集原声 master'
  + '（audio/<集>.wav，48kHz 无损、不加增益、不逐镜重采样），并安装 SRT 到 editing/<集>.srt；不编码画面。'
  + 'render=出片：逐镜编码到交付规格 1440x2560@60、24M 目标码率 / 30M 上限 / 48M 缓冲、H.264 high@5.1，'
  + '片尾用最后一镜的真实尾帧定格 2 秒并叠 ending_effect，拼接后烧录 ASS 字幕'
  + '（默认 SimHei 68，字体服从部署配置；字间距 -2、7px 黑描边、底部居中，右下角唯一的「内容由AI生成」标记），'
  + '再把整集原声（增益 1.45）+ BGM（增益 0.24，到正片结束）+ 片尾音 amix 后 alimiter=0.95，'
  + 'AAC 192k/48kHz、+faststart 输出，并回读实测分辨率/帧率/码率/时长/大小/编码器。'
  + 'GPU 编码先探测 h264_nvenc（用 256x256 探针，太小会被 NVENC 拒绝），失败就按设计回退 libx264，'
  + '回退原因写进 encoder_fallback_reason 与渲染日志。'
  + 'verify=渲染后检查：总时长、音视频流、总码率下限 4.6 Mbps、黑帧、静音、字幕 cue 是否越界，逐项给实测值与中文修法。'
  + '抽尾帧固定用 -sseof -0.1：-sseof -0.05 在部分片子上不写文件却返回 0，'
  + '所以每次都用 framemd5 与顺序解码的最后一帧比对，证明抽到的是真实尾帧，比对不上就改用顺序解码取帧。'
  + '只有让渲染无法进行的问题（缺参数、缺文件、命令失败、尾帧无法证明）才会报错；'
  + '成片本身的问题按 checks 返回，ok=false 并在 failures 里给出中文修法，成片与实测参数照常返回。'

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
      method: { type: 'string', required: true, enum: ['prepare', 'render', 'verify', 'subtitles'],
        description: 'prepare=构建渲染输入（不编码）；render=出片并回读实测参数；verify=渲染后检查；'
          + 'subtitles=按语音识别对齐文档给台词定时并写出 SRT（不编码、不做识别）。' },
      project: { type: 'string', required: true,
        description: '项目根目录（含 video/、audio/、editing/、exports/）；四个方法都必填。' },
      episode: { type: 'integer', required: true, description: '集号（正整数，如 2）；写入时补成两位，如 02。' },
      shots: { type: 'string',
        description: '成片清单 JSON 路径，形如 {"shots":[{"shot":1,"video":"media/02/p1-clean.mp4","audio":"可选"}]}；'
          + 'prepare 与 subtitles 必填。video 缺音轨时必须给 audio。' },
      lines: { type: 'string',
        description: '台词计划 JSON 路径，形如 {"shots":[{"shot":1,"lines":["第一句","第二句"]}]}；subtitles 必填。'
          + '每镜的台词在这里就按字幕条切好（单条不超过 14 个字），工具只给时间，不改文字。' },
      alignment: { type: 'string',
        description: '语音识别对齐文档 JSON 路径，subtitles 必填，形如'
          + ' {"shots":[{"shot":1,"cues":[{"text":"识别文本","start":0.0,"end":0.8}]}]}（镜内、相对该镜起点，秒）。'
          + '只取它的时间：字幕文字仍来自 lines，识别文本仅用于核对是不是同一段表演。'
          + '缺某一镜、段数与台词条数不符、或文本对不上，都会按 failure 报出。' },
      timeline: { type: 'string',
        description: '时间线 JSON 路径；render 与 verify 必填，通常是 prepare 写出的 editing/<集>-timeline.json。' },
      subtitle_srt: { type: 'string',
        description: '本集 SRT 字幕路径；subtitles 写出它（省略时写 editing/<集>.srt），'
          + 'prepare 装到 editing/<集>.srt，render 烧录它，verify 检查它的 cue 是否越界。' },
      last_shot: { type: 'integer',
        description: '本次交付的最后一个镜头号（如 9）；render 必填，时间线里 shot <= last_shot 的镜头数必须正好等于它。' },
      bgm: { type: 'string', description: '本集实际使用的 BGM 文件路径；render 必填，会循环铺到正片结束。' },
      bgm_plan: { type: 'string', description: 'render 可选：现有 episodes/segments 配乐计划 JSON；校验时间、记录曲目与复用提醒，不代替试听。' },
      ending_audio: { type: 'string', description: '片尾音文件路径；render 必填。' },
      ending_effect: { type: 'string', description: '片尾特效视频路径；render 必填。' },
      output: { type: 'string',
        description: '成片输出路径；render 省略时写 exports/<集>.mp4，verify 必填（要检查哪个文件）。' },
      force: { type: 'boolean',
        description: 'render 是否忽略 exports/.render_cache 里的逐镜缓存并全部重编；默认 false。' },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async ({ subtitle_srt, last_shot, ending_audio, ending_effect, bgm_plan, ...args }) => await runDramaRender({
      ...args,
      ...(subtitle_srt === undefined ? {} : { subtitleSrt: subtitle_srt }),
      ...(bgm_plan === undefined ? {} : { bgmPlan: bgm_plan }),
      ...(last_shot === undefined ? {} : { lastShot: last_shot }),
      ...(ending_audio === undefined ? {} : { endingAudio: ending_audio }),
      ...(ending_effect === undefined ? {} : { endingEffect: ending_effect }),
    }, settings),
  }))
}
