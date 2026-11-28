/** Pair the exact current render with the editable draft's retained playback audio. */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import { deliveryPictureClockSchema, fileSha256, prepareRenderedDraftMix, readSourceRecord, renderedDraftMixSchema,
  requireRenderedPicturePts, sourceRecordPathFor, type RenderedDraftMix } from '@deepseek-ai/dsh-tool-episode-render/delivery'
import { z } from 'zod'
import { GuardianMediaChannel } from './episode-guardian-media.ts'

const sha = z.hash('sha256')
const path = z.string().min(1).refine(isAbsolute)
const shotSchema = z.object({ shot: z.number().int().positive(), sha256: sha })
const renderInputs = z.object({
  timeline_sha256: sha, subtitle_sha256: sha, master_audio_sha256: sha,
  videos: z.array(shotSchema).min(1),
  music: z.object({ mode: z.enum(['music', 'none']), bed_path: path.optional() }),
  picture_clock: deliveryPictureClockSchema.optional(),
})
const sourceRecord = z.object({
  episode: z.string(), output: z.object({ path, sha256: sha }),
  request_sha256: sha, delivery_inputs: renderInputs,
  input_files: z.array(z.object({ path, sha256: sha.nullable() })).min(1),
})
const savedReceipt = z.object({
  version: z.literal(1), episode: z.string(), audio_mode: z.literal('independent'),
  material_scope: z.literal('episode'), track_verification: z.literal('independent-v1'),
  timeline_sha256: sha, subtitle_sha256: sha, master_audio_sha256: sha,
  videos: z.array(shotSchema), rendered_mix: renderedDraftMixSchema,
  materials: z.array(z.object({ path, sha256: sha })),
  picture_clock: deliveryPictureClockSchema.optional(),
})
const pairedRequest = z.object({
  episode: z.number().int().positive(), project: path, rendered_output: path, audio_mode: z.literal('independent'),
  timeline: path, subtitle_srt: path, audio: path, videos: z.array(path).min(1),
  bgm: path.optional(), bgm_role: z.string().optional(), ending_audio: path.optional(), ending_effect: path.optional(),
})

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && !isAbsolute(rel) && rel.split(sep)[0] !== '..'
}

async function canonicalPath(value: string, type: 'file' | 'directory', label: string, limit?: number): Promise<string> {
  const expected = resolve(value), actual = await realpath(expected), entry = await lstat(expected)
  if (relative(expected, actual) !== '' || (type === 'file' ? !entry.isFile() : !entry.isDirectory())
    || (limit !== undefined && entry.size > limit)) {
    throw new Error(`${label} 需要有效且未链接的本地${type === 'file' ? '文件' : '目录'}。`)
  }
  return actual
}

async function projectFile(root: string, value: string, label: string, limit?: number): Promise<string> {
  if (!inside(root, value)) throw new Error(`${label} 需要位于当前项目内。`)
  return await canonicalPath(value, 'file', label, limit)
}

type BoundFile = { path: string; sha256: string }

/** The exact working render and draft inputs eligible for one generated playback track. */
export interface PairedDraftRender {
  readonly project: string
  readonly episode: string
  readonly drafts: string
  readonly materialRoot: string
  readonly output: BoundFile
  readonly receipt: BoundFile
  readonly files: readonly BoundFile[]
  readonly inputs: z.infer<typeof renderInputs>
}

/**
 * Validate all paired request inputs against the same working render.
 * @param request - Original JSON request validated before producing any candidate.
 * @param requestFile - The project's real request file.
 * @param draftRoot - Existing episode-local destination under the project.
 * @param workspace - Owning workspace for a registered tool call, when available.
 * @param limit - Maximum bytes for the source record.
 * @param signal - Cancellation from the native invocation.
 * @returns Current working output, source record and exact files required through publication.
 */
