/** Install source Muse plugins under the fixture's existing dependency owner. */
import { cp, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * @param {string} sourceRoot - Repository directory containing the source plugins.
 * @param {string} nodeModules - Private fixture node_modules with the Host dependencies linked.
 * @returns {Promise<void>} Entries use the fixture's peers; the TypeScript adapter uses its source entry in source mode and requires compiled artifacts in lib mode.
 */
export async function stageSourceMusePlugins(sourceRoot, nodeModules) {
  for (const plugin of ['muse-hongguo-search', 'muse-hongguo-download', 'muse-douyin-download', 'muse-reverse-tools', 'muse-fanqie-download', 'muse-lvpaopao']) {
    const source = join(sourceRoot, plugin)
    const target = join(nodeModules, plugin)
    // Node resolves a symlink's peer imports from the source realpath, outside this installed owner.
    if (plugin === 'muse-hongguo-download' || plugin === 'muse-lvpaopao') await cp(source, target, { recursive: true })
    else await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    if (plugin === 'muse-lvpaopao' && process.env.DSH_EXAMPLE_MODE !== 'lib') {
      const path = join(target, 'package.json')
      const manifest = JSON.parse(await readFile(path, 'utf8'))
      manifest.exports['.'] = { default: './src/index.ts' }
      await writeFile(path, JSON.stringify(manifest) + '\n')
    }
  }
}
