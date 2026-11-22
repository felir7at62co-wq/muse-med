/** Generate editable Jianying drafts with the selected bundled, managed backend. */
import { access, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { draftDirectory } from '@deepseek-ai/dsh-drama-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-jingliu-connection'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import { resolvePrimaryRuntime } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import type { default as SubprocessRuntime, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { defaultNamePrefix, runDraftBatch, runJingliuDraftBatch } from './jianying-batch.ts'

/** Deployment-owned interpreter, process limits and bundled resource location. */
export interface Config {
  /** Resolved FFmpeg executable forwarded to the managed Python generator. */
  readonly ffmpegPath?: string
  /** Resolved ffprobe executable forwarded to the managed Python generator. */
  readonly ffprobePath?: string
  /** Final BGM track gain ceiling; defaults to 8, while Muse office composition selects 1. */
  readonly maxBgmGain?: number
  /** Bundled font directory, independent of fonts installed in the operating system. */
  readonly fontsDir?: string
  /** Product subtitle family supplied to both rendering and editable-draft backends. */
  readonly subtitleFontFamily?: string
  readonly source: string
  readonly pythonPath?: string
  readonly windowsPowerShellPath?: string
  readonly windowsCliPath?: string
  readonly windowsHostPath?: string
  readonly windowsLandscapeSubtitleSize?: number
  readonly windowsLandscapeSubtitleY?: number
  /** Product-only policy; the editor adapter uses UI units, not FFmpeg pixels. */
  readonly enforceSubtitleVisual?: boolean
  readonly defaultSubtitleVisual?: {
    readonly schema_version: 1
    readonly reference_width: number
    readonly reference_height: number
    readonly font_size_px: number
    readonly outline_px: number
    readonly center_y_ratio: number
    readonly max_width_ratio: number
    readonly font_family?: string
  } | undefined
  readonly timeoutMs: number
  readonly graceMs: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  /** Episodes one batch call generates; the rest are returned as `not_started`. */
  readonly maxEpisodesPerCall?: number
}

/** Reject invalid process limits before the draft tool is registered. */
export const Config: z<Config> = z.object({
  ffmpegPath: z.string().min(1), ffprobePath: z.string().min(1),
  maxBgmGain: z.number().min(0).max(8).default(8),
  fontsDir: z.string().min(1), subtitleFontFamily: z.string().min(1).max(128),
  source: z.string().min(1).required(), pythonPath: z.string().min(1),
  windowsPowerShellPath: z.string().min(1), windowsCliPath: z.string().min(1), windowsHostPath: z.string().min(1),
  windowsLandscapeSubtitleSize: z.number().min(0.01).max(100),
  windowsLandscapeSubtitleY: z.number().min(-16384).max(16384),
  enforceSubtitleVisual: z.boolean().default(false),
  defaultSubtitleVisual: z.union([z.const(undefined), z.object({
    schema_version: z.const(1).required(), reference_width: z.number().min(1).max(16384).required(),
    reference_height: z.number().min(1).max(16384).required(), font_size_px: z.number().min(0.001).max(16384).required(),
    outline_px: z.number().min(0).max(100).required(), center_y_ratio: z.number().min(0).max(1).required(),
    max_width_ratio: z.number().min(0.001).max(1).required(), font_family: z.string().min(1).max(128),
  })]),
  timeoutMs: z.number().step(1).min(1).required(), graceMs: z.number().step(1).min(0).required(),
  maxInputBytes: z.number().step(1).min(1).required(), maxOutputBytes: z.number().step(1).min(1).required(),
  maxEpisodesPerCall: z.number().step(1).min(1).max(100).default(10),
})

/** Prefix of the reminder `generateJianyingDraft` adds when the request has no usable BGM. */
const MUSIC_REMINDER = '剪映配乐待完成'

/** One episode request file and the existing editor root returned by drama_draft_dir. */
export interface DraftInput {
  readonly request_file: string
  readonly drafts_dir: string
}

/** Resolved generator identity for an explicit audio source on the current platform. */
export interface DraftBackend {
  readonly script: 'generate_draft_request.py' | 'windows_aa_draft.py'
  readonly library: 'pyJianYingDraft' | 'aa-jianying'
}

/**
 * Select the Windows source-audio implementation without changing legacy independent-audio requests.
 * @param audioMode - Requested audio source, resolved from the episode request.
 * @param platform - Operating system running the Desktop Host.
 * @returns Generator filename and expected result identity.
 * @throws When embedded source audio is requested on a platform without that implementation.
 */
export function resolveJianyingDraftBackend(audioMode: 'embedded' | 'independent', platform: NodeJS.Platform): DraftBackend {
  if (audioMode === 'independent') return { script: 'generate_draft_request.py', library: 'pyJianYingDraft' }
  if (platform !== 'win32') throw new Error('Embedded source audio in Jianying drafts is currently supported on Windows only')
  return { script: 'windows_aa_draft.py', library: 'aa-jianying' }
}

/** Resolve source-audio mode and missing-music feedback without treating an old mix profile as a current decision. */
function resolveDraftRequest(bytes: Buffer): { audioMode: 'embedded' | 'independent'; musicReminder?: string } {
  const request: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''))
  if (typeof request !== 'object' || request === null || Array.isArray(request)) throw new Error('Draft request must be a JSON object')
  const audioMode = !('audio_mode' in request) || request.audio_mode === 'independent' ? 'independent'
    : request.audio_mode === 'embedded' ? 'embedded' : undefined
  if (audioMode === undefined) throw new Error('audio_mode must be embedded or independent')
  const sourceProvided = 'bgm' in request && typeof request.bgm === 'string' && request.bgm.trim() !== ''
  if ('music_decision' in request && request.music_decision !== 'music' && request.music_decision !== 'none') {
    throw new Error('music_decision must be music or none')
  }
  if ('music_decision' in request && request.music_decision === 'none' && sourceProvided) {
    throw new Error('music_decision=none conflicts with a supplied bgm; use the actual music decision')
  }
  if ('music_decision' in request && request.music_decision === 'none'
    && 'decision_reason' in request && typeof request.decision_reason === 'string' && request.decision_reason.trim()) {
    return { audioMode }
  }
  if (sourceProvided && (!('bgm_role' in request) || request.bgm_role !== 'dialogue_music_mix')) return { audioMode }
  return { audioMode, musicReminder: `${MUSIC_REMINDER}：本次未提供可导入的独立纯音乐 BGM。`
    + '请按剧本、对白与采用画面用 bgm_match 选曲，drama_bgm 合成并核验纯音乐底轨，'
    + '将输出绝对路径写入 bgm、bgm_role=music_only 后另存新草稿，并回读实际 BGM 轨道和音量。'
    + '只生成音乐底轨即可，不必先渲染整集 MP4；片尾音不算正文 BGM。'
    + '用户明确不要配乐或剧情确需留白时，写 music_decision=none 与 decision_reason；'
    + '旧 audio-mix.json 的 no_bgm 不自动代表本次要求。草稿候选保留，不能宣称配乐完成。' }
}

