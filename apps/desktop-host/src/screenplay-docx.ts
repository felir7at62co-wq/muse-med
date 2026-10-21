/** Export screenplay Markdown with the Desktop's bundled Python and python-docx. */
import { execFile } from 'node:child_process'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolvePrimaryRuntime } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import type {} from '@deepseek-ai/dsh-tool-present'
import { sha256, validateAcceptedStoryEvidence, validateStoryApprovalLog } from '@deepseek-ai/dsh-screenplay-project'
import { resolveTrustedVideoEvidence } from '@deepseek-ai/dsh-tool-video-inspect'
import { approveVideoMarkdown, validateVideoDelivery, verifyWordBody, type StoryEvidenceVerifier } from './video-delivery.ts'

/** Application-owned Word export limits and runtime. */
export interface Config {
  /** Deployment-selected creative review policy; omission preserves strict managed-project approval. */
  reviewMode?: 'strict' | 'advisory'
  /** Bundled primary runtime, read in place without installing packages. */
  source: string
  /** Maximum total Markdown input bytes. */
  maxInputBytes: number
  /** Python process deadline in milliseconds. */
  timeoutMs: number
  /** Maximum bytes read from managed project and delivery records. */
  maxProjectBytes: number
}

/** Source files in delivery order and a new Word destination. */
export interface ScreenplayDocxInput {
  inputs: readonly string[]
  output: string
  /** Managed video or refinement project when exporting outside its conventional final directory. */
  project?: string
}

/**
 * Convert script files without overwriting an existing destination.
 * @param input - Absolute Markdown paths in episode order and a new DOCX path.
 * @param config - Bundled runtime and resource limits.
 * @param signal - Caller cancellation, forwarded to the conversion process.
 * @param verifyStoryEvidence - Host-only persisted video receipt verification for story projects.
 * @returns Output path after Python has checked saved paragraph contents.
 */
export async function exportScreenplayDocx(input: ScreenplayDocxInput, config: Config, signal?: AbortSignal,
  verifyStoryEvidence?: StoryEvidenceVerifier): Promise<{ output: string }> {
  signal?.throwIfAborted()
  if (!input.inputs.length || input.inputs.some(path => !isAbsolute(path) || extname(path).toLowerCase() !== '.md')
    || !isAbsolute(input.output) || extname(input.output).toLowerCase() !== '.docx') {
    throw new Error('Use absolute .md input paths and a new absolute .docx output path')
  }
  let size = 0
  for (const path of input.inputs) {
    const stat = await lstat(path)
    if (!stat.isFile()) throw new Error('Each Markdown input must be a regular file')
    size += stat.size
  }
  if (size > config.maxInputBytes) throw new Error('Markdown inputs exceed the export size limit')
  const exists = await lstat(input.output).then(() => true, (error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  })
  if (exists) throw new Error('Word output already exists; choose a new versioned path')
  const approved = await approveVideoMarkdown(input.inputs, input.output, config.maxProjectBytes,
    input.project, verifyStoryEvidence, config.reviewMode)
  if (approved !== undefined && await lstat(`${input.output}.screenplay.json`).then(() => true, () => false)) {
    throw Error('Word verification record already exists; choose a new versioned path')
  }
  const pinned: { contents: string[]; hashes: string[] } | undefined = config.reviewMode === 'advisory'
    ? { contents: [], hashes: [] } : undefined
  if (pinned !== undefined) {
    let bytes = 0
    for (const path of input.inputs) {
      const body = await readFile(path, { signal })
      bytes += body.length
      if (bytes > config.maxInputBytes) throw Error('Markdown inputs exceed the export size limit')
      pinned.contents.push(new TextDecoder('utf-8', { fatal: true }).decode(body))
      pinned.hashes.push(sha256(body))
    }
  }
  const runtime = await resolvePrimaryRuntime(config.source)
  const script = await readFile(new URL('../skills/office-support/export_docx.py', import.meta.url), 'utf8')
  await new Promise<void>((resolveRun, reject) => {
    let failure: Error | null = null
    const child = execFile(runtime.python, ['-c', script], {
      signal, windowsHide: true, timeout: config.timeoutMs, maxBuffer: 65536,
      env: { ...process.env, PYTHONUTF8: '1' },
    }, (error) => { failure = error })
    child.once('close', () => {
      if (failure) reject(new Error(`Word export failed: ${failure.message}`))
      else resolveRun()
    })
    child.stdin?.on('error', () => { /* execFile reports process failure through its callback. */ })
    child.stdin?.end(JSON.stringify({ ...input, max_input_bytes: config.maxInputBytes,
      ...(pinned !== undefined ? { contents: pinned.contents } : approved === undefined ? {} : { contents: approved.contents }) }))
  })
  if (pinned !== undefined) {
    const outputHash = sha256(await readFile(input.output, { signal }))
    await verifyWordBody(input.output, pinned.contents, config, signal ?? new AbortController().signal)
    if (sha256(await readFile(input.output, { signal })) !== outputHash) throw Error('video_delivery_changed: Word 文件在核对期间变更。')
    for (const [index, path] of input.inputs.entries()) {
      if (sha256(await readFile(path, { signal })) !== pinned.hashes[index]) throw Error('source_changed: Markdown 文件在转换期间变更。')
    }
  }
  if (approved !== undefined) {
    await writeFile(`${input.output}.screenplay.json`, `${JSON.stringify({ version: 1,
      output_sha256: sha256(await readFile(input.output)), episodes: approved.episodes }, null, 2)}\n`, { flag: 'wx' })
    await validateVideoDelivery([input.output], config, signal ?? new AbortController().signal, {
      requireRefinementPair: false, ...(verifyStoryEvidence === undefined ? {} : { verifyStoryEvidence }),
    })
  }
  return { output: input.output }
}

