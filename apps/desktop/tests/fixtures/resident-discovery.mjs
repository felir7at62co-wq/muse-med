/** Load the shipped Desktop discovery configuration in the recorded headless fixture. */
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const entry = new URL(process.env.DSH_EXAMPLE_MODE === 'lib'
  ? '../../../../packages/core/tool-discovery/lib/index.js'
  : '../../../../packages/core/tool-discovery/src/index.ts', import.meta.url)
const Discovery = await import(entry.href)

export const name = 'resident-discovery-fixture'
export function apply(ctx) {
  const path = fileURLToPath(new URL('../../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))
  const row = loadOverlayPatches('resident-question-snapshot', path)
    .flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'tool-discovery')
  if (!row) throw new Error('Missing Desktop tool discovery row')
  ctx.plugin(Discovery, Discovery.Config(row.config))
}
