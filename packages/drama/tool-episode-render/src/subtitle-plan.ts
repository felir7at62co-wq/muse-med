/** Source-bound decisions that avoid overlaying matching dialogue already in video pixels. */
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { fileSha256 } from './cache.ts'
import { episodePaths, shotFileName } from './paths.ts'
import { formatSrtDocument, parseSrtDocument } from './subtitles.ts'
import type { EmbeddedSubtitleDecision, SubtitleCue, SubtitleOverlayReport, Timeline } from './types.ts'

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象。`)
  return value as Record<string, unknown>
}

function nonblank(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空文字。`)
  return value
}

function seconds(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} 必须是非负有限秒数。`)
  return value
}

/** Parse the file's explicit retain-embedded decisions; no OCR claim becomes trusted evidence.
 * @param value - Parsed plan JSON.
 * @returns Validated shot-local decisions.
 */
export function parseSubtitlePlan(value: unknown): EmbeddedSubtitleDecision[] {
  const plan = object(value, 'subtitle_plan')
  if (plan.schema_version !== 1 || !Array.isArray(plan.decisions)) throw new Error('subtitle_plan 需要 schema_version=1 和 decisions 数组。')
  return plan.decisions.map((entry, index) => {
    const row = object(entry, `decisions[${String(index)}]`)
    if (typeof row.shot !== 'number' || !Number.isSafeInteger(row.shot) || row.shot < 1) throw new Error('字幕决定的 shot 必须是正整数。')
    const hash = nonblank(row.source_sha256, 'source_sha256')
    if (!/^[a-f\d]{64}$/iu.test(hash)) throw new Error('source_sha256 必须是 64 位十六进制 SHA-256。')
    if (row.action !== 'retain_embedded') throw new Error('字幕决定仅支持 action=retain_embedded。')
    const start = seconds(row.start_seconds, 'start_seconds'), end = seconds(row.end_seconds, 'end_seconds')
    if (end <= start) throw new Error('字幕决定的 end_seconds 必须大于 start_seconds。')
    const evidence = row.evidence_paths ?? []
    if (!Array.isArray(evidence) || evidence.some(item => typeof item !== 'string' || !item.trim())) throw new Error('evidence_paths 必须是非空路径字符串数组。')
    return { shot: row.shot, source_sha256: hash.toLowerCase(), start_seconds: start, end_seconds: end,
      text: nonblank(row.text, 'text'), action: row.action, reason: nonblank(row.reason, 'reason'),
      evidence_paths: evidence.map(item => nonblank(item, 'evidence_paths')) }
  })
}

function textKey(text: string): string { return text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '').toLowerCase() }
function micros(seconds: number): number { return Math.round(seconds * 1_000_000) }
const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

async function requireUnlinkedOutput(file: string, project: string): Promise<void> {
  for (let current = file; current !== resolve(project); current = dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('字幕导出路径不得经过符号链接或 junction。')
    } catch (error) {
      if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }
    if (current === dirname(current)) break
  }
}

async function requireAbsent(file: string): Promise<void> {
  try { await lstat(file) }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  throw Object.assign(new Error(`字幕导出已存在，不覆盖：${file}`), { code: 'EEXIST' })
}

/** Resolve an authored plan against the selected, byte-identical prepared videos.
 * @param input - Original SRT, real timeline and authored plan; all paths are absolute.
 * @returns New overlay cues, immutable evidence files and non-blocking review observations.
 */
export async function resolveSubtitleOverlay(input: {
  readonly project: string
  readonly episode: string
  readonly timeline: Timeline
  readonly subtitleSrt: string
  readonly planPath: string
  readonly outputSrt?: string
}): Promise<{ cues: SubtitleCue[]; report: SubtitleOverlayReport; written: string[]; warnings: string[] }> {
  const original = await readFile(input.subtitleSrt)
  const planBytes = await readFile(input.planPath)
  const decisions = parseSubtitlePlan(JSON.parse(planBytes.toString('utf8').replace(/^\ufeff/u, '')))
  const cues = parseSrtDocument(original.toString('utf8'), input.subtitleSrt)
  const paths = episodePaths(input.project, input.episode)
  const sources = new Map<number, { shot: number; path: string; sha256: string }>()
  for (const clip of input.timeline.clips) {
    const video = resolve(paths.videoDir, shotFileName(clip.shot))
    sources.set(clip.shot, { shot: clip.shot, path: video, sha256: await fileSha256(video) })
  }
  const retained = new Set<number>()
  const retainedEmbedded: SubtitleOverlayReport['retained_embedded'][number][] = []
  const warnings: string[] = []
  const findings = []
  for (const [index, decision] of decisions.entries()) {
    const clip = input.timeline.clips.find(candidate => candidate.shot === decision.shot)
    if (!clip) throw new Error(`字幕决定的 shot=${String(decision.shot)} 不在时间线内。`)
    if (micros(decision.end_seconds) > clip.durationUs) throw new Error(`shot=${String(decision.shot)} 的字幕决定越过片段末尾。`)
    const source = sources.get(clip.shot)
    if (source === undefined) throw new Error(`字幕决定缺少所选源视频：shot=${String(clip.shot)}。`)
    if (source.sha256 !== decision.source_sha256) throw new Error(`shot=${String(clip.shot)} 字幕决定的源视频 SHA-256 已变化，请重新预览该片段。`)
    const start = clip.startUs + micros(decision.start_seconds), end = clip.startUs + micros(decision.end_seconds)
    const matched: number[] = []
    const uncertain: number[] = []
    for (const cue of cues) {
      const cueStart = micros(cue.startSeconds), cueEnd = micros(cue.endSeconds)
      if (cueEnd <= start || cueStart >= end) continue
      if (textKey(cue.text) && textKey(cue.text) === textKey(decision.text)
        && cueEnd > cueStart && cueStart >= start && cueEnd <= end
        && cueStart >= clip.startUs && cueEnd <= clip.startUs + clip.durationUs) {
        matched.push(cue.index)
        if (!retained.has(cue.index)) retainedEmbedded.push({ cue_index: cue.index, shot: clip.shot, text: cue.text,
          start_seconds: cue.startSeconds, end_seconds: cue.endSeconds, source_sha256: source.sha256, editable: false })
        retained.add(cue.index)
      } else uncertain.push(cue.index)
    }
    if (!matched.length || uncertain.length) warnings.push(`第 ${String(index + 1)} 项已有字幕决定未完整覆盖同文 cue${uncertain.length ? `（${uncertain.join('、')}）` : ''}；未确定部分保留外加字幕，请用 video_inspect/video_ocr 预览，不自动切句。`)
    findings.push({ ...decision, global_start_seconds: start / 1_000_000, global_end_seconds: end / 1_000_000,
      retained_cue_indexes: matched, review_cue_indexes: uncertain })
  }
  const overlay = cues.filter(cue => !retained.has(cue.index)).map((cue, index) => ({ ...cue, index: index + 1 }))
  if (retained.size) warnings.push('保留的原片字幕已烧录在画面中，不可作为字幕编辑，也无法用外加字幕样式统一其字号和位置；原始 SRT 保留作对白参考。')
  warnings.push('字幕决定与 evidence_paths 由调用方声明，不是 Host 签发的 OCR 或人工验收凭据；抽帧漏检、噪声及内容准确度仍需预览。')
  let resolvedSrt: string, decisionReport: string
  if (input.outputSrt !== undefined) {
    resolvedSrt = resolve(input.project, input.outputSrt)
    const inside = relative(input.project, resolvedSrt)
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('subtitle_overlay output 必须在项目目录内。')
    decisionReport = `${resolvedSrt}.decision-report.json`
    await requireUnlinkedOutput(resolvedSrt, input.project)
    await requireUnlinkedOutput(decisionReport, input.project)
    await mkdir(dirname(resolvedSrt), { recursive: true })
  } else {
    const parent = resolve(input.project, 'editing', 'subtitle-overlays')
    await requireUnlinkedOutput(parent, input.project)
    await mkdir(parent, { recursive: true })
    const directory = await mkdtemp(resolve(parent, `ep${input.episode}-`))
    resolvedSrt = resolve(directory, 'resolved-overlay.srt')
    decisionReport = resolve(directory, 'decision-report.json')
  }
  await requireAbsent(resolvedSrt)
  await requireAbsent(decisionReport)
  const resolvedText = formatSrtDocument(overlay)
  const report: SubtitleOverlayReport = {
    episode: input.episode, plan_path: input.planPath, plan_sha256: digest(planBytes), original_srt: input.subtitleSrt,
    original_srt_sha256: digest(original), resolved_srt: resolvedSrt, resolved_srt_sha256: digest(resolvedText),
    decision_report: decisionReport, sources: [...sources.values()], retained_cue_indexes: [...retained].sort((a, b) => a - b),
    timeline_clips: input.timeline.clips.map(clip => ({ shot: clip.shot, start_us: clip.startUs, duration_us: clip.durationUs })),
    retained_embedded: retainedEmbedded,
    original_cue_count: cues.length, overlay_cue_count: overlay.length, evidence_kind: 'caller_declared',
    retained_text_editable: false, retained_text_style_adjustable: false,
  }
  for (const source of sources.values()) if (await fileSha256(source.path) !== source.sha256) throw new Error('解析期间源视频变化，未发布字幕决定。')
  if (digest(await readFile(input.subtitleSrt)) !== report.original_srt_sha256
    || digest(await readFile(input.planPath)) !== report.plan_sha256) throw new Error('解析期间字幕或计划变化，未发布字幕决定。')
  await writeFile(resolvedSrt, resolvedText, { encoding: 'utf8', flag: 'wx' })
  try {
    await writeFile(decisionReport, `${JSON.stringify({ schema_version: 1, ...report, decisions: findings, warnings }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    // Only this invocation's new, unchanged SRT can be rolled back; an existing
    // or concurrently published sidecar is never removed.
    try {
      if (!(await lstat(resolvedSrt)).isSymbolicLink()
        && digest(await readFile(resolvedSrt)) === report.resolved_srt_sha256) await rm(resolvedSrt)
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], '字幕决定报告写入失败，且新建 SRT 回滚失败；保留文件供核对。')
    }
    throw error
  }
  return { cues: overlay, report, written: [resolvedSrt, decisionReport], warnings }
}
