/** Accepted-only delivery for explicitly managed video screenplay final directories. */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { acceptedScripts, PROJECT_FILE, sha256 } from '@deepseek-ai/dsh-screenplay-project'
import { resolvePrimaryRuntime } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import type { Config } from './screenplay-docx.ts'

const receipt = z.strictObject({
  version: z.literal(1), output_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  episodes: z.array(z.strictObject({ project: z.string().min(1), project_id: z.string().min(1),
    candidate_id: z.string().min(1), candidate_sha256: z.string().min(1), script_sha256: z.string().min(1) })).min(1),
})

/** Application-issued verification data for one managed Word export. */
export type VideoExportReceipt = z.infer<typeof receipt>

async function optionalText(path: string, maxBytes: number): Promise<string | undefined> {
  const info = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (info === undefined) return undefined
  if (!info.isFile() || info.size > maxBytes) throw Error('video_delivery_project: 交付校验文件必须为预算内的普通文件。')
  return readFile(path, 'utf8')
}

async function projectAt(path: string, maxBytes: number) {
  const text = await optionalText(path, maxBytes)
  if (text === undefined) return undefined
  const marker = z.object({ workflow: z.unknown().optional() }).parse(JSON.parse(text))
  if (marker.workflow !== 'video_to_screenplay') return undefined
  const project = PROJECT_FILE.parse(JSON.parse(text))
  for (const source of project.sources) {
    if (sha256(await readFile(source.path)) !== source.sha256) throw Error('source_changed: 正式交付的来源已变更。')
  }
  return { path: await realpath(path), project, scripts: acceptedScripts(project) }
}

async function scopedProjects(paths: readonly string[], maxBytes: number, explicit?: string) {
  const projects = new Map<string, NonNullable<Awaited<ReturnType<typeof projectAt>>>>()
  const visited = new Set<string>()
  if (explicit !== undefined) {
    const value = await projectAt(explicit, maxBytes)
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
        const value = await projectAt(projectPath, maxBytes)
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
 * @returns Pinned accepted contents and receipt episodes, or undefined for ordinary conversion.
 */
export async function approveVideoMarkdown(inputs: readonly string[], output: string, maxProjectBytes: number, explicit?: string) {
  const projects = await scopedProjects([...inputs, output], maxProjectBytes, explicit)
  if (projects.length === 0) return undefined
  const episodes: VideoExportReceipt['episodes'] = [], contents: string[] = []
  for (const input of inputs) {
    const text = await readFile(input, 'utf8')
    const owner = projects.find(value => value.scripts.some(script => script.script === text))
    const candidate = owner?.scripts.find(script => script.script === text)
    if (owner === undefined || candidate === undefined) throw Error('video_delivery_unaccepted: 正式视频剧本必须与已验收候选正文一致。')
    contents.push(text)
    episodes.push({ project: owner.path, project_id: owner.project.id, candidate_id: candidate.id,
      candidate_sha256: candidate.sha256, script_sha256: sha256(text) })
  }
  return { contents, episodes }
}

async function verifyWordBody(file: string, contents: string[], config: Config, signal: AbortSignal): Promise<void> {
  const info = await lstat(file)
  if (!info.isFile() || info.size > config.maxProjectBytes) throw Error('video_delivery_body_changed: Word 文件超出核对预算。')
  const runtime = await resolvePrimaryRuntime(config.source)
  const script = await readFile(new URL('../skills/screenplay-format/scripts/export_docx.py', import.meta.url), 'utf8')
  await new Promise<void>((resolveRun, reject) => {
    const child = execFile(runtime.python, ['-c', script], {
      signal, windowsHide: true, timeout: config.timeoutMs, maxBuffer: 65536, env: { ...process.env, PYTHONUTF8: '1' },
    }, (error) => {
      if (error) reject(Error('video_delivery_body_changed: Word 正文与已验收正文不一致或无法核对。'))
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
 */
export async function validateVideoDelivery(files: readonly string[], config: Config, signal: AbortSignal): Promise<void> {
  const { maxProjectBytes } = config
  for (const file of files) {
    signal.throwIfAborted()
    const extension = extname(file).toLowerCase()
    if (!['.md', '.markdown', '.docx', '.txt', '.doc', '.pdf', '.html', '.rtf', '.odt', '.epub',
      '.xlsx', '.xls', '.ods', '.csv', '.pptx', '.ppt', '.odp'].includes(extension)) continue
    const projects = await scopedProjects([file], maxProjectBytes)
    const receiptText = extension === '.docx' ? await optionalText(`${file}.screenplay.json`, maxProjectBytes) : undefined
    if (projects.length === 0 && receiptText === undefined) continue
    if (extension === '.md') {
      await approveVideoMarkdown([file], file, maxProjectBytes)
      continue
    }
    if (extension !== '.docx' || receiptText === undefined) {
      throw Error('video_delivery_unaccepted: 受管视频正式交付仅接受已验收 Markdown 或经校验的 Word。')
    }
    const checked = receipt.parse(JSON.parse(receiptText))
    if (sha256(await readFile(file)) !== checked.output_sha256) throw Error('video_delivery_changed: Word 文件与验收导出记录不一致。')
    const contents: string[] = []
    for (const episode of checked.episodes) {
      const owner = await projectAt(episode.project, maxProjectBytes)
      if (projects.length > 0 && !projects.some(value => value.path === owner?.path)) {
        throw Error('video_delivery_project: Word 验收记录不属于当前正式交付目录的项目。')
      }
      const candidate = owner?.scripts.find(value => value.id === episode.candidate_id)
      if (owner?.project.id !== episode.project_id || candidate === undefined || candidate.sha256 !== episode.candidate_sha256
        || sha256(candidate.script) !== episode.script_sha256) {
        throw Error('video_delivery_unaccepted: Word 引用的候选未验收或已经变更。')
      }
      contents.push(candidate.script)
    }
    await verifyWordBody(file, contents, config, signal)
    if (sha256(await readFile(file)) !== checked.output_sha256) throw Error('video_delivery_changed: Word 文件在核对期间变更。')
  }
}
