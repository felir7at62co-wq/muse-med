/** Load the actual audio tools after the isolated provider fixture is ready. */
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const Jubian = await importSnapshotModule(
  new URL('../../../packages/jubian/tool-jubian/src/index.ts', import.meta.url),
  new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url),
)
export default { ...Jubian, inject: [...Jubian.inject, 'snapshotAudioBindingReady'] }
