/** Generate editable Jianying drafts through bundled Python without a shell process. */
import { access, stat } from 'node:fs/promises'
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
  timeoutMs: z.number().step(1).min(1).required(), graceMs: z.number().step(1).min(0).required(),
  maxInputBytes: z.number().step(1).min(1).required(), maxOutputBytes: z.number().step(1).min(1).required(),
})

/** One episode request file and the existing editor root returned by drama_draft_dir. */
export interface DraftInput {
  readonly request_file: string
  readonly drafts_dir: string
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
 * Build one episode with the upstream library and verify its saved project data.
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
  const python = config.pythonPath ?? (process.platform === 'win32'
    ? join(dirname(config.source), 'media', 'python', 'python.exe')
    : (await resolvePrimaryRuntime(config.source)).python)
  await access(python)
  const manifest = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-drama-skills/package.json'))
    .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
  const script = join(dirname(manifest), 'skills', 'tweet-drama-draft-build', 'scripts', 'generate_draft_request.py')
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const handle = subprocess.spawn({
    argv: [python, '-B', script, input.request_file, input.drafts_dir, String(config.maxInputBytes)],
    cwd: dirname(input.request_file), env: { PYTHONUTF8: '1', DSH_BGM_MAX_GAIN: String(config.maxBgmGain ?? 8),
      ...(config.ffmpegPath === undefined ? {} : { DSH_FFMPEG_PATH: config.ffmpegPath }),
      ...(config.ffprobePath === undefined ? {} : { DSH_FFPROBE_PATH: config.ffprobePath }) },
    signal: combined, graceMs: config.graceMs,
    stdio: { stdin: 'ignore', stdout: { maxBytes: config.maxOutputBytes }, stderr: { maxBytes: config.maxOutputBytes } },
  })
  let outcome: SubprocessOutcome
  try { outcome = await handle.done } finally { await handle.waitForExit() }
  combined.throwIfAborted()
  const stdout = handle.collected.stdout?.readFrom(0)
  if (stdout === undefined || stdout.lossy) throw new Error('Draft generator output is missing or exceeds the output limit')
  const value: unknown = JSON.parse(stdout.text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Draft generator returned an invalid JSON object')
  const row = value as Record<string, unknown>
  const summary = z.object({ success: z.boolean().required(), error: z.string().default('process did not complete successfully') })(row)
  if (outcome.exitCode !== 0 || outcome.signal || !summary.success) {
    throw new Error(`Jianying draft generation failed: ${summary.error}`)
  }
  const result = DraftResult(row)
  if (result.drafts_created < 1 || result.drafts_created !== result.drafts.length || result.drafts.some(draft => !draft.success)
    || result.editor_open_verified || result.library.name !== 'pyJianYingDraft') {
    throw new Error('Draft generator returned inconsistent saved-draft results')
  }
  return result
}

/** Loader identity for Desktop's library-backed draft builder. */
export const name = 'desktop-jianying-draft'
/** The tool registry, managed process owner and current tool guidance. */
export const inject = ['tools', 'subprocess', 'systemPrompt']

/**
 * Register direct draft generation without PowerShell or an external Python installation.
 * @param ctx - Desktop profile with bundled creative resources.
 * @param config - Runtime location and process limits.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.systemPrompt.section({ name: 'tool:jianying_draft',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), interpolate: false,
    text: `## 剪映草稿：当前原生入口

当前实例提供 jianying_draft。历史会话续做、升级后恢复或首次生成草稿时，重新读取当前 tweet-drama-draft-build 技能，以当前工具及技能为准，不以历史成功记录代替。用 drama_draft_dir 取得根目录，write 单集 JSON 请求，再调用 jianying_draft（也可经 run_code 调用 tools.jianying_draft）。不要沿用历史记录中的绝对开发路径、.desktop-build、sys.path 或 DraftGenerator 脚本来生成草稿。原生工具失败时核查本次实际错误与当前打包资源，不静默退回旧脚本或另装依赖绕过。

独立对白成功导入后才静音正文源视频，保留独立对白；导入失败时保留源视频原声并说明未完成分轨，不删除对白或把所有音轨静音。独立 BGM 必须是纯音乐，不能叠加含对白的审查混音。已有草稿不会自动迁移；修复旧稿时生成唯一名称的新候选，不覆盖原稿。以上为 Agent 操作指导，不新增用户审批，不把保存成功写成剪映打开、播放或听感已验收。` })
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'jianying_draft',
    description: '使用随 Muse 打包的 pyJianYingDraft 生成一集可编辑剪映草稿，不经过 PowerShell。先读 tweet-drama-draft-build 技能并用 drama_draft_dir 取得根目录；write 一个 JSON 请求文件，包含 project、episode、name_prefix、audio、按镜头顺序的 videos 路径数组、subtitle_srt、timeline，可选 bgm、bgm_role、ending_audio、ending_effect，所有文件用绝对路径。主音轨是未混 BGM 的完整对白；独立 bgm 应为纯音乐并声明 bgm_role=music_only，dialogue_music_mix 审查混音不会再导入独立 BGM 轨，未知用途只提示、不会宣称已证明无对白。字幕已按实际语音校时，timeline 沿用成片时间线。只处理指定集，不覆盖已有草稿；字幕、配乐和轨道质量疑点返回 warnings 与 review_path 软提示，由你查看实际轨道决定，不要求提示清零。返回保存后读回一致的草稿路径和库版本，editor_open_verified=false 表示尚未在用户剪映里打开验收。',
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
