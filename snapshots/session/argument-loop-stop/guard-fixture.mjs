/** Load the actual guard from source or its owning installed Host dependency. */
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const guard = await importSnapshotPackage('@deepseek-ai/dsh-argument-loop', new URL('../../../apps/desktop-host/package.json', import.meta.url))
export const name = guard.name
export const inject = guard.inject
export const Config = guard.Config
export const apply = guard.apply
