/**
 * The model-facing `script_finalize` tool: upload a finished script from the workspace to Script Workshop's
 * finalized-script library as a new version, after the user agreed to finalize it.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool, ToolArgsError, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ScriptSummary, WorkbenchSession } from '@deepseek-ai/dsh-workbench-connection'
import { scriptList, scriptOf } from '@deepseek-ai/dsh-workbench-connection/scripts'

/** JSON object fields returned to the model. */
export type Fields = { [key: string]: JsonValue }

/** Rights the library records, as the model names them. */
export const RIGHTS = { 原创: 'original', 授权改编: 'licensed' } as const
/** Script forms, matching Jingliu's project types. */
export const KINDS = { 剧情剧: 'drama', 解说剧: 'narration' } as const
/** Visual styles, matching Jingliu's projects. */
export const STYLES = { 仿真人: 'realistic', '3D': '3d' } as const
const RIGHT_NAMES = ['原创', '授权改编'] as const satisfies readonly (keyof typeof RIGHTS)[]
const KIND_NAMES = ['剧情剧', '解说剧'] as const satisfies readonly (keyof typeof KINDS)[]
const STYLE_NAMES = ['仿真人', '3D'] as const satisfies readonly (keyof typeof STYLES)[]
/** Workshop limits, checked before upload so a failure names the episode. */
export const LIMITS = { files: 300, episodes: 300, episodeChars: 60_000, totalChars: 3_000_000 } as const

const ORIGIN = /^(?:hongguo|fanqie|qimao|douyin|lvpaopao):[0-9A-Za-z_-]{1,64}$/u
const HEADING = /^#{0,6}\s*第\s*([0-9]{1,3})\s*集\s*(.*)$/u

/** Arguments after schema validation. */
export interface FinalizeArgs {
  title: string
  files: string[]
  rights?: keyof typeof RIGHTS
  kind?: keyof typeof KINDS
  style?: keyof typeof STYLES
  origin?: string
  origin_title?: string
}

/** One episode as uploaded. */
export interface UploadEpisode {
  order: number
  title: string
  content: string
}

/** Reads one workspace file as text; the caller resolves paths against the conversation's workspace. */
export type ReadFile = (path: string, signal: AbortSignal) => Promise<string>

type FinalizeContext = ToolRunContext & { readonly agent: NonNullable<ToolRunContext['agent']> }

/**
 * Authenticated Workshop access and workspace reads.
 * @template Exec - Tool context required by the reader.
 */
export interface FinalizeDependencies<Exec extends ToolRunContext = ToolRunContext> {
  connect(): Promise<WorkbenchSession>
  read(exec: Exec): ReadFile
}

function requireFinalizeAgent(exec: ToolRunContext): asserts exec is FinalizeContext {
  if (exec.agent === undefined) throw new HarnessError('请在 Muse 会话中定稿。', 'WORKSHOP_SESSION_REQUIRED')
}

/**
 * Split script files into episodes: a file with 第N集 headings splits at them; a file without takes the number in its
 * name (`0003.md` → 3), else its place in the list.
 * @param files - Paths and texts in the order given.
 * @returns Episodes sorted by number.
 */
export function splitEpisodes(files: readonly { path: string; text: string }[]): UploadEpisode[] {
  const episodes: UploadEpisode[] = []
  files.forEach(({ path, text }, index) => {
    const lines = text.replace(/^﻿/u, '').split(/\r?\n/u)
    const marks = lines.flatMap((line, at) => {
      const match = HEADING.exec(line.trim())
      if (match === null) return []
      const [, order, title] = match
      return [{ at, order: Number(order), title: `第${String(order)}集 ${String(title)}`.trim() }]
    })
    if (marks.length === 0) {
      const filename = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
      const named = /([0-9]{1,3})(?:\.[A-Za-z]+)?$/u.exec(filename)
      const order = named ? Number(named[1]) : index + 1
      episodes.push({ order, title: '第' + String(order) + '集', content: text.replace(/^﻿/u, '').trim() })
      return
    }
    marks.forEach((mark, n) => {
      const end = marks[n + 1]?.at ?? lines.length
      episodes.push({ order: mark.order, title: mark.title, content: lines.slice(mark.at + 1, end).join('\n').trim() })
    })
  })
  return episodes.sort((a, b) => a.order - b.order)
}

