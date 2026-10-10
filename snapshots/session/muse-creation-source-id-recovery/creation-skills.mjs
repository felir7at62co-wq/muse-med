/** Select the real product creation skill provider in the snapshot's execution mode. */
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const skills = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/creation-skills.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/creation-skills.js', import.meta.url),
)
export const { name, inject, apply } = skills
