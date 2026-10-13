/** Select the product short-drama guidance in the snapshot's execution mode. */
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const guidance = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/short-drama-guidance.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/short-drama-guidance.js', import.meta.url),
)
export const { name, inject, apply } = guidance
