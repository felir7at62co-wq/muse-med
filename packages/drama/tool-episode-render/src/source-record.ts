/**
 * The delivery's own record of what it was made from and what was checked on it.
 *
 * A rendered file on its own cannot answer two questions that matter before
 * shipping: which bytes of the project it actually consumed, and whether the
 * checks that passed were run against *this* file. Both are answered by writing a
 * sidecar beside the delivery that carries the output's own digest, the digest of
 * every source byte the render touched, and the verdicts it was given.
 *
 * A digest is what makes the record verifiable rather than asserted: replacing the
 * file at the same path leaves the sidecar describing bytes that are no longer
 * there, and `verify` reports exactly that instead of letting an older review stand
 * in for the current file.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/source-record
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DeliverySubtitleVisual, RenderCheck } from './types.ts'

/** Format version; only 1 is read. */
export const SOURCE_RECORD_VERSION = 1

/** The delivered file, as the record states it. */
export interface SourceRecordOutput {
  /** Absolute path the delivery was written to. */
  readonly path: string
  /** Digest of the delivered bytes. */
  readonly sha256: string
  /** Size in bytes. */
  readonly size_bytes: number
  /** Probed duration in seconds. */
  readonly duration_seconds: number
}

/** One check's verdict, as run against this delivery. */
export interface SourceRecordCheck {
  /** Stable check id. */
  readonly id: string
  /** Whether it passed. */
  readonly ok: boolean
  /** `failure` or `warning`. */
  readonly severity: string
}

/** Body inputs shared with the editable draft. */
export interface DeliveryRenderInputs {
  readonly timeline_sha256: string
  readonly subtitle_sha256: string
  /** Actual OCR, observed picture versions and source-content decisions checked for this render. */
  readonly source_qa_sha256?: string
  /** Actual final-display text, glyph-width and selected-face checks run before encoding. */
  readonly subtitle_visual_verification?: {
    readonly version: 1
    readonly subtitle_sha256: string
    readonly report_path: string
    readonly report_sha256: string
    readonly requested_font: string
    readonly delivery: { readonly width: number; readonly height: number; readonly fps: number }
    readonly visual: DeliverySubtitleVisual
    readonly checks: readonly { readonly id: string; readonly ok: true }[]
  }
  /** Whether this strict-coverage render processed a retained-subtitle overlay plan. */
  readonly subtitle_display?: 'external' | 'overlay'
  /** Actual render music inputs and gain for projects requiring a music decision. */
  readonly music?: {
    readonly mode: 'music' | 'none'
    readonly gain: number
    readonly plan_path?: string
    readonly bed_path?: string
    readonly generation_path?: string
  }
  readonly master_audio_sha256: string
  readonly videos: readonly { readonly shot: number; readonly sha256: string }[]
}

/** What one delivery was made from, and what was checked on it. */
export interface DeliverySourceRecord {
  /** Format version. */
  readonly version: number
  /** Two-digit episode number. */
  readonly episode: string
  /** When the render finished, ISO. */
  readonly rendered_at: string
  /** The delivered file. */
  readonly output: SourceRecordOutput
  /** Digest of every source byte this render consumed, in consumption order. */
  readonly inputs: readonly string[]
  /** Exact input and settings fingerprint for an opt-in resumable render. */
  readonly request_sha256?: string
  /** Effective timeline, burned subtitle and selected body media of a full resumable render. */
  readonly delivery_inputs?: DeliveryRenderInputs
  /** Absolute paths and captured digests of the full resumable render's inputs. */
  readonly input_files?: readonly { readonly path: string; readonly sha256: string | null }[]
  /** Independently hashed music output when this render emitted one. */
  readonly music_stem_sha256?: string
  /** Encoder that produced the file. */
  readonly encoder: string
  /** The verdicts this delivery was given. */
  readonly checks: readonly SourceRecordCheck[]
}

/**
 * The sidecar path for one delivery.
 * @param output - Absolute path of the delivered file.
 * @returns The sidecar path beside it.
 */
export function sourceRecordPathFor(output: string): string {
  return `${output}.source-record.json`
}

/**
 * Build one delivery's record.
 * @param input - The delivered file's facts, the digests consumed, and the verdicts run.
 * @returns The record, ready to write.
 */
export function buildSourceRecord(input: {
  readonly episode: string
  readonly output: string
  readonly outputSha256: string
  readonly sizeBytes: number
  readonly durationSeconds: number
  readonly inputs: readonly string[]
  readonly requestSha256?: string
  readonly deliveryInputs?: DeliveryRenderInputs
  readonly inputFiles?: DeliverySourceRecord['input_files']
  readonly musicStemSha256?: string
  readonly encoder: string
  readonly checks: readonly RenderCheck[]
  readonly now: Date
}): DeliverySourceRecord {
  return {
    version: SOURCE_RECORD_VERSION,
    episode: input.episode,
    rendered_at: input.now.toISOString(),
    output: { path: input.output, sha256: input.outputSha256, size_bytes: input.sizeBytes,
      duration_seconds: input.durationSeconds },
    inputs: [...input.inputs],
    ...(input.requestSha256 === undefined ? {} : { request_sha256: input.requestSha256 }),
    ...(input.deliveryInputs === undefined ? {} : { delivery_inputs: input.deliveryInputs }),
    ...(input.inputFiles === undefined ? {} : { input_files: input.inputFiles }),
    ...(input.musicStemSha256 === undefined ? {} : { music_stem_sha256: input.musicStemSha256 }),
    encoder: input.encoder,
    checks: input.checks.map(check => ({ id: check.id, ok: check.ok, severity: check.severity })),
  }
}

/**
 * Write one delivery's record, replacing any earlier one atomically.
 * @param path - Sidecar path.
 * @param value - The record.
 */
export async function writeSourceRecord(path: string, value: DeliverySourceRecord): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Read one delivery's record.
 * @param path - Sidecar path.
 * @returns The record, or undefined when the delivery has none.
 * @throws {Error} When the sidecar exists but is not a version 1 record.
 */
export async function readSourceRecord(path: string): Promise<DeliverySourceRecord | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} 不是合法 JSON：来源清单损坏，不能当作没有清单。`, { cause: error })
  }
  const document = parsed as Partial<DeliverySourceRecord>
  if (document.version !== SOURCE_RECORD_VERSION || typeof document.output?.sha256 !== 'string') {
    throw new Error(`${path} 不是 version ${String(SOURCE_RECORD_VERSION)} 的来源清单。`)
  }
  return document as DeliverySourceRecord
}
