import { isAbsolute, relative } from 'node:path'
import { requireProjectAudioFile } from './audio.ts'

/** The selected local project and its optional verified display alias. */
export interface ContentListeningProject {
  /** Project root selected by the caller or filesystem adapter. */
  readonly project: string
  /** The display path of the same project selected by the filesystem adapter. */
  readonly projectAlias?: string
}

type ListeningSourceInput = { readonly path: string; readonly sha256: string | null }

/** Compare a receipt path to an already authorized canonical file.
 * @param selection - Authorized project and its optional display alias.
 * @param canonicalFile - Canonical identity of the previously validated project file.
 * @param recordedPath - Untrusted absolute path from the receipt.
 * @returns Whether the recorded path resolves to the same project file.
 */
export async function matchesListeningSourcePath(
  selection: ContentListeningProject,
  canonicalFile: string,
  recordedPath: unknown,
): Promise<boolean> {
  if (typeof recordedPath !== 'string' || !isAbsolute(recordedPath)) return false
  if (relative(canonicalFile, recordedPath) === '') return true
  try {
    const { project, projectAlias } = selection
    return relative(canonicalFile, await requireProjectAudioFile(project, recordedPath, projectAlias)) === ''
  } catch {
    return false
  }
}

/** Find the first receipt entry with the same project file identity.
 * @param project - Authorized project and its optional display alias.
 * @param inputs - Recorded render input entries.
 * @param canonicalFile - Canonical identity of the previously validated project file.
 * @param sha256 - Optional digest filter applied before comparing file identities.
 * @returns The first matching entry, if any.
 */
export async function findListeningSourceInput(
  project: ContentListeningProject,
  inputs: readonly ListeningSourceInput[],
  canonicalFile: string,
  sha256?: string,
): Promise<ListeningSourceInput | undefined> {
  for (const input of inputs) {
    if ((sha256 === undefined || input.sha256 === sha256)
      && await matchesListeningSourcePath(project, canonicalFile, input.path)) return input
  }
  return undefined
}