/**
 * Check the episodes against the Workshop's limits.
 * @param episodes - Split episodes.
 * @returns The same episodes.
 */
export function checkEpisodes(episodes: readonly UploadEpisode[]): readonly UploadEpisode[] {
  const orders = episodes.map(episode => episode.order)
  const repeated = [...new Set(orders.filter((order, i) => orders.indexOf(order) !== i))]
  const violations = [
    ...(episodes.length === 0 ? ['没有读到任何一集'] : []),
    ...(episodes.length > LIMITS.episodes ? ['最多 ' + String(LIMITS.episodes) + ' 集'] : []),
    ...repeated.map(order => '第 ' + String(order) + ' 集出现了不止一次'),
    ...episodes.filter(episode => episode.order < 1 || episode.order > LIMITS.episodes).map(episode => '集数 ' + String(episode.order) + ' 超出范围'),
    ...episodes.filter(episode => episode.content === '').map(episode => '第 ' + String(episode.order) + ' 集没有正文'),
    ...episodes.filter(episode => episode.content.length > LIMITS.episodeChars).map(episode => '第 ' + String(episode.order) + ' 集超过 ' + String(LIMITS.episodeChars) + ' 字'),
    ...(episodes.reduce((sum, episode) => sum + episode.content.length, 0) > LIMITS.totalChars ? ['全剧超过 ' + String(LIMITS.totalChars) + ' 字'] : []),
  ]
  if (violations.length > 0) throw new ToolArgsError(violations)
  return episodes
}

async function existing(session: WorkbenchSession, title: string, signal: AbortSignal): Promise<ScriptSummary | undefined> {
  const query = new URLSearchParams({ q: title, mine: 'true', page: '1', limit: '100' })
  const page = scriptList(await session.request('/script-library?' + query.toString(), { signal }))
  return page.items.find(item => item.title === title)
}

/** What `script_finalize` reports: the script's card fields, the version and whether the text was new. */
export type FinalizeReport = { id: number; version: number } & Fields

function report(script: ScriptSummary, created: boolean, version: number): FinalizeReport {
  return {
    id: script.id, title: script.title, version, created, status: script.status, episodes: script.episodes, words: script.words,
    latest_version: script.latestVersion,
  }
}

/**
 * Upload a finished script as a new library version.
 * @param deps - Workshop connection and workspace reads.
 * @returns The tool definition; Workshop credentials never appear in its arguments or results.
 */
