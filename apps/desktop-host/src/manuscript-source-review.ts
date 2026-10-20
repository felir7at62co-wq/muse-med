/** Read-only source and revision materials for the current author session. */
import { createHash } from 'node:crypto'
import { diffLines } from 'diff'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { isManuscript } from './manuscript-document.ts'

/** Cordis plugin identity. */
export const name = 'manuscript-source-review'
/** Materials use the active filesystem and ordinary tool-result logging. */
export const inject = ['tools', 'fs']

/** Complete-document budgets, revision context and optional save hints. */
export interface Config {
  maxFileBytes: number
  maxInputChars: number
  contextLines: number
  maxPassageLines: number
  revisionHints: boolean
}

/** Resolve budgets before registering the optional comparison tool. */
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  maxFileBytes: Schema.number().step(1).min(1).default(16 * 1024 * 1024),
  maxInputChars: Schema.number().step(1).min(1).default(200_000),
  contextLines: Schema.number().step(1).min(0).default(3),
  maxPassageLines: Schema.number().step(1).min(1).default(8),
  revisionHints: Schema.boolean().default(true),
})

interface Document {
  id: string
  kind: 'source' | 'draft' | 'baseline'
  path: string
  sha256: string
  text: string
}

interface Change {
  id: string
  document: string
  line: number
  before: string | null
  after: string
  context: string
}

interface MaterialReceipt {
  sources: string[]
  drafts: Document[]
  userMessage: string | undefined
}
interface SourceRange {
  document: string
  start_line: number
  end_line: number
}
const suppliedMaterials = new WeakMap<Agent, MaterialReceipt>()

function changesFor(document: Document, baseline: Document | undefined, contextLines: number, maxPassageLines: number): Change[] {
  const lines = document.text.split('\n')
  const result: Change[] = []
  const add = (line: number, before: string | null, after: string) => result.push({
    id: `${document.id}:${result.length + 1}`, document: document.id, line, before, after,
    context: lines.slice(Math.max(0, line - 1 - contextLines), line - 1 + after.split('\n').length + contextLines).join('\n'),
  })
  if (baseline === undefined) {
    for (const match of document.text.matchAll(/[^\r\n]+(?:\r?\n(?![ \t]*\r?\n)[^\r\n]+)*/g)) {
      if (!match[0].trim()) continue
      const start = document.text.slice(0, match.index).split('\n').length
      const passage = match[0].split('\n')
      for (let offset = 0; offset < passage.length; offset += maxPassageLines) {
        add(start + offset, null, passage.slice(offset, offset + maxPassageLines).join('\n'))
      }
    }
  } else {
    let line = 1
    let before = '', after = ''
    const flush = () => {
      if (before || after) add(line, before, after)
      line += after.split('\n').length - 1
      before = ''; after = ''
    }
    for (const part of diffLines(baseline.text, document.text)) {
      if (part.removed) before += part.value
      else if (part.added) after += part.value
      else { flush(); line += part.count }
    }
    flush()
  }
  return result
}

async function readDocuments(ctx: Context, paths: readonly string[], kind: Document['kind'], agent: Agent,
  config: Config, signal: AbortSignal): Promise<Document[]> {
  const documents: Document[] = []
  let characters = 0
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw Error('MANUSCRIPT_REVIEW_CWD: the author session requires a workspace.')
  for (const [index, path] of paths.entries()) {
    const target = await ctx.fs.resolve(path, { cwd, signal })
    const info = await ctx.fs.stat(target, signal)
    if (info?.type !== 'file' || info.size === undefined || info.size > config.maxFileBytes) {
      throw Error(`MANUSCRIPT_REVIEW_FILE: ${target.displayPath} must be a regular UTF-8 text file within the configured byte limit.`)
    }
    const text = await ctx.fs.readText(target, signal)
    if (Buffer.byteLength(text) > config.maxFileBytes) throw Error('MANUSCRIPT_REVIEW_SIZE: file grew beyond the configured byte limit.')
    characters += text.length
    if (characters > config.maxInputChars) throw Error('MANUSCRIPT_REVIEW_SIZE: complete documents exceed the configured character limit; no partial review was run.')
    documents.push({ id: `${kind === 'source' ? 'S' : kind === 'draft' ? 'D' : 'B'}${index + 1}`, kind,
      path: target.displayPath, sha256: createHash('sha256').update(text).digest('hex'), text })
  }
  return documents
}

