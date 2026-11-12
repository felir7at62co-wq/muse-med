/** Actual Desktop discovery configuration shared by source and built test owners. */
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { Config } from '@deepseek-ai/dsh-tool-discovery'

/** Read and validate the shipped Desktop discovery settings.
 * @returns The schema-validated configuration with explicit resident names.
 */
export function desktopDiscoveryConfig() {
  const patchPath = fileURLToPath(new URL('../../config/desktop.cordis.patch.yml', import.meta.url))
  const row = loadOverlayPatches('desktop-discovery-catalog', patchPath)
    .flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'tool-discovery')
  if (!row) throw new Error('Missing Desktop tool-discovery row')
  const raw: unknown = row.config
  if (!raw || typeof raw !== 'object' || !('alwaysLoad' in raw)
    || !Array.isArray(raw.alwaysLoad) || !raw.alwaysLoad.every((value: unknown): value is string => typeof value === 'string')) {
    throw new Error('Missing resident tool names')
  }
  return Config({ ...raw, alwaysLoad: raw.alwaysLoad })
}
