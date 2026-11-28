/** Compare a render-bound body master with the playback of the current MP4, locally. */
import { createHash } from 'node:crypto'
import { lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { requireProjectAudioFile } from './audio.ts'
import { fileSha256 } from './cache.ts'
import { acousticRate, measureAcousticWindow } from './content-listening-acoustic.ts'
import { prepareContentListeningAudio } from './content-listening-audio.ts'
import { verifyRenderedDraftMix } from './draft-playback-mix.ts'
import { runFfmpeg } from './ffmpeg.ts'
import { episodePaths } from './paths.ts'
import { deliveryFrameTimeUs, deliveryPictureClockSchema } from './picture-clock.ts'
import { renderMusicStem } from './render-resume.ts'
import { readSourceRecord, sourceRecordPathFor } from './source-record.ts'
import type { DeliverySourceRecord } from './source-record.ts'
import { parseSrtDocument } from './subtitles.ts'
import type { MediaToolkit } from './types.ts'

const bytesPerFrame = 8 // stereo float32
const maxUs = 120_000_000
const windowSamples = acousticRate / 8
const sample = (us: number): number => Math.round(us * acousticRate / 1_000_000)
const timestamp = (frames: number): number => Math.round(frames * 1_000_000 / acousticRate)

function requirePreflight(valid: unknown, reason: string): asserts valid {
  if (!valid) throw new HarnessError(reason, 'CONTENT_LISTENING_PREFLIGHT_INPUT')
}

async function measureFile(toolkit: MediaToolkit, path: string, target: string, count: number, signal?: AbortSignal) {
  await runFfmpeg(toolkit, ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-threads', '1',
    '-f', 'wav', '-i', path, '-map', '0:a:0', '-vn', '-sn', '-dn', '-filter_threads', '1', '-af',
    `aresample=${String(acousticRate)},atrim=end_sample=${String(count)}`, '-c:a', 'pcm_f32le', '-ac', '2', '-n', '-f', 'f32le', target])
  const size = (await lstat(target)).size
  requirePreflight(size > 0 && size <= count * bytesPerFrame && size % bytesPerFrame === 0, '本机声学采样为空或超出同版成片时钟。')
  const buffer = await readFile(target, { signal })
  requirePreflight(buffer.byteLength === size, '本机声学采样在校验期间发生变化。')
  const data = new Float32Array(buffer.byteLength / 4)
  for (let i = 0; i < data.length; i++) {
    const item = buffer.readFloatLE(i * 4)
    requirePreflight(Number.isFinite(item), '本机声学采样包含无效值。')
    data[i] = item
  }
  return data
}

type PreflightWindow = Omit<ReturnType<typeof measureAcousticWindow>, 'lagSamples'> & {
  readonly shot: number
  readonly start_us: number
  readonly end_us: number
  readonly lag_us?: number
}
type ContentListeningPreflight = {
  readonly kind: 'muse_rendered_audio_preflight'
  readonly version: number
  readonly episode: string
  readonly status: 'needs_review' | 'issues_found'
  readonly listening_verified: boolean
  readonly grants_approval: boolean
  readonly source_sha256: string
  readonly source_record_sha256: string
  readonly pcm_sha256: string
  readonly preparation: string
  readonly comparison: string
  readonly expected_body_end_us: number
  readonly sample_rate: number
  readonly reference_files: { readonly path: string; readonly sha256: string }[]
  readonly source_music_mode: 'none' | 'music'
  readonly external_requests: number
  readonly matching_windows: number
  readonly issue_count: number
  readonly uncertain_windows: number
  readonly last_subtitle_end_us?: number
  readonly final_subtitle_following_signal?: PreflightWindow
  readonly final_subtitle_signal_issue?: boolean
  readonly limitations: string[]
  readonly receipt_path: string
  readonly findings: PreflightWindow[]
}

/**
 * Run the advisory version-bound waveform preflight with no external calls.
 * @param input - The current render, its project identity and optional displayed subtitles.
 * @returns The measured correspondence findings and the saved preflight receipt.
 */
