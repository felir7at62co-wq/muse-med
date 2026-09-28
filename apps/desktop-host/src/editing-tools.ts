/** Keep video production tools out of the script-writing agent's tool set. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

/** The Host's Jubian tool names; Host rows may register them after this preset mounts. */
const JUBIAN_TOOLS = [
  'jubian_catalog',
  'jubian_find',
  'jubian_asset',
  'jubian_organize',
  'jubian_model',
  'jubian_storyboard',
  'jubian_video',
  'jubian_watch',
  'jubian_media',
] as const

/** Cordis plugin name. */
export const name = 'editing-tools'

/** Scope-local tool registry is required to filter only this preset. */
export const inject = ['tools']

/**
 * Hide Host video tools from the editing agent and its joined child agents.
 * @param ctx - The selected editing preset's scoped context.
 */
export function apply(ctx: Context): void {
  ctx.tools.restrict({ futureDeny: JUBIAN_TOOLS })
}
