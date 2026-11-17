/** Root Include module overrides that keep Muse-owned plugin rows on the application's packaged modules. */

import { bundledBridgeModules } from './bundled-bridge.ts'

/**
 * Map Muse-owned plugin specifiers to the `file:` URLs of their packaged modules.
 * The Loader imports an override as given, so each value is a `file:` URL; a Windows path such as `D:\…` is not an import specifier.
 * @param runtimeDir - Application runtime directory containing the reviewed bridge packages.
 * @returns Exact specifier overrides for the root Include.
 * @throws When a bundled bridge entry is unavailable.
 */
export function productModuleOverrides(runtimeDir: string): Readonly<Record<string, string>> {
  const productModule = (file: string): string => new URL(file, import.meta.url).href
  return { ...bundledBridgeModules(runtimeDir),
    'muse-workspace-owned-storage': productModule('./workspace-owned-storage.js'),
    'ds-bot': productModule('./retired-bot.js'), 'muse-bot': productModule('./retired-bot.js') }
}
