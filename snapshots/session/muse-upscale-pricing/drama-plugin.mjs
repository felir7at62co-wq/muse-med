/** Compose the real drama settings defaults in either snapshot execution mode. */
import { importSnapshotModule } from '../muse-fixture-import.mjs'
export default await importSnapshotModule(
  new URL('../../../packages/drama/drama-settings/src/index.ts', import.meta.url),
  new URL('../../../packages/drama/drama-settings/lib/index.js', import.meta.url),
)
