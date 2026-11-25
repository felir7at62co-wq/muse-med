/** Model tool that builds per-episode subtitles from measured speech, corrected toward the locked script. */
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type {} from '@deepseek-ai/dsh-jingliu-connection'
import type { MuseAccountService } from '@deepseek-ai/dsh-muse-account'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolvePrimaryRuntime } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import Schema from '@deepseek-ai/schemastery'
import { bundledRulesDirectory, pythonRules } from './rules.ts'
import { runEpisodeSubtitles, type EpisodeSubtitlesSettings } from './tool.ts'

/** Cordis row name. */
export const name = 'tool-episode-subtitles'

/**
 * The account supplies the cloud transcription cookie; the subprocess provider owns the rules process; the system prompt
 * carries the three-call delivery rule. The optional `jingliuConnection` is read per call, and without it Jingliu
 * episodes are `jingliu_outdated`.
 */
export const inject = ['tools', 'museAccount', 'subprocess', 'systemPrompt']

/** Deployment settings; Desktop passes its bundled runtime and media executables. Omitted limits take the schema defaults. */
export interface Config extends Partial<EpisodeSubtitlesSettings> {
  /** Bundled primary runtime directory, used to find the Python that ships `pypinyin`. */
  readonly source?: string
  /** Explicit interpreter with `pypinyin==0.55.0`; overrides `source`. */
  readonly pythonPath?: string
  /** Effective characters per cue; a space counts as `spaceWidth`. */
  readonly maxChars?: number
  /** Width of a space relative to one character when counting cue length. */
  readonly spaceWidth?: number
  /** Effective characters per cue of a Jingliu project's preview, equal to the width Jingliu lays its cues out with. */
  readonly jingliuMaxChars?: number
  /** Deadline of one rules process, in milliseconds. */
  readonly rulesTimeoutMs?: number
  /** Termination grace of the rules process, in milliseconds. */
  readonly graceMs?: number
  /** Largest rules result, in bytes. */
  readonly maxRulesOutputBytes?: number
}

/** Settings after defaults. */
type ResolvedConfig = Config & EpisodeSubtitlesSettings
  & Required<Pick<Config, 'maxChars' | 'spaceWidth' | 'jingliuMaxChars' | 'rulesTimeoutMs' | 'graceMs' | 'maxRulesOutputBytes'>>

/** Validated settings; `source` or `pythonPath` is required. */
export const Config: Schema<Config, ResolvedConfig> = Schema.object({
  source: Schema.string().min(1), pythonPath: Schema.string().min(1),
  ffmpegPath: Schema.string().default('ffmpeg'), ffprobePath: Schema.string().default('ffprobe'),
  packSeconds: Schema.number().min(10).max(600).default(600),
  gapSeconds: Schema.number().min(0).max(5).default(0.8),
  maxChars: Schema.number().min(4).max(40).default(14),
  jingliuMaxChars: Schema.number().min(4).max(40).default(20),
  spaceWidth: Schema.number().min(0).max(1).default(0.5),
  maxEpisodes: Schema.number().step(1).min(1).max(100).default(100),
  reviewPageSize: Schema.number().step(1).min(1).max(100).default(20),
  commandTimeoutMs: Schema.number().step(1).min(1_000).max(3_600_000).default(600_000),
  maxDurationSeconds: Schema.number().step(1).min(1).max(18_000).default(18_000),
  maxAudioBytes: Schema.number().step(1).min(1).max(536_870_912).default(100_000_000),
  pollIntervalMs: Schema.number().step(1).min(1000).max(30_000).default(2000),
  uploadRetryBudgetMs: Schema.number().step(1).min(0).max(600_000).default(120_000),
  maxBatchInputs: Schema.number().step(1).min(1).max(100).default(10),
  lockWaitMs: Schema.number().step(1).min(1000).max(3_600_000).default(300_000),
  jingliuJobWaitMs: Schema.number().step(1).min(0).max(600_000).default(60_000),
  rulesTimeoutMs: Schema.number().step(1).min(1000).max(3_600_000).default(300_000),
  graceMs: Schema.number().step(1).min(1).max(60_000).default(1000),
  maxRulesOutputBytes: Schema.number().step(1).min(65_536).max(268_435_456).default(33_554_432),
})

