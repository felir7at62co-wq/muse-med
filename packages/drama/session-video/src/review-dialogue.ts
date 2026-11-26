/** Source- and interval-checked dialogue from completed local Muse transcription receipts. */
import { createHash } from 'node:crypto'
import { basename, dirname, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FsError, type FileSystem, type FsTarget, type FsVersion } from '@deepseek-ai/dsh-fs'
import { z } from 'zod'

const receiptName = /^([\w.-]+)-v([1-9]\d*)\.json$/u
const sha256 = z.string().regex(/^[a-f0-9]{64}$/iu)
const receiptSchema = z.object({
  id: z.uuid(), source: z.string().min(1), sourceSha256: sha256.optional(), sha256,
  stem: z.string().regex(/^[\w.-]+$/u), version: z.number().int().positive(),
  status: z.enum(['prepared', 'preparing', 'processing', 'submitting', 'uncertain', 'complete', 'silent', 'failed']),
})
const transcriptSchema = z.array(z.object({
  start: z.number().nonnegative(), end: z.number().nonnegative(), text: z.string(),
  speaker_id: z.string().refine(label => label.trim().length > 0).optional(),
}).refine(segment => segment.end > segment.start)).min(1)
  .refine(segments => segments.every((segment, index) => segment.start >= (segments[index - 1]?.start ?? 0)))

type DialogueUnavailableReason = 'workspace_unavailable' | 'receipt_unavailable' | 'receipt_invalid'
  | 'receipt_incomplete' | 'receipt_reported_silent' | 'source_hash_unavailable' | 'source_mismatch'
  | 'transcript_unavailable' | 'transcript_invalid' | 'limit_exceeded' | 'evidence_changed'

interface DialogueSegment {
  readonly start_seconds: number
  readonly end_seconds: number
  readonly text: string
  readonly speaker_group?: number
}

/** Saved ASR observations, or the reason the selected interval could not be checked. */
export type ReviewDialogueEvidence =
  | { readonly status: 'unavailable'; readonly reason: DialogueUnavailableReason }
  | {
    readonly status: 'available'
    readonly source: 'saved_muse_transcription'
    readonly speaker_identity_verified: false
    readonly segments: readonly DialogueSegment[]
    readonly boundary_segments_omitted: number
  }

function unavailable(reason: DialogueUnavailableReason): ReviewDialogueEvidence {
  return { status: 'unavailable', reason }
}

async function scopedEntry(fs: FileSystem, parent: FsTarget, name: string, kind: 'file' | 'directory', signal: AbortSignal) {
  const cwd = fs.processPath(parent)
  const observation = await fs.lstat(name, { cwd }, signal)
  if (observation?.type !== kind) return undefined
  const target = await fs.resolve(name, { cwd, signal })
  if (target.targetKey === parent.targetKey || !fs.contains(parent, target)
    || (await fs.stat(target, signal))?.version !== observation.version) {
    return undefined
  }
  return { target, version: observation.version }
}

async function latestReceiptName(fs: FileSystem, jobs: FsTarget, source: FsTarget, signal: AbortSignal): Promise<string | undefined> {
  const stem = basename(fs.processPath(source)).replace(/\.[^.]+$/u, '').replace(/[^\w.-]+/gu, '_').slice(0, 80) || 'media'
  let latest: { name: string; version: number } | undefined
  for (const entry of await fs.listDir(jobs, signal)) {
    const match = receiptName.exec(entry.name)
    if (entry.type !== 'file' || match?.[1] !== stem) continue
    const version = Number(match[2])
    if (Number.isSafeInteger(version) && (latest === undefined || version > latest.version)) latest = { name: entry.name, version }
  }
  return latest?.name
}

async function readJson(fs: FileSystem, target: FsTarget, limit: number, signal: AbortSignal): Promise<unknown> {
  const bytes = await fs.readBytes(target, signal, limit)
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch (_invalidJson) { return undefined }
}

/**
 * Read completed, same-source Muse ASR without starting or querying a transcription job.
 * @param ctx - Host filesystem in the video source's execution world.
 * @param target - Exact resolved video selected for review.
 * @param fileVersion - Video version retained at review start.
 * @param sourceBytesLimit - Inclusive cap for verifying the selected video digest.
 * @param resultBytesLimit - Inclusive cap for the returned dialogue data.
 * @param workspaceRoot - Session workspace containing first-party transcripts; absent skips the lookup.
 * @param startSeconds - Inclusive source interval start.
 * @param endSeconds - Exclusive source interval end.
 * @param signal - Review cancellation and Host lifetime.
 * @param receiptPath - Explicit receipt in the workspace's jobs directory, which may use the workspace's original path spelling.
 * Omission selects the newest receipt with the selected source's standard filename stem.
 * @param maxReadBytes - Inclusive cap for each complete evidence file; defaults to the result cap.
 * @returns Complete segments within the interval, an omitted crossing-segment count, and anonymous speaker groups.
 */
