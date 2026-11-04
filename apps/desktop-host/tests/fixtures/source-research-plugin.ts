/** Private source copies resolve the research plugin's two owned clients beside its declared peers. */
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Load the real plugin without a development-only sibling node_modules mapping.
 * @param ctx - Test context that owns the private directory through disposal.
 * @returns The real research plugin namespace with clients resolved from its private dependency owner.
 */
export async function loadSourceResearchPlugin(ctx: Context): Promise<typeof import('../../../../third_party/plugins/muse-source-research/src/index.js')> {
  const anchor = await mkdtemp(fileURLToPath(new URL('../../.test-source-research-', import.meta.url)))
  ctx.effect(() => () => rm(anchor, { recursive: true, force: true }))
  for (const plugin of ['muse-source-research', 'muse-hongguo-search', 'muse-qimao-data']) {
    await cp(new URL(`../../../../third_party/plugins/${plugin}/`, import.meta.url), join(anchor, 'node_modules', plugin), {
      recursive: true,
      filter: source => !source.split(/[\\/]/).includes('node_modules'),
    })
  }
  const plugin = await import(pathToFileURL(join(anchor, 'node_modules/muse-source-research/src/index.js')).href) as typeof import('../../../../third_party/plugins/muse-source-research/src/index.js')
  return plugin
}