export async function findPairedDraftRender(request: unknown, requestFile: string, draftRoot: string,
  workspace: string | undefined, limit: number, signal: AbortSignal): Promise<PairedDraftRender> {
  signal.throwIfAborted()
  const args = pairedRequest.safeParse(request)
  if (!args.success) throw new Error('配套成片需要 audio_mode=independent，以及本集成片、主音轨、时间线和最终字幕的绝对路径。')
  const { data } = args
  const project = await canonicalPath(data.project, 'directory', '剧集项目')
  if (workspace !== undefined) {
    const owner = await realpath(workspace)
    if (relative(owner, project) !== '' && !inside(owner, project)) throw new Error('配套成片项目需要位于当前工作区内。')
  }
  await projectFile(project, requestFile, '草稿请求')
  const episode = String(data.episode).padStart(2, '0')
  const episodeDir = join(project, '视频', `第${episode}集`)
  const drafts = await canonicalPath(draftRoot, 'directory', '草稿目录')
  if (relative(join(episodeDir, '02_剪映草稿'), drafts) !== '') throw new Error('配套成片的草稿必须保存在本集 02_剪映草稿 目录。')
  const output = await projectFile(project, data.rendered_output, '配套成片')
  if (extname(output).toLowerCase() !== '.mp4') throw new Error('配套成片需要本次渲染实际返回的 MP4。')
  const recordPath = await projectFile(project, sourceRecordPathFor(output), '成片来源回执', limit)
  const recordSha = await fileSha256(recordPath, signal)
  const saved = sourceRecord.safeParse(await readSourceRecord(recordPath))
  if (!saved.success || saved.data.episode !== episode || relative(saved.data.output.path, output) !== ''
    || saved.data.delivery_inputs.videos.length !== data.videos.length) {
    throw new Error('缺少同集、同版且有配乐决定的成片来源回执，请用 resume=true 重新渲染。')
  }
  const { delivery_inputs: inputs, input_files: inputFiles } = saved.data
  if (inputs.picture_clock !== undefined && (inputs.picture_clock.clips.length !== inputs.videos.length
    || inputs.picture_clock.clips.some((clip, index) => clip.shot !== inputs.videos[index]?.shot))) {
    throw new Error('成片画面时钟的镜头顺序与同版成片来源回执不一致。')
  }
  const files: BoundFile[] = []
  const bind = async (file: string, label: string, expected: string | undefined, matchPath = true) => {
    const actual = await projectFile(project, file, label)
    if (expected === undefined || !inputFiles.some(row => row.sha256 === expected && (!matchPath || relative(row.path, actual) === ''))
      || await fileSha256(actual, signal) !== expected) {
      throw new Error(`草稿的${label}与配套成片不同，请使用本次渲染实际采用的文件。`)
    }
    files.push({ path: actual, sha256: expected })
  }
  await bind(data.timeline, '时间线', inputs.timeline_sha256)
  await bind(data.subtitle_srt, '字幕 (render_preview.subtitle.path)', inputs.subtitle_sha256)
  await bind(data.audio, '独立主音轨', inputs.master_audio_sha256)
  for (const [index, video] of data.videos.entries()) await bind(video, `镜头 ${index + 1}`, inputs.videos[index]?.sha256)

  const music = inputs.music
  if (music.mode === 'music') {
    if (music.bed_path === undefined || data.bgm === undefined || data.bgm_role !== 'music_only'
      || relative(data.bgm, music.bed_path) !== '') throw new Error('配套成片需要同版独立纯音乐 BGM。')
    await bind(data.bgm, 'BGM', inputFiles.find(row => relative(row.path, data.bgm ?? '') === '')?.sha256 ?? undefined)
  } else if (data.bgm !== undefined || music.bed_path !== undefined) throw new Error('草稿和成片的配乐决定不一致。')
  for (const [file, name] of [[data.ending_audio, 'ending_audio.mp3'], [data.ending_effect, 'ending_effect.mp4']] as const) {
    const rendered = inputFiles.filter(row => basename(row.path).toLowerCase() === name && row.sha256 !== null)
    if (rendered.length !== (file === undefined ? 0 : 1)) throw new Error('草稿和成片的片尾来源不一致。')
    if (file !== undefined) await bind(file, name, rendered[0]?.sha256 ?? undefined, false)
  }
  return { project, episode, drafts, materialRoot: join(episodeDir, '制作资料', '剪映素材'), output: { path: output, sha256: saved.data.output.sha256 },
    receipt: { path: recordPath, sha256: recordSha }, files, inputs }
}

/** Extract a bounded playback reference from the already prepared working MP4.
 * @param subprocess - Desktop's managed subprocess provider.
 * @param pair - Validated paired render and selected inputs.
 * @param target - New WAV in the invocation's private temporary directory.
 * @param config - Resolved media executables and process limits.
 * @param signal - Cancellation and timeout for the draft invocation.
 * @returns Host-owned playable PCM data for the managed Python request.
 */