const DraftResult = z.object({
  success: z.boolean().required(),
  drafts_created: z.number().step(1).min(0).required(),
  drafts: z.array(z.object({
    episode: z.string().required(), name: z.string().required(), path: z.string().required(),
    id: z.string().required(), success: z.boolean().required(), error: z.string().required(),
    quality: z.string(), warnings: z.array(z.string()).default([]), review_path: z.string(),
    saved: z.boolean(),
    subtitle_font: z.union([z.const(undefined), z.object({
      requested: z.union([z.string(), z.const(null)]),
      required: z.boolean().required(), status: z.string().required(),
      delivery_ready: z.boolean().required(), binding_verified: z.boolean().required(),
    })]),
  })).required(),
  materials_dir: z.string(),
  quality: z.string(),
  warnings: z.array(z.string()).default([]),
  library: z.object({ name: z.string().required(), version: z.string().required() }).required(),
  editor_open_verified: z.boolean().required(),
  error: z.string(),
})

/**
 * Build one episode with its selected backend and verify the reported saved-project identity.
 * @param subprocess - Managed process provider owning cancellation and teardown.
 * @param input - Bounded episode JSON file and saved editor root.
 * @param config - Bundled runtime and deployment limits.
 * @param signal - Calling tool cancellation.
 * @returns Saved draft paths and library identity; editor compatibility remains unverified.
 */
