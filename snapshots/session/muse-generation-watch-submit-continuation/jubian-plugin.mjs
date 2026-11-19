/** Real native submission and generation-watch producer, using only the fixture's transport. */
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const Jubian = await importSnapshotModule(new URL('../../../packages/jubian/tool-jubian/src/index.ts', import.meta.url),
  new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url))
export default { ...Jubian, inject: [...Jubian.inject, 'snapshotWatchReady'] }