export async function preparePairedDraftMix(subprocess: SubprocessRuntime, pair: PairedDraftRender, target: string,
  config: { ffmpeg: string; ffprobe: string; graceMs: number; maxOutputBytes: number }, signal: AbortSignal): Promise<RenderedDraftMix> {
  const { ffmpeg, ffprobe, graceMs, maxOutputBytes } = config
  const channel = new GuardianMediaChannel({ subprocess, cwd: pair.project, ffmpeg, ffprobe, graceMs, signal,
    stdoutBytes: maxOutputBytes, stderrBytes: maxOutputBytes })
  try {
    const toolkit = { ffmpeg, ffprobe, channel }
    const mix = await prepareRenderedDraftMix(toolkit, pair.output.path, pair.output.sha256, target, signal)
    const clock = pair.inputs.picture_clock
    if (clock !== undefined) {
      await requireRenderedPicturePts(toolkit, pair.output.path, clock)
      const expectedSamples = Math.round(clock.total_frames * mix.sample_rate / clock.fps)
      if (mix.sample_count !== expectedSamples || await fileSha256(pair.output.path, signal) !== pair.output.sha256
        || await fileSha256(pair.receipt.path, signal) !== pair.receipt.sha256) {
        throw new Error('配套成片的画面时钟、混音样本数或回执已不一致，请重新选用同版成片。')
      }
    }
    return mix
  } finally {
    if ((await channel.stopAndJoin()).kind !== 'empty') throw new Error('剪映播放音轨处理尚未确认已退出。')
  }
}

/** Recheck the retained mix, saved draft receipt and unchanged exact working inputs.
 * @param pair - Verified paired render and request files.
 * @param draft - Actual saved candidate returned by the generator.
 * @param materials - Actual episode-scoped materials directory returned by the generator.
 * @param mix - Host temporary playback track, already bound to the rendered MP4.
 * @param signal - Calling invocation cancellation.
 * @returns Retained playback metadata for this saved candidate.
 */
export async function confirmPairedDraftMix(pair: PairedDraftRender, draft: string, materials: string | undefined,
  mix: RenderedDraftMix, signal: AbortSignal): Promise<RenderedDraftMix> {
  if (!isAbsolute(draft) || relative(dirname(draft), pair.drafts) !== ''
    || materials === undefined || !isAbsolute(materials) || relative(dirname(materials), pair.materialRoot) !== '') {
    throw new Error('配套草稿或素材没有保存到本集目录。')
  }
  const directory = await canonicalPath(draft, 'directory', '剪映草稿')
  const materialDir = await canonicalPath(materials, 'directory', '本集草稿素材')
  const receipt = await projectFile(directory, join(directory, 'muse-episode-source.json'), '草稿回执', 4 * 1024 * 1024)
  const source = savedReceipt.parse(JSON.parse(await readFile(receipt, { encoding: 'utf8', signal })))
  const { rendered_mix: rendered } = source
  const retained = await projectFile(materialDir, rendered.path, '保留的配套混音')
  const videosEqual = source.videos.length === pair.inputs.videos.length && pair.inputs.videos.every((video, index) =>
    source.videos[index]?.shot === video.shot && source.videos[index].sha256 === video.sha256)
  if (source.episode !== pair.episode || source.timeline_sha256 !== pair.inputs.timeline_sha256
    || source.subtitle_sha256 !== pair.inputs.subtitle_sha256 || source.master_audio_sha256 !== pair.inputs.master_audio_sha256
    || !videosEqual || relative(join(materialDir, '07_rendered_mix', 'rendered_mix.wav'), retained) !== ''
    || !isDeepStrictEqual(source.picture_clock, pair.inputs.picture_clock)
    || rendered.sha256 !== mix.sha256 || rendered.pcm_sha256 !== mix.pcm_sha256 || rendered.source_mp4_sha256 !== mix.source_mp4_sha256
    || rendered.sample_count !== mix.sample_count || rendered.duration_us !== mix.duration_us
    || !source.materials.some(row => relative(row.path, retained) === '' && row.sha256 === mix.sha256)) {
    throw new Error('草稿保存后发现配套成片、素材或混音不一致。')
  }
  for (const file of [...pair.files, pair.output, pair.receipt, { path: retained, sha256: mix.sha256 }]) {
    if (await fileSha256(await projectFile(pair.project, file.path, '配套来源'), signal) !== file.sha256) {
      throw new Error('草稿保存期间配套成片或回执文件已经变化。')
    }
  }
  return { ...rendered, path: retained }
}
