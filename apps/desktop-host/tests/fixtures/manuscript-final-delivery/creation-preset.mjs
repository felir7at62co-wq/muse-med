/** The real creation policy and PTC executor are confined to the parent composition. */
import { importSnapshotModule, importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const creation = await importSnapshotModule(new URL('../../../src/creation-policy.ts', import.meta.url), new URL('../../../lib/creation-policy.js', import.meta.url))
const ptc = await importSnapshotPackage('@deepseek-ai/dsh-tool-executor-ptc', owner)

export const name = 'manuscript-delivery-real-creation-preset'
export const inject = ['tools', 'systemPrompt', 'ptcRuntime']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Independently mounted parent creation scope. */
export async function apply(ctx) {
  await ctx.plugin(creation)
  await ctx.plugin(ptc, { maxParallelSubCalls: 10 })
}
