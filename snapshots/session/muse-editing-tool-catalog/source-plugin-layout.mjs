/** Install source Muse plugins under the fixture's existing dependency owner. */
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * @param {string} sourceRoot - Repository directory containing the source plugins.
 * @param {string} nodeModules - Private fixture node_modules with the Host dependencies linked.
 * @returns {Promise<void>} Private source copies share the fixture's peers and remain outside node_modules for source-launch path resolution; lib mode requires compiled artifacts.
 */
export async function stageSourceMusePlugins(sourceRoot, nodeModules) {
  const privateSources = join(dirname(nodeModules), '.source-muse-plugins')
  await mkdir(privateSources, { recursive: true })
  for (const plugin of ['muse-hongguo-search', 'muse-hongguo-download', 'muse-douyin-download', 'muse-reverse-tools', 'muse-fanqie-download', 'muse-qimao-data', 'muse-source-research', 'muse-lvpaopao']) {
    const source = join(sourceRoot, plugin)
    const target = join(nodeModules, plugin)
    if (plugin === 'muse-hongguo-search' || plugin === 'muse-hongguo-download' || plugin === 'muse-qimao-data' || plugin === 'muse-source-research' || plugin === 'muse-lvpaopao') {
      const staged = join(privateSources, plugin)
      await cp(source, staged, { recursive: true, filter: path => basename(path) !== 'node_modules' })
      await symlink(staged, target, process.platform === 'win32' ? 'junction' : 'dir')
    } else await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    if (plugin === 'muse-lvpaopao' && process.env.DSH_EXAMPLE_MODE !== 'lib') {
      const path = join(target, 'package.json')
      const manifest = JSON.parse(await readFile(path, 'utf8'))
      manifest.exports['.'] = { default: './src/index.ts' }
      await writeFile(path, JSON.stringify(manifest) + '\n')
    }
  }
}
