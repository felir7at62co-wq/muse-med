/** Prepare the disposable npm-project view used by an unpackaged Electron shell. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { extract } from 'tar'
import { satisfies } from 'semver'
import { createDevelopmentProjectMetadata } from '../src/project-manager.ts'
import type { DesktopRelease } from '../src/release.ts'

interface PackageManifest {
  readonly name?: string
  readonly version?: string
  readonly main?: string
  readonly dependencies?: Record<string, string>
}

/** Inputs whose locations differ between the launcher and isolated tests. */
export interface DevelopmentProjectOptions {
  /** Checkout owning the pinned community source and frozen toolchain. */
  readonly repositoryRoot: string
  /** Tarballs emitted by the existing source builder for development. */
  readonly communityArtifactsDir: string
  /** Directory replaced with the generated development project. */
  readonly projectDir: string
  /** Current workspace's `apps/cli` package directory. */
  readonly cliDir: string
  /** Current workspace's private Desktop Host application directory. */
  readonly hostDir: string
  /** pnpm's workspace-wide virtual-hoist directory. */
  readonly dependencyDir: string
  /** Release identity written into the disposable project metadata. */
  readonly release: DesktopRelease
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function removeOwnedPath(path: string): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(path)
    return
  }
  if (stat.isDirectory()) {
    rmSync(path, { recursive: true })
    return
  }
  unlinkSync(path)
}

function linkDirectory(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(realpathSync(source), destination, process.platform === 'win32' ? 'junction' : 'dir')
}

function mirrorDependencyLinks(sourceRoot: string, destinationRoot: string): void {
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === '.bin') continue
    const source = join(sourceRoot, entry.name)
    if (entry.name.startsWith('@') && (entry.isDirectory() || entry.isSymbolicLink())) {
      mkdirSync(join(destinationRoot, entry.name), { recursive: true })
      for (const scoped of readdirSync(source, { withFileTypes: true })) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue
        linkDirectory(join(source, scoped.name), join(destinationRoot, entry.name, scoped.name))
      }
      continue
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) linkDirectory(source, join(destinationRoot, entry.name))
  }
}

/**
 * Replace one disposable project with links to the current built workspace.
 * @param options - Project destination, CLI package, and release identity.
 * @returns the absolute project directory supplied by the caller.
 */
