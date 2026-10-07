/** Validate either current app entry chosen by GitHub's ordering of releases from one commit. */
const RELEASE_BASE = 'https://github.com/felir7at62co-wq/muse-med/releases/tag/'
const TAGS = ['v1.0.3', 'v1.0.3-rc.muse-stable']

/**
 * Accept only a public current app release with the exact staged files and source commit.
 * @param {string} firstUrl First link returned by the actual release Atom feed.
 * @param {object} release Public GitHub metadata for that exact entry.
 * @param {object} object Dereferenced tag object for that exact entry.
 * @param {object} inventory Verified local eleven-file staging inventory.
 * @returns {string} The accepted current app tag.
 */
export function validateLegacyAtomAppRelease(firstUrl, release, object, inventory) {
  const tag = TAGS.find(value => firstUrl === RELEASE_BASE + value)
  if (!tag || release?.tag_name !== tag || release.draft !== false
    || release.prerelease !== (tag !== TAGS[0]) || object?.type !== 'commit'
    || object.sha !== inventory.sourceCommit || !Array.isArray(release.assets)
    || release.assets.length !== 11 || new Set(release.assets.map(asset => asset.name)).size !== 11
    || !Array.isArray(inventory.files) || inventory.files.length !== 11) {
    throw new Error('Legacy Atom entry is not a complete current app release from the verified source')
  }
  for (const file of inventory.files) {
    const asset = release.assets.find(asset => asset.name === file.filename)
    if (!asset || asset.size !== file.size || asset.state !== 'uploaded'
      || asset.digest !== `sha256:${file.sha256}`) {
      throw new Error('Legacy Atom app assets differ from the verified eleven-file inventory')
    }
  }
  return tag
}
