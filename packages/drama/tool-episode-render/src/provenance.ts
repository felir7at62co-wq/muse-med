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
 * @module @deepseek-ai/dsh-tool-episode-render/provenance
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { RenderCheck } from './types.ts'

/** Format version; only 1 is read. */
export const PROVENANCE_VERSION = 1

/** The delivered file, as the record states it. */
export interface ProvenanceOutput {
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
export interface ProvenanceCheck {
  /** Stable check id. */
  readonly id: string
  /** Whether it passed. */
  readonly ok: boolean
  /** `failure` or `warning`. */
  readonly severity: string
}

/** What one delivery was made from, and what was checked on it. */
export interface DeliveryProvenance {
  /** Format version. */
  readonly version: number
  /** Two-digit episode number. */
  readonly episode: string
  /** When the render finished, ISO. */
  readonly rendered_at: string
  /** The delivered file. */
  readonly output: ProvenanceOutput
  /** Digest of every source byte this render consumed, in consumption order. */
  readonly inputs: readonly string[]
  /** Encoder that produced the file. */
  readonly encoder: string
  /** The verdicts this delivery was given. */
  readonly checks: readonly ProvenanceCheck[]
}

/**
 * The sidecar path for one delivery.
 * @param output - Absolute path of the delivered file.
 * @returns The sidecar path beside it.
 */
export function provenancePathFor(output: string): string {
  return `${output}.provenance.json`
}

/**
 * Build one delivery's record.
 * @param input - The delivered file's facts, the digests consumed, and the verdicts run.
 * @returns The record, ready to write.
 */
export function buildProvenance(input: {
  readonly episode: string
  readonly output: string
  readonly outputSha256: string
  readonly sizeBytes: number
  readonly durationSeconds: number
  readonly inputs: readonly string[]
  readonly encoder: string
  readonly checks: readonly RenderCheck[]
  readonly now: Date
}): DeliveryProvenance {
  return {
    version: PROVENANCE_VERSION,
    episode: input.episode,
    rendered_at: input.now.toISOString(),
    output: { path: input.output, sha256: input.outputSha256, size_bytes: input.sizeBytes,
      duration_seconds: input.durationSeconds },
    inputs: [...input.inputs],
    encoder: input.encoder,
    checks: input.checks.map(check => ({ id: check.id, ok: check.ok, severity: check.severity })),
  }
}

/**
 * Write one delivery's record, replacing any earlier one atomically.
 * @param path - Sidecar path.
 * @param value - The record.
 */
export async function writeProvenance(path: string, value: DeliveryProvenance): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Read one delivery's record.
 * @param path - Sidecar path.
 * @returns The record, or undefined when the delivery has none.
 * @throws {Error} When the sidecar exists but is not a version 1 record.
 */
export async function readProvenance(path: string): Promise<DeliveryProvenance | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`${path} 不是合法 JSON：来源清单损坏，不能当作没有清单。`, { cause: error })
  }
  const document = parsed as Partial<DeliveryProvenance>
  if (document.version !== PROVENANCE_VERSION || typeof document.output?.sha256 !== 'string') {
    throw new Error(`${path} 不是 version ${String(PROVENANCE_VERSION)} 的来源清单。`)
  }
  return document as DeliveryProvenance
}
