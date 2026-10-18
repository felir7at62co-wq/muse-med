/** Keep Muse bridge providers on the application's reviewed package. */

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const entries = [
  { specifier: '@wenbin_wb/dsh-bridge/remote', packageName: '@wenbin_wb/dsh-bridge', entry: '@wenbin_wb/dsh-bridge/remote' },
  { specifier: '@wenbin_wb/dsh-bridge', packageName: '@xmanrui/dsh-im', entry: '@xmanrui/dsh-im' },
  { specifier: '@xmanrui/dsh-im', packageName: '@xmanrui/dsh-im', entry: '@xmanrui/dsh-im' },
] as const

/**
 * Resolve remote access and the retained Feishu row through their bundled providers.
 * @param runtimeDir - Application runtime directory containing its reviewed node_modules.
 * @returns Exact module-specifier overrides for root Include imports.
 * @throws When the bundled package or a required entry is unavailable.
 */
export function bundledBridgeModules(runtimeDir: string): Readonly<Record<string, string>> {
  return Object.fromEntries(entries.map(({ specifier, packageName, entry }) => {
    let filename: string
    try {
      const anchor = realpathSync(join(runtimeDir, 'node_modules', packageName, 'package.json'))
      filename = createRequire(anchor).resolve(entry)
    } catch (error) {
      throw new Error(`muse-med: bundled bridge entry ${JSON.stringify(specifier)} is unavailable`, { cause: error })
    }
    return [specifier, pathToFileURL(filename).href]
  }))
}

/**
 * Require the IM row's Host and browser metadata to resolve to the same reviewed artifact.
 * @param runtimeDir - Application runtime containing the reviewed IM package.
 * @param projectDir - Root Include directory used by client-module discovery.
 * @throws When a profile installation shadows the bundled IM entry or it is unavailable.
 */
export function verifyBundledImClient(runtimeDir: string, projectDir: string): void {
  const specifier = '@xmanrui/dsh-im'
  let bundled: string
  let selected: string
  try {
    const anchor = realpathSync(join(runtimeDir, 'node_modules', specifier, 'package.json'))
    bundled = realpathSync(createRequire(anchor).resolve(specifier))
    selected = realpathSync(createRequire(join(projectDir, 'package.json')).resolve(specifier))
  } catch (error) {
    throw new Error('muse-med: the bundled IM package must be resolvable from the Desktop profile', { cause: error })
  }
  if (selected !== bundled) {
    throw new Error('muse-med: profile package @xmanrui/dsh-im conflicts with the bundled IM package; remove the profile-installed copy before starting Muse')
  }
}
