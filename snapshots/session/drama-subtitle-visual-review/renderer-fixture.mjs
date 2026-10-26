/** Load the shipped renderer in the scenario's declared source or built plane. */
import { importSnapshotModule } from '../muse-fixture-import.mjs'

export const { name, inject, Config, apply } = await importSnapshotModule(
  new URL('../../../packages/drama/tool-episode-render/src/index.ts', import.meta.url),
  new URL('../../../packages/drama/tool-episode-render/lib/index.js', import.meta.url),
)
