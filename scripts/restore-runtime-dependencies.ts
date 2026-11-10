/** Materialize installed dependency resolution after pnpm legacy deployment omits package links. */
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'

interface Manifest {
  name: string
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

async function manifest(directory: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Manifest
}

/**
 * Restore installed packages and native assets without replicating direct workspace peers.
 * Conflicting transitive versions remain nested under their declaring package.
 * @param source - Installed deployment source, including its package.json and node_modules.
 * @param staging - Existing deployed package; installed files are retained.
 * @returns Number of package directories restored.
 */
export async function restoreRuntimeDependencies(source: string, staging: string): Promise<number> {
  const root = await manifest(source)
  const visited = new Set<string>()
  const direct = new Map<string, string>()
  let restored = 0
  const resolveDependency = (owner: string, name: string, within?: string): string | undefined => {
    const require = createRequire(join(owner, 'package.json'))
    return require.resolve.paths(name)?.map(path => join(path, name))
      .filter(path => within === undefined || path.startsWith(within + sep))
      .find(path => existsSync(join(path, 'package.json')))
  }
  const materialize = async (sourceDirectory: string, destination: string): Promise<void> => {
    if (existsSync(destination)) return
    await mkdir(dirname(destination), { recursive: true })
    const nested = join(sourceDirectory, 'node_modules')
    await cp(sourceDirectory, destination, { recursive: true, dereference: true,
      filter: path => path !== nested && !path.startsWith(nested + sep) })
    restored++
  }
  const copy = async (sourceDirectory: string, destination: string): Promise<void> => {
    const key = `${sourceDirectory}\0${destination}`
    if (visited.has(key)) return
    visited.add(key)
    await materialize(sourceDirectory, destination)
    const owner = await manifest(sourceDirectory)
    const dependencies = { ...owner.peerDependencies, ...owner.dependencies, ...owner.optionalDependencies }
    for (const name of Object.keys(dependencies).sort()) {
      const installed = resolveDependency(sourceDirectory, name)
      if (installed === undefined) {
        if (owner.optionalDependencies?.[name] !== undefined || owner.peerDependenciesMeta?.[name]?.optional) continue
        throw new Error(`Runtime dependency ${name} required by ${owner.name} is not installed`)
      }
      const resolved = await realpath(installed)
      const selected = await manifest(resolved)
      let target = join(staging, 'node_modules', name)
      const existing = resolveDependency(destination, name, staging)
      if (existing !== undefined && (await manifest(existing)).version === selected.version) {
        target = existing
      } else if (existsSync(target)) {
        target = join(destination, 'node_modules', name)
      }
      await copy(resolved, target)
    }
  }
  // Direct packages establish the shared workspace instances before transitive traversal.
  for (const name of Object.keys(root.dependencies ?? {}).sort()) {
    const installed = resolveDependency(source, name)
    if (installed === undefined) throw new Error(`Runtime dependency ${name} required by ${root.name} is not installed`)
    const resolved = await realpath(installed)
    direct.set(name, resolved)
    const destination = join(staging, 'node_modules', name)
    await materialize(resolved, destination)
  }
  for (const [name, resolved] of direct) {
    await copy(resolved, join(staging, 'node_modules', name))
  }
  return restored
}
