/** Project-local, reversible user bans keyed by exact video bytes; independent of source review. */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { fileSha256 } from './cache.ts'

/** One version's latest user decision; releasing a ban retains its labels and reason. */
interface VideoBan {
  /** Lowercase SHA256 of the marked file bytes. */
  sha256: string
  /** Nonempty user labels, retained after unban. */
  labels: string[]
  /** Optional user explanation, stored as an empty string when absent. */
  reason: string
  /** Whether this version is currently disabled. */
  banned: boolean
  /** ISO timestamp of the latest decision. */
  updated_at: string
  /** Absolute path observed when the version was banned; not its identity. */
  video: string
}

const SHA256 = /^[a-f0-9]{64}$/u

function labelsValid(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
    && value.every(label => typeof label === 'string' && label.trim().length > 0)
}

/**
 * Read all decisions, refusing corrupt or unsupported manifests rather than treating them as empty.
 * @param project - Project root.
 * @returns Validated version decisions; absent manifest means no decisions.
 */
export async function readVideoBans(project: string): Promise<VideoBan[]> {
  const path = resolve(project, 'video-bans.json')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  try {
    const document = JSON.parse(text.replace(/^\ufeff/u, '')) as { version?: unknown; videos?: unknown } | null
    if (document?.version !== 1 || !Array.isArray(document.videos)) throw new Error('version/videos')
    const hashes = new Set<string>()
    for (const value of document.videos) {
      const row = value as Partial<VideoBan> | null
      if (row === null || typeof row !== 'object' || typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)
        || hashes.has(row.sha256) || !labelsValid(row.labels) || typeof row.reason !== 'string'
        || typeof row.banned !== 'boolean' || typeof row.video !== 'string' || !isAbsolute(row.video)
        || typeof row.updated_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(row.updated_at)
        || !Number.isFinite(Date.parse(row.updated_at))) {
        throw new Error('invalid video decision')
      }
      hashes.add(row.sha256)
    }
    return document.videos as VideoBan[]
  } catch (error) {
    throw new Error(`禁用清单损坏或版本不支持：${path}。请修复清单后重试；不会忽略或覆盖旧数据。`, { cause: error })
  }
}

/**
 * Refuse exact selected bytes that the user disabled, including same-byte copies.
 * @param project - Project root owning the decisions.
 * @param videos - Actual files about to be consumed.
 * @returns Resolves only when none of the selected versions is banned.
 */
export async function assertVideosAllowed(project: string, videos: readonly string[]): Promise<void> {
  const bans = (await readVideoBans(project)).filter(row => row.banned)
  if (bans.length === 0) return
  for (const video of new Set(videos)) {
    const sha256 = await fileSha256(video)
    rejectBannedHash(bans, sha256, video)
  }
}

function rejectBannedHash(bans: readonly VideoBan[], sha256: string, label: string): void {
  const banned = bans.find(row => row.banned && row.sha256 === sha256)
  if (banned !== undefined) {
    throw new Error(`视频版本已禁用：${label} [${sha256}]；labels=${banned.labels.join('、')}；reason=${banned.reason}。`
      + '请选择其他版本；确认误标或收到解除要求后可调用 drama_video unban，不要仅为让导出通过而解除；解除禁用不代表审核通过。')
  }
}

/**
 * Recheck versions actually consumed earlier in a render, even if their paths were subsequently replaced.
 * @param project - Project root owning decisions.
 * @param hashes - Source hashes computed by this render, never model-supplied identities.
 */
export async function assertVideoHashesAllowed(project: string, hashes: readonly string[]): Promise<void> {
  const bans = await readVideoBans(project)
  for (const hash of hashes) rejectBannedHash(bans, hash, '本次渲染已选源')
}

/** Validated tool operation fields. */
interface VideoArguments {
  method: 'ban' | 'unban' | 'list' | 'inspect'
  project: string
  video?: string
  sha256?: string
  labels?: string[]
  reason?: string
}

/**
 * Query or atomically update a project decision; ban always hashes a readable local video.
 * @param args - User-requested operation and local project/video selection.
 * @returns Latest labels and reason, with review explicitly unassessed.
 */
