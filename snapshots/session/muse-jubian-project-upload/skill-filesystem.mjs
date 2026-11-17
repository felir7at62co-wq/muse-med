/** Discover the copied active Skill through its canonical, isolated native directory. */
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const Filesystem = await importSnapshotModule(
  new URL('../../../packages/skill/skill-filesystem/src/index.ts', import.meta.url),
  new URL('../../../packages/skill/skill-filesystem/lib/index.js', import.meta.url),
)
export const name = 'snapshot-project-upload-filesystem'
export const inject = [...Filesystem.inject, 'snapshotNativeSkillReady']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Real Skill registry in the Headless profile. */
export async function apply(ctx) {
  await Filesystem.apply(ctx, { includeDefaultRoots: false, customSkillDirs: [], watch: false,
    bundledSkillDir: await realpath(join(process.env.DSH_HOME, 'skills')) })
}
