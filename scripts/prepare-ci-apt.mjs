/** Upgrade Ubuntu APT sources and local mirror lists before CI dependency installation. */
import { readFile, writeFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Upgrade only official Ubuntu archive/security URLs, retaining other text verbatim.
 * @param {string} source - APT source or mirror-list text, including its original line endings.
 * @returns {string} Text with official Ubuntu HTTP URLs using HTTPS.
 */
export function upgradeUbuntuMirrorUrls(source) {
  return source.replace(/(^|[\t \uFEFF]|^URIs:)http:\/\/((?:(?:azure|[a-z]{2})\.)?archive\.ubuntu\.com|security\.ubuntu\.com)(?=\/|[\t \r\n]|$)/gim, '$1https://$2')
}

/**
 * Prepare existing APT source files and root-level mirror lists without changing signatures or third-party URLs.
 * @param {string} directory - APT configuration directory; the CI entry point uses /etc/apt.
 * @returns {Promise<string[]>} Changed filenames; unchanged files are not written.
 */
export async function prepareCiApt(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const sources = entries.filter(entry => entry.isFile() && (entry.name === 'sources.list' || /mirror.*\.txt$/iu.test(entry.name)))
    .map(entry => join(directory, entry.name))
  /** @type {import('node:fs').Dirent[]} */
  let additional = []
  try {
    additional = await readdir(join(directory, 'sources.list.d'), { withFileTypes: true })
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  sources.push(...additional.filter(entry => entry.isFile() && /\.(?:list|sources)$/u.test(entry.name))
    .map(entry => join(directory, 'sources.list.d', entry.name)))
  const changed = []
  for (const file of sources.sort()) {
    const before = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(file))
    const after = upgradeUbuntuMirrorUrls(before)
    if (after === before) continue
    await writeFile(file, after)
    changed.push(file)
  }
  return changed
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const changed = await prepareCiApt('/etc/apt')
  console.log(`Prepared Ubuntu APT HTTPS sources: ${changed.length} file(s) changed`)
}
