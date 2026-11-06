/** Evidence-bound reuse and exclusive allocation of a single-episode render output. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { dirname, parse, resolve } from 'node:path'
import { requireNewAudioOutput, requireProjectAudioFile } from './audio.ts'
import { fileSha256 } from './cache.ts'
import { readSourceRecord, sourceRecordPathFor, type DeliverySourceRecord } from './source-record.ts'
import { verifyEpisode, type VerifyInput } from './verify.ts'
import type { DramaRenderReport } from './types.ts'

/** File bytes used by a resumable render. `null` records an absent project configuration. */
export interface RenderResumeFile {
  readonly path: string
  readonly sha256: string | null
}

/** The immutable request identity and the files that must still match at publication. */
export interface RenderResumeRequest {
  readonly sha256: string
  readonly files: readonly RenderResumeFile[]
}

/**
 * Read one input digest. Only an explicitly optional absent file can lack bytes.
 * @param path - Absolute input path.
 * @param optional - Whether a missing file is part of the effective input state.
 * @returns The captured file identity.
 */
export async function readRenderResumeFile(path: string, optional = false): Promise<RenderResumeFile> {
  try { return { path, sha256: await fileSha256(path) } }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return { path, sha256: null }
    throw error
  }
}

/**
 * Bind byte inputs and the effective choices affecting the render.
 * @param files - Captured files in role order.
 * @param effective - Ordered scope and effective settings values.
 * @returns A stable, versioned request identity.
 */
export function renderResumeRequest(files: readonly RenderResumeFile[], effective: readonly unknown[]): RenderResumeRequest {
  return { files, sha256: createHash('sha256').update(JSON.stringify(['episode-render-resume-v1', files, effective])).digest('hex') }
}

/**
 * Refuse to reuse or publish a render if an input changed during work.
 * @param request - Captured input identities.
 */
export async function assertRenderResumeInputs(request: RenderResumeRequest): Promise<void> {
  for (const file of request.files) {
    if ((await readRenderResumeFile(file.path, file.sha256 === null)).sha256 !== file.sha256) {
      throw new Error(`续跑渲染期间输入已变化：${file.path}。请重新运行。`)
    }
  }
}

/**
 * Confirm a directory is inside the real project without writing a probe file.
 * @param project - Project root.
 * @param directory - Candidate parent directory.
 */
export async function assertRenderResumeDirectory(project: string, directory: string): Promise<void> {
  try {
    await requireNewAudioOutput(project, resolve(directory, `.render-resume-${randomUUID()}`))
  } catch (error) {
    throw new Error(`无法验证续跑目录 ${directory}。输出必须位于项目目录内。`, { cause: error })
  }
}

/**
 * Locate the independent music output next to the delivery.
 * @param output - MP4 path.
 * @returns Music stem path.
 */
export function renderMusicStem(output: string): string {
  return resolve(dirname(output), `${parse(output).name}.music-stem.wav`)
}

async function entry(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try { return await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

type RenderResumeCandidate = { output: string; verified?: undefined }
  | { output: string; verified: DramaRenderReport; record: DeliverySourceRecord }

/**
 * Find an exact independently verified output or an unused path without changing either.
 * @param input - Standard read-only verification inputs and preferred output.
 * @param request - SHA of the current render request.
 * @param emitsStem - Whether a matching music stem is required.
 * @returns A reusable artifact or the earliest unoccupied candidate path.
 */
export async function findRenderResumeCandidate(input: VerifyInput & { requireSubtitleVisualVerification?: boolean },
  request: RenderResumeRequest,
  emitsStem: boolean): Promise<RenderResumeCandidate> {
  const outputPath = parse(input.output)
  await assertRenderResumeDirectory(input.project, outputPath.dir)
  const prefix = `${outputPath.name}.resume-${request.sha256.slice(0, 12)}`
  const paths = [input.output, ...Array.from({ length: 16 }, (_, index) => resolve(outputPath.dir,
    `${prefix}${index === 0 ? '' : `-${String(index + 1)}`}${outputPath.ext}`))]
  let free: string | undefined
  for (const output of paths) {
    const receipt = sourceRecordPathFor(output)
    const stem = renderMusicStem(output)
    const [videoInfo, receiptInfo, stemInfo] = await Promise.all([entry(output), entry(receipt),
      emitsStem ? entry(stem) : undefined])
    if (videoInfo === undefined && receiptInfo === undefined && stemInfo === undefined) {
      free ??= output
      continue
    }
    if (!videoInfo?.isFile() || !receiptInfo?.isFile() || (emitsStem && !stemInfo?.isFile())) continue
    try {
      await requireProjectAudioFile(input.project, output)
      await requireProjectAudioFile(input.project, receipt)
      const receiptSha256 = await fileSha256(receipt)
      const record = await readSourceRecord(receipt)
      if (record?.request_sha256 !== request.sha256 || record.episode !== input.episode) continue
      if (record.delivery_inputs == null || !Array.isArray(record.input_files)) continue
      if (input.requireSubtitleVisualVerification && (record.delivery_inputs.subtitle_visual_verification?.delivery === undefined
        || record.delivery_inputs.subtitle_visual_verification.visual === undefined)) continue
      if (emitsStem) {
        await requireProjectAudioFile(input.project, stem)
        if (await fileSha256(stem) !== record.music_stem_sha256) continue
      }
      const verified = await verifyEpisode({ ...input, output })
      if (!verified.ok || !verified.checks.some(check => check.id === 'output_source_record' && check.ok)) continue
      if (await fileSha256(receipt) !== receiptSha256) continue
      if (await fileSha256(output) !== record.output.sha256 || (emitsStem && await fileSha256(stem) !== record.music_stem_sha256)) continue
      await assertRenderResumeInputs(request)
      return { output, verified, record }
    } catch (error) {
      // A broken candidate cannot certify reuse. The caller keeps it and allocates a fresh path.
      void error
    }
  }
  if (free === undefined) throw new Error(`没有可用的单集续跑候选路径：${input.output}。请指定新的 output。`)
  return { output: free }
}
