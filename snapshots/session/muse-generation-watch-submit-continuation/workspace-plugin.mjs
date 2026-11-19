/** Native Desktop workspace ownership in the same execution face as the shipped CLI. */
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const Workspace = await importSnapshotModule(new URL('../../../apps/desktop-host/src/workspace-owned-storage.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/workspace-owned-storage.js', import.meta.url))
export default { ...Workspace, inject: [...Workspace.inject, 'snapshotWatchEntropyReady'] }
