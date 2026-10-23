/** Mount the real tools after their isolated provider transport is ready. */
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const Jubian = await importSnapshotModule(
  new URL('../../../packages/jubian/tool-jubian/src/index.ts', import.meta.url),
  new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url),
)
export default { ...Jubian, inject: [...Jubian.inject, 'snapshotEraseReady'] }
