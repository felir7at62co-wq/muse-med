/** Verify declared maintained edits before applying private build overlays. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Require exact local bytes for every modification declared by the source pin.
 * @param {string} directory - Retained plugin source directory.
 * @param {object} pin - Reviewed source inventory entry.
 * @returns {void}
 */
export function assertCommunitySourceIntegrity(directory, pin) {
  for (const [path, record] of Object.entries(pin.localModifications?.files ?? {})) {
    const hash = createHash('sha256').update(readFileSync(join(directory, path))).digest('hex')
    if (hash !== record.sha256) throw new Error(`community plugins: local source hash mismatch: ${path}`)
  }
}
