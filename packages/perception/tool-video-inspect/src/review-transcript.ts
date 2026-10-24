/** Version-checked explicit ASR and read-receipt candidates; association never establishes shared source identity. */
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { VideoReview } from './review-state.ts'
import { reviewSpeech, type ReviewSpeech, type ReviewSpeechLink, type ReviewTranscriptReference } from './review-speech.ts'

/** A successful JSON read established by the owning Host's Session projection, rather than requested tool arguments. */
export interface VideoTranscriptReadReceipt {
  path: string
  readCallId: ToolCallId
  readResultSeq: SessionSeq
}

/** Current-task successful reads offered for optional same-directory ASR resolution. */
export interface VideoTranscriptCandidates {
  taskStartSeq: SessionSeq
  reads: readonly VideoTranscriptReadReceipt[]
}

/** One candidate's eligibility or full bounded read result; errors do not replace an explicit association. */
export interface VideoTranscriptCandidateDiagnostic {
  path: string
  status: 'not_current_task' | 'outside_source_directory' | 'not_json' | 'unavailable' | 'valid'
  reason?: string
  reference?: ReviewTranscriptReference
}

/** ASR selection evidence, without changing the saved review or claiming video/ASR source identity. */
export interface VideoTranscriptResolution {
  kind: 'explicit_reference' | 'successful_read_candidate' | 'ambiguous' | 'unavailable' | 'none'
  same_source_verified: false
  reference?: ReviewTranscriptReference
  read_receipts?: readonly VideoTranscriptReadReceipt[]
  diagnostics: readonly VideoTranscriptCandidateDiagnostic[]
}

interface TranscriptRead {
  speech: ReviewSpeech
  reference: ReviewTranscriptReference
  stillCurrent: () => Promise<boolean>
}

interface ResolvedTranscript {
  link: ReviewSpeechLink
  resolution?: VideoTranscriptResolution
  reference?: ReviewTranscriptReference
  stillCurrent?: () => Promise<boolean>
}

async function readTranscript(ctx: Context, target: FsTarget, duration: number, maxBytes: number,
  signal: AbortSignal, expected?: ReviewTranscriptReference): Promise<TranscriptRead> {
  const before = await ctx.fs.stat(target, signal)
  if (before === undefined || expected !== undefined && before.version !== expected.version) {
    throw Error('VIDEO_TRANSCRIPT_CHANGED: ASR版本变化或文件缺失。')
  }
  if (before.type !== 'file' || before.size === undefined || before.size > maxBytes) {
    throw Error('VIDEO_TRANSCRIPT_SIZE: ASR超出本次完整读取上限或不是普通文件。')
  }
  const bytes = await ctx.fs.readBytes(target, signal, maxBytes)
  const speech = reviewSpeech({ path: target.displayPath, version: before.version,
    text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }, duration)
  if ((await ctx.fs.stat(target, signal))?.version !== before.version
    || expected !== undefined && speech.source.sha256 !== expected.sha256) {
    throw Error('VIDEO_TRANSCRIPT_CHANGED: ASR在读取期间变化或摘要不匹配。')
  }
  return { speech, reference: { path: target.displayPath, version: before.version, sha256: speech.source.sha256 },
    stillCurrent: async () => (await ctx.fs.stat(target, signal))?.version === before.version }
}

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000)
}

/**
 * Resolve saved ASR or one current-task same-directory successful-read candidate without storing a new association.
 * @param ctx - Same-world filesystem provider.
 * @param review - Current source revision and optional explicit ASR reference, which always takes priority.
 * @param source - Resolved current video identity.
 * @param options - Complete-ASR byte bound and Host-verified successful read receipts.
 * @param cwd - Workspace used for relative read paths.
 * @param signal - Cancellation for every source read.
 * @returns Optional original speech, association diagnostics and a final freshness check; ambiguity retains no speech.
 */
export async function resolveReviewTranscript(ctx: Context, review: VideoReview, source: FsTarget,
  options: { maxTranscriptBytes: number; transcriptCandidates?: VideoTranscriptCandidates }, cwd: string,
  signal: AbortSignal): Promise<ResolvedTranscript> {
  const reference = review.transcript_reference
  if (reference !== undefined) {
    const resolution: VideoTranscriptResolution = { kind: 'explicit_reference', same_source_verified: false,
      reference, diagnostics: [] }
    let currentVersion: string | undefined
    try {
      const target = await ctx.fs.resolve(reference.path, { cwd, signal })
      currentVersion = (await ctx.fs.stat(target, signal))?.version
      const read = await readTranscript(ctx, target, review.duration, options.maxTranscriptBytes, signal, reference)
      return { link: { speech: read.speech }, resolution, reference, stillCurrent: read.stillCurrent }
    } catch (error) {
      signal.throwIfAborted()
      return { reference, resolution, link: { speech_unavailable: { reference,
        ...currentVersion === undefined ? {} : { current_version: currentVersion }, reason: reason(error),
        notice: '本次未使用不匹配或不可读的已关联ASR；画面时间线仍可核对，未更换来源或提交新的转写。' } } }
    }
  }
  const candidates = options.transcriptCandidates
  if (candidates === undefined) return { link: {} }
  const diagnostics: VideoTranscriptCandidateDiagnostic[] = []
  const targets = new Map<FsTargetKey, { target: FsTarget; receipts: VideoTranscriptReadReceipt[] }>()
  const sourceDirectory = new URL('.', ctx.fs.fileUrl(source)).href
  for (const receipt of candidates.reads) {
    if (receipt.readResultSeq < candidates.taskStartSeq) {
      diagnostics.push({ path: receipt.path, status: 'not_current_task' })
      continue
    }
    try {
      const target = await ctx.fs.resolve(receipt.path, { cwd, signal }), url = new URL(ctx.fs.fileUrl(target))
      if (new URL('.', url).href !== sourceDirectory) {
        diagnostics.push({ path: receipt.path, status: 'outside_source_directory' })
      } else if (!url.pathname.toLowerCase().endsWith('.json')) {
        diagnostics.push({ path: receipt.path, status: 'not_json' })
      } else {
        const previous = targets.get(target.targetKey)
        if (previous === undefined) targets.set(target.targetKey, { target, receipts: [receipt] })
        else previous.receipts.push(receipt)
      }
    } catch (error) {
      signal.throwIfAborted()
      diagnostics.push({ path: receipt.path, status: 'unavailable', reason: reason(error) })
    }
  }
  const valid: { read: TranscriptRead; receipts: VideoTranscriptReadReceipt[] }[] = []
  for (const { target, receipts } of targets.values()) {
    try {
      const read = await readTranscript(ctx, target, review.duration, options.maxTranscriptBytes, signal)
      diagnostics.push({ path: target.displayPath, status: 'valid', reference: read.reference })
      valid.push({ read, receipts })
    } catch (error) {
      signal.throwIfAborted()
      diagnostics.push({ path: target.displayPath, status: 'unavailable', reason: reason(error) })
    }
  }
  const selected = valid.length === 1 ? valid[0] : undefined
  const resolution: VideoTranscriptResolution = { kind: selected !== undefined ? 'successful_read_candidate'
    : valid.length > 1 ? 'ambiguous' : candidates.reads.length === 0 ? 'none' : 'unavailable',
  same_source_verified: false, diagnostics,
  ...selected === undefined ? {} : { reference: selected.read.reference, read_receipts: selected.receipts } }
  return selected === undefined ? { link: {}, resolution } : { link: { speech: selected.read.speech }, resolution,
    reference: selected.read.reference, stillCurrent: selected.read.stillCurrent }
}