export async function runDramaVideo(args: VideoArguments) {
  if (typeof args.project !== 'string' || args.project.trim() === '') throw new Error('project 必须是项目目录。')
  const project = resolve(args.project)
  if (!(await stat(project)).isDirectory()) throw new Error('project 必须是项目目录。')
  const manifest_path = resolve(project, 'video-bans.json')
  if (!['ban', 'unban', 'list', 'inspect'].includes(args.method)) throw new Error('不支持的 drama_video method。')
  if (args.method === 'ban' && !labelsValid(args.labels)) throw new Error('ban 的 labels 必须是至少含一个非空字符串的列表。')
  if (args.reason !== undefined && typeof args.reason !== 'string') throw new Error('reason 必须是字符串。')
  if (args.method === 'ban' && (args.video === undefined || args.sha256 !== undefined)) {
    throw new Error('ban 必须指定现有本地 video，不接受 sha256 代替。')
  }
  let sha256 = ''
  let video = ''
  if (args.method !== 'list') {
    if ((args.video === undefined) === (args.sha256 === undefined)) throw new Error('必须且只能指定 video 或 sha256。')
    if (args.video !== undefined) {
      if (typeof args.video !== 'string' || args.video.trim() === '') throw new Error('video 必须是本地视频路径。')
      video = resolve(project, args.video)
      if (!(await stat(video)).isFile()) throw new Error('video 必须是本地文件。')
      sha256 = await fileSha256(video)
    } else {
      if (typeof args.sha256 !== 'string' || !SHA256.test(args.sha256)) throw new Error('sha256 必须是清单返回的64位小写十六进制值。')
      sha256 = args.sha256
    }
  }
  const operation = async () => {
    const videos = await readVideoBans(project)
    let record = videos.find(row => row.sha256 === sha256)
    if (args.method === 'ban') {
      if (!labelsValid(args.labels)) throw new Error('ban 的 labels 必须是至少含一个非空字符串的列表。')
      const next: VideoBan = {
        sha256, video, labels: [...new Set(args.labels.map(label => label.trim()))], reason: args.reason ?? '',
        banned: true, updated_at: new Date().toISOString(),
      }
      if (record === undefined) videos.push(next)
      else videos[videos.indexOf(record)] = next
      record = next
    } else if (args.method === 'unban' && record !== undefined) {
      record.banned = false
      record.updated_at = new Date().toISOString()
    }
    if (args.method === 'ban' || (args.method === 'unban' && record !== undefined)) {
      await writeFileAtomic(manifest_path, `${JSON.stringify({ version: 1, videos }, null, 2)}\n`, { mode: 0o600 })
    }
    return {
      method: args.method, project, manifest_path, sha256,
      banned: args.method === 'list' ? videos.some(row => row.banned) : record?.banned ?? false,
      labels: record?.labels ?? [], reason: record?.reason ?? '',
      review_status: 'not_assessed' as const, videos: args.method === 'list' ? videos : [],
    }
  }
  return args.method === 'ban' || args.method === 'unban'
    ? await withFileLock(manifest_path, operation) : await operation()
}

/**
 * Register the reversible video decision tool in the renderer's owning fiber.
 * @param ctx - Context carrying the tool registry.
 */
export function registerDramaVideo(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'drama_video',
    description: '按用户决定禁用或解除禁用具体视频版本。ban 必须提供本地 video 和至少一个 labels 标签（如人物对调、字幕错误），'
      + 'reason 可选，不要求审图证据。内部按 SHA256 标识，同字节副本共享禁用，新生成不同字节不受影响。'
      + 'unban 不等于审核通过；list/inspect 可读标签和原因。只在 drama_render prepare/render 拦截，verify 报告风险不删文件；不拦截通用 ffmpeg。',
    parameters: {
      method: { type: 'string', required: true, enum: ['ban', 'unban', 'list', 'inspect'] },
      project: { type: 'string', required: true, description: '现有项目目录，禁用清单持久化在该目录。' },
      video: { type: 'string', description: '本地视频路径，相对项目或绝对路径；ban 必填，内部计算 SHA256。' },
      sha256: { type: 'string', description: '仅 unban/inspect 可用清单返回的 SHA256 代替已不存在的 video，二者互斥。' },
      labels: { type: 'array', items: { type: 'string' }, description: 'ban 必填：至少一个非空标签，如人物对调、字幕错误。' },
      reason: { type: 'string', description: 'ban 可选：用户禁用原因；不是审图证据。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, properties: {
          method: { type: 'string', required: true }, project: { type: 'string', required: true },
          manifest_path: { type: 'string', required: true }, sha256: { type: 'string', required: true },
          banned: { type: 'boolean', required: true }, labels: { type: 'array', required: true, items: { type: 'string' } },
          reason: { type: 'string', required: true }, review_status: { type: 'string', required: true, enum: ['not_assessed'] },
          videos: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false, properties: {
              sha256: { type: 'string', required: true }, video: { type: 'string', required: true },
              labels: { type: 'array', required: true, items: { type: 'string' } },
              reason: { type: 'string', required: true }, banned: { type: 'boolean', required: true },
              updated_at: { type: 'string', required: true },
            },
          } },
        },
      },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async args => await runDramaVideo(args),
  }))
}
