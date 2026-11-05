/** Mount the production child scheduling policy in the active source or artifact mode. */
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const policy = await importSnapshotModule(new URL('../../../apps/desktop-host/src/delegation-policy.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/delegation-policy.js', import.meta.url))
export const name = policy.name
export const inject = policy.inject
export const apply = policy.apply
