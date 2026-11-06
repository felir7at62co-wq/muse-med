/** Stored ZIP fixture with a false expanded size in the first central directory entry. */
import { zipSync } from 'fflate'

/** Preserve the ZIP payload while making its first entry declare fewer expanded bytes.
 * @param entries Archive entries, with the changed entry first.
 * @returns ZIP whose compressed and expanded size fields disagree.
 */
export function underreportedStoredZip(entries: Record<string, Uint8Array>): Uint8Array {
  const archive = zipSync(entries, { level: 0 })
  const header = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const directoryOffset = header.getUint32(archive.length - 22 + 16, true)
  if (header.getUint32(directoryOffset, true) !== 0x02014b50) throw new Error('Missing ZIP directory entry')
  header.setUint32(directoryOffset + 24, 0, true)
  return archive
}
