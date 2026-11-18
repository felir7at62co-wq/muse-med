/** Pin the companion's multipart parser without resolving unrelated dependencies. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const override = JSON.parse(readFileSync(new URL('./runtime-dependencies.json', import.meta.url), 'utf8'))
const digest = source => createHash('sha256').update(source).digest('hex')

/**
 * Plan a manifest and lockfile update only for the exact pinned upstream files.
 * @param root - Sparse checkout of the Dockerfile's upstream revision.
 * @param readSource - Read staged source before falling back to disk.
 * @returns Both complete JSON documents, with only the declared dependency delta applied.
 */
export function planRuntimeDependencies(root, readSource = path => readFileSync(path, 'utf8')) {
  const manifestPath = resolve(root, 'backend-node/package.json')
  const lockPath = resolve(root, 'backend-node/package-lock.json')
  const manifestSource = readSource(manifestPath).replaceAll('\r\n', '\n'), lockSource = readSource(lockPath).replaceAll('\r\n', '\n')
  if (digest(manifestSource) !== override.source.packageSha256 || digest(lockSource) !== override.source.lockSha256) {
    throw new Error('Muse runtime dependencies do not match pinned upstream package and lock hashes')
  }
  const manifest = JSON.parse(manifestSource), lock = JSON.parse(lockSource)
  manifest.dependencies[override.dependency.name] = override.dependency.version
  lock.packages[''].dependencies[override.dependency.name] = override.dependency.version
  lock.packages[`node_modules/${override.dependency.name}`] = override.lockPackage
  for (const name of override.removeLockPackages) delete lock.packages[name]
  return [[manifestPath, JSON.stringify(manifest, null, 2) + '\n'], [lockPath, JSON.stringify(lock, null, 2) + '\n']]
}
