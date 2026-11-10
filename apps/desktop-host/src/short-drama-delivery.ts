/** Check current episode artifacts before declaring or sending a short-drama candidate. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tool-present'
import type {} from '@deepseek-ai/dsh-tools'
import { findShortDramaProject } from '@deepseek-ai/dsh-tool-episode-render'
import { z } from 'zod'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const absolute = z.string().refine(isAbsolute)
const candidate = z.object({ version: z.literal(1), status: z.literal('candidate'), episode: z.string().regex(/^\d{2,}$/u),
  video: absolute, draft: absolute, sha256: hash, working_output: absolute,
  render_source_sha256: hash, draft_source_sha256: hash })
const fileDigest = z.object({ path: absolute, sha256: hash.nullable() })
const videoDigest = z.object({ shot: z.number().int().positive(), sha256: hash })
const PRODUCT_FONT = 'Zhuque Fangsong (technical preview)'
const productVisual = z.object({ schema_version: z.literal(1), reference_width: z.literal(480), reference_height: z.literal(854),
  font_size_px: z.literal(46), outline_px: z.literal(1.25), center_y_ratio: z.literal(0.736747073), max_width_ratio: z.literal(0.9),
  font_family: z.literal(PRODUCT_FONT) })
const DISPLAY_CHECKS = ['subtitle_display_text', 'subtitle_display_width', 'subtitle_display_font']
const visualVerification = z.object({ version: z.literal(1), subtitle_sha256: hash,
  report_path: absolute, report_sha256: hash, requested_font: z.string(),
  delivery: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive() }).optional(),
  visual: z.unknown().optional(),
  checks: z.array(z.object({ id: z.string(), ok: z.boolean() })) })
const renderRecord = z.object({ version: z.literal(1), episode: z.string(),
  output: z.object({ path: absolute, sha256: hash }),
  delivery_inputs: z.object({ timeline_sha256: hash, subtitle_sha256: hash, master_audio_sha256: hash,
    source_qa_sha256: hash.optional(), subtitle_visual_verification: visualVerification.optional(),
    videos: z.array(videoDigest).min(1) }),
  input_files: z.array(fileDigest).min(1), inputs: z.array(hash).min(1),
})
const draftRecord = z.object({ version: z.literal(1), episode: z.string(),
  timeline_sha256: hash, subtitle_sha256: hash, master_audio_sha256: hash.optional(),
  audio_mode: z.enum(['embedded', 'independent']), videos: z.array(videoDigest).min(1),
  files: z.array(z.object({ path: z.string(), sha256: hash })).min(2),
  materials: z.array(z.object({ path: absolute, sha256: hash })).min(1),
})
const VIDEO = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v'])
const FORMAL = new Set(['exports', 'export', 'final', '01_可交付视频'])
const RECEIPT = '成片与草稿回执.json'

function inside(root: string, file: string): boolean {
  const part = relative(root, file)
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

function pathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

const samePath = (left: string, right: string) => pathKey(left) === pathKey(right)

async function optionalFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile() }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true
    throw error
  }
}

async function digest(path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw Error(`short_drama_delivery_changed: 需要本地普通文件：${path}`)
  const value = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) {
    if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) throw Error('short_drama_delivery_changed: 文件读取返回未知字节类型。')
    value.update(chunk)
  }
  signal.throwIfAborted()
  return value.digest('hex')
}

async function boundJson(path: string, expected: string, signal: AbortSignal): Promise<unknown> {
  if (await digest(path, signal) !== expected) throw Error(`short_drama_delivery_changed: 交付证据已变化：${path}`)
  const bytes = await readFile(path)
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('short_drama_delivery_changed: 读取期间交付证据已变化。')
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''))
}

async function checkProductEvidence(source: z.infer<typeof renderRecord>, signal: AbortSignal): Promise<void> {
  const render = source.delivery_inputs, visual = render.subtitle_visual_verification
  if (render.source_qa_sha256 === undefined || !source.inputs.includes(render.source_qa_sha256)) {
    throw Error('short_drama_delivery_evidence: 正式短剧缺少当前选源检查证据。请按当前 Muse 配置重新 prepare、render 和 stage_delivery；旧候选或关闭项目检查不能代替。')
  }
  const timelineFile = source.input_files.find(file => file.sha256 === render.timeline_sha256
    && extname(file.path).toLowerCase() === '.json')
  if (timelineFile === undefined) throw Error('short_drama_delivery_evidence: 缺少已绑定的实际时间线，请重新 prepare 和渲染归档。')
  const timeline = z.object({ delivery: z.object({
    width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive(),
  }), clips: z.array(z.object({ shot: z.number().int().positive(),
    start_us: z.number().int().nonnegative(), duration_us: z.number().int().positive() })).min(1) })
    .parse(await boundJson(timelineFile.path, render.timeline_sha256, signal))
  const portrait = timeline.delivery.height > timeline.delivery.width
  if (visual === undefined && !portrait) return
  if (visual === undefined || (portrait && visual.requested_font !== PRODUCT_FONT) || visual.subtitle_sha256 !== render.subtitle_sha256
    || visual.delivery === undefined || visual.delivery.width !== timeline.delivery.width
    || visual.delivery.height !== timeline.delivery.height
    || visual.delivery.fps !== timeline.delivery.fps || (portrait && !productVisual.safeParse(visual.visual).success)
    || DISPLAY_CHECKS.some(id => !visual.checks.some(check => check.id === id && check.ok))
    || visual.checks.some(check => DISPLAY_CHECKS.includes(check.id) && !check.ok)
    || !source.input_files.some(file => samePath(file.path, visual.report_path) && file.sha256 === visual.report_sha256)) {
    throw Error('short_drama_delivery_evidence: 正式短剧缺少当前产品字幕格式及选源检查证据。请按当前 Muse 配置重新 prepare、render 和 stage_delivery；旧候选或关闭项目检查不能代替。')
  }
  const report = z.object({ schema_version: z.literal(1), status: z.literal('measured'), requested_font: z.string(),
    delivery_size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
    entries: z.array(z.object({ status: z.literal('measured'), fits_available_width: z.literal(true),
      selected_fonts: z.array(z.string()).min(1), fontselect_trace: z.array(z.string()).min(1) })) })
    .parse(await boundJson(visual.report_path, visual.report_sha256, signal))
  if (report.delivery_size.width !== timeline.delivery.width || report.delivery_size.height !== timeline.delivery.height
    || report.requested_font !== visual.requested_font) throw Error('short_drama_delivery_evidence: 字幕实测画布或字体与本集时间线及渲染记录不符。')
  if (!portrait) return
  const knownFace = (name: string) => name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === 'zhuquefangsongregular'
  if (report.entries.some(entry => entry.selected_fonts.some(name => !knownFace(name))
    || entry.fontselect_trace.some((line) => {
      const face = /\s->\s.+,\s*\d+,\s*([^,]+)$/u.exec(line)?.[1]?.trim()
      return face === undefined || !knownFace(face)
    }))) {
    throw Error('short_drama_delivery_font: 正式字幕未实测采用产品朱雀字族，请修复实际字体后重新渲染归档。')
  }
}

/** Identify only conventional final outputs of a project with a short-drama binding. */
async function formalProject(file: string): Promise<string | undefined> {
  let directory = dirname(file)
  while (true) {
    if (FORMAL.has(basename(directory).toLowerCase())) return await findShortDramaProject(dirname(directory))
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * Recheck the candidate receipt and every retained input at the final file operation.
 * A successful result retains candidate status; this does not approve content or editor appearance.
 * @param files - Absolute paths about to be presented or sent.
 * @param signal - The initiating operation's cancellation.
 * @param registered - Native episode outputs observed by this scoped Host plugin.
 */
export async function validateShortDramaDelivery(files: readonly string[], signal: AbortSignal,
  registered: ReadonlyMap<string, string> = new Map()): Promise<void> {
  for (const file of files) {
    if (!VIDEO.has(extname(file).toLowerCase())) continue
    const selected = resolve(file)
    const project = registered.get(selected) ?? registered.get(pathKey(selected)) ?? await formalProject(selected)
    if (project === undefined) continue
    if (basename(dirname(selected)) !== '01_可交付视频') {
      throw Error('short_drama_delivery_unstaged: 本集工作成片尚未归集。请用 drama_render stage_delivery 复验同集成片、字幕、时间线和草稿，再交付其返回的 candidate 视频。')
    }
    const episodeDir = dirname(dirname(selected)), receiptPath = resolve(episodeDir, RECEIPT)
    if (!(await optionalFile(receiptPath))) throw Error('short_drama_delivery_unstaged: 本集缺少成片与草稿回执，请先完成 stage_delivery。')
    const receiptSha = await digest(receiptPath, signal)
    const receipt = candidate.parse(await boundJson(receiptPath, receiptSha, signal))
    if (!samePath(receipt.video, selected) || !samePath(basename(selected), `第${receipt.episode}集.mp4`) || !inside(project, selected)
      || !samePath(dirname(receipt.draft), resolve(episodeDir, '02_剪映草稿'))
      || !inside(project, receipt.working_output)) throw Error('short_drama_delivery_scope: 回执不属于本集交付路径。')
    const root = await realpath(project)
    if (![selected, receipt.draft, receipt.working_output, receiptPath].every(path => inside(project, path))
      || !inside(root, await realpath(selected)) || !inside(root, await realpath(receipt.draft))
      || !inside(root, await realpath(receipt.working_output))) {
      throw Error('short_drama_delivery_scope: 交付文件或草稿不在本集项目内。')
    }
    const sourcePath = `${receipt.working_output}.source-record.json`
    const source = renderRecord.parse(await boundJson(sourcePath, receipt.render_source_sha256, signal))
    await checkProductEvidence(source, signal)
    if (source.episode !== receipt.episode || !samePath(source.output.path, receipt.working_output)
      || source.output.sha256 !== receipt.sha256 || await digest(selected, signal) !== receipt.sha256
      || await digest(receipt.working_output, signal) !== receipt.sha256) throw Error('short_drama_delivery_changed: 成片与本集渲染回执不符。')
    for (const input of source.input_files) {
      if (input.sha256 === null ? !await absent(input.path) : await digest(input.path, signal) !== input.sha256) {
        throw Error(`short_drama_delivery_changed: 成片输入已变化，需重新 prepare、render 和生成同集草稿：${input.path}`)
      }
    }
    const render = source.delivery_inputs
    const inputs = new Set(source.input_files.flatMap(input => input.sha256 === null ? [] : [input.sha256]))
    if ([render.timeline_sha256, render.subtitle_sha256, render.master_audio_sha256, ...render.videos.map(row => row.sha256)]
      .some(value => !inputs.has(value))) throw Error('short_drama_delivery_unstaged: 渲染回执未完整绑定本集输入。')
    const draftSourcePath = resolve(receipt.draft, 'muse-episode-source.json')
    const draft = draftRecord.parse(await boundJson(draftSourcePath, receipt.draft_source_sha256, signal))
    if (draft.episode !== receipt.episode || draft.timeline_sha256 !== render.timeline_sha256
      || draft.subtitle_sha256 !== render.subtitle_sha256 || JSON.stringify(draft.videos) !== JSON.stringify(render.videos)
      || (draft.audio_mode === 'independent' && draft.master_audio_sha256 !== render.master_audio_sha256)) {
      throw Error('short_drama_delivery_changed: 草稿与成片未使用同集字幕、时间线或选源。')
    }
    const nativeNames = new Set(draft.files.map(row => row.path))
    if (!['draft_content.json', 'draft_meta_info.json'].every(name => nativeNames.has(name))) throw Error('short_drama_delivery_unstaged: 草稿缺少原生文件记录。')
    // stage_delivery checked native draft bytes at pairing; later editor changes do not rewrite the MP4.
    for (const row of draft.materials) {
      if (!inside(project, row.path) || !inside(root, await realpath(row.path)) || await digest(row.path, signal) !== row.sha256) {
        throw Error('short_drama_delivery_changed: 草稿引用素材已变化或越出项目。')
      }
    }
    if (await digest(receiptPath, signal) !== receiptSha
      || await digest(sourcePath, signal) !== receipt.render_source_sha256
      || await digest(draftSourcePath, signal) !== receipt.draft_source_sha256) throw Error('short_drama_delivery_changed: 核对期间交付回执已变化。')
  }
}

/** Install episode-only checks at declared deliveries and before IM attachment registration/upload. */
export function installShortDramaDelivery(ctx: Context): void {
  const registered = new Map<string, string>()
  ctx.effect(() => () => { registered.clear() })
  ctx.on('deliverables/validate', (files, signal) => validateShortDramaDelivery(files, signal, registered))
  ctx.on('tools/execute', async (exec, next) => {
    if (['dsh_im_return_file', 'send_file'].includes(exec.name)) {
      const args = z.object({ path: z.string() }).safeParse(exec.arguments)
      if (args.success) {
        const path = resolve(exec.agent?.session.header.cwd ?? process.cwd(), args.data.path)
        await validateShortDramaDelivery([path], exec.signal, registered)
      }
    }
    const result = await next()
    if (exec.name === 'drama_render' && !result.isError) {
      const args = z.object({ project: z.string(), method: z.enum(['render', 'stage_delivery']) }).safeParse(exec.arguments)
      const report = z.object({ ok: z.literal(true), output: z.string().min(1), project: z.string().optional() }).safeParse(result.value)
      if (args.success && report.success) {
        const cwd = exec.agent?.session.header.cwd ?? process.cwd()
        const project = resolve(cwd, report.data.project ?? args.data.project)
        registered.set(pathKey(resolve(project, report.data.output)), project)
      }
    }
    return result
  })
}