export function finalizeTool(deps: FinalizeDependencies<FinalizeContext>): ToolDefinition {
  return defineTool({
    name: 'script_finalize',
    description: '把写完的剧本定稿上传到剧本工坊的定稿库，全组都能看到，组长从里面选用投产。'
      + '只在剧本写完、检查通过，并且你用提问问过用户「是否定稿」、用户明确同意之后调用；用户没同意就不要调用。'
      + '同一用户同名的剧本会追加为新版本，正文没变不会新增版本。files 按集给出 Markdown 剧本文件；一个文件里有多集时按「第N集」标题拆分。',
    parameters: {
      title: { type: 'string', required: true, description: '剧名。' },
      files: { type: 'array', items: { type: 'string' }, required: true, description: '剧本文件路径，按集排好；相对路径按当前工作区解析。' },
      rights: { type: 'string', enum: RIGHT_NAMES, description: '版权：原创或授权改编，默认原创。' },
      kind: { type: 'string', enum: KIND_NAMES, description: '剧本形式，默认剧情剧。' },
      style: { type: 'string', enum: STYLE_NAMES, description: '画面风格，默认仿真人。' },
      origin: { type: 'string', description: '改编时原小说或原剧在数据站的作品编号，如 fanqie:7300000000000000001 或 hongguo:7460844307990187033。' },
      origin_title: { type: 'string', description: '原小说或原剧的名字。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { id: { type: 'integer', required: true }, version: { type: 'integer', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ title: value.title ?? null, version: value.version, created: value.created ?? null }),
    },
    async execute(args, exec): Promise<FinalizeReport> {
      requireFinalizeAgent(exec)
      const title = args.title.trim()
      const violations = [
        ...(title === '' || title.length > 200 ? ['title 需要 1 到 200 字'] : []),
        ...(args.files.length === 0 || args.files.length > LIMITS.files ? ['files 需要 1 到 ' + String(LIMITS.files) + ' 个文件'] : []),
        ...(args.origin !== undefined && !ORIGIN.test(args.origin) ? ['origin 必须是数据站作品编号，如 fanqie:… 或 hongguo:…'] : []),
        ...(args.origin === undefined && args.rights === '授权改编' ? ['授权改编需要 origin'] : []),
      ]
      if (violations.length > 0) throw new ToolArgsError(violations)
      const read = deps.read(exec)
      const texts = []
      for (const path of args.files) texts.push({ path, text: await read(path, exec.signal) })
      const episodes = checkEpisodes(splitEpisodes(texts))
      const session = await deps.connect()
      const before = await existing(session, title, exec.signal)
      exec.signal.throwIfAborted()
      let uploaded: unknown
      try {
        uploaded = await session.request('/script-library', {
          method: 'POST', signal: exec.signal, body: {
            ...(before === undefined ? {} : { entry_id: before.id }), title, rights: RIGHTS[args.rights ?? '原创'],
            kind: KINDS[args.kind ?? '剧情剧'], style: STYLES[args.style ?? '仿真人'], episodes,
            ...(args.origin === undefined ? {} : { origin_work_id: args.origin, origin_title: args.origin_title?.trim() || null }),
            session_ref: String(exec.agent.session.id).slice(0, 120),
          },
        })
      } catch (error) {
        if (error instanceof HarnessError || exec.signal.aborted) throw error
        throw new HarnessError('剧本工坊没有确认是否已上传。先看定稿库里有没有这一版，没有再重试。', 'WORKSHOP_FINALIZE_OUTCOME_UNKNOWN', { cause: error })
      }
      const created = typeof uploaded === 'object' && uploaded !== null && 'created' in uploaded && uploaded.created === true
      const version = typeof uploaded === 'object' && uploaded !== null && 'version' in uploaded && typeof uploaded.version === 'number' ? uploaded.version : 0
      return report(scriptOf(uploaded), created, version)
    },
    presentCall: args => ({ card: 'generic', kind: 'other', title: '定稿 ·《' + args.title + '》' }),
    presentResult: (args, result) => {
      if (result.isError || typeof result.meta !== 'object' || result.meta === null || Array.isArray(result.meta)) return undefined
      const meta = result.meta
      const version = typeof meta.version === 'number' ? ' v' + String(meta.version) : ''
      return { card: 'generic', title: (meta.created === false ? '定稿 · 正文没变 ·《' : '已上传剧本工坊 ·《') + args.title + '》' + version }
    },
  })
}

/**
 * Register `script_finalize` while the Host provides the Script Workshop connection and workspace files.
 * @param ctx - Agent or Host context with the tool registry.
 */
export function applyFinalize(ctx: Context): void {
  ctx.inject(['workshopConnection', 'fs', 'sandboxPolicy'], (scope) => {
    const tool = finalizeTool({
      connect: () => scope.workshopConnection.connection(),
      read: exec => async (path, signal) => {
        const policy = scope.sandboxPolicy.resolve({ session: exec.agent.session })
        const target = await scope.fs.resolve(path, { cwd: policy.workspaceRoot, signal })
        return await scope.fs.readText(target, signal)
      },
    })
    scope.effect(() => scope.tools.register(tool))
  })
}
