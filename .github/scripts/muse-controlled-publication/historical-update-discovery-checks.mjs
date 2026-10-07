/** Validate historical provider discovery against genuine final app metadata. */

/** Reject auxiliary entries, foreign app tags, and different installer metadata. */
export function validateHistoricalDiscovery({ installedVersion, expectedVersion, firstTag, result, expected }) {
  const tags = [`v${expectedVersion}`, `v${expectedVersion}-rc.muse-stable`]
  if (!tags.includes(firstTag)) throw new Error(`First Atom entry is not a required app release: ${firstTag}`)
  if (!tags.includes(result.tag)) throw new Error(`Provider selected a foreign app release: ${result.tag}`)
  if (installedVersion === '1.0.1' && result.tag !== firstTag) throw new Error('Original stable provider must select the first required app release')
  if (installedVersion !== '1.0.1' && result.tag !== tags[1]) throw new Error('Original RC provider must select the matching RC discovery tag')
  if (result.version !== expectedVersion || expected.version !== expectedVersion) throw new Error('Provider metadata does not carry the intended genuine app version')
  if (!Array.isArray(result.files) || result.files.length !== 1 || expected.files.length !== 1) throw new Error('Metadata must name one Windows installer')
  for (const field of ['url', 'sha512', 'size']) {
    if (result.files[0][field] !== expected.files[0][field]) throw new Error(`Provider installer ${field} differs from the final build`)
  }
  for (const field of ['path', 'sha512']) {
    if (result[field] !== expected[field]) throw new Error(`Provider metadata ${field} differs from the final build`)
  }
}
