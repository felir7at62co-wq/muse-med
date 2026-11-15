/** Source selection for ordinary-session builds and explicit archived compatibility builds. */
const archivedSources = new Set(['ds-bot'])

/**
 * Keep archived source out of default artifacts while preserving explicit recovery builds.
 * @param {Readonly<Record<string, { readonly desktop?: boolean }>>} pins Retained source inventory.
 * @param {string | undefined} only Explicit source directory, including archived or retired entries.
 * @returns {string[]} Selected directories in inventory order; unknown selections reject.
 */
export function selectCommunitySources(pins, only) {
  if (only !== undefined) {
    if (!Object.hasOwn(pins, only)) throw new Error(`community plugins: unknown source ${only}`)
    return [only]
  }
  return Object.keys(pins).filter(name => pins[name].desktop !== false && !archivedSources.has(name))
}
