/** Qualify the recovered public metadata plugin without changing its retained source. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sourceFilesSha256 = 'acc2308582ddf63e2dab6865da7a73b0a4bb00e2d153ce7bf6370a07a4dae913'
const sourceBytes = readFileSync(new URL('./hongguo-source-files.json', import.meta.url))
if (createHash('sha256').update(sourceBytes).digest('hex') !== sourceFilesSha256) throw new Error('community plugins: Hongguo source inventory requires review')
const sourceFiles = JSON.parse(sourceBytes.toString('utf8'))

/** Metadata included in the artifact's SOURCE.json. */
export const hongguoHostCompatibility = {
  hostToolApiVersion: '0.2.0-rc.2', sourceFilesSha256,
  activation: 'scoped creative presets; disabled global entry',
  tools: ['hongguo_search', 'hongguo_detail', 'hongguo_rankings', 'hongguo_collections'],
  credentialsRequired: false,
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