const DESCRIPTION = '按集生成字幕：读取锁定分镜与选定镜头，实测时长，按音频摘要复用或提交云转写，用剧本纠正识别文字，按字词时间排条，写 SRT、时钟回执与待核清单。参数相同重复调用即可续做；只重做变化的镜头。不要自己写台词、对齐或时间。手做的 SRT 会移到 NN.srt.manual-<时间> 并在 manual_srt_kept 报出。结果带 ask 时（镜流旧字幕来源不明）把 question 原样问用户，按用户的回答调 keep 或 remake 给出的调用，不要替用户选。用户消息里的 json 代码块给出 source、project、episodes 时，照原样传入。'

/**
 * Register `episode_subtitles`.
 * @param ctx - Host context with tools, the Muse account and the subprocess provider.
 * @param input - Runtime location, media executables and limits.
 */
export function apply(ctx: Context, input: Config): void {
  const config = Config(input)
  const account = ctx.get('museAccount') as MuseAccountService
  const { pythonPath, source } = config
  const python = pythonPath !== undefined ? () => Promise.resolve(pythonPath)
    : source === undefined ? undefined
      : async () => process.platform === 'win32' ? join(dirname(source), 'media', 'python', 'python.exe')
        : (await resolvePrimaryRuntime(source)).python
  if (python === undefined) throw new Error('tool-episode-subtitles needs source (bundled runtime) or pythonPath')
  const rulesOf = (maxChars: number) => pythonRules({ subprocess: ctx.subprocess,
    directory: bundledRulesDirectory(),
    maxChars, spaceWidth: config.spaceWidth, timeoutMs: config.rulesTimeoutMs, graceMs: config.graceMs,
    maxOutputBytes: config.maxRulesOutputBytes, python })
  const rules = rulesOf(config.maxChars), jingliuRules = rulesOf(config.jingliuMaxChars)
  // Carried in the prompt so a preset that keeps few task skills still follows the delivery order after compaction.
  ctx.systemPrompt.section({ name: 'tool:episode_subtitles', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    interpolate: false, text: `## 分集字幕与剪映草稿

按集出字幕和剪映草稿只用三步：
1. episode_subtitles build；status 为 waiting 时用相同参数再调。
2. 有 needs_review 时调 episode_subtitles review，用 show_view 把待核处给用户看，把用户的选择作为 decisions 传回。
3. jianying_draft。refused 为 subtitles_stale、subtitles_missing，或本机项目的 subtitles_unverified 时回到第 1 步。

两个工具的结果带 ask（镜流里有来源不明的旧字幕，可能是用户手加的）时，把 question 问用户，按回答调 keep 或 remake 给出的调用；replace_legacy 与 keep_legacy_subtitles 只按用户的回答传。

镜头重新生成、换版本或修剪后从第 1 步重跑，不手改偏移，不运行 align_subtitles.py。` })
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'episode_subtitles',
    description: DESCRIPTION,
    parameters: {
      method: { type: 'string', enum: ['build', 'review'], description: 'build=生成或续做（默认）；review=分页列出待核处，或带 decisions 应用选择并重排，不新转写。' },
      source: { type: 'string', required: true, enum: ['local', 'jingliu'], description: 'local=本机项目；jingliu=镜流项目。' },
      project: { type: 'string', required: true, description: 'local：项目根目录（相对路径以工作区为基准）；jingliu：项目 ID。' },
      episodes: { type: 'array', required: true, items: { type: 'integer' }, description: `集号，1–${String(config.maxEpisodes)} 个，不重复。` },
      wait_seconds: { type: 'number', description: 'build：在本次调用内等待云转写的秒数，0–30，默认 0。' },
      decisions: { type: 'array', description: 'review：用户对待核处的选择；id 取自 review 返回的 items。', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        action: { type: 'string', required: true, enum: ['heard', 'script', 'drop'], description: 'heard=按听到的；script=按剧本；drop=删去这几个字。' },
      } } },
      offset: { type: 'integer', description: `review 分页起点，每页 ${String(config.reviewPageSize)} 条；用返回的 next_offset。` },
      replace_legacy: { type: 'boolean', description: 'build、jingliu：把来源不明的旧字幕存档后删掉、按声音重做。只在用户对 ask 选了重做时传 true。' },
    },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async (args, exec) => await runEpisodeSubtitles(args, config, { account, rules, jingliuRules,
      cwd: exec.agent?.session.header.cwd,
      jingliu: async (project) => {
        const connection = ctx.get('jingliuConnection')
        if (connection === undefined) return undefined
        const session = await connection.connection()
        const selected = exec.agent === undefined ? null : await connection.selected(exec.agent.session.id, session.identity)
        if (selected !== null && selected.id !== project) throw new HarnessError('这个操作指向另一个云项目，请先确认要切换的项目。', 'JINGLIU_INVALID_PROJECT')
        return session
      } }, exec.signal),
  })))
}
