/** Complete a materialized runtime deployment with the installed production dependency graph. */
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

interface Manifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

async function manifest(directory: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Manifest
}

function installed(name: string, directory: string): string | undefined {
  return (createRequire(join(directory, 'package.json')).resolve.paths(name) ?? [])
    .map(parent => join(parent, name)).find(path => existsSync(join(path, 'package.json')))
}

/**
 * Restore transitive packages omitted by legacy hoisting without resolving outside the deployment at runtime.
 * Existing matching packages are shared; conflicting installed versions remain package-local.
 * @param source - Installed build workspace used to resolve production dependencies.
 * @param staging - Materialized deployment whose manifest selects the runtime packages.
 * @returns Relative directories copied into deployment; missing required source packages reject.
 */
export async function restoreRuntimeDependencies(source: string, staging: string): Promise<string[]> {
  const pending = [{ source, destination: staging }]
  const visited = new Set<string>()
  const restored: string[] = []
  for (let index = 0; index < pending.length; index++) {
    const entry = pending[index] as { source: string; destination: string }
    if (visited.has(entry.destination)) continue
    visited.add(entry.destination)
    const info = await manifest(entry.destination)
    const dependencies = new Set([...Object.keys(info.dependencies ?? {}),
      ...Object.keys(info.optionalDependencies ?? {}), ...Object.keys(info.peerDependencies ?? {})])
    for (const name of dependencies) {
      const location = installed(name, entry.source) ?? installed(name, source)
      if (location === undefined) {
        if (info.optionalDependencies?.[name] !== undefined || info.peerDependenciesMeta?.[name]?.optional === true) continue
        throw Error(`Runtime dependency ${name} required by ${info.name ?? 'deployment'} is missing from the build workspace`)
      }
      const sourceDirectory = await realpath(location)
      const sourceInfo = await manifest(sourceDirectory)
      let destination = installed(name, entry.destination)
      if (destination !== undefined) {
        const path = relative(staging, destination)
        if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep)
          || (await manifest(destination)).version !== sourceInfo.version) destination = undefined
      }
      if (destination === undefined) {
        const shared = join(staging, 'node_modules', name)
        destination = existsSync(join(shared, 'package.json')) ? join(entry.destination, 'node_modules', name) : shared
        if (existsSync(join(destination, 'package.json'))) {
          throw Error(`Runtime dependency version conflicts with the installed build workspace: ${destination}`)
        }
        const nestedModules = join(sourceDirectory, 'node_modules')
        await mkdir(dirname(destination), { recursive: true })
        await cp(sourceDirectory, destination, { recursive: true, dereference: true,
          filter: path => path !== nestedModules && !path.startsWith(nestedModules + sep) })
        restored.push(relative(staging, destination))
      }
      pending.push({ source: sourceDirectory, destination })
    }
  }
  return restored
}
