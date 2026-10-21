/** Configured screenplay delivery checks and exact Word conversion verification. */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { acceptedScripts, PROJECT_FILE, sha256, validateAcceptedStoryEvidence } from '@deepseek-ai/dsh-screenplay-project'
import { resolvePrimaryRuntime } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import type { Config } from './screenplay-docx.ts'
import { isManuscript, readManuscript } from './manuscript-document.ts'

const receipt = z.strictObject({
  version: z.literal(1), output_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  episodes: z.array(z.strictObject({ project: z.string().min(1), project_id: z.string().min(1),
    candidate_id: z.string().min(1), candidate_sha256: z.string().min(1), script_sha256: z.string().min(1),
    modification_notes_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).min(1),
})

/** Application-issued verification data for one managed Word export. */
export type VideoExportReceipt = z.infer<typeof receipt>

/** Host-only recheck of persisted inspection receipts before accepted story delivery. */
export type StoryEvidenceVerifier = (project: Parameters<typeof validateAcceptedStoryEvidence>[0]) => Promise<void>

async function optionalText(path: string, maxBytes: number): Promise<string | undefined> {
  const info = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (info === undefined) return undefined
  if (!info.isFile() || info.size > maxBytes) throw Error('video_delivery_project: 交付校验文件必须为预算内的普通文件。')
  return readFile(path, 'utf8')
}

async function projectAt(path: string, maxBytes: number, verify?: StoryEvidenceVerifier) {
  const text = await optionalText(path, maxBytes)
  if (text === undefined) return undefined
  const marker = z.object({ workflow: z.unknown().optional(), refinement: z.unknown().optional(),
    story_policy: z.unknown().optional() }).parse(JSON.parse(text))
  if (marker.workflow !== 'video_to_screenplay' && marker.refinement === undefined && marker.story_policy === undefined) return undefined
  const project = PROJECT_FILE.parse(JSON.parse(text))
  if (project.story_policy !== undefined) {
    if (verify === undefined) throw Error('story_video_evidence_pending: 故事正式交付须由Host核对已验收的真实视频检查记录。')
    await verify(project)
  }
  for (const source of project.sources) {
    if (sha256(await readFile(source.path)) !== source.sha256) throw Error('source_changed: 正式交付的来源已变更。')
  }
  return { path: await realpath(path), project, scripts: acceptedScripts(project) }
}

async function scopedProjects(paths: readonly string[], maxBytes: number, explicit?: string, verify?: StoryEvidenceVerifier) {
  const projects = new Map<string, NonNullable<Awaited<ReturnType<typeof projectAt>>>>()
  const visited = new Set<string>()
  if (explicit !== undefined) {
    const value = await projectAt(explicit, maxBytes, verify)
    if (value === undefined) throw Error('video_delivery_project: 指定的受管视频项目不存在或未标记。')
    projects.set(value.path, value)
  }
  for (const file of paths) {
    let directory = dirname(resolve(file))
    while (true) {
      const part = relative(directory, resolve(file)).split(sep)[0]?.toLowerCase()
      const projectPath = join(directory, 'qa', 'screenplay-project.json')
      if (part === 'final' && !visited.has(projectPath)) {
        visited.add(projectPath)
        const value = await projectAt(projectPath, maxBytes, verify)
        if (value !== undefined) projects.set(value.path, value)
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return [...projects.values()]
}

/**
 * Verify Markdown against current accepted candidates before conversion.
 * @param inputs - Ordered Markdown paths.
 * @param output - Destination used to recognize a managed final directory.
 * @param maxProjectBytes - Host-selected project/receipt read budget.
 * @param explicit - Optional managed project outside the conventional directory.
 * @param verify - Host-only logged inspection recheck for story-faithful projects.
 * @param reviewMode - Deployment-selected approval policy; advisory conversion uses the actual input files.
 * @returns Pinned accepted contents and receipt episodes, or undefined for ordinary conversion.
 */
export async function approveVideoMarkdown(inputs: readonly string[], output: string, maxProjectBytes: number,
  explicit?: string, verify?: StoryEvidenceVerifier, reviewMode: 'strict' | 'advisory' = 'strict') {
  if (reviewMode === 'advisory') return undefined
  const projects = await scopedProjects([...inputs, output], maxProjectBytes, explicit, verify)
  if (projects.length === 0) return undefined
  const episodes: VideoExportReceipt['episodes'] = [], contents: string[] = []
  for (const input of inputs) {
    const text = await readFile(input, 'utf8')
    const owner = projects.find(value => value.scripts.some(script => script.script === text))
    const candidate = owner?.scripts.find(script => script.script === text)
    if (owner === undefined || candidate === undefined) throw Error('video_delivery_unaccepted: 正式视频剧本必须与已验收候选正文一致。')
    contents.push(text)
    episodes.push({ project: owner.path, project_id: owner.project.id, candidate_id: candidate.id,
      candidate_sha256: candidate.sha256, script_sha256: sha256(text),
      ...(candidate.modification_notes === undefined ? {} : { modification_notes_sha256: sha256(candidate.modification_notes) }) })
  }
  return { contents, episodes }
}

/**
 * Compare real Word paragraphs with this operation's complete pinned Markdown.
 * @param file - Actual generated Word file.
 * @param contents - Ordered Markdown snapshots used for conversion.
 * @param config - Bundled Python and bounded verification settings.
 * @param signal - Initiating operation cancellation.
 */
export async function verifyWordBody(file: string, contents: string[], config: Config, signal: AbortSignal): Promise<void> {
  const info = await lstat(file)
  if (!info.isFile() || info.size > config.maxProjectBytes) throw Error('video_delivery_body_changed: Word 文件超出核对预算。')
  const runtime = await resolvePrimaryRuntime(config.source)
  const script = await readFile(new URL('../skills/office-support/export_docx.py', import.meta.url), 'utf8')
  await new Promise<void>((resolveRun, reject) => {
    const child = execFile(runtime.python, ['-c', script], {
      signal, windowsHide: true, timeout: config.timeoutMs, maxBuffer: 65536, env: { ...process.env, PYTHONUTF8: '1' },
    }, (error) => {
      if (error) reject(Error('video_delivery_body_changed: Word 正文与本次转换正文不一致或无法核对。'))
      else resolveRun()
    })
    child.stdin?.on('error', () => { /* execFile reports process failure through its callback. */ })
    child.stdin?.end(JSON.stringify({ inputs: contents.map(() => ''), contents, output: file,
      verify_only: true, max_input_bytes: config.maxInputBytes, max_docx_bytes: config.maxProjectBytes }))
  })
}

/**
 * Check files at the actual final-delivery executor, including generic Python exports.
 * @param files - Files about to be declared final deliverables.
 * @param config - Bundled offline verification runtime and host-selected read budgets.
 * @param signal - Delivery cancellation.
 * @param options - Internal conversion can defer the delivery pair until the actual present executor.
 */
export async function validateVideoDelivery(files: readonly string[], config: Config, signal: AbortSignal,
  options: { requireRefinementPair?: boolean; verifyStoryEvidence?: StoryEvidenceVerifier } = {}): Promise<void> {
  if (config.reviewMode === 'advisory') {
    for (const file of files) {
      signal.throwIfAborted()
      if (!isManuscript(file)) continue
      await readManuscript(file, dirname(resolve(file)), {
        maxFileBytes: extname(file).toLowerCase() === '.docx' ? config.maxProjectBytes : config.maxInputBytes,
        maxTextChars: config.maxInputBytes,
      }, signal)
    }
    return
  }
  const { maxProjectBytes } = config
  const pairedNotes = new Set<string>()
  for (const file of files) {
    signal.throwIfAborted()
    const extension = extname(file).toLowerCase()
    if (!['.md', '.markdown', '.docx', '.txt', '.doc', '.pdf', '.html', '.rtf', '.odt', '.epub',
      '.xlsx', '.xls', '.ods', '.csv', '.pptx', '.ppt', '.odp'].includes(extension)) continue
    const projects = await scopedProjects([file], maxProjectBytes, undefined, options.verifyStoryEvidence)
    const receiptText = extension === '.docx' ? await optionalText(`${file}.screenplay.json`, maxProjectBytes) : undefined
    if (projects.length === 0 && receiptText === undefined) continue
    if (extension === '.md') {
      const text = await readFile(file, 'utf8')
      if (projects.some(project => project.scripts.some(candidate => candidate.modification_notes !== undefined
        && candidate.modification_notes === text))) continue
      await approveVideoMarkdown([file], file, maxProjectBytes, undefined, options.verifyStoryEvidence)
      for (const project of projects) for (const candidate of project.scripts) {
        if (candidate.script === text && candidate.modification_notes !== undefined) pairedNotes.add(candidate.modification_notes)
      }
      continue
    }
    if (extension !== '.docx' || receiptText === undefined) {
      throw Error('video_delivery_unaccepted: 受管视频正式交付仅接受已验收 Markdown 或经校验的 Word。')
    }
    const checked = receipt.parse(JSON.parse(receiptText))
    if (sha256(await readFile(file)) !== checked.output_sha256) throw Error('video_delivery_changed: Word 文件与验收导出记录不一致。')
    const contents: string[] = []
    for (const episode of checked.episodes) {
      const owner = await projectAt(episode.project, maxProjectBytes, options.verifyStoryEvidence)
      if (projects.length > 0 && !projects.some(value => value.path === owner?.path)) {
        throw Error('video_delivery_project: Word 验收记录不属于当前正式交付目录的项目。')
      }
      const candidate = owner?.scripts.find(value => value.id === episode.candidate_id)
      if (owner?.project.id !== episode.project_id || candidate === undefined || candidate.sha256 !== episode.candidate_sha256
        || sha256(candidate.script) !== episode.script_sha256
        || (candidate.modification_notes === undefined ? undefined : sha256(candidate.modification_notes))
          !== episode.modification_notes_sha256) {
        throw Error('video_delivery_unaccepted: Word 引用的候选未验收或已经变更。')
      }
      contents.push(candidate.script)
      if (projects.length > 0 && candidate.modification_notes !== undefined) pairedNotes.add(candidate.modification_notes)
    }
    await verifyWordBody(file, contents, config, signal)
    if (sha256(await readFile(file)) !== checked.output_sha256) throw Error('video_delivery_changed: Word 文件在核对期间变更。')
  }
  // Only conventional managed final directories require the formal delivery pair.
  // Receipt-bound Word resends elsewhere retain their existing standalone verification.
  if (options.requireRefinementPair !== false && pairedNotes.size > 0) {
    const included = new Set<string>()
    for (const file of files) {
      signal.throwIfAborted()
      if (extname(file).toLowerCase() !== '.md') continue
      const text = await optionalText(file, maxProjectBytes)
      if (text !== undefined) included.add(text)
    }
    for (const notes of pairedNotes) if (!included.has(notes)) {
      throw Error('refinement_delivery_pair: 正式精修交付须并列包含同一验收版本的《修改说明》文件。')
    }
  }
}