export function prepareDevelopmentProject(options: DevelopmentProjectOptions): string {
  const cliManifest = readManifest(join(options.cliDir, 'package.json'))
  if (cliManifest.name !== '@deepseek-ai/dsh' || cliManifest.version !== options.release.version) {
    throw new Error(
      `desktop development: apps/cli must be @deepseek-ai/dsh@${options.release.version}, found `
      + `${String(cliManifest.name)}@${String(cliManifest.version)}`,
    )
  }
  if (!existsSync(options.dependencyDir)) {
    throw new Error('desktop development: workspace dependency links are missing; run pnpm install')
  }
  const hostManifest = readManifest(join(options.hostDir, 'package.json'))
  if (hostManifest.name !== '@deepseek-ai/dsh-desktop-host' || hostManifest.version !== options.release.version) {
    throw new Error(
      `desktop development: apps/desktop-host must be @deepseek-ai/dsh-desktop-host@${options.release.version}, found `
      + `${String(hostManifest.name)}@${String(hostManifest.version)}`,
    )
  }
  if (!existsSync(join(options.hostDir, 'lib', 'index.js'))) {
    throw new Error('desktop development: apps/desktop-host/lib/index.js is missing; run pnpm run build')
  }

  const sourceRoot = join(options.repositoryRoot, 'third_party', 'plugins')
  const pins = JSON.parse(readFileSync(join(sourceRoot, 'sources.json'), 'utf8')) as Record<string, { version: string }>
  mkdirSync(dirname(options.projectDir), { recursive: true })
  const staging = mkdtempSync(join(dirname(options.projectDir), '.community-'))
  const packages: Array<{ directory: string; name: string; version: string; dependencies: Array<[string, string]> }> = []
  try {
    for (const [source, pin] of Object.entries(pins)) {
      if (!/^[a-z0-9-]+$/u.test(source)) throw new Error('desktop development: invalid community source name')
      const expected = readManifest(join(sourceRoot, source, 'package.json'))
      const name = expected.name
      if (name === undefined || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name) || expected.version !== pin.version) {
        throw new Error('desktop development: invalid pinned community manifest')
      }
      const archive = join(options.communityArtifactsDir, `${name.replace('@', '').replace('/', '-')}-${pin.version}.tgz`)
      if (!existsSync(archive)) throw new Error(`desktop development: community artifact missing: ${archive}; run pnpm run dev:desktop without --skip-build`)
      const directory = join(staging, source)
      mkdirSync(directory)
      extract({ file: archive, cwd: directory, sync: true, strip: 1, strict: true, filter(path, entry) {
        const parts = path.replaceAll('\\', '/').split('/')
        if (parts[0] !== 'package' || parts.some(part => part === '..' || part.includes(':')) || !('type' in entry) || !['File', 'Directory'].includes(entry.type)) {
          throw new Error(`desktop development: unsafe community archive entry ${path}`)
        }
        return true
      } })
      const manifest = readManifest(join(directory, 'package.json'))
      const sourceMetadata = JSON.parse(readFileSync(join(directory, 'SOURCE.json'), 'utf8')) as { hostVersion?: string }
      const main = relative(directory, resolve(directory, manifest.main ?? ''))
      if (manifest.name !== name || manifest.version !== pin.version || sourceMetadata.hostVersion !== options.release.version
        || !main || main.startsWith('..') || isAbsolute(main) || !existsSync(join(directory, main))) {
        throw new Error(`desktop development: incompatible community artifact ${name}; rebuild with pnpm run dev:desktop`)
      }
      const dependencies: Array<[string, string]> = []
      for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
        if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(dependency)) throw new Error('desktop development: invalid community dependency')
        const tool = join(sourceRoot, 'toolchain', 'node_modules', dependency)
        const target = !dependency.startsWith('@deepseek-ai/') && existsSync(tool) ? tool : join(options.dependencyDir, dependency)
        if (!existsSync(target) || !satisfies(readManifest(join(target, 'package.json')).version ?? '', version)) {
          throw new Error(`desktop development: missing pinned community dependency ${dependency}@${version}; run pnpm run dev:desktop`)
        }
        dependencies.push([dependency, target])
      }
      packages.push({ directory, name, version: pin.version, dependencies })
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }

  try {
    removeOwnedPath(options.projectDir)
    createDevelopmentProjectMetadata(options.projectDir, options.release)
    const destinationModules = join(options.projectDir, 'node_modules')
    mkdirSync(destinationModules, { recursive: true })
    mirrorDependencyLinks(options.dependencyDir, destinationModules)
    const dshLink = join(destinationModules, '@deepseek-ai', 'dsh')
    removeOwnedPath(dshLink)
    linkDirectory(options.cliDir, dshLink)
    const hostLink = join(destinationModules, '@deepseek-ai', 'dsh-desktop-host')
    removeOwnedPath(hostLink)
    linkDirectory(options.hostDir, hostLink)
    for (const pkg of packages) {
      const destination = join(destinationModules, pkg.name)
      removeOwnedPath(destination)
      mkdirSync(dirname(destination), { recursive: true })
      renameSync(pkg.directory, destination)
      for (const [dependency, target] of pkg.dependencies) linkDirectory(target, join(destination, 'node_modules', dependency))
    }
    const manifestPath = join(options.projectDir, 'package.json')
    const metadata = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    for (const pkg of packages) metadata.dependencies[pkg.name] = pkg.version
    writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(metadata, undefined, 2)}\n`)
    renameSync(`${manifestPath}.tmp`, manifestPath)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return options.projectDir
}
