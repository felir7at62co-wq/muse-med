/** File URL overrides for Desktop-owned packaged plugins. */

/**
 * Resolve packaged plugin specifiers beside the Desktop Host entry.
 * @param baseUrl - File URL of the packaged Desktop Host entry.
 * @returns ESM file URLs accepted by the Loader on Windows and POSIX.
 */
export function packagedModuleOverrides(baseUrl: string): Readonly<Record<string, string>> {
  return {
    'muse-workspace-owned-storage': new URL('./workspace-owned-storage.js', baseUrl).href,
    'ds-bot': new URL('./retired-bot.js', baseUrl).href,
    'muse-bot': new URL('./retired-bot.js', baseUrl).href,
  }
}
