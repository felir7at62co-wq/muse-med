/** Generate editable Jianying drafts with the selected bundled, managed backend. */
import { access, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolvePrimaryRuntime } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import type { default as SubprocessRuntime, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'

/** Deployment-owned interpreter, process limits and bundled resource location. */
export interface Config {
  /** Resolved FFmpeg executable forwarded to the managed Python generator. */
  readonly ffmpegPath?: string
  /** Resolved ffprobe executable forwarded to the managed Python generator. */
  readonly ffprobePath?: string
  /** Final BGM track gain ceiling; defaults to 8, while Muse office composition selects 1. */
  readonly maxBgmGain?: number
  readonly source: string
  readonly pythonPath?: string
  readonly windowsPowerShellPath?: string
  readonly windowsCliPath?: string
  readonly windowsHostPath?: string
  readonly windowsLandscapeSubtitleSize?: number
  readonly windowsLandscapeSubtitleY?: number
  readonly timeoutMs: number
  readonly graceMs: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
}

/** Reject invalid process limits before the draft tool is registered. */
export const Config: z<Config> = z.object({
  ffmpegPath: z.string().min(1), ffprobePath: z.string().min(1),
  maxBgmGain: z.number().min(0).max(8).default(8),
  source: z.string().min(1).required(), pythonPath: z.string().min(1),
  windowsPowerShellPath: z.string().min(1), windowsCliPath: z.string().min(1), windowsHostPath: z.string().min(1),
  windowsLandscapeSubtitleSize: z.number().min(0.01).max(100),
  windowsLandscapeSubtitleY: z.number().min(-16384).max(16384),
  timeoutMs: z.number().step(1).min(1).required(), graceMs: z.number().step(1).min(0).required(),
  maxInputBytes: z.number().step(1).min(1).required(), maxOutputBytes: z.number().step(1).min(1).required(),
})

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

/** Resolve the optional audio mode at the episode JSON parser, preserving the released default. */
function resolveAudioMode(bytes: Buffer): 'embedded' | 'independent' {
  const request: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''))
  if (typeof request !== 'object' || request === null || Array.isArray(request)) throw new Error('Draft request must be a JSON object')
  if (!('audio_mode' in request) || request.audio_mode === 'independent') return 'independent'
  if (request.audio_mode === 'embedded') return 'embedded'
  throw new Error('audio_mode must be embedded or independent')
}

const DraftResult = z.object({
  success: z.boolean().required(),
  drafts_created: z.number().step(1).min(0).required(),
  drafts: z.array(z.object({
    episode: z.string().required(), name: z.string().required(), path: z.string().required(),
    id: z.string().required(), success: z.boolean().required(), error: z.string().required(),
    quality: z.string(), warnings: z.array(z.string()).default([]), review_path: z.string(),
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
  const backend = resolveJianyingDraftBackend(resolveAudioMode(requestBytes), process.platform)
  const python = config.pythonPath ?? (process.platform === 'win32'
    ? join(dirname(config.source), 'media', 'python', 'python.exe')
    : (await resolvePrimaryRuntime(config.source)).python)
  await access(python)
  const manifest = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-drama-skills/package.json'))
    .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
  const script = join(dirname(manifest), 'skills', 'tweet-drama-draft-build', 'scripts', backend.script)
  const env: Record<string, string | undefined> = { PYTHONUTF8: '1', DSH_BGM_MAX_GAIN: String(config.maxBgmGain ?? 8) }
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
    const stderr = handle.collected.stderr?.readFrom(0)?.text.trim()
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
  if (result.drafts_created < 1 || result.drafts_created !== result.drafts.length || result.drafts.some(draft => !draft.success)
    || result.editor_open_verified || result.library.name !== backend.library
    || (backend.library === 'aa-jianying' && row.backend !== 'aa-jianying')) {
    throw new Error('Draft generator returned inconsistent saved-draft results')
  }
  return result
}

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

Windows 保留原视频声音时，请求写 audio_mode="embedded"，省略 audio；由 aa剪映后端直接保留视频声音，BGM 独立；仅 9:16 在整集末尾追加片尾，16:9 不加。未声明模式的旧请求仍走独立主音轨：成功导入后才静音正文源视频，导入失败保留原声并说明缺口。Mac 暂不支持 embedded，不改用独立音轨冒称满足。独立 BGM 必须是纯音乐，不能叠加含对白的审查混音。已有草稿不会自动迁移；修复旧稿时生成唯一名称的新候选，不覆盖原稿。以上为 Agent 操作指导，不新增用户审批，不把保存成功写成剪映打开、播放或听感已验收。` })
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'jianying_draft',
    description: '生成一集可编辑剪映草稿，先读 tweet-drama-draft-build 并用 drama_draft_dir 取得根目录。write JSON 请求文件，包含 project、episode、name_prefix、按镜头顺序的 videos、subtitle_srt、timeline；Windows 保留原视频声音时写 audio_mode=embedded 并省略 audio，使用 aa剪映后端。未声明模式或 audio_mode=independent 时仍用 pyJianYingDraft 并要求 audio 为未混 BGM 的完整主音轨；Mac 暂不支持 embedded。可选 bgm、bgm_role、ending_audio、ending_effect，所有文件用绝对路径。Windows 片尾仅在 9:16 末尾追加，16:9 不加。BGM 为独立纯音乐轨，声明 bgm_role=music_only；含对白的审查混音不能当配乐重复叠加。字幕复用同源云转写时间轴，对照剧本在派生文件纠错，不均分时间。只处理指定集，不覆盖已有草稿；质量疑点返回 warnings 与 review_path 供核对，不要求提示清零。返回 backend、草稿路径与实际实现身份；editor_open_verified=false 表示尚未在剪映打开验收。',
    parameters: {
      request_file: { type: 'string', required: true, description: 'Existing JSON request file for one selected episode; relative paths use the current workspace.' },
      drafts_dir: { type: 'string', required: true, description: 'Existing editor root returned by drama_draft_dir.' },
    },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: (args, exec) => {
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      return generateJianyingDraft(ctx.subprocess, {
        request_file: resolve(cwd, args.request_file), drafts_dir: resolve(cwd, args.drafts_dir),
      }, config, exec.signal)
    },
  })))
}
