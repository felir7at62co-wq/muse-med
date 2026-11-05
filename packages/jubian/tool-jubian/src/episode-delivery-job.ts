/** Journal and file operations for publishing a verified episode exactly once per plan. */
import type { Stats } from 'node:fs'
import { link, lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { episodeInputHashesSchema, parseEpisodeDelivery } from './episode-delivery.ts'
import type { ApprovedEpisodeDelivery, ApprovedEpisodeInputHashes } from './types.ts'
import { artifactHash } from './video-recovery.ts'

const common = { attempt: z.uuid(), inputHashes: episodeInputHashesSchema }
const jobSchema = z.discriminatedUnion('phase', [
  z.object({ ...common, phase: z.literal('pending') }).strict(),
  z.object({ ...common, phase: z.literal('prepared'), delivery: z.unknown() }).strict(),
])

/** A render intent or the verified result from which publication can resume. */
export type EpisodeDeliveryJob = {
  readonly attempt: string
  readonly inputHashes: ApprovedEpisodeInputHashes
} & ({ readonly phase: 'pending' } | { readonly phase: 'prepared'; readonly delivery: ApprovedEpisodeDelivery })

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function episodeFile(path: string): Promise<Stats | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile()) throw new Error('Episode delivery requires a regular file: ' + path)
    return info
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

function sameFile(expected: Stats, actual: Stats | undefined): boolean {
  return actual !== undefined && actual.dev === expected.dev && actual.ino === expected.ino
}

/**
 * Check for an episode delivery file and reject directories and links.
 * @param path - Absolute project file path.
 * @returns Whether a regular file exists there.
 */
export async function episodeFileExists(path: string): Promise<boolean> {
  return await episodeFile(path) !== undefined
}

/**
 * Create the local delivery directory and reject linked directories.
 * @param path - Absolute directory in the bound project.
 */
export async function ensureEpisodeDirectory(path: string): Promise<void> {
  let info
  try { info = await lstat(path) } catch (error) {
    if (!missing(error)) throw error
    await ensureEpisodeDirectory(dirname(path))
    try { await mkdir(path, { mode: 0o700 }) } catch (mkdirError) {
      if (!(mkdirError instanceof Error) || !('code' in mkdirError) || mkdirError.code !== 'EEXIST') throw mkdirError
    }
    info = await lstat(path)
  }
  if (!info.isDirectory() || await realpath(path) !== path) {
    throw new Error('Episode delivery requires a real project directory')
  }
}

/**
 * Read a complete journal record without following a file link.
 * @param path - Absolute journal path inside the project review directory.
 * @returns The validated job when it exists.
 */
export async function readEpisodeJob(path: string): Promise<EpisodeDeliveryJob | undefined> {
  if (!await episodeFileExists(path)) return undefined
  const job = jobSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  return job.phase === 'pending' ? job : { ...job, delivery: parseEpisodeDelivery(job.delivery) }
}

/**
 * Save a journal stage while the caller owns the writer lock.
 * @param path - Absolute journal path.
 * @param job - Render intent or verified candidate metadata.
 */
export async function writeEpisodeJob(path: string, job: EpisodeDeliveryJob): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(job) + '\n', { mode: 0o600 })
}

/**
 * Remove an attempt-owned file after interruption or publication.
 * @param path - Absolute private candidate or journal path.
 */
export async function removeEpisodeJobFile(path: string): Promise<void> {
  if (await episodeFileExists(path)) await unlink(path)
}

/**
 * Link the candidate to its public name or verify a previously linked file.
 * @param candidate - Absolute path owned by the journaled attempt.
 * @param output - Absolute public MP4 path for the same plan.
 * @param sha256 - Digest committed before publication.
 * @param signal - Host shutdown signal.
 * @param validateInputs - Check the current plan immediately before accepting a verified MP4.
 */
export async function publishEpisodeCandidate(candidate: string, output: string, sha256: string, signal: AbortSignal,
  validateInputs: () => Promise<void>): Promise<void> {
  await ensureEpisodeDirectory(dirname(output))
  await validateInputs()
  let linked: Stats | undefined
  if (!await episodeFileExists(output)) {
    const source = await episodeFile(candidate)
    if (source === undefined || await artifactHash(candidate, signal) !== sha256
      || !sameFile(source, await episodeFile(candidate))) {
      throw new Error('The verified episode candidate is missing or changed')
    }
    signal.throwIfAborted()
    try {
      await link(candidate, output)
      linked = source
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    }
  }
  const published = await episodeFile(output)
  if (linked !== undefined && !sameFile(linked, published)) {
    throw new Error('The episode candidate changed during publication')
  }
  if (published === undefined || await artifactHash(output, signal) !== sha256) {
    if (linked !== undefined && sameFile(linked, await episodeFile(output))) await unlink(output)
    throw new Error('An existing episode output does not match the verified delivery')
  }
}
