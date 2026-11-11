/** Mount the real Jubian tools after the offline transport and active Skill source are ready. */
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const Jubian = await importSnapshotModule(
  new URL('../../../packages/jubian/tool-jubian/src/index.ts', import.meta.url),
  new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url),
)
export default { ...Jubian, inject: [...Jubian.inject, 'snapshotNativeSkillReady'],
  async apply(ctx, config) {
    const home = await realpath(process.env.DSH_HOME)
    return await Jubian.apply(ctx, { ...config, ledgerRoot: join(home, 'jubian', 'ledger') })
  },
}
