/** Install source Muse plugins under the fixture's existing dependency owner. */
import { cp, symlink } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * @param {string} sourceRoot - Repository directory containing the source plugins.
 * @param {string} nodeModules - Private fixture node_modules with the Host dependencies linked.
 * @returns {Promise<void>} All plugin entries are ready for the product preset to resolve.
 */
export async function stageSourceMusePlugins(sourceRoot, nodeModules) {
  for (const plugin of ['muse-hongguo-search', 'muse-hongguo-download', 'muse-douyin-download', 'muse-reverse-tools', 'muse-fanqie-download']) {
    const source = join(sourceRoot, plugin)
    const target = join(nodeModules, plugin)
    // Node resolves a symlink's peer imports from the source realpath, outside this installed owner.
    if (plugin === 'muse-hongguo-download') await cp(source, target, { recursive: true })
    else await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
  }
}