/** Cordis plugin identity. */
export const name = 'screenplay-docx'
/** Register only after the Host tool service is available. */
export const inject = ['tools']

/**
 * Add direct Markdown-to-Word delivery to the Desktop Office composition.
 * @param ctx - Host tool registry.
 * @param config - Application runtime and conversion limits.
 */
export function apply(ctx: Context, config: Config): void {
  let evidenceContext: Context | undefined
  ctx.inject(['fs', 'attachments', 'sessions', 'sessionQuery', 'llm'], (scope) => {
    evidenceContext = scope
    scope.effect(() => () => { if (evidenceContext === scope) evidenceContext = undefined })
  })
  const verify = (signal: AbortSignal): StoryEvidenceVerifier => (project) => {
    const scope = evidenceContext
    if (scope === undefined) throw Error('story_video_evidence_pending: 正式故事交付需要Host来源、附件和Session查询服务。')
    return validateAcceptedStoryEvidence(project,
      (input, persisted) => resolveTrustedVideoEvidence(scope, undefined, input, signal, persisted),
      candidate => validateStoryApprovalLog(scope, project, candidate, signal))
  }
  ctx.on('deliverables/validate', (files, signal) => validateVideoDelivery(files, config, signal, { verifyStoryEvidence: verify(signal) }))
  ctx.tools.register(defineTool({
    name: 'screenplay_export_docx',
    description: '将剧本 Markdown 转为 Word 交付。按 inputs 顺序合并多集，保留场次、人物、▲动作、对白和 OS/VO；转换标题与加粗，其他 Markdown 写法按原文保留。逐段核对导出正文，不覆盖已有文件。'
      + (config.reviewMode === 'advisory' ? '当前由Agent自主决定内容审校方式，导出和交付不要求独立审校、批准候选或审校收据；返稿差异可通过manuscript_revision查看。' : '受管项目沿用其严格候选验收与交付检查。')
      + '格式沿系统提示词，Word 操作使用 office-docx；生成后检查排版，再用 present 交付实际 DOCX。',
    parameters: {
      inputs: { type: 'array', required: true, items: { type: 'string' }, description: '绝对路径的 .md 文件，按交付集数顺序排列；使用本次实际正文。' },
      output: { type: 'string', required: true, description: '项目 final/ 下新的绝对 .docx 路径；已有文件请换版本名。' },
      project: { type: 'string', description: config.reviewMode === 'advisory'
        ? '可选的 screenplay_project 项目路径；不作为内容审校或候选批准前提。'
        : '视频转剧本的 screenplay_project 项目文件；跨目录导出也保留验收绑定。普通文档转换无需填写。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { output: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args, exec) => exportScreenplayDocx(args, config, exec.signal, verify(exec.signal)),
    presentCall: () => ({ card: 'generic', title: 'Export screenplay to Word', kind: 'edit' }),
  }))
}
