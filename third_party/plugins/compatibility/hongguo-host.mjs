/** Qualify reviewed public metadata sources and their current Host peer. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sourceFilesSha256 = '66c8fb18a32c8ad05896fd37e50f3f1519486094004b56c8182a7b9f915e3cb9'
const sourceBytes = readFileSync(new URL('./hongguo-source-files.json', import.meta.url))
if (createHash('sha256').update(sourceBytes).digest('hex') !== sourceFilesSha256) throw new Error('community plugins: Hongguo source inventory requires review')
const sourceFiles = JSON.parse(sourceBytes.toString('utf8'))

/** Metadata included in the artifact's SOURCE.json. */
export const hongguoHostCompatibility = {
  hostToolApiVersion: '0.2.1-alpha.1', sourceFilesSha256,
  activation: 'scoped creative presets; disabled global entry',
  tools: ['hongguo_search', 'hongguo_detail', 'hongguo_rankings', 'hongguo_collections'],
  credentialsRequired: false,
  localChanges: ['retain ranking cards with unknown metrics', 'preserve multi-metric observations and field coverage'],
}

/**
 * Validate all retained files and bind the staged manifest to the tested Host tools.
 * @param {string} directory Private source staging directory.
 * @returns {void}
 */
export function applyHongguoHostCompatibility(directory) {
  for (const [path, hash] of Object.entries(sourceFiles)) {
    if (createHash('sha256').update(readFileSync(join(directory, path))).digest('hex') !== hash) {
      throw new Error(`community plugins: Hongguo ${path} requires source review`)
    }
  }
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.peerDependencies['@deepseek-ai/dsh-tools'] = hongguoHostCompatibility.hostToolApiVersion
  manifest.files = [...new Set([...manifest.files, 'RECOVERY.md'])]
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(join(directory, 'cordis.patch.yml'), '# Creative presets activate this provider in their own scope.\n- insert:\n    - id: muse-hongguo-search\n      name: muse-hongguo-search\n      disabled: true\n')
}
