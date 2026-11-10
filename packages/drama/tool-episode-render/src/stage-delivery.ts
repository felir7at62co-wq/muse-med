/** Publish a verified working MP4 next to its same-source editable draft. */

import { createHash } from 'node:crypto'
import { copyFile, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, format, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { hasSeparateAudio, verifySelectedSourceReviews } from './approved-sources.ts'
import { checkMusicDecision } from './bgm.ts'
import { fileSha256 } from './cache.ts'
import { findShortDramaProject, resolveDeliveryPolicy } from './delivery-policy.ts'
import { episodePaths, shotFileName } from './paths.ts'
import { parseShotManifest } from './prepare.ts'
import { readSourceRecord, sourceRecordPathFor, type DeliveryRenderInputs } from './source-record.ts'
import { reviewSpeechCoverage } from './speech-coverage.ts'
import { activeSubtitleVisual } from './subtitle-visual.ts'
import { parseSrtDocument } from './subtitles.ts'
import { parseTimelineDocument } from './timeline.ts'
import type { DramaRenderReport, TimelineClip } from './types.ts'
import { verifyEpisode, type VerifyInput } from './verify.ts'
import { summarizeSourceQa, type SourceQaVerifier } from './source-qa.ts'
import { assertVideoHashesAllowed } from './video.ts'

const DRAFTS = '02_剪映草稿'
const UPLOAD = '01_可交付视频'
const DRAFT_SOURCE = 'muse-episode-source.json'
const RECEIPT = '成片与草稿回执.json'
const DRAFT_FILES = ['draft_content.json', 'draft_meta_info.json']
const CANDIDATE_WARNING = '已归档技术检查通过的候选，画面、对白与字幕同步仍待内容验收。'

interface StageDeliveryInput extends VerifyInput {
  readonly transcriptsPath?: string
  readonly decisionsPath?: string
  readonly sourceQaVerifier?: SourceQaVerifier
}

const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function list(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function inside(root: string, path: string): boolean {
  const name = relative(root, path)
  return name !== '' && name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name)
}

async function localEntry(path: string) {
  try {
    // A trailing separator can make lstat follow a directory link; keep every raw parent component.
    let current = format(parse(path))
    const info = await lstat(current)
    let entry = info
    // Realpath can expand Windows short names without traversing a link.
    for (;;) {
      if (entry.isSymbolicLink()) throw new Error(`交付归档不接受通过链接访问的文件或目录：${path}`)
      const parent = dirname(current)
      if (parent === current) return info
      current = parent
      entry = await lstat(current)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

async function localDigest(path: string, optional = false): Promise<string | null> {
  const info = await localEntry(path)
  if (optional && info === undefined) return null
  if (!info?.isFile()) throw new Error(`交付归档需要可读取的普通文件：${path}`)
  return await fileSha256(path)
}

/** Read the same bytes the render receipt identifies before using them for a layout decision. */
async function readBoundText(path: string, expected: string): Promise<string> {
  const bytes = await readFile(path)
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error(`归档期间工作成片记录的输入已变化：${path}`)
  }
  return bytes.toString('utf8')
}

/** Use the renderer's exact consumed inputs when checking the episode's music decision. */
async function checkBoundMusicDecision(input: VerifyInput, music: DeliveryRenderInputs['music'], bodyEnd: number,
  checked: ReadonlyMap<string, string | null>) {
  const mode: unknown = music?.mode
  if (!object(music) || (mode !== 'music' && mode !== 'none') || typeof music.gain !== 'number') {
    throw new Error('工作成片缺少严格配乐来源，请以当前配乐决定重新执行 resume=true 渲染。')
  }
  const bound = (path: string | undefined, label: string) => {
    const sha = typeof path === 'string' && isAbsolute(path) && inside(input.project, path)
      ? checked.get(resolve(path)) : undefined
    if (path === undefined || !digest(sha)) throw new Error(`严格配乐归档需要渲染回执绑定本集${label}。`)
    return { path, sha }
  }
  const plan = bound(music.plan_path, '配乐计划 bgm_plan')
  const bed = music.mode === 'music' || music.bed_path !== undefined ? bound(music.bed_path, '实际采用的 BGM') : undefined
  const generation = music.mode === 'music' ? bound(music.generation_path, 'drama_bgm 合成收据 bgm_generation') : undefined
  if (generation !== undefined) {
    const file = await localEntry(generation.path)
    if (!file?.isFile() || file.size > 2_097_152) throw new Error('配乐合成收据必须是普通文件且不能超过 2 MiB。')
  }
  const verdict = checkMusicDecision({ project: input.project, episode: input.episode, bodyEnd,
    timelinePath: input.timelinePath, mode: music.mode, gain: music.gain, planPath: plan.path,
    planText: await readBoundText(plan.path, plan.sha), ...(bed === undefined ? {} : { bedSha: bed.sha }),
    ...(generation === undefined ? {} : { generationText: await readBoundText(generation.path, generation.sha) }),
  })
  return { ...verdict, mix_gain: music.gain, plan_sha256: plan.sha,
    ...(bed === undefined ? {} : { bed_sha256: bed.sha }),
    ...(generation === undefined ? {} : { generation_sha256: generation.sha }),
  }
}

/** Enforce the enabled display and picture-cut rules on the effective burned SRT. */
async function checkBoundSubtitleRules(input: VerifyInput, render: DeliveryRenderInputs,
  singleLine: boolean, noPunctuation: boolean, clips?: readonly TimelineClip[]): Promise<void> {
  if (!singleLine && !noPunctuation && clips === undefined) return
  const subtitleText = await readBoundText(input.subtitleSrt, render.subtitle_sha256)
  const cues = parseSrtDocument(subtitleText, input.subtitleSrt)
  const multiline = singleLine ? cues.filter(cue => /[\r\n]|\\[nN]/u.test(cue.text)) : []
  if (multiline.length > 0) {
    throw new Error(`第 ${multiline.map(cue => String(cue.index)).join('、')} 条字幕含有强制换行。`
      + '当前字幕视觉要求单行，请按已核对的字词时间拆分并重新渲染及生成同集草稿后归档。')
  }
  const punctuated = noPunctuation ? cues.filter(cue => /\p{P}/u.test(cue.text)) : []
  if (punctuated.length > 0) {
    throw new Error(`第 ${punctuated.map(cue => String(cue.index)).join('、')} 条字幕含有标点。`
      + '当前项目要求显示字幕无标点，请修正显示字幕并重新渲染及生成同集草稿后归档。')
  }
  const cuts = clips?.filter(clip => clip.startUs > 0).map(clip => ({
    actual: clip.startUs / 1_000_000,
    // A cue edge formatted as SRT may touch the cut at millisecond precision.
    srt: Math.round(clip.startUs / 1000) / 1000,
  })) ?? []
  for (const cue of cues) {
    if (!cue.text.trim()) continue
    const cut = cuts.find(point => cue.startSeconds < point.srt && cue.endSeconds > point.srt)
    if (cut !== undefined) {
      throw new Error(`第 ${String(cue.index)} 条字幕跨越 ${cut.actual.toFixed(6)} 秒画面切点。`
        + '请对照切点两侧的同源字词时间重新安排字幕，复验成片并生成同集草稿后再归档。')
    }
  }
}

/** Verify the editable draft, then match its selected body to the independently verified render. */
async function checkDraft(project: string, episode: string, draft: string, render: DeliveryRenderInputs,
  separateAudio: boolean, requireSpeech: boolean, episodeDir?: string): Promise<string> {
  const path = resolve(draft, DRAFT_SOURCE)
  const sha = await localDigest(path)
  const source: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!object(source) || source.version !== 1 || source.episode !== episode) throw new Error('剪映草稿来源回执集号或版本不符。')
  if (requireSpeech && (source.audio_mode !== 'independent' || source.track_verification !== 'independent-v1')) {
    throw new Error('严格归档需要剪映草稿的独立原声与字幕轨道核查。请用当前时间线和字幕重新生成本集独立音轨草稿。')
  }
  if (episodeDir !== undefined && (source.audio_mode !== 'independent' || source.material_scope !== 'episode')) {
    throw new Error('本集剪映草稿需要保留同集素材。请在本集 02_剪映草稿 目录重新生成独立音轨草稿。')
  }
  const episodeRoot = episodeDir === undefined ? undefined : await realpath(episodeDir)
  if (source.timeline_sha256 !== render.timeline_sha256 || source.subtitle_sha256 !== render.subtitle_sha256
    || !list(source.videos) || source.videos.length !== render.videos.length
    || source.videos.some((item, index) => !object(item) || item.shot !== render.videos[index]?.shot
      || item.sha256 !== render.videos[index]?.sha256)) {
    throw new Error('剪映草稿与成片使用的时间线、字幕或选片版本不符。')
  }
  if (!(source.audio_mode === 'embedded' && !separateAudio && source.master_audio_sha256 === undefined)
    && !(source.audio_mode === 'independent' && source.master_audio_sha256 === render.master_audio_sha256)) {
    throw new Error('剪映草稿与成片使用的整集原声版本不符。')
  }
  if (!list(source.files) || !list(source.materials)) {
    throw new Error('剪映草稿来源回执缺少原生草稿文件或保留的素材。')
  }
  const draftNames = new Set<string>()
  const materialDigests = new Set<string>()
  for (const [files, isMaterial] of [[source.files, false], [source.materials, true]] as const) {
    for (const file of files) {
      if (!object(file) || typeof file.path !== 'string' || !digest(file.sha256) || isAbsolute(file.path) !== isMaterial) {
        throw new Error('剪映草稿来源回执的文件路径或摘要无效。')
      }
      const target = resolve(draft, file.path)
      if (!inside(isMaterial ? project : draft, target) || await localDigest(target) !== file.sha256) {
        throw new Error(`剪映草稿记录的文件越界或已变化：${file.path}`)
      }
      if (isMaterial && episodeRoot !== undefined && !inside(episodeRoot, await realpath(target))) {
        throw new Error(`剪映草稿引用的素材不在本集目录：${file.path}`)
      }
      if (isMaterial) materialDigests.add(file.sha256)
      else draftNames.add(file.path)
    }
  }
  if (!DRAFT_FILES.every(name => draftNames.has(name))) throw new Error('剪映草稿来源回执缺少原生草稿文件。')
  const retained = [render.timeline_sha256, render.subtitle_sha256, ...render.videos.map(item => item.sha256)]
  if (source.audio_mode === 'independent') retained.push(render.master_audio_sha256)
  if (retained.some(sha256 => !materialDigests.has(sha256))) throw new Error('剪映草稿缺少已记录的本集素材。')
  if (sha === null || sha !== await localDigest(path)) throw new Error('归档期间剪映草稿来源回执已变化。')
  return sha
}

async function checkPreparedSources(project: string, episode: string, render: DeliveryRenderInputs,
  clips: DramaRenderReport['clips'], requireSpeech: boolean, requireSourceReview: boolean, sourceQaVerifier?: SourceQaVerifier) {
  const paths = episodePaths(project, episode)
  const sourceSha = await localDigest(paths.sources)
  const source: unknown = JSON.parse((await readFile(paths.sources, 'utf8')).replace(/^\uFEFF/u, ''))
  const rows = parseShotManifest(source, paths.sources)
  if (!object(source) || !list(source.shots) || rows.length !== render.videos.length
    || source.shots.some(item => !object(item)
      || !render.videos.some(video => video.shot === item.shot && video.sha256 === item.sha256))) {
    throw new Error('已准备的选源与工作成片不符，请重新 prepare 和渲染。')
  }
  const reviews = await verifySelectedSourceReviews(paths, rows, true, requireSourceReview, sourceQaVerifier)
  const sourceQa = requireSourceReview ? summarizeSourceQa(reviews) : undefined
  if (sourceQa !== undefined && render.source_qa_sha256 !== sourceQa.sha256) {
    throw new Error('当前源片复验与工作成片绑定的OCR或审看版本不同，请重新正式渲染。')
  }
  const approved = new Map(reviews.map(row => [row.shot, row]))
  const previouslyReviewed = source.shots.some(item => object(item) && item.review_sha256 !== undefined)
  if (requireSpeech || reviews.length > 0 || previouslyReviewed
    || Object.hasOwn(source, 'master_audio_sha256') || Object.hasOwn(source, 'timeline_clips')) {
    const clock = source.timeline_clips
    if (!list(clock) || clock.length !== clips.length || clock.some((row, index) => {
      const clip = clips[index]
      return !object(row) || clip === undefined || row.shot !== clip.shot
        || row.start_us !== clip.start_us || row.duration_us !== clip.duration_us
    })) {
      throw new Error('已准备的原声与当前时间线切点不符，请重新 prepare 和渲染。')
    }
    if (source.master_audio_sha256 !== render.master_audio_sha256) {
      throw new Error('已准备的整集原声与工作成片不符，请重新 prepare 和渲染。')
    }
  }
  if (reviews.length > 0 || previouslyReviewed) {
    if (source.shots.some((item) => {
      const stored = item as { shot: number; sha256?: unknown; audio_sha256?: unknown; review_sha256?: unknown }
      const row = approved.get(stored.shot)
      return row === undefined || row.videoSha256 !== stored.sha256 || row.audioSha256 !== stored.audio_sha256
        || row.reviewSha256 !== stored.review_sha256
    })) {
      throw new Error('已准备的画面、原声或审核版本与工作成片不符，请重新 prepare 和渲染。')
    }
  }
  if (sourceSha !== await localDigest(paths.sources)) throw new Error('归档期间已准备选源已变化。')
  return { sourceSha, rows, approved, sourceQa, separateAudio: rows.some(row => hasSeparateAudio(project, row)),
    reviewedAudioHashes: reviews.map(row => row.audioSha256).filter(sha => sha !== undefined) }
}

/** Compare against current source-bound word evidence before publishing a strict candidate. */
async function checkBoundSpeechCoverage(input: StageDeliveryInput, render: DeliveryRenderInputs,
  timeline: ReturnType<typeof parseTimelineDocument>, prepared: Awaited<ReturnType<typeof checkPreparedSources>>): Promise<string> {
  if (render.subtitle_display !== 'external') {
    throw new Error('严格声文检查需要完整的外加显示 SRT。带保留原片字幕的叠加渲染或未记录字幕来源的成片不能归档。')
  }
  const transcriptsPath = input.transcriptsPath
  if (transcriptsPath === undefined) throw new Error('严格声文检查缺少 speech_transcripts，请提供本集同源词级转写与完整显示字幕声明。')
  if (!inside(input.project, transcriptsPath)) throw new Error('严格声文检查的 speech_transcripts 必须位于当前项目内。')
  const transcriptMapSha = await localDigest(transcriptsPath)
  const mapping: unknown = JSON.parse(await readFile(transcriptsPath, 'utf8'))
  const display = object(mapping) ? mapping.display : undefined
  if (!object(display) || display.embedded !== false || display.subtitle_sha256 !== render.subtitle_sha256
    || !list(display.video_sha256) || display.video_sha256.length !== render.videos.length
    || display.video_sha256.some((sha, index) => sha !== render.videos[index]?.sha256)) {
    throw new Error('严格声文检查需要完整显示字幕声明：确认当前所选画面不保留原片烧字，声明须匹配本次 SRT 和全部视频的 SHA-256。')
  }
  const sources = new Map(prepared.rows.map(row => [row.shot, resolve(input.project, row.audio)]))
  const pictureHashes = new Map(render.videos.map(video => [video.shot, video.sha256]))
  const audioHashes = new Map(prepared.rows.map(row => [row.shot, hasSeparateAudio(input.project, row)
    ? prepared.approved.get(row.shot)?.audioSha256 : pictureHashes.get(row.shot)]))
  const coverage = await reviewSpeechCoverage({ project: input.project, timeline, sources,
    subtitleSrt: input.subtitleSrt, transcriptsPath,
    ...(input.decisionsPath === undefined ? {} : { decisionsPath: input.decisionsPath }) })
  if (transcriptMapSha !== await localDigest(transcriptsPath) || coverage.subtitle_sha256 !== render.subtitle_sha256
    || !coverage.evidence_complete || coverage.sources.some(source => source.sha256 !== audioHashes.get(source.shot))) {
    throw new Error('严格声文检查缺少与当前音轨和烧录字幕一致的完整词级证据。'
      + (coverage.warnings.length ? ` ${coverage.warnings.join('；')}` : ''))
  }
  const pending = coverage.findings.filter(finding => finding.review?.decision !== 'keep' && finding.review?.decision !== 'asr_error')
  if (pending.length > 0) {
    const detail = pending.slice(0, 5).map(finding => `${finding.start_seconds.toFixed(3)}–${finding.end_seconds.toFixed(3)} 秒「${finding.text}」`).join('；')
    throw new Error(`严格声文检查还有 ${String(pending.length)} 项字幕或发声待核：${detail}。`
      + '请用 speech_coverage 定位，修正并重做同集成片与草稿，或提供与本次证据匹配的逐项核听声明。')
  }
  return coverage.evidence_sha256
}

/**
 * Stage a technically verified candidate without changing the working render or the draft.
 * Input and publication paths must not traverse symbolic links or junctions.
 * Short-drama project markers require current source, speech and draft-track evidence even when
 * the project or saved timeline omits or disables the corresponding optional checks.
 * @param input - The working MP4 and its effective timeline and subtitle inputs.
 * @param draft - The saved native draft directory in this episode's draft folder.
 * @returns The verification report and, if staged, the exact candidate paths.
 */
export async function stageEpisodeDelivery(input: StageDeliveryInput, draft: string): Promise<DramaRenderReport> {
  const { project, episode, output, timelinePath, subtitleSrt } = input
  const draftRoot = dirname(draft)
  const episodeDir = dirname(draftRoot)
  if (!/^\d{2,}$/.test(episode) || basename(draftRoot) !== DRAFTS || !inside(project, draftRoot)
    || !(await localEntry(draft))?.isDirectory()) {
    throw new Error('请指定本集项目内 02_剪映草稿 下实际保存的剪映草稿目录。')
  }
  const labeledEpisode = /^第\s*([0-9]+)\s*集$|^EP[ _-]?([0-9]+)$/iu.exec(basename(episodeDir))
  const folderEpisode = labeledEpisode?.[1] ?? labeledEpisode?.[2]
  if (folderEpisode !== undefined && Number(folderEpisode) !== Number(episode)) {
    throw new Error(`交付目录集号 ${folderEpisode} 与工作成片集号 ${episode} 不符。请选择本集草稿目录。`)
  }
  const upload = resolve(episodeDir, UPLOAD)
  const video = resolve(upload, `第${episode}集.mp4`)
  const receipt = resolve(episodeDir, RECEIPT)
  if (extname(output).toLowerCase() !== '.mp4' || inside(upload, output)
    || [output, timelinePath, subtitleSrt].some(path => !inside(project, path))) {
    throw new Error('归档需要项目内的工作成片、时间线和实际烧录的 SRT。')
  }
  const sourcePath = sourceRecordPathFor(output)
  const sourceSha = await localDigest(sourcePath)
  const record = await readSourceRecord(sourcePath)
  const render = record?.delivery_inputs
  const inputFiles = record?.input_files
  if (record === undefined || render == null || !list(inputFiles) || !digest(record.output.sha256)
    || !list(record.inputs) || !record.inputs.every(digest)
    || !list(render.videos) || render.videos.length === 0) {
    throw new Error('工作成片缺少完整的单集续跑来源回执。请以 resume=true 重新渲染后归档。')
  }
  for (const path of [output, timelinePath, subtitleSrt]) {
    if (!(await localEntry(path))?.isFile()) throw new Error(`归档需要可读取的工作文件：${path}`)
  }
  const verified = { ...await verifyEpisode(input), method: 'stage_delivery' as const }
  if (!verified.ok) return verified
  if (!verified.checks.some(check => check.id === 'output_source_record' && check.ok)) {
    throw new Error('成片复验无法证明当前文件与本集来源回执一致。')
  }
  const shots = verified.clips.map(clip => clip.shot).sort((a, b) => a - b)
  if (shots.length !== render.videos.length || render.videos.some((item, index) =>
    !object(item) || item.shot !== shots[index] || !digest(item.sha256))) throw new Error('归档要求成片覆盖完整时间线选片。')

  return await withFileLock(receipt, async () => {
    const paths = episodePaths(project, episode)
    const checked = new Map<string, string | null>()
    for (const file of inputFiles) {
      if (!object(file) || typeof file.path !== 'string' || !isAbsolute(file.path)
        || (file.sha256 !== null && !digest(file.sha256))) {
        throw new Error('工作成片记录的输入路径或摘要无效。')
      }
      if (await localDigest(file.path, file.sha256 === null) !== file.sha256) {
        throw new Error(`工作成片记录的输入已变化：${file.path}`)
      }
      checked.set(resolve(file.path), file.sha256)
    }
    const expected: readonly [string, string][] = [
      [timelinePath, render.timeline_sha256], [subtitleSrt, render.subtitle_sha256],
      [paths.masterAudio, render.master_audio_sha256],
      ...render.videos.map(({ shot, sha256 }): [string, string] => [resolve(paths.videoDir, shotFileName(shot)), sha256]),
    ]
    if (expected.some(([path, sha]) => !digest(sha) || checked.get(resolve(path)) !== sha)) {
      throw new Error('工作成片未记录当前时间线、烧录字幕、整集原声或选片的文件摘要。')
    }
    const timelineText = await readBoundText(timelinePath, render.timeline_sha256)
    const timeline = parseTimelineDocument(JSON.parse(timelineText.replace(/^\uFEFF/u, '')), timelinePath)
    const policy = await resolveDeliveryPolicy(project, timeline.delivery)
    const shortDrama = await findShortDramaProject(project) !== undefined
    const musicDecision = policy.delivery.audio?.require_music_decision === true
      ? await checkBoundMusicDecision(input, render.music, timeline.bodyEndSeconds, checked) : undefined
    const requireSpeech = shortDrama || policy.delivery.subtitle?.require_speech_coverage === true
    const requireSourceReview = shortDrama || policy.delivery.require_source_review === true
    if (requireSpeech && !verified.checks.some(check => check.id === 'av_stream_clock' && check.ok)) {
      throw new Error('严格归档缺少成片音视频流的实测起止时间。请从当前已核对的原声与时间线重新渲染后复验。')
    }
    await checkBoundSubtitleRules(input, render, activeSubtitleVisual(policy.delivery) !== undefined,
      policy.delivery.subtitle?.require_no_punctuation === true, requireSpeech ? timeline.clips : undefined)
    const prepared = await checkPreparedSources(project, episode, render, verified.clips,
      requireSpeech, requireSourceReview, input.sourceQaVerifier)
    if (prepared.sourceQa?.files.some(file => checked.get(file.path) !== file.sha256)) {
      throw new Error('正式成片缺少当前OCR及审看文件的来源绑定，请以 resume=true 重新渲染。')
    }
    if (requireSpeech && checked.get(paths.sources) !== prepared.sourceSha) {
      throw new Error('严格声文检查需要工作成片绑定已准备的音画来源。请重新 prepare 并以 resume=true 渲染。')
    }
    const speechEvidence = requireSpeech ? await checkBoundSpeechCoverage(input, render, timeline, prepared) : undefined
    const draftSha = await checkDraft(project, episode, draft, render, prepared.separateAudio, requireSpeech,
      requireSourceReview ? episodeDir : undefined)
    const sha256 = record.output.sha256
    const body = `${JSON.stringify({ version: 1, status: 'candidate', episode, video, draft, sha256,
      working_output: output, render_source_sha256: sourceSha, draft_source_sha256: draftSha,
      ...(prepared.sourceQa === undefined ? {} : { source_qa_sha256: prepared.sourceQa.sha256 }),
      ...(musicDecision === undefined ? {} : { music_decision: musicDecision }),
      ...(speechEvidence === undefined ? {} : { speech_evidence_sha256: speechEvidence }) }, null, 2)}\n`
    const present = await localEntry(receipt)
    if (present !== undefined && (!present.isFile() || await readFile(receipt, 'utf8') !== body)) {
      throw new Error(`交付回执已存在并与本次候选不符：${receipt}`)
    }
    const directory = await localEntry(upload)
    if (directory !== undefined && !directory.isDirectory()) throw new Error(`交付位置不是文件夹：${upload}`)
    const entries = directory === undefined ? [] : await readdir(upload)
    const reused = entries.length === 1 && entries[0] === basename(video) && present !== undefined
      && await localDigest(video) === sha256
    if (!reused && entries.length > 0) throw new Error(`交付文件夹已有其他文件或冲突的成片：${upload}`)
    if (await localDigest(sourcePath) !== sourceSha) throw new Error('归档期间成片来源回执已变化。')

    const written: string[] = []
    await withFileLock(resolve(project, 'video-bans.json'), async () => {
      await assertVideoHashesAllowed(project, [sha256, ...record.inputs, ...render.videos.map(item => item.sha256),
        ...prepared.reviewedAudioHashes])
      const recheckSelection = async () => {
        if (prepared.sourceSha !== (await checkPreparedSources(project, episode, render, verified.clips,
          requireSpeech, requireSourceReview, input.sourceQaVerifier)).sourceSha
          || draftSha !== await localDigest(resolve(draft, DRAFT_SOURCE))
          || sourceSha !== await localDigest(sourcePath)) {
          throw new Error('归档期间选源、成片或草稿回执已变化。')
        }
      }
      if (reused) {
        if (await localDigest(output) !== sha256) throw new Error('归档期间工作成片已变化。')
        await recheckSelection()
        return
      }
      const staging = await mkdtemp(resolve(episodeDir, '.delivery-stage-'))
      const stagedVideo = resolve(staging, 'video.mp4')
      const stagedReceipt = resolve(staging, 'receipt.json')
      try {
        await copyFile(output, stagedVideo)
        if (await fileSha256(stagedVideo) !== sha256) throw new Error('归档期间工作成片已变化。')
        await recheckSelection()
        if (directory === undefined) await mkdir(upload)
        if (!(await localEntry(upload))?.isDirectory() || (await readdir(upload)).length > 0) {
          throw new Error(`归档期间交付文件夹已变化：${upload}`)
        }
        if (present === undefined) {
          await writeFile(stagedReceipt, body, { flag: 'wx', mode: 0o600 })
          await link(stagedReceipt, receipt)
          written.push(receipt)
        }
        // The receipt goes first. A matching receipt and empty upload folder can resume after interruption.
        await link(stagedVideo, video)
        written.push(video)
      } finally {
        await Promise.all([stagedVideo, stagedReceipt].map(async (path) => {
          await rm(path, { force: true })
        }))
        await rmdir(staging)
      }
    })
    return { ...verified, output: video, written, warnings: [...verified.warnings, CANDIDATE_WARNING],
      summary: { ...verified.summary, warnings: verified.summary.warnings + 1 },
      delivery_package: { status: 'candidate', video, draft, sha256, reused, receipt } }
  })
}
