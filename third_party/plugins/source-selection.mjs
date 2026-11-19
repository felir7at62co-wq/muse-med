/** Source selection for desktop builds and explicit single-source builds. */

/**
 * Select the sources a desktop build ships, or one named source.
 * @param {Readonly<Record<string, { readonly desktop?: boolean }>>} pins Retained source inventory.
 * @param {string | undefined} only Explicit source directory, including retired entries.
 * @returns {string[]} Selected directories in inventory order; unknown selections reject.
 */
export function selectCommunitySources(pins, only) {
  if (only !== undefined) {
    if (!Object.hasOwn(pins, only)) throw new Error(`community plugins: unknown source ${only}`)
    return [only]
  }
  return Object.keys(pins).filter(name => pins[name].desktop !== false)
}
