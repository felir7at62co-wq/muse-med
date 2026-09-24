/** Read-only marketplace discovery and bundled-package inventory for the desktop shell. */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DESKTOP_SOURCE_PLUGINS } from './core-package-set.ts'
import { packageNameFromSpec } from './project-manager.ts'

/** One immutable community package shipped with the application. */
export interface DesktopBundledPlugin {
  readonly name: string
  readonly version: string
  /** Whether the profile mounts its bundle; settings may still leave its feature disabled. */
  readonly mounted: boolean
}

/** Validated public metadata, never an executable catalog installation command. */
export interface DesktopCatalogPlugin {
  readonly name: string
  readonly description: Readonly<Partial<Record<'en' | 'zh', string>>>
  readonly repository: string
  readonly npm?: string
  readonly bundled: boolean
}

/** Shell-owned discovery response; local inventory remains available without a network request. */
export interface DesktopPluginCatalog {
  readonly canInstall: boolean
  readonly bundled: readonly DesktopBundledPlugin[]
  readonly plugins: readonly DesktopCatalogPlugin[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** Validate a public repository link before handing it to the operating system browser.
 * @param value - Untrusted catalog URL or popup navigation target.
 * @returns A canonical HTTPS GitHub repository URL.
 */
export function repositoryUrl(value: unknown): string {
  if (!text(value)) throw new Error('desktop catalog: invalid repository URL')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username !== '' || url.password !== ''
    || url.port !== '' || url.search !== '' || url.hash !== ''
    || !/^\/[\w.-]+\/[\w.-]+(?:\/(?:tree|blob)\/[^?#]+)?\/?$/u.test(url.pathname)) {
    throw new Error('desktop catalog: expected an HTTPS GitHub repository URL')
  }
  return url.href
}

/** Project the remote catalog onto the fields the desktop can display or install.
 * @param value - Untrusted response from the maintained marketplace catalog loader.
 * @returns Entries with validated registry specs; source-only entries have no npm field.
 */
export function parseCatalog(value: unknown): DesktopCatalogPlugin[] {
  if (!record(value) || !Array.isArray(value.plugins)) throw new Error('desktop catalog: expected a plugin list')
  return value.plugins.map((item: unknown) => {
    if (!record(item) || !text(item.name)) throw new Error('desktop catalog: invalid plugin name')
    const repository = repositoryUrl(item.url)
    const description: Partial<Record<'en' | 'zh', string>> = {}
    if (item.description !== undefined) {
      if (!record(item.description)) throw new Error('desktop catalog: invalid description')
      for (const language of ['en', 'zh'] as const) {
        const translation = item.description[language]
        if (translation !== undefined) {
          if (typeof translation !== 'string') throw new Error('desktop catalog: invalid translated description')
          description[language] = translation
        }
      }
    }
    let npm: string | undefined
    let name = item.name
    if (item.npm !== undefined && item.npm !== null && item.npm !== '') {
      if (!text(item.npm)) throw new Error('desktop catalog: invalid npm spec')
      name = packageNameFromSpec(item.npm)
      npm = item.npm
    }
    return { name: item.name, repository, description, ...(npm === undefined ? {} : { npm }),
      bundled: DESKTOP_SOURCE_PLUGINS.some(bundled => bundled === name) }
  })
}

/** Read bundled inventory and optionally fetch the public catalog without installing anything.
 * @param runtimeDir - The application-owned runtime dependency root, never a user-supplied package root.
 * @param projectDir - The active desktop profile containing the enabled bundle list.
 * @param discover - Whether to make a network catalog request; false only reads local inventory.
 * @returns Plain inventory and catalog metadata, without profile settings or credentials.
 */
export async function desktopPluginCatalog(runtimeDir: string, projectDir: string, discover: boolean): Promise<Omit<DesktopPluginCatalog, 'canInstall'>> {
  const manifest: unknown = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8'))
  const bundles = record(manifest) && record(manifest.dsh) && record(manifest.dsh.profile) ? manifest.dsh.profile.bundles : undefined
  if (!Array.isArray(bundles) || !bundles.every(bundle => typeof bundle === 'string')) {
    throw new Error('desktop catalog: invalid desktop profile bundle list')
  }
  const bundled = await Promise.all(DESKTOP_SOURCE_PLUGINS.map(async (name): Promise<DesktopBundledPlugin> => {
    const pkg: unknown = JSON.parse(await readFile(join(runtimeDir, 'node_modules', name, 'package.json'), 'utf8'))
    if (!record(pkg) || pkg.name !== name || !text(pkg.version)) throw new Error(`desktop catalog: invalid bundled package ${name}`)
    return { name, version: pkg.version, mounted: bundles.includes(name) }
  }))
  if (!discover) return { bundled, plugins: [] }
  const require = createRequire(join(runtimeDir, 'package.json'))
  const module: unknown = await import(pathToFileURL(require.resolve('dshmarket/catalog')).href)
  if (!record(module) || typeof module.loadRegistry !== 'function') throw new Error('desktop catalog: bundled loader unavailable')
  const registry: unknown = await module.loadRegistry()
  return { bundled, plugins: parseCatalog(registry) }
}
