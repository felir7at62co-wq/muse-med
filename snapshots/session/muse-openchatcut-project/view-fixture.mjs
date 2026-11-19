/** A headless conversation with the real editing tools and no connected editor view. */
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const plugin = await importSnapshotModule(
  new URL('../../../packages/client/ui-jingliu/src/index.ts', import.meta.url),
  new URL('../../../packages/client/ui-jingliu/lib/index.js', import.meta.url),
)
export const inject = ['tools']
export async function apply(ctx) {
  await ctx.plugin(plugin, { editorOrigin: 'http://127.0.0.1:1', editorTokenFile: 'unused-without-an-editor' }).await()
}
