/** Prepare the actual final audio for a separate listening review without scoring it. */
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { requireProjectAudioFile } from './audio.ts'
import { fileSha256 } from './cache.ts'
import { prepareRenderedDraftMix } from './draft-playback-mix.ts'
import { readSourceRecord, sourceRecordPathFor } from './source-record.ts'
import type { MediaToolkit } from './types.ts'

const pictureProbe = z.object({ streams: z.array(z.object({
  start_time: z.string(), duration: z.string(),
})).length(1) })

/** File and sample identity for the exact local listening input. */
export interface ContentListeningPreparation {
  readonly status: 'prepared_for_review'
  readonly listening_verified: false
  readonly grants_approval: false
  readonly source_path: string
  readonly source_sha256: string
  readonly source_record_sha256: string
  readonly wav_path: string
  readonly wav_sha256: string
  readonly pcm_sha256: string
  readonly duration_us: number
  readonly sample_count: number
  readonly sample_rate: 48000
  readonly channels: 2
  readonly receipt_path: string
}

function pending(message: string, cause?: unknown): HarnessError {
  return new HarnessError(message, 'CONTENT_LISTENING_PREPARATION_FAILED',
    cause === undefined ? {} : { cause })
}

/**
 * Read the single zero-based MP4 picture clock for a full-playback check.
 * @param toolkit - Host media process runner and FFprobe executable.
 * @param output - Rendered MP4 path to probe.
 * @returns Duration of the picture stream in microseconds.
 */
export async function pictureDurationUs(toolkit: MediaToolkit, output: string): Promise<number> {
  const probe = await toolkit.channel.run(toolkit.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file',
    '-f', 'mov', '-select_streams', 'v', '-show_entries', 'stream=start_time,duration', '-of', 'json', output])
  if (probe.code !== 0) throw pending('无法读取成片画面时间。请确认所选文件是实际渲染出的完整 MP4。')
  let json: unknown
  try { json = JSON.parse(probe.stdout) } catch (error) {
    throw pending('成片画面时间报告损坏。请重新提取试听音轨。', error)
  }
  const result = pictureProbe.safeParse(json)
  const stream = result.success ? result.data.streams[0] : undefined
  const durationUs = stream === undefined ? NaN : Math.round(Number(stream.duration) * 1_000_000)
  if (stream === undefined || !stream.start_time.trim() || Number(stream.start_time) !== 0
    || !Number.isSafeInteger(durationUs) || durationUs <= 0) {
    throw pending('试听准备要求一条从零开始且时长可测量的成片画面。请重新核对渲染输出。')
  }
  return durationUs
}

/** Extract a sample-accurate stereo WAV with the same playback as the current episode MP4.
 * @param input - Current episode render, project and owned media execution range. An optional signal also cancels file operations.
 * @returns A new local WAV and its digest receipt. No listening or delivery decision is made.
 */
export async function prepareContentListeningAudio(input: {
  readonly toolkit: MediaToolkit
  readonly project: string
  readonly episode: string
  readonly output: string
  readonly signal?: AbortSignal
}): Promise<ContentListeningPreparation> {
  const { toolkit, episode, signal } = input
  signal?.throwIfAborted()
  const project = await realpath(input.project)
  const output = await requireProjectAudioFile(input.project, input.output)
  if (extname(output).toLowerCase() !== '.mp4') throw pending('请提供本集实际渲染输出的 MP4。')
  const sourceRecord = sourceRecordPathFor(output)
  const sourceInfo = await lstat(sourceRecord).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw pending('找不到成片旁边的有效来源回执。请选用本次渲染原样返回的 MP4。', error)
    }
    throw error
  })
  if (!sourceInfo.isFile() || sourceInfo.size <= 0 || sourceInfo.size > 8 * 1024 * 1024) {
    throw pending('找不到成片旁边的有效来源回执。请选用本次渲染原样返回的 MP4。')
  }
  const sourceRecordSha = await fileSha256(sourceRecord, signal)
  const record = await readSourceRecord(sourceRecord)
  if (record === undefined || record.episode !== episode || typeof record.output.path !== 'string'
    || !isAbsolute(record.output.path) || relative(output, record.output.path) !== ''
    || !/^[0-9a-f]{64}$/u.test(record.output.sha256) || record.output.size_bytes !== (await lstat(output)).size
    || !Number.isFinite(record.output.duration_seconds) || record.output.duration_seconds <= 0) {
    throw pending('成片来源回执里的集号、路径或文件信息不匹配。请选用当前同一集的原成片。')
  }
  const pictureUs = await pictureDurationUs(toolkit, output)
  // MP4 format duration may be rounded up to the container's millisecond time unit.
  if (Math.abs(pictureUs - Math.round(record.output.duration_seconds * 1_000_000)) > 1000) {
    throw pending('实际画面时长与成片来源回执不符。请重新核对当前成片。')
  }

  const audioRoot = join(project, 'audio')
  await mkdir(audioRoot, { recursive: true })
  if (relative(audioRoot, await realpath(audioRoot)) !== '') throw pending('项目 audio 目录发生重定向，无法安全保留试听材料。')
  const directory = await mkdtemp(join(audioRoot, 'content-listening-'))
  const wavPath = join(directory, 'full-playback.wav')
  const receiptPath = join(directory, 'preparation.json')
  try {
    const playback = await prepareRenderedDraftMix(toolkit, output, record.output.sha256, wavPath, signal)
    // Permit one PCM sample of rounding when the picture ends between samples.
    if (Math.abs(playback.duration_us - pictureUs) > Math.ceil(1_000_000 / playback.sample_rate)) {
      throw pending('实际音轨未覆盖完整画面时长。请核对正文、片尾和最终混音后重新渲染。')
    }
    if (await fileSha256(sourceRecord, signal) !== sourceRecordSha) {
      throw pending('提取期间成片来源回执发生变化。请用固定版本重新提取。')
    }
    signal?.throwIfAborted()
    await chmod(wavPath, 0o600)
    const prepared: ContentListeningPreparation = { status: 'prepared_for_review', listening_verified: false,
      grants_approval: false, source_path: output, source_sha256: playback.source_mp4_sha256,
      source_record_sha256: sourceRecordSha, wav_path: wavPath, wav_sha256: playback.sha256,
      pcm_sha256: playback.pcm_sha256, duration_us: playback.duration_us, sample_count: playback.sample_count,
      sample_rate: playback.sample_rate, channels: playback.channels, receipt_path: receiptPath }
    await writeFile(receiptPath, `${JSON.stringify(prepared, null, 2)}\n`, { flag: 'wx', mode: 0o600, signal })
    return prepared
  } catch (error) {
    await Promise.all([rm(wavPath, { force: true }), rm(receiptPath, { force: true })])
    await rmdir(directory)
    if (signal?.aborted) signal.throwIfAborted()
    if (error instanceof HarnessError) throw error
    throw pending('准备成片试听材料失败。请核对当前成片与来源回执后重试。', error)
  }
}
