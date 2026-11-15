/** Load current product discovery, or an explicit retained Bot-policy fixture for historical recordings. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const entry = new URL(process.env.DSH_EXAMPLE_MODE === 'lib'
  ? '../../../../packages/core/tool-discovery/lib/index.js'
  : '../../../../packages/core/tool-discovery/src/index.ts', import.meta.url)
const Discovery = await import(entry.href)

export const name = 'resident-discovery-fixture'
export async function apply(ctx, config = {}) {
  if (config.legacyBotTools === true) {
    const retained = JSON.parse(await readFile(new URL('../../../../snapshots/session/muse-resident-question/legacy-discovery.json', import.meta.url), 'utf8'))
    await ctx.plugin(Discovery, Discovery.Config(retained))
    return
  }
  const path = fileURLToPath(new URL('../../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))
  const row = loadOverlayPatches('resident-question-snapshot', path)
    .flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'tool-discovery')
  if (!row) throw new Error('Missing Desktop tool discovery row')
  await ctx.plugin(Discovery, Discovery.Config(row.config))
}