export async function preflightContentListening(input: {
  readonly toolkit: MediaToolkit
  readonly project: string
  readonly episode: string
  readonly output: string
  readonly subtitleSrt?: string
  readonly signal?: AbortSignal
}): Promise<ContentListeningPreflight> {
  const { project, toolkit, signal } = input
  const output = await requireProjectAudioFile(project, input.output)
  const recordPath = await requireProjectAudioFile(project, sourceRecordPathFor(output))
  requirePreflight((await lstat(recordPath)).size <= 8 * 1024 * 1024, '成片来源回执超过本机预检容量。')
  const recordSha = await fileSha256(recordPath, signal), record = await readSourceRecord(recordPath)
  requirePreflight(record?.episode === input.episode && typeof record.output.path === 'string'
    && isAbsolute(record.output.path) && relative(output, record.output.path) === ''
    && record.delivery_inputs !== undefined && Array.isArray(record.input_files),
  '本机声学预检需要当前集完整原生渲染来源回执。')
  const delivery = record.delivery_inputs, inputs = record.input_files
  const clock = deliveryPictureClockSchema.safeParse(delivery.picture_clock)
  requirePreflight(clock.success, '当前成片缺少已核实的正文画面时间，声音错位留待核实。')
  const totalUs = deliveryFrameTimeUs(clock.data.total_frames, clock.data.fps)
  requirePreflight(totalUs <= maxUs && clock.data.body_end_us <= totalUs, '成片超出本机预检的画面时钟范围。')
  const master = await requireProjectAudioFile(project, episodePaths(project, input.episode).masterAudio)
  const hasInput = (path: string, digest: string) => inputs.some((file: NonNullable<DeliverySourceRecord['input_files']>[number]) =>
    typeof file.path === 'string' && isAbsolute(file.path) && relative(path, file.path) === '' && file.sha256 === digest)
  requirePreflight(hasInput(master, delivery.master_audio_sha256), '当前成片未绑定本集正文母轨。')
  const music = delivery.music?.mode
  requirePreflight(music === 'none' || music === 'music',
    '当前成片缺少确定的音乐选择或同版独立音乐轨，无法可信区分背景声与正文。')
  const paths = [{ path: recordPath, sha256: recordSha }, { path: master, sha256: delivery.master_audio_sha256 }]
  let stem: string | undefined
  if (music === 'music') {
    const sha256 = record.music_stem_sha256
    requirePreflight(sha256 !== undefined && /^[a-f0-9]{64}$/u.test(sha256), '当前成片缺少同版独立音乐轨摘要。')
    stem = await requireProjectAudioFile(project, renderMusicStem(output))
    paths.push({ path: stem, sha256 })
  }
  let lastSubtitleEndUs: number | undefined
  if (input.subtitleSrt !== undefined) {
    const subtitle = await requireProjectAudioFile(project, input.subtitleSrt)
    requirePreflight((await lstat(subtitle)).size <= 256 * 1024 && hasInput(subtitle, delivery.subtitle_sha256),
      '这份字幕与当前成片绑定的实际显示字幕不符。')
    paths.push({ path: subtitle, sha256: delivery.subtitle_sha256 })
    if (delivery.subtitle_display === 'external') {
      const srt = await readFile(subtitle, { signal })
      requirePreflight(srt.byteLength <= 256 * 1024 && createHash('sha256').update(srt).digest('hex') === delivery.subtitle_sha256,
        '这份字幕已与当前成片绑定的实际显示字幕不符。')
      const cues = parseSrtDocument(srt.toString('utf8'), subtitle)
      lastSubtitleEndUs = cues.length === 0 ? undefined : Math.round(Math.max(...cues.map(cue => cue.endSeconds)) * 1_000_000)
    }
  }
  const verifyPaths = async () => {
    const digests = await Promise.all(paths.map(file => fileSha256(file.path, signal)))
    requirePreflight(paths.every((file, index) => file.sha256 === digests[index]), '声学预检中当前成片的绑定材料已变化。')
  }
  await verifyPaths()
  const prep = await prepareContentListeningAudio({ ...input, output })
  requirePreflight(prep.source_record_sha256 === recordSha && Math.abs(prep.duration_us - totalUs) <= 21,
    '整集播放轨和正式画面时钟不一致。')
  const directory = dirname(prep.wav_path), count = sample(totalUs)
  const scratch = [join(directory, 'mix.f32'), join(directory, 'master.f32'), join(directory, 'music.f32')] as const
  try {
    const playback = await measureFile(toolkit, prep.wav_path, scratch[0], count, signal)
    const reference = await measureFile(toolkit, master, scratch[1], count, signal)
    requirePreflight(playback.length === count * 2, '最终成片采样时钟与画面不一致。')
    if (stem !== undefined) {
      const bed = await measureFile(toolkit, stem, scratch[2], count, signal)
      for (const [index, value] of playback.entries()) {
        const musicSample = bed[index]
        if (musicSample === undefined) break
        playback[index] = value - musicSample
      }
    }
    const bodyEnd = sample(clock.data.body_end_us)
    const window = (shot: number, start: number, end: number) => {
      signal?.throwIfAborted()
      const { lagSamples, ...result } = measureAcousticWindow(reference, playback, start, end, bodyEnd)
      return { shot, start_us: timestamp(start), end_us: timestamp(end), ...result,
        ...(lagSamples === undefined ? {} : { lag_us: timestamp(lagSamples) }) }
    }
    const windows = clock.data.clips.flatMap((clip) => {
      const end = sample(clip.start_us + clip.duration_us)
      const rows: ReturnType<typeof window>[] = []
      for (let start = sample(clip.start_us); start < end; start += windowSamples) {
        rows.push(window(clip.shot, start, Math.min(end, start + windowSamples)))
      }
      return rows
    })
    const findings = windows.filter(row => row.status !== 'matching')
    const audibleTailEnd = lastSubtitleEndUs === undefined ? undefined
      : Math.min(clock.data.body_end_us, timestamp(reference.length / 2), lastSubtitleEndUs + 250_000)
    const lastClip = clock.data.clips.at(-1)
    const subtitleTail = lastSubtitleEndUs !== undefined && audibleTailEnd !== undefined && lastClip !== undefined
      && lastSubtitleEndUs >= lastClip.start_us && audibleTailEnd - lastSubtitleEndUs >= 50_000 ? window(lastClip.shot,
        sample(lastSubtitleEndUs), sample(audibleTailEnd)) : undefined
    await verifyPaths()
    await verifyRenderedDraftMix(toolkit, output, { schema_version: 1, path: prep.wav_path, sha256: prep.wav_sha256,
      source_mp4_sha256: prep.source_sha256, pcm_sha256: prep.pcm_sha256, sample_count: prep.sample_count,
      duration_us: prep.duration_us, sample_rate: prep.sample_rate, channels: prep.channels }, signal)
    const receipt = join(directory, 'acoustic-preflight.json')
    const issue = (row: ReturnType<typeof window>) => row.status === 'missing_reference_signal' || row.status === 'shifted_reference_signal'
    const issues = findings.filter(issue)
    const tailIssue = subtitleTail !== undefined && issue(subtitleTail)
    const report = { kind: 'muse_rendered_audio_preflight', version: 1, episode: input.episode,
      status: issues.length === 0 && !tailIssue ? 'needs_review' : 'issues_found', listening_verified: false, grants_approval: false,
      source_sha256: prep.source_sha256, source_record_sha256: prep.source_record_sha256, pcm_sha256: prep.pcm_sha256,
      preparation: prep.receipt_path, comparison: 'body_master_to_rendered_playback', expected_body_end_us: clock.data.body_end_us,
      sample_rate: acousticRate, reference_files: paths, source_music_mode: music, external_requests: 0,
      matching_windows: windows.length - findings.length, issue_count: issues.length, uncertain_windows: findings.length - issues.length,
      ...(lastSubtitleEndUs === undefined ? {} : { last_subtitle_end_us: lastSubtitleEndUs }),
      ...(subtitleTail === undefined ? {} : { final_subtitle_following_signal: subtitleTail, final_subtitle_signal_issue: tailIssue }),
      limitations: ['声学匹配只证明绑定母轨信号保留，不能证明台词、发音、角色、口型或字幕覆盖。',
        '正文之外的片尾音、未写入母轨的原源片内容，以及不明确的弱声窗仍须核验。'],
      receipt_path: receipt } satisfies Omit<ContentListeningPreflight, 'findings'>
    await writeFile(receipt, `${JSON.stringify({ ...report, windows }, null, 2)}\n`, { flag: 'wx', mode: 0o600, signal })
    return { ...report, findings: [...issues, ...findings.filter(row => row.status.startsWith('uncertain'))].slice(0, 24) }
  } finally {
    await Promise.all(scratch.map(async (path) => { await rm(path, { force: true }) }))
  }
}