export async function generateJianyingDraft(subprocess: SubprocessRuntime, input: DraftInput,
  config: Config, signal?: AbortSignal) {
  if (!isAbsolute(input.request_file) || !isAbsolute(input.drafts_dir)
    || !(await stat(input.drafts_dir)).isDirectory()) throw new Error('Use an absolute request file and existing editor draft root')
  const requestStat = await stat(input.request_file)
  if (!requestStat.isFile() || requestStat.size > config.maxInputBytes) throw new Error('Draft request must be a regular file within the input limit')
  const requestBytes = await readFile(input.request_file)
  if (requestBytes.byteLength > config.maxInputBytes) throw new Error('Draft request exceeds the input limit')
  const request = resolveDraftRequest(requestBytes)
  const backend = resolveJianyingDraftBackend(request.audioMode, process.platform)
  const python = config.pythonPath ?? (process.platform === 'win32'
    ? join(dirname(config.source), 'media', 'python', 'python.exe')
    : (await resolvePrimaryRuntime(config.source)).python)
  await access(python)
  const manifest = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-drama-skills/package.json'))
    .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
  const script = join(dirname(manifest), 'skills', 'tweet-drama-draft-build', 'scripts', backend.script)
  const env: Record<string, string | undefined> = { PYTHONUTF8: '1', DSH_BGM_MAX_GAIN: String(config.maxBgmGain ?? 8) }
  if (config.fontsDir !== undefined) env.MUSE_FONTS_DIR = config.fontsDir
  if (config.subtitleFontFamily !== undefined) env.MUSE_SUBTITLE_FONT_FAMILY = config.subtitleFontFamily
  if (config.enforceSubtitleVisual) {
    if (config.defaultSubtitleVisual === undefined) throw new Error('Forced subtitle visual requires the product visual configuration')
    env.MUSE_FORCE_SUBTITLE_VISUAL = '1'
    env.MUSE_DEFAULT_SUBTITLE_VISUAL = JSON.stringify(config.defaultSubtitleVisual)
  }
  if (config.ffmpegPath !== undefined) env.DSH_FFMPEG_PATH = config.ffmpegPath
  if (config.ffprobePath !== undefined) env.DSH_FFPROBE_PATH = config.ffprobePath
  if (backend.library === 'aa-jianying') {
    if (config.windowsPowerShellPath !== undefined) env.MUSE_JIANYING_POWERSHELL = config.windowsPowerShellPath
    if (config.windowsCliPath !== undefined) env.JY_CLI = config.windowsCliPath
    if (config.windowsHostPath !== undefined) env.JY_HOST = config.windowsHostPath
    if (config.windowsLandscapeSubtitleSize !== undefined) {
      env.MUSE_JIANYING_LANDSCAPE_SUBTITLE_SIZE = String(config.windowsLandscapeSubtitleSize)
    }
    if (config.windowsLandscapeSubtitleY !== undefined) env.MUSE_JIANYING_LANDSCAPE_SUBTITLE_Y = String(config.windowsLandscapeSubtitleY)
    const media = join(dirname(config.source), 'media', 'ffmpeg', 'bin')
    env.FFMPEG_BINARY = config.ffmpegPath ?? process.env.DSH_FFMPEG_PATH ?? join(media, 'ffmpeg.exe')
    env.FFPROBE_BINARY = config.ffprobePath ?? process.env.DSH_FFPROBE_PATH ?? join(media, 'ffprobe.exe')
    env.MUSE_JIANYING_TIMEOUT_SECONDS = String(config.timeoutMs / 1000)
  }
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const handle = subprocess.spawn({
    argv: [python, '-B', script, input.request_file, input.drafts_dir, String(config.maxInputBytes)],
    cwd: dirname(input.request_file), env, signal: combined, graceMs: config.graceMs,
    stdio: { stdin: 'ignore', stdout: { maxBytes: config.maxOutputBytes }, stderr: { maxBytes: config.maxOutputBytes } },
  })
  let outcome: SubprocessOutcome
  try { outcome = await handle.done } finally { await handle.waitForExit() }
  combined.throwIfAborted()
  const stdout = handle.collected.stdout?.readFrom(0)
  if (stdout === undefined || stdout.lossy) throw new Error('Draft generator output is missing or exceeds the output limit')
  if (!stdout.text.trim()) {
    const stderr = handle.collected.stderr?.readFrom(0).text.trim()
    throw new Error(`Draft generator returned no JSON (exit ${outcome.exitCode}): ${stderr || 'no diagnostic output'}`)
  }
  const value: unknown = JSON.parse(stdout.text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Draft generator returned an invalid JSON object')
  const row = value as Record<string, unknown>
  const summary = z.object({ success: z.boolean().required(), error: z.string().default('process did not complete successfully') })(row)
  if (outcome.exitCode !== 0 || outcome.signal || !summary.success) {
    throw new Error(`Jianying draft generation failed: ${summary.error}`)
  }
  const result = DraftResult(row)
  if (result.drafts.some(draft => config.enforceSubtitleVisual && draft.subtitle_font === undefined
    || draft.subtitle_font?.required && !draft.subtitle_font.delivery_ready)) {
    throw new Error('Draft subtitle font was not verified; saved candidates cannot be delivered with a fallback font')
  }
  if (result.drafts_created < 1 || result.drafts_created !== result.drafts.length || result.drafts.some(draft => !draft.success)
    || result.editor_open_verified || result.library.name !== backend.library
    || (backend.library === 'aa-jianying' && row.backend !== 'aa-jianying')) {
    throw new Error('Draft generator returned inconsistent saved-draft results')
  }
  if (request.musicReminder !== undefined) {
    result.warnings = [...new Set([...result.warnings, request.musicReminder])]
    result.quality = 'needs_review'
    for (const draft of result.drafts) {
      draft.warnings = [...new Set([...draft.warnings, request.musicReminder])]
      draft.quality = 'needs_review'
    }
  }
  return result
}

/** Model-facing description: the batch call first, then the single-episode request file mode. */
const DESCRIPTION = '生成可编辑剪映草稿。批量：传 source、project、episodes，可带 switches 与 name_prefix；用户消息里的 json 代码块给出 source、project、episodes、switches 时，照原样传入；工具读取 episode_subtitles 写出的字幕时钟回执，镜头时长、画面或声音变化时该集列入 refused（subtitles_stale 与 changed_shots），先重跑 episode_subtitles，不手改偏移；然后准备素材、逐集生成，已生成且输入未变的集返回 existing，输入变化时另存唯一名称的新候选。配乐取 editing/NN-bgm.wav（先用 bgm_match 选曲、drama_bgm 合成纯音乐底轨），缺配乐的集列入 music_missing。'
  + '单集模式：write JSON 请求文件，包含 project、episode、name_prefix、按镜头顺序的 videos、subtitle_srt、timeline；Windows 保留原视频声音时写 audio_mode=embedded 并省略 audio，使用 aa剪映后端。未声明模式或 audio_mode=independent 时仍用 pyJianYingDraft 并要求 audio 为未混 BGM 的完整主音轨；Mac 暂不支持 embedded。bgm 绝对路径配 bgm_role=music_only；确实不加配乐时写 music_decision=none、decision_reason。可选 ending_audio、ending_effect，以及 ending、watermark 布尔开关（false 去掉片尾或 AI 标识），所有文件用绝对路径。字幕须带同源时钟回执；人工字幕写 subtitle_source=manual。含对白的审查混音不能当配乐重复叠加。只处理指定集，不覆盖已有草稿；质量疑点返回 warnings 与 review_path 供核对。返回草稿路径与实际实现身份；editor_open_verified=false 表示尚未在剪映打开验收。'

/** Loader identity for Desktop's single draft-building entry point. */
export const name = 'desktop-jianying-draft'
/** The tool registry, managed process owner and current tool guidance. */
export const inject = ['tools', 'subprocess', 'systemPrompt']

/**
 * Register draft generation through bundled Python and the platform's selected adapter.
 * @param ctx - Desktop profile with bundled creative resources.
 * @param config - Runtime location and process limits.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.systemPrompt.section({ name: 'tool:jianying_draft',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), interpolate: false,
    text: `## 剪映草稿：当前原生入口

当前实例提供 jianying_draft。历史会话续做、升级后恢复或首次生成草稿时，重新读取当前 tweet-drama-draft-build 技能，以当前工具及技能为准，不以历史成功记录代替。用 drama_draft_dir 取得根目录，write 单集 JSON 请求，再调用 jianying_draft（也可经 run_code 调用 tools.jianying_draft）。不要沿用历史记录中的绝对开发路径、.desktop-build、sys.path 或 DraftGenerator 脚本来生成草稿。原生工具失败时核查本次实际错误与当前打包资源，不静默退回旧脚本或另装依赖绕过。

生成剪映文件时，先完成本集 BGM 并一起导入：重新读取 tweet-drama-background-render 的 references/story-bgm-selection.md，根据真实剧本、对白、剧情发展和采用画面用 bgm_match 选曲，drama_bgm 合成并核验纯音乐底轨，把输出绝对路径写入请求 bgm、bgm_role="music_only"，再调用 jianying_draft。生成纯音乐底轨不要求先渲染整集 MP4；保留视频原声。剧情不需换曲可沿用一首，相邻两集尽量不重复，源音乐至少衰减 10 dB，已衰减底轨导入增益不大于 1。回读实际 BGM 轨道、覆盖时间和音量，片尾音不算正文 BGM。旧 no_bgm 配置不是当前用户明确不要配乐；确实不加配乐时在请求写 music_decision="none" 和 decision_reason。缺配乐时保留候选并处理返回的提醒，不把草稿创建成功当作配乐完成，也不新增用户审批。

Windows 保留原视频声音时，请求写 audio_mode="embedded"，省略 audio；由 aa剪映后端直接保留视频声音，BGM 独立；仅 9:16 在整集末尾追加片尾，16:9 不加。未声明模式的旧请求仍走独立主音轨：成功导入后才静音正文源视频，导入失败保留原声并说明缺口。Mac 暂不支持 embedded，不改用独立音轨冒称满足。独立 BGM 必须是纯音乐，不能叠加含对白的审查混音。已有草稿不会自动迁移；修复旧稿时生成唯一名称的新候选，不覆盖原稿。以上为 Agent 操作指导，不新增用户审批，不把保存成功写成剪映打开、播放或听感已验收。

恢复时不强删锁、不移动活动素材目录、不手改 root_meta_info.json；同名并发需等本次实际退出，或另用唯一新名生成候选。Windows 原声生成期间保护活动目录和已保留素材；身份或源时窗明确不符则失败并保留文件，无法读取则保持未验证且不出交付凭据。保存检查不替代剪映裁剪、保存、关闭重开验收，不自动修复旧稿。` })
  const manifest = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-drama-skills/package.json'))
    .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
  const skillsDir = join(dirname(manifest), 'skills')
  const draftsRoot = async (given: string | undefined, cwd: string): Promise<string> => {
    if (given !== undefined) return resolve(cwd, given)
    const settings = ctx.get('settings')
    const saved = settings === undefined ? undefined : await draftDirectory(settings)
    if (saved?.status !== 'ready') throw new ToolArgsError(['剪映草稿根目录尚未设置：先调用 drama_draft_dir 取得或设置根目录，或传 drafts_dir。'])
    return saved.path
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'jianying_draft',
    description: DESCRIPTION,
    parameters: {
      source: { type: 'string', enum: ['local', 'jingliu'], description: '批量模式：local=本机项目；jingliu=镜流项目。' },
      project: { type: 'string', description: '批量模式：本机项目根目录（相对路径以工作区为基准）或镜流项目 ID。' },
      episodes: { type: 'array', items: { type: 'integer' }, description: `批量模式集号，与 request_file 二选一；每次最多生成 ${String(config.maxEpisodesPerCall ?? 10)} 集，其余列入 not_started。` },
      switches: { type: 'object', additionalProperties: false, description: '批量模式开关；省略时按项目交付设置。', properties: {
        subtitles: { type: 'boolean', description: '是否带字幕，默认 true。' },
        music: { type: 'boolean', description: '是否导入 editing/NN-bgm.wav 配乐，默认 true；false 表示本次不加配乐。' },
        ending: { type: 'boolean', description: 'false 去掉片尾。' },
        watermark: { type: 'boolean', description: 'false 去掉 AI 内容标识。' },
        watermark_text: { type: 'string', description: 'AI 内容标识文字，最多 40 字。' },
      } },
      name_prefix: { type: 'string', description: '批量模式草稿名前缀，默认项目目录名加 -。' },
      request_file: { type: 'string', description: '单集模式：已写好的单集 JSON 请求文件；相对路径以工作区为基准。' },
      drafts_dir: { type: 'string', description: '剪映草稿根目录；默认取 drama_draft_dir 保存的目录。' },
    },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async (args, exec) => {
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      if (args.request_file !== undefined) {
        if (args.episodes !== undefined) throw new ToolArgsError(['request_file 与 episodes 二选一。'])
        return await generateJianyingDraft(ctx.subprocess, {
          request_file: resolve(cwd, args.request_file), drafts_dir: await draftsRoot(args.drafts_dir, cwd),
        }, config, exec.signal)
      }
      if (args.episodes === undefined || args.source === undefined || args.project === undefined) {
        throw new ToolArgsError(['批量模式需要 source、project 和 episodes；单集模式传 request_file。'])
      }
      const episodes = args.episodes
      if (episodes.length === 0 || episodes.length > 100 || new Set(episodes).size !== episodes.length
        || episodes.some(episode => !Number.isSafeInteger(episode) || episode < 1)) throw new ToolArgsError(['episodes 须为 1–100 个不重复的正整数集号。'])
      const switches = args.switches ?? {}
      if (switches.watermark_text !== undefined && Array.from(switches.watermark_text).length > 40) throw new ToolArgsError(['watermark_text 最多 40 字。'])
      if (args.source === 'jingliu') {
        const connection = ctx.get('jingliuConnection')
        if (connection === undefined) {
          return { created: [], existing: [], refused: episodes.map(episode => ({ episode, reason: 'jingliu_outdated' })),
            needs_review: [], music_missing: [], not_started: [] }
        }
        const workspace = exec.agent?.session.header.cwd
        if (workspace === undefined) throw new ToolArgsError(['镜流项目的批量草稿需要本会话的工作区来存放下载的素材。'])
        const session = await connection.connection()
        const selected = exec.agent === undefined ? null : await connection.selected(exec.agent.session.id, session.identity)
        if (selected !== null && selected.id !== args.project) throw new HarnessError('这个操作指向另一个云项目，请先确认要切换的项目。', 'JINGLIU_INVALID_PROJECT')
        const prefix = args.name_prefix?.replace(/-+$/u, '').trim()
        return await runJingliuDraftBatch({ session, project: args.project, workspace, episodes, switches,
          namePrefix: prefix === undefined || prefix === '' ? undefined : prefix, draftsDir: await draftsRoot(args.drafts_dir, cwd) }, {
          ffmpegPath: config.ffmpegPath ?? 'ffmpeg', ffprobePath: config.ffprobePath ?? 'ffprobe',
          maxEpisodesPerCall: config.maxEpisodesPerCall ?? 10 }, exec.signal)
      }
      if (switches.subtitles === false) throw new ToolArgsError(['本机项目的批量草稿总是带本集字幕；不需要字幕时请在剪映中关闭字幕轨。'])
      const project = isAbsolute(args.project) ? args.project : resolve(cwd, args.project)
      const draftsDir = await draftsRoot(args.drafts_dir, cwd)
      return await runDraftBatch({ project, display: args.project, episodes, switches,
        namePrefix: args.name_prefix ?? defaultNamePrefix(project), draftsDir }, {
        ffmpegPath: config.ffmpegPath ?? 'ffmpeg', ffprobePath: config.ffprobePath ?? 'ffprobe', skillsDir,
        maxEpisodesPerCall: config.maxEpisodesPerCall ?? 10,
        ...(config.defaultSubtitleVisual === undefined ? {} : { defaultSubtitleVisual: config.defaultSubtitleVisual }),
        ...(config.enforceSubtitleVisual === undefined ? {} : { enforceSubtitleVisual: config.enforceSubtitleVisual }),
        generate: async (requestFile, root, signal) => {
          const result = await generateJianyingDraft(ctx.subprocess, { request_file: requestFile, drafts_dir: root }, config, signal)
          const [draft] = result.drafts
          if (draft === undefined) throw new Error('Draft generator returned no saved draft')
          return { path: draft.path, musicMissing: result.warnings.some(warning => warning.startsWith(MUSIC_REMINDER)) }
        },
      }, exec.signal)
    },
  })))
}
