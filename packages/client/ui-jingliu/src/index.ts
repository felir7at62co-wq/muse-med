/** Publish configured workbench addresses to the Muse renderer. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, editorUrl, studioUrl } from './config.ts'
import { registerCutImport } from './cut-import-host.ts'
import { EDITOR_URL_GLOBAL, STUDIO_URL_GLOBAL, WORKSHOP_URL_GLOBAL } from './page.ts'

export { Config }

/**
 * Add each configured workbench to the application bootstrap.
 * @param ctx - Host context collecting public page fields.
 * @param config - Dedicated origins of the workbenches.
 */
export function apply(ctx: Context, config: Config): void {
  const studio = studioUrl(config.studioOrigin)
  const workshop = studioUrl(config.workshopOrigin, 'workshop')
  const editor = editorUrl(config.editorOrigin)
  if (editor && studio) registerCutImport(ctx, new URL(studio).origin)
  ctx.on('webserver/index-inject', (table) => {
    if (studio) table.push({ kind: 'global', name: STUDIO_URL_GLOBAL, value: studio })
    if (workshop) table.push({ kind: 'global', name: WORKSHOP_URL_GLOBAL, value: workshop })
    if (editor) table.push({ kind: 'global', name: EDITOR_URL_GLOBAL, value: editor })
  })
}
