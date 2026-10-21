/**
 * Reading packed npm tarballs and the order file that accompanies them.
 *
 * The release steps after pack treat a directory of tarballs as the unit of
 * work, so they read what a tarball declares rather than what the checkout
 * currently says.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t as listTar } from 'tar'

/** Name of the file recording the order in which a packed family uploads. */
export const PUBLISH_ORDER_FILE = 'publish-order.txt'

/** What a packed tarball calls itself. */
export interface PackedIdentity {
  /** Package name from the packed manifest. */
  readonly name: string
  /** Package version from the packed manifest. */
  readonly version: string
}

function readTarball(tarball: string, withManifest: boolean): { files: string[]; manifest: Buffer } {
  const files: string[] = []
  const seen = new Set<string>()
  const chunks: Buffer[] = []
  let manifestCount = 0
  let manifestBytes = 0
  listTar({ file: tarball, sync: true, strict: true, onReadEntry(entry) {
    const name = entry.path
    const parts = name.replace(/\/$/u, '').split('/')
    if (name === '' || /[\\:\u0000-\u001f]/u.test(name) || parts.some(part => part === '' || part === '.' || part === '..')) {
      throw new Error(`${tarball} contains an unsafe archive member`)
    }
    if (entry.type !== 'File' && entry.type !== 'OldFile' && entry.type !== 'Directory') {
      throw new Error(`${tarball} contains a link or special archive member`)
    }
    if (seen.has(name)) throw new Error(`${tarball} contains duplicate archive member ${name}`)
    seen.add(name)
    files.push(name)
    if (withManifest && name === 'package/package.json') {
      if (entry.type === 'Directory') throw new Error(`${tarball} package manifest is not a regular file`)
      manifestCount++
      entry.on('data', (chunk: Buffer) => {
        manifestBytes += chunk.length
        if (manifestBytes > 1024 * 1024) throw new Error(`${tarball} package manifest exceeds 1 MiB`)
        chunks.push(chunk)
      })
    }
  } })
  if (withManifest && manifestCount !== 1) throw new Error(`${tarball} must contain exactly one package/package.json`)
  return { files, manifest: Buffer.concat(chunks) }
}

/**
 * List a tarball's members.
 * @param tarball - absolute tarball path.
 * @returns Every path after strict validation of the complete archive; malformed members reject.
 */
export function tarballFiles(tarball: string): string[] {
  return readTarball(tarball, false).files
}

/**
 * Read one npm manifest while validating every member, including UTF-8 PAX paths.
 * @param tarball Absolute tarball path.
 * @returns Parsed object from the archive's single package/package.json; malformed archives reject.
 */
export function packedManifest(tarball: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readTarball(tarball, true).manifest.toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${tarball} has no package manifest`)
  return value as Record<string, unknown>
}

/**
 * Read a packed tarball's own manifest.
 * @param tarball - absolute tarball path.
 * @returns The name and version the tarball declares.
 */
export function packedIdentity(tarball: string): PackedIdentity {
  const { name, version } = packedManifest(tarball)
  if (typeof name !== 'string' || typeof version !== 'string') throw new Error(`${tarball} manifest lacks name/version`)
  return { name, version }
}

/**
 * Read a packed directory's upload order.
 * @param directory - absolute path of a pack output directory.
 * @returns Tarball filenames in upload order.
 */
export function readPublishOrder(directory: string): string[] {
  return readFileSync(join(directory, PUBLISH_ORDER_FILE), 'utf8').split('\n').filter(line => line !== '')
}
