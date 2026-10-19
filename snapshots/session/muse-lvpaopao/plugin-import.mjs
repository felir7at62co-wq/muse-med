/**
 * Import the owned plugin through one private layout in lib mode. Build the package with
 * third_party/plugins/muse-lvpaopao/scripts/build.mjs and the matching Harness peers before this replay.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = fileURLToPath(new URL('../../../third_party/plugins/muse-lvpaopao/', import.meta.url))
const runtimeRequire = createRequire(new URL('../../../apps/cli/package.json', import.meta.url))
const modules = new Map()
let mountedRoot

/** Find the manifest of the actual built peer selected by the CLI installation. */
function peerRoot(name) {
  const entry = runtimeRequire.resolve(name)
  if (!/\.(?:cjs|mjs|js)$/.test(entry)) throw Error(`Lib replay requires a built runtime peer: ${name}`)
  let directory = dirname(entry)
  for (;;) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return directory
    const parent = dirname(directory)
    if (parent === directory) throw Error(`Cannot locate the selected runtime peer: ${name}`)
    directory = parent
  }
}

/** Copy compiled plugin files once; the snapshot harness owns and removes this isolated home. */
function mountedPackage() {
  if (mountedRoot !== undefined) return mountedRoot
  const home = process.env.DSH_HOME
  if (typeof home !== 'string' || !isAbsolute(home)) throw Error('Lib replay requires its isolated DSH_HOME')
  if (!existsSync(join(packageRoot, 'lib', 'bridge.js')) || !existsSync(join(packageRoot, 'lib', 'index.js'))) {
    throw Error('Build muse-lvpaopao before running its lib snapshot')
  }
  const manifestPath = join(packageRoot, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const layout = mkdtempSync(join(home, 'muse-lvpaopao-layout-'))
  cpSync(join(packageRoot, 'lib'), join(layout, 'lib'), { recursive: true })
  cpSync(manifestPath, join(layout, 'package.json'))
  for (const name of Object.keys(manifest.peerDependencies)) {
    const link = join(layout, 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(peerRoot(name), link, process.platform === 'win32' ? 'junction' : 'dir')
  }
  mountedRoot = layout
  return layout
}

/**
 * @param {'bridge' | 'index'} entry - Production plugin entry selected by this scenario.
 * @returns {Promise<object>} The same module namespace for both fixture wrappers.
 */
export function importLvpaopaoSnapshot(entry) {
  if (entry !== 'bridge' && entry !== 'index') throw Error('Unexpected Lvpaopao snapshot entry')
  if (!modules.has(entry)) {
    modules.set(entry, import(pathToFileURL(process.env.DSH_EXAMPLE_MODE === 'lib'
      ? join(mountedPackage(), 'lib', `${entry}.js`)
      : join(packageRoot, 'src', `${entry}.ts`)).href))
  }
  return modules.get(entry)
}
