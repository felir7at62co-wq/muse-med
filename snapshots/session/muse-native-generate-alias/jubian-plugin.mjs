/** Run this scenario's real Jubian tools in the same source or built face as dsh. */
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const Jubian = await importSnapshotModule(
  new URL('../../../packages/jubian/tool-jubian/src/index.ts', import.meta.url),
  new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url),
)
// The real client captures fetch at mount, after the isolated wire and ledger are ready.
export default { ...Jubian, inject: [...Jubian.inject, 'snapshotGenerateAliasReady'] }