function locate(input: SourceRange, documents: readonly Document[]) {
  const document = documents.find(value => value.id === input.document)
  const lines = document?.text.split('\n')
  const valid = lines !== undefined && input.start_line >= 1 && input.end_line >= input.start_line && input.end_line <= lines.length
  return { ...input, literal_match: valid,
    ...valid && document !== undefined ? { path: document.path, kind: document.kind,
      line: input.start_line, quote: lines.slice(input.start_line - 1, input.end_line).join('\n') } : {} }
}

function numbered(document: Document) {
  const { text, ...metadata } = document
  return { ...metadata, numbered_text: text.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n') }
}

/**
 * Prepare source text, current drafts and actual revisions for the calling author without model calls.
 * @param ctx - Active filesystem service.
 * @param config - Complete-document budgets and passage context.
 * @param agent - Author whose current request scopes the last supplied draft versions.
 * @param input - Source/current paths, optional earlier drafts and exact source ranges.
 * @param signal - Cancels filesystem reads.
 * @returns Factual comparison materials and version checks, without semantic judgments or approval.
 */
export async function compareManuscriptSources(ctx: Context, config: Config, agent: Agent,
  input: {
    source_paths: string[]
    draft_paths: string[]
    previous_draft_paths?: string[]
    source_ranges?: SourceRange[]
    instructions?: string
  }, signal: AbortSignal) {
  signal.throwIfAborted()
  if (input.previous_draft_paths !== undefined && input.previous_draft_paths.length !== input.draft_paths.length) {
    throw Error('MANUSCRIPT_REVIEW_INPUT: previous_draft_paths must correspond to draft_paths by index.')
  }
  const sources = await readDocuments(ctx, input.source_paths, 'source', agent, config, signal)
  const drafts = await readDocuments(ctx, input.draft_paths, 'draft', agent, config, signal)
  const baselines = await readDocuments(ctx, input.previous_draft_paths ?? [], 'baseline', agent, config, signal)
  const documents = [...sources, ...drafts, ...baselines]
  const user = agent.session.deriveMessages().findLast(message => message.role === 'user' && message.source.kind === 'user')
  const previous = suppliedMaterials.get(agent)
  const reusable = previous !== undefined && previous.userMessage === user?.id
    && JSON.stringify(previous.sources) === JSON.stringify(sources.map(document => document.sha256))
    && JSON.stringify(previous.drafts.map(document => document.path)) === JSON.stringify(drafts.map(document => document.path))
  const changes = drafts.flatMap((document, index) => changesFor(document,
    reusable ? previous.drafts[index] : undefined, config.contextLines, config.maxPassageLines).map(change => ({ ...change,
    context_lines: { start: Math.max(1, change.line - config.contextLines),
      end: Math.min(document.text.split('\n').length, change.line - 1 + change.after.split('\n').length + config.contextLines) },
  })))
  const requestedChanges = drafts.flatMap((document, index) => changesFor(document,
    baselines[index], config.contextLines, config.maxPassageLines))
  const current = [...await readDocuments(ctx, input.source_paths, 'source', agent, config, signal),
    ...await readDocuments(ctx, input.draft_paths, 'draft', agent, config, signal),
    ...await readDocuments(ctx, input.previous_draft_paths ?? [], 'baseline', agent, config, signal)]
  const currentVersions = new Map(current.map(document => [document.id, document.sha256]))
  const versions = documents.map(({ text, ...document }) => ({ ...document, characters: text.length,
    unchanged_since_read: document.sha256 === currentVersions.get(document.id) }))
  const result = {
    advisory: true, semantic_review: 'not_performed_by_tool',
    scope: reusable ? 'changed_passages' : 'current_passages',
    scope_note: reusable ? '对照本次实际修改；之前提供过材料不代表内容已经审校。' : '首次提供完整当前稿和来源；相同的改前稿不能证明没有问题。',
    sources: sources.map(numbered), drafts: drafts.map(numbered),
    changes: changes.map(({ context: _context, ...change }) => change),
    revisions_since_requested_baseline: baselines.length === 0 ? [] : requestedChanges.map(({ id: _id, ...change }) => change),
    source_excerpts: (input.source_ranges ?? []).map(range => locate(range, sources)),
    author_notes: input.instructions ?? '', inputs: versions,
    limitation: '这些是原句、当前稿及实际差异，不是自动审校结论。人称、道具状态、推测和新增事实由当前Muse结合上下文判断；没有改动不代表没有问题。',
  }
  if (JSON.stringify(result).length > config.maxInputChars) throw Error('MANUSCRIPT_REVIEW_SIZE: complete materials exceed the configured character limit; no partial comparison was returned.')
  if (versions.every(document => document.unchanged_since_read)) {
    suppliedMaterials.set(agent, { sources: sources.map(document => document.sha256), drafts, userMessage: user?.id })
  }
  return result
}

/**
 * Expose optional source materials without model calls, a stopping hook or a required skill sequence.
 * @param ctx - Preset-scoped tools and filesystem services.
 * @param config - Resolved material budgets and save hints.
 */
export function apply(ctx: Context, config: Config): void {
  const notified = new WeakMap<Agent, string | undefined>()
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!config.revisionHints || result.isError || decision.kind !== 'accept' || 'value' in decision
      || exec.agent === undefined || !['write', 'edit'].includes(exec.name)) return decision
    const mutation = z.object({ path: z.string(), before: z.string().nullable(), after: z.string() }).safeParse(result.value)
    if (!mutation.success || !isManuscript(mutation.data.path) || mutation.data.before === mutation.data.after) return decision
    const user = exec.agent.session.deriveMessages().findLast(message => message.role === 'user' && message.source.kind === 'user')
    if (notified.has(exec.agent) && notified.get(exec.agent) === user?.id) return decision
    notified.set(exec.agent, user?.id)
    return { kind: 'accept', content: [...decision.content ?? result.content, { type: 'text', text: JSON.stringify({
      manuscript_revision: { advisory: true, saved_path: mutation.data.path,
        source_comparison_tool_for_saved_version: 'not_performed', available_tool: 'manuscript_source_review' },
    }) }], ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts } }
  })
  ctx.tools.register(defineTool({ name: 'manuscript_source_review',
    description: '读取小说或视频转写原句、完整当前稿和实际修改，供当前Muse结合上下文判断人称、道具状态及新增事实。首次返回当前段落，此后提取自上次材料版本以来的修改；可传改前稿或原句行号。只读材料，不调用其他模型或子会话，不给出自动审校结论。UTF-8文本；Word或视频先提取。',
    parameters: {
      source_paths: { type: 'array', items: { type: 'string' }, required: true, description: '本轮实际来源文本路径，如小说或已核对的视频转写。' },
      draft_paths: { type: 'array', items: { type: 'string' }, required: true, description: '要相互核对的本轮交付文本路径，包括当前正文、修改说明等；只核对明确传入的文件。' },
      previous_draft_paths: { type: 'array', items: { type: 'string' }, description: '可选的改前版本，与draft_paths逐一对应，仅供提取相对改前版本的实际差异；首次仍提供完整当前稿。' },
      source_ranges: { type: 'array', items: { type: 'object', properties: { document: { type: 'string', required: true }, start_line: { type: 'integer', required: true }, end_line: { type: 'integer', required: true } }, additionalProperties: false }, description: '可选的来源文档编号和行号，按实际文件逐字提取原句；无效范围明确标记。' },
      instructions: { type: 'string', description: '本轮关注点或遗留问题，作为参考材料返回，不作为来源事实或新授权。' },
    },
    output: { schema: { type: 'string' }, render: (_input, value) => [{ type: 'text', text: value }] },
    async execute(input, exec) {
      if (exec.agent === undefined) throw Error('MANUSCRIPT_REVIEW_AGENT: comparison requires an author session.')
      if (input.source_paths.length === 0 || input.draft_paths.length === 0) throw Error('MANUSCRIPT_REVIEW_INPUT: specify source and draft files.')
      return JSON.stringify(await compareManuscriptSources(ctx, config, exec.agent, input, exec.signal))
    },
    presentCall: () => ({ card: 'generic', title: 'Source comparison', kind: 'read' }),
  }))
}
