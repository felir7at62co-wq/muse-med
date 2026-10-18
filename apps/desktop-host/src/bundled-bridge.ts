/** Keep Muse bridge providers on the application's reviewed package. */

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const entries = [
  { specifier: '@wenbin_wb/dsh-bridge/remote', packageName: '@wenbin_wb/dsh-bridge', entry: '@wenbin_wb/dsh-bridge/remote' },
  { specifier: '@wenbin_wb/dsh-bridge', packageName: '@dsh-feishu/dsh-feishu', entry: '@dsh-feishu/dsh-feishu' },
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
