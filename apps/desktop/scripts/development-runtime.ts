/** Resolve and verify an explicit development runtime without preparing a replacement. */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Runtime preparation and validation owned by the Desktop launcher. */
export interface DevelopmentRuntimeActions {
  /** Prepare the default development runtime when no override was supplied. */
  prepare(): Promise<void>
  /** Verify the explicitly selected, native runtime before it is launched. */
  verify(directory: string): void | Promise<void>
}

/**
 * Prepare the default runtime or verify a supplied native runtime without fallback.
 * @param override - Optional primary-runtime directory supplied by the developer.
 * @param actions - Default preparation and explicit-runtime verification operations.
 * @returns The verified absolute override path, or undefined for the default runtime.
 */
export async function prepareDevelopmentRuntime(
  override: string | undefined,
  actions: DevelopmentRuntimeActions,
): Promise<string | undefined> {
  if (override === undefined) {
    await actions.prepare()
    return undefined
  }
  if (override.trim() === '') throw new Error('desktop development: primary runtime override must not be empty')
  const directory = resolve(override)
  const manifest: unknown = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)
    || !('platform' in manifest) || !('arch' in manifest)
    || manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error(`desktop development: primary runtime must target ${process.platform}/${process.arch}`)
  }
  await actions.verify(directory)
  return directory
}
