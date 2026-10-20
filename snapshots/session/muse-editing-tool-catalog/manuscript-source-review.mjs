/** Load the product source comparison tool in the snapshot's execution mode. */
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const review = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/manuscript-source-review.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/manuscript-source-review.js', import.meta.url),
)
export const { name, inject, apply, Config } = review
