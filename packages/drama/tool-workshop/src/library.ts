/**
 * The model-facing `script_library` tool: read one version of a finalized script from Script Workshop's library into
 * the workspace, or record the Jingliu project a picked script became.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool, ToolArgsError, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { scriptDetail, scriptOf, type ScriptEpisode, type WorkbenchSession } from '@deepseek-ai/dsh-workbench-connection'
import type { Fields } from './jobs.ts'

/** Workspace folder that holds scripts read from the library. */
export const LIBRARY_FOLDER = '剧本库'
/** Actions of `script_library`. */
export const LIBRARY_ACTIONS = ['read', 'link'] as const

/** Arguments after schema validation. */
export interface LibraryArgs {
  action: typeof LIBRARY_ACTIONS[number]
  id: number
  version?: number
  project_id?: string
  project_title?: string
}

/** Writes one workspace file as text; the caller resolves paths against the conversation's workspace. */
export type WriteFile = (path: string, text: string, signal: AbortSignal) => Promise<void>

/** Authenticated Workshop access and workspace writes. */
export interface LibraryDependencies {
  connect(): Promise<WorkbenchSession>
  write(exec: ToolRunContext): WriteFile
}

/**
 * The workspace files of one script version: one Markdown file per episode under `剧本库/<剧名>-v<版本>/`, each opening
 * with its 第N集 heading so `script_finalize` reads the files back as the same episodes.
 * @param title - Script title.
 * @param version - Version number.
 * @param episodes - The version's episodes.
 * @returns The folder and the files in episode order.
 */
export function episodeFiles(title: string, version: number, episodes: readonly ScriptEpisode[]): { folder: string; files: { path: string; text: string }[] } {
  const name = title.replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').replace(/^\.+/u, '_').trim().slice(0, 80) || '剧本'
  const folder = LIBRARY_FOLDER + '/' + name + '-v' + String(version)
  return {
    folder,
    files: [...episodes].sort((a, b) => a.order - b.order).map((episode) => {
      const heading = /^第\s*[0-9]{1,3}\s*集/u.test(episode.title) ? episode.title : ('第' + String(episode.order) + '集 ' + episode.title).trim()
      return { path: folder + '/第' + String(episode.order).padStart(3, '0') + '集.md', text: '# ' + heading + '\n\n' + episode.content + '\n' }
    }),
  }
}

async function read(deps: LibraryDependencies, session: WorkbenchSession, args: LibraryArgs, exec: ToolRunContext): Promise<Fields> {
  if (args.version !== undefined && (!Number.isSafeInteger(args.version) || args.version < 1)) throw new ToolArgsError(['version 是从 1 开始的版本号'])
  const query = args.version === undefined ? '' : '?version=' + String(args.version)
  const detail = scriptDetail(await session.request('/script-library/' + String(args.id) + query, { signal: exec.signal }))
  const { folder, files } = episodeFiles(detail.script.title, detail.content.version, detail.content.episodes)
  const write = deps.write(exec)
  for (const file of files) await write(file.path, file.text, exec.signal)
  const script = detail.script
  return {
    action: 'read', id: script.id, title: script.title, version: detail.content.version, latest_version: script.latestVersion,
    status: script.status, picked_version: script.picked?.version ?? null, project: script.project?.title ?? null,
    episodes: files.length, folder, files: files.map(file => file.path),
  }
}

async function link(session: WorkbenchSession, args: LibraryArgs, exec: ToolRunContext): Promise<Fields> {
  const projectId = args.project_id?.trim() ?? ''
  const projectTitle = args.project_title?.trim() ?? ''
  const violations = [
    ...(projectId === '' || projectId.length > 80 ? ['link 需要 project_id'] : []),
    ...(projectTitle === '' || projectTitle.length > 200 ? ['link 需要 project_title'] : []),
  ]
  if (violations.length > 0) throw new ToolArgsError(violations)
  const script = scriptOf(await session.request('/script-library/' + String(args.id) + '/production', {
    method: 'POST', signal: exec.signal, body: { project_id: projectId, project_title: projectTitle },
  }))
  return { action: 'link', id: script.id, title: script.title, status: script.status, project_id: script.project?.id ?? null, project: script.project?.title ?? null }
}

/**
 * Read finalized scripts and record their Jingliu projects.
 * @param deps - Workshop connection and workspace writes.
 * @returns The tool definition; Workshop credentials never appear in its arguments or results.
 */
export function libraryTool(deps: LibraryDependencies): ToolDefinition {
  return defineTool({
    name: 'script_library',
    description: '剧本工坊定稿库：全组定稿的剧本，组长从中选用投产。'
      + 'read 把一版剧本按集写进工作区「剧本库/剧名-v版本/」，返回文件路径，用来导入镜流或参考；'
      + 'link 在用选用的剧本建好镜流项目后登记这个项目，剧本库显示为已投产。',
    parameters: {
      action: { type: 'string', enum: [...LIBRARY_ACTIONS], required: true, description: 'read 取出剧本；link 登记镜流项目。' },
      id: { type: 'integer', required: true, description: '剧本库编号。' },
      version: { type: 'integer', description: 'read 读取的版本，默认最新版；投产时用被选用的那一版。' },
      project_id: { type: 'string', description: 'link 必填：镜流项目 ID。' },
      project_title: { type: 'string', description: 'link 必填：镜流项目名。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { id: { type: 'integer', required: true }, status: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ title: value.title, version: value.version, episodes: value.episodes, project: value.project }),
    },
    async execute(args, exec): Promise<Fields> {
      if (!Number.isSafeInteger(args.id) || args.id < 1) throw new ToolArgsError(['id 是剧本库编号'])
      if (args.action === 'read' && !exec.agent) throw new HarnessError('请在 Muse 会话中取出剧本。', 'WORKSHOP_SESSION_REQUIRED')
      const session = await deps.connect()
      return args.action === 'read' ? await read(deps, session, args, exec) : await link(session, args, exec)
    },
    presentCall: args => ({ card: 'generic', kind: 'other', title: (args.action === 'link' ? '登记投产 · 剧本 ' : '取出定稿剧本 · 剧本 ') + String(args.id) }),
    presentResult: (args, result) => {
      if (result.isError || typeof result.meta !== 'object' || result.meta === null || Array.isArray(result.meta)) return undefined
      const meta = result.meta
      const title = typeof meta.title === 'string' ? '《' + meta.title + '》' : ''
      if (args.action === 'link') return { card: 'generic', title: '已登记投产 · ' + title + (typeof meta.project === 'string' ? ' → ' + meta.project : '') }
      const version = typeof meta.version === 'number' ? ' 第 ' + String(meta.version) + ' 版' : ''
      const episodes = typeof meta.episodes === 'number' ? ' · ' + String(meta.episodes) + ' 集' : ''
      return { card: 'generic', title: '已取出 ' + title + version + episodes }
    },
  })
}

/**
 * Register `script_library` while the Host provides the Script Workshop connection and workspace files.
 * @param ctx - Agent or Host context with the tool registry.
 */
export function applyLibrary(ctx: Context): void {
  ctx.inject(['workshopConnection', 'fs', 'sandboxPolicy'], (scope) => {
    const tool = libraryTool({
      connect: () => scope.workshopConnection.connection(),
      write: exec => async (path, text, signal) => {
        const policy = scope.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
        const target = await scope.fs.resolve(path, { cwd: policy.workspaceRoot, signal })
        await scope.fs.writeText(target, text, undefined, signal, policy)
      },
    })
    scope.effect(() => scope.tools.register(tool))
  })
}
