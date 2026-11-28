/** Prepare a separate timing-only candidate from native word evidence of an exact rendered MP4. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative } from 'node:path'
import { requireProjectAudioFile } from './audio.ts'
import { fileSha256 } from './cache.ts'
import { pictureDurationUs } from './content-listening-audio.ts'
import { DEFAULT_DELIVERY } from './delivery.ts'
import type { OfflineWordReceiptVerifier } from './offline-word-evidence.ts'
import { deliveryFrameTimeUs, deliveryPictureClockSchema } from './picture-clock.ts'
import { readSourceRecord, sourceRecordPathFor } from './source-record.ts'
import { reviewSpeechCoverage, speechCoverageTextKey, type SpeechCoverageReport, type SpeechCoverageWord } from './speech-coverage.ts'
import { formatSrtTime, parseSrtDocument, parseSrtTime } from './subtitles.ts'
import type { MediaToolkit, SubtitleCue } from './types.ts'

const maxSubtitleBytes = 256 * 1024
const maxExtensionUs = 250_000
const maxAnchorGapSeconds = 0.12
const durationUs = (seconds: number): number => Math.round(seconds * 1_000_000)
const timingLine = /^[ \t]*(\d{2}:\d{2}:\d{2}[,.]\d{3})[ \t]*-->[ \t]*(\d{2}:\d{2}:\d{2}[,.]\d{3})(?=[ \t]*(?:\r?$))/gmu

type Anchor = { readonly start_seconds: number; readonly end_seconds: number; readonly words: readonly SpeechCoverageWord[] }

function anchoredSuffix(coverage: SpeechCoverageReport, cue: SubtitleCue, clipEndUs: number, fps: number) {
  const cueText = speechCoverageTextKey(cue.text)
  const timing = coverage.findings.filter(finding => finding.kind === 'timing_mismatch' && finding.cue_indexes.length === 1
    && finding.cue_indexes[0] === cue.index && finding.end_seconds > cue.endSeconds)
  const isFullWord = (word: SpeechCoverageWord) => {
    const uses = coverage.matches.filter(match => match.word_id === word.id)
    return uses.length === 1 && uses[0]?.cue_index === cue.index && uses[0].text === speechCoverageTextKey(word.text)
  }
  const candidates: { anchor: Anchor; findingId: string; safeFrame: boolean; unique: boolean }[] = []
  for (const finding of timing) {
    const index = coverage.words.findIndex(word => finding.word_ids.includes(word.id) && word.end_seconds === finding.end_seconds
      && word.start_seconds < cue.endSeconds && isFullWord(word))
    const last = coverage.words[index]
    if (last === undefined) continue
    const sequence = coverage.words.slice(Math.max(0, index - 2), index + 1)
    const parts = sequence.map(word => speechCoverageTextKey(word.text))
    const first = sequence[0]
    if (first === undefined || first.start_seconds < cue.startSeconds || sequence.length < 2 || parts.some(part => !part)
      || Array.from(parts.join('')).length < 3 || !cueText.endsWith(parts.join('')) || !sequence.every(isFullWord)
      || sequence.some((word, i) => i > 0 && word.start_seconds - (sequence[i - 1]?.end_seconds ?? 0) > maxAnchorGapSeconds)) continue
    const occurrences = coverage.words.filter((word, i) => word.start_seconds >= cue.startSeconds && word.start_seconds < cue.endSeconds
      && parts.every((part, j) => speechCoverageTextKey(coverage.words[i + j]?.text ?? '') === part))
    const missing = durationUs(last.end_seconds - cue.endSeconds)
    candidates.push({ anchor: { start_seconds: first.start_seconds, end_seconds: last.end_seconds, words: sequence },
      findingId: finding.id, unique: occurrences.length === 1,
      safeFrame: missing > 1_000_000 / fps + 500 && missing <= maxExtensionUs
        && Math.ceil(durationUs(last.end_seconds) / 1000) * 1000 <= clipEndUs })
  }
  return candidates.length === 1 ? candidates[0] : undefined
}

function replaceTailSrtEnd(text: string, path: string, cues: readonly SubtitleCue[], tail: SubtitleCue, end: number): string | undefined {
  const lines = [...text.matchAll(timingLine)]
  const last = lines.at(-1), original = last?.[2]
  if (lines.length !== cues.length || last === undefined || original === undefined
    || parseSrtTime(original, path) !== tail.endSeconds) return undefined
  const offset = last.index + last[0].length - original.length
  const newTime = formatSrtTime(end)
  const result = text.slice(0, offset) + (original.includes('.') ? newTime.replace(',', '.') : newTime) + text.slice(offset + original.length)
  const verification = parseSrtDocument(result, path)
  return verification.length === cues.length && verification.every((after, i) => {
    const before = cues[i]
    return before !== undefined && after.index === before.index && after.text === before.text && after.startSeconds === before.startSeconds
      && after.endSeconds === (before.index === tail.index ? end : before.endSeconds)
  }) ? result : undefined
}

/** Create a new bounded SRT candidate without changing the current render, draft or subtitle. */
export async function prepareSubtitleTailCandidate(input: {
  readonly toolkit: MediaToolkit
  readonly project: string
  readonly episode: string
  readonly output: string
  readonly subtitleSrt: string
  readonly wordReceipt: string
  readonly verifyOfflineWords: OfflineWordReceiptVerifier
  readonly signal?: AbortSignal
}) {
  const { signal, toolkit } = input
  const project = await realpath(input.project)
  const [output, subtitlePath, wordReceipt] = await Promise.all([input.output, input.subtitleSrt, input.wordReceipt]
    .map(async path => await requireProjectAudioFile(project, path))) as [string, string, string]
  const recordPath = await requireProjectAudioFile(project, sourceRecordPathFor(output))
  const report = { kind: 'muse_subtitle_tail_candidate', episode: input.episode, assessment: 'asr_word_timing_candidate',
    listening_verified: false, grants_approval: false, external_requests: 0 } as const
  const pending = (reason: string) => ({ ...report, status: 'needs_review' as const, reason })
  if (extname(output).toLowerCase() !== '.mp4' || (await lstat(recordPath)).size > 8 * 1024 * 1024
    || (await lstat(subtitlePath)).size > maxSubtitleBytes) return pending('同版字幕和原生成片回执缺失、格式不符或超出本机读取范围。')
  const [recordSha, record, subtitleBytes] = await Promise.all([
    fileSha256(recordPath, signal), readSourceRecord(recordPath), readFile(subtitlePath, { signal }),
  ])
  const subtitleSha = createHash('sha256').update(subtitleBytes).digest('hex'), delivery = record?.delivery_inputs
  if (record === undefined || record.episode !== input.episode || !isAbsolute(record.output.path)
    || relative(output, record.output.path) !== '' || delivery?.subtitle_sha256 !== subtitleSha
    || !record.input_files?.some(file => isAbsolute(file.path) && relative(file.path, subtitlePath) === '' && file.sha256 === subtitleSha)) {
    return pending('这份字幕、集号或成片不属于同一份实际渲染回执。')
  }
  if (delivery.subtitle_display !== 'external') return pending('当前回执不能证明字幕是完整外加显示内容，保留待核。')
  const clock = deliveryPictureClockSchema.safeParse(delivery.picture_clock)
  if (!clock.success) return pending('当前成片缺少实际正文画面边界，不能推算字幕尾点。')
  const pictureUs = deliveryFrameTimeUs(clock.data.total_frames, clock.data.fps)
  if (await pictureDurationUs(toolkit, output) !== pictureUs) return pending('实际成片画面时长与来源回执不一致。')
  const source = { source_sha256: record.output.sha256, source_record_sha256: recordSha, subtitle_sha256: subtitleSha }
  const text = subtitleBytes.toString('utf8')
  if (subtitleBytes.byteLength > maxSubtitleBytes || !Buffer.from(text).equals(subtitleBytes)) return pending('当前字幕不是可原样回写的 UTF-8。')
  const cues = parseSrtDocument(text, subtitlePath), cue = cues.at(-1)
  if (cue === undefined || cues.some((row, index) => row.endSeconds <= row.startSeconds || row.startSeconds < 0
    || (index > 0 && row.startSeconds < (cues[index - 1]?.endSeconds ?? 0)))) return pending('字幕顺序、时间或接缝不适合自动生成尾点候选。')
  const clip = clock.data.clips.find(row => durationUs(cue.startSeconds) >= row.start_us
    && durationUs(cue.endSeconds) <= row.start_us + row.duration_us)
  if (clip === undefined) return pending('末条字幕已跨实际镜头或超出正文，需另行核对。')
  const coverageInput = { project, sources: new Map([[1, output]]), offlineReceiptPath: wordReceipt,
    verifyOfflineWords: input.verifyOfflineWords, timeline: { clips: [{ shot: 1, startUs: 0, durationUs: pictureUs }],
      bodyEndSeconds: pictureUs / 1_000_000, delivery: { ...DEFAULT_DELIVERY, fps: clock.data.fps } } }
  const coverage = await reviewSpeechCoverage({ ...coverageInput, subtitleSrt: subtitlePath })
  const wordSource = coverage.sources[0]
  if (!coverage.evidence_complete || wordSource?.sha256 !== record.output.sha256 || coverage.subtitle_sha256 !== subtitleSha) {
    return pending('仅接受当前会话针对同版实际成片签发并复验成功的本机逐词回执。')
  }
  const anchor = anchoredSuffix(coverage, cue, clip.start_us + clip.duration_us, clock.data.fps)
  if (anchor === undefined || !anchor.unique) return pending('没有唯一且连续的完整尾词证据；维持原字幕供核听。')
  if (!anchor.safeFrame) return pending('逐词尾点超出安全画面范围、超过允许调整时长或已在单帧误差内。')
  const endSeconds = Math.ceil(durationUs(anchor.anchor.end_seconds) / 1000) / 1000
  const candidateText = replaceTailSrtEnd(text, subtitlePath, cues, cue, endSeconds)
  if (candidateText === undefined) return pending('无法逐字节证明仅末条字幕终点被修改。')
  signal?.throwIfAborted()
  const directory = join(project, 'editing')
  await mkdir(directory, { recursive: true })
  if (relative(directory, await realpath(directory)) !== '') return pending('候选字幕目录发生重定向。')
  const owned = await mkdtemp(join(directory, 'subtitle-tail-'))
  const candidatePath = join(owned, 'candidate.srt'), evidencePath = join(owned, 'evidence.json')
  let written = false
  try {
    await writeFile(candidatePath, candidateText, { flag: 'wx', mode: 0o600, signal })
    const after = await reviewSpeechCoverage({ ...coverageInput, subtitleSrt: candidatePath })
    const expected = new Set(coverage.findings.map(finding => finding.id))
    expected.delete(anchor.findingId)
    if (!after.evidence_complete || after.sources[0]?.receipt_sha256 !== wordSource.receipt_sha256
      || after.sources[0]?.transcript_sha256 !== wordSource.transcript_sha256 || after.findings.length !== expected.size
      || after.findings.some(finding => !expected.has(finding.id))) return pending('重比较后出现其他差异，独立候选已撤下。')
    const check = [[output, source.source_sha256], [subtitlePath, subtitleSha], [recordPath, recordSha],
      [candidatePath, after.subtitle_sha256]] as const
    if (!(await Promise.all(check.map(async ([path, hash]) => await fileSha256(path, signal) === hash))).every(Boolean)) {
      return pending('比对期间原件或候选已改变，本轮候选没有保留。')
    }
    const evidence = { ...report, ...source, status: 'candidate' as const, cue: cue.index,
      start_seconds: cue.startSeconds, old_end_seconds: cue.endSeconds, candidate_end_seconds: endSeconds,
      safe_frame_end_us: clip.start_us + clip.duration_us, word_receipt_sha256: wordSource.receipt_sha256,
      word_transcript_sha256: wordSource.transcript_sha256, anchor: anchor.anchor,
      original_findings_count: coverage.findings.length, candidate_findings_count: after.findings.length,
      removed_finding_id: anchor.findingId, candidate_path: candidatePath, candidate_sha256: after.subtitle_sha256,
      evidence_path: evidencePath, remaining_review: '只提供当前同版尾词的机器时间建议。仍须核听并重做同版成片与草稿，其他问题继续待核。' }
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600, signal })
    written = true
    return evidence
  } finally {
    if (!written) {
      await Promise.all([rm(candidatePath, { force: true }), rm(evidencePath, { force: true })])
      await rmdir(owned)
    }
  }
}
