/**
 * The model-facing Script Workshop tools, as the signed-in Muse user: `script_finalize` uploads a finished script to
 * the finalized-script library after the user agreed; `script_library` reads a library script into the workspace and
 * records the Jingliu project a picked script became. `workshop_script_editor` reads cloud drafts and stages a
 * single-episode candidate for human review.
 * @module @deepseek-ai/dsh-tool-workshop
 */
import type { Context } from '@deepseek-ai/cordis'
import { applyFinalize } from './finalize.ts'
import { applyLibrary } from './library.ts'
import { applyScriptEditor } from './editor.ts'

export type { FinalizeArgs, FinalizeDependencies, FinalizeReport, ReadFile, UploadEpisode } from './finalize.ts'
export type { EpisodeFiles, LibraryArgs, LibraryDependencies, LibraryReport, WriteFile } from './library.ts'

/** Cordis plugin name. */
export const name = 'tool-workshop'
/** The tools register once the Host also provides `workshopConnection`. */
export const inject = ['tools']

/**
 * Register `workshop_script_editor` while the Host provides the Script Workshop connection.
 * Register `script_finalize` and `script_library` when it also provides workspace files.
 * @param ctx - Agent or Host context with the tool registry.
 */
export function apply(ctx: Context): void {
  applyFinalize(ctx)
  applyLibrary(ctx)
  applyScriptEditor(ctx)
}