export async function reviewDialogue(ctx: Context, target: FsTarget, fileVersion: FsVersion,
  sourceBytesLimit: number, resultBytesLimit: number, workspaceRoot: string | undefined,
  startSeconds: number, endSeconds: number, signal: AbortSignal, receiptPath?: string,
  maxReadBytes = resultBytesLimit): Promise<ReviewDialogueEvidence> {
  signal.throwIfAborted()
  if (workspaceRoot === undefined) return unavailable('workspace_unavailable')
  const fs = ctx.fs
  let phase: DialogueUnavailableReason = 'workspace_unavailable'
  try {
    const workspace = await fs.resolve(workspaceRoot, { signal })
    const transcript = await scopedEntry(fs, workspace, 'transcript', 'directory', signal)
    if (transcript === undefined) return unavailable('receipt_unavailable')
    phase = 'receipt_unavailable'
    const jobs = await scopedEntry(fs, transcript.target, 'jobs', 'directory', signal)
    if (jobs === undefined) return unavailable('receipt_unavailable')
    const name = receiptPath === undefined ? await latestReceiptName(fs, jobs.target, target, signal) : basename(receiptPath)
    if (name === undefined) return unavailable('receipt_unavailable')
    if (!receiptName.test(name)) return unavailable('receipt_invalid')
    const workspacePath = fs.processPath(workspace)
    if (receiptPath !== undefined) {
      const requestedParent = resolve(workspacePath, dirname(receiptPath))
      const receiptDirectories = [fs.processPath(jobs.target), resolve(workspace.displayPath, 'transcript', 'jobs')]
      if (receiptDirectories.every(path => relative(path, requestedParent) !== '')
        || (await fs.resolve(requestedParent, { signal })).targetKey !== jobs.target.targetKey) return unavailable('receipt_invalid')
    }
    const receiptFile = await scopedEntry(fs, jobs.target, name, 'file', signal)
    if (receiptFile === undefined) return unavailable('receipt_unavailable')
    const receipt = receiptSchema.safeParse(await readJson(fs, receiptFile.target, maxReadBytes, signal))
    if (!receipt.success || `${receipt.data.stem}-v${receipt.data.version}.json` !== name) return unavailable('receipt_invalid')
    phase = 'source_mismatch'
    const recordedPath = fs.processPathFromHostPath(receipt.data.source)
    if (recordedPath === undefined) return unavailable('source_mismatch')
    const targetPath = fs.processPath(target)
    const sourcePaths = [target.displayPath, targetPath]
    if (fs.contains(workspace, target)) sourcePaths.push(resolve(workspace.displayPath, relative(workspacePath, targetPath)))
    if (sourcePaths.every(path => relative(path, recordedPath) !== '')
      || (await fs.resolve(recordedPath, { signal })).targetKey !== target.targetKey) return unavailable('source_mismatch')
    if (receipt.data.sourceSha256 === undefined) return unavailable('source_hash_unavailable')
    if ((await fs.stat(target, signal))?.version !== fileVersion) return unavailable('evidence_changed')
    const digest = createHash('sha256').update(await fs.readBytes(target, signal, sourceBytesLimit)).digest('hex')
    if (digest !== receipt.data.sourceSha256.toLowerCase()) return unavailable('source_mismatch')
    if ((await fs.stat(receiptFile.target, signal))?.version !== receiptFile.version) return unavailable('evidence_changed')
    if (receipt.data.status === 'silent') return unavailable('receipt_reported_silent')
    if (receipt.data.status !== 'complete') return unavailable('receipt_incomplete')

    phase = 'transcript_unavailable'
    const raw = await scopedEntry(fs, transcript.target, 'raw', 'directory', signal)
    if (raw === undefined) return unavailable('transcript_unavailable')
    const output = await scopedEntry(fs, raw.target, name, 'file', signal)
    if (output === undefined) return unavailable('transcript_unavailable')
    const body = transcriptSchema.safeParse(await readJson(fs, output.target, maxReadBytes, signal))
    if (!body.success) return unavailable('transcript_invalid')
    if ((await fs.stat(target, signal))?.version !== fileVersion
      || (await fs.stat(receiptFile.target, signal))?.version !== receiptFile.version
      || (await fs.stat(output.target, signal))?.version !== output.version) return unavailable('evidence_changed')

    let boundarySegmentsOmitted = 0
    const groups = new Map<string, number>()
    const segments: DialogueSegment[] = []
    for (const row of body.data) {
      if (row.end <= startSeconds || row.start >= endSeconds) continue
      if (row.start < startSeconds || row.end > endSeconds) { boundarySegmentsOmitted++; continue }
      const segment = { start_seconds: row.start, end_seconds: row.end, text: row.text }
      if (row.speaker_id === undefined) { segments.push(segment); continue }
      const speaker_group = groups.get(row.speaker_id) ?? groups.size + 1
      groups.set(row.speaker_id, speaker_group)
      segments.push({ ...segment, speaker_group })
    }
    const evidence: ReviewDialogueEvidence = { status: 'available', source: 'saved_muse_transcription', segments,
      speaker_identity_verified: false, boundary_segments_omitted: boundarySegmentsOmitted }
    return Buffer.byteLength(JSON.stringify(evidence)) <= resultBytesLimit ? evidence : unavailable('limit_exceeded')
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof FsError) return unavailable(error.code === 'FS_TOO_LARGE' ? 'limit_exceeded' : phase)
    throw error
  }
}
