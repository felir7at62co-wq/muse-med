/** Canonical local project identity shared by recovery discovery and reconciliation. */
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { JubianLedgerRecord } from '@deepseek-ai/dsh-jubian'
import { z } from 'zod'
import { readEpisodeBytes } from './episode-delivery.ts'

/** Project identity read from the selected regular configuration file. */
export interface RecoveryProject {
  readonly directory: string
  readonly scriptId: number
  readonly configSha256: string
}

const bindingSchema = z.object({
  jubian_script_id: z.union([z.number(), z.string().regex(/^[0-9]+$/u)]).transform(Number)
    .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
})

/**
 * Validate the project endpoints and resolve ancestor aliases to one identity.
 * @param path - Absolute operator-selected project directory.
 * @param signal - Cancellation of local inspection; omitted for a caller without a lifetime.
 * @param metadataMaxBytes - Optional bounded-read budget for the source-lease path.
 * @returns Canonical directory, project ID and exact configuration hash.
 */
export async function recoveryProject(path: string, signal?: AbortSignal, metadataMaxBytes?: number): Promise<RecoveryProject> {
  signal?.throwIfAborted()
  if (!isAbsolute(path)) throw new Error('Select an absolute Jubian project directory')
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Select a regular Jubian project directory')
  const directory = await realpath(path)
  const configPath = join(directory, 'project_config.json')
  const config = await lstat(configPath)
  if (!config.isFile() || config.isSymbolicLink()) throw new Error('The project configuration must be a regular file')
  const bytes = metadataMaxBytes === undefined ? await readFile(configPath, { signal })
    : await readEpisodeBytes(configPath, metadataMaxBytes, signal)
  if (bytes === undefined) throw new Error('The selected project configuration is unavailable')
  const binding = bindingSchema.parse(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')))
  signal?.throwIfAborted()
  return { directory, scriptId: binding.jubian_script_id, configSha256: createHash('sha256').update(bytes).digest('hex') }
}

/**
 * Locate a recorded preview without inventing missing legacy submission evidence.
 * @param record - Original ledger intent; absence is not recoverable.
 * @param project - Canonical authorized project identity.
 * @param signal - Cancellation of local inspection; omitted for a caller without a lifetime.
 * @returns Canonical regular preview path, or undefined for an unrelated or incomplete intent.
 */
export async function recordedVideoPreview(record: JubianLedgerRecord | undefined, project: RecoveryProject,
  signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted()
  const source = record?.video_preview_path
  if (record?.method !== 'storyboard_native_submit' || record.script_id !== project.scriptId
    || record.outcome === 'not_sent' || source === undefined || !isAbsolute(source)
    || (record.before_task_ids === undefined && record.outcome !== 'accepted')) return undefined
  try {
    const tasks = join(project.directory, 'video_tasks')
    for (const path of [tasks, dirname(source)]) {
      const entry = await lstat(path)
      if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(path) !== tasks) return undefined
    }
    const entry = await lstat(source)
    if (!entry.isFile() || entry.isSymbolicLink()) return undefined
    const preview = await realpath(source)
    signal?.throwIfAborted()
    return dirname(preview) === tasks ? preview : undefined
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}
