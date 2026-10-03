/** Exact Host releases qualified by the private community-plugin build. */
export const reviewedHostVersion = '0.2.1-alpha.1'

/** Vendor peers must admit the reviewed prereleases explicitly. */
export const reviewedVendorVersions = Object.freeze({
  '@deepseek-ai/cordis': '4.0.5-alpha.1',
  '@deepseek-ai/cosmokit': '1.8.6-alpha.1',
  '@deepseek-ai/cordis-plugin-group': '1.0.5-alpha.1',
  '@deepseek-ai/cordis-plugin-hmr': '1.0.20-alpha.1',
  '@deepseek-ai/cordis-plugin-include': '1.0.10-alpha.1',
  '@deepseek-ai/cordis-plugin-loader': '1.0.6-alpha.1',
  '@deepseek-ai/cordis-plugin-logger-console': '1.0.5-alpha.1',
  '@deepseek-ai/schemastery': '3.18.5-alpha.1',
  '@deepseek-ai/cordis-plugin-timer': '1.1.7-alpha.1',
})

/** Artifact metadata for the Host qualification and retired companion exports. */
export const hostRuntimeCompatibility = Object.freeze({
  hostVersion: reviewedHostVersion,
  vendorVersions: reviewedVendorVersions,
  retiredPackage: '@deepseek-ai/dsh-invariants',
  retiredCompanion: '@mengyuly/dsh-ponytail/invariant',
})

/**
 * Resolve the exact reviewed version for a first-party Host or vendor package.
 * @param {string} name Package name in a retained manifest.
 * @returns {string | undefined} Reviewed release, or absence for unrelated or retired packages.
 */
export function reviewedHostPackageVersion(name) {
  if (name === '@deepseek-ai/dsh-invariants') return undefined
  if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) return reviewedHostVersion
  return reviewedVendorVersions[name]
}

/**
 * Qualify a copied manifest without modifying its retained source object.
 * The retired invariant service and Ponytail companion are omitted from artifacts;
 * remaining peers explicitly admit the reviewed releases and runtime dependencies use exact pins.
 * @param {object} source Manifest read from private staging.
 * @returns {object} Qualified manifest retaining unrelated dependencies and resource exports.
 */
export function qualifyCommunityManifest(source) {
  const manifest = structuredClone(source)
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies']) {
    if (manifest[section]) delete manifest[section]['@deepseek-ai/dsh-invariants']
  }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const version = reviewedHostPackageVersion(name)
    if (version && !range.split(' || ').includes(version)) manifest.peerDependencies[name] = `${range} || ${version}`
  }
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      const version = reviewedHostPackageVersion(name)
      if (version) manifest[section][name] = version
    }
  }
  if (manifest.name === '@mengyuly/dsh-ponytail') {
    delete manifest.exports['./invariant']
    manifest.files = manifest.files.filter(path => path !== 'lib/invariant.js')
  }
  return manifest
}
