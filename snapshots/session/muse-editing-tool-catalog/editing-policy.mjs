/** Load the product editing policy in the snapshot's execution mode. */
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const policy = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/editing-policy.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/editing-policy.js', import.meta.url),
)
export const { name, inject, apply } = policy
