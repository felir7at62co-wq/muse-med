/** Explicit browser file delivery after the owning adapter has verified its bytes. */

/** Start a browser ZIP download without recording a local Muse installation.
 * @param file Validated file name and complete archive bytes.
 */
export function downloadMarketFile(file: { name: string; bytes: Uint8Array }): void {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(file.bytes)], { type: 'application/zip' }))
  const link = document.createElement('a')
  link.href = url; link.download = file.name
  document.body.append(link); link.click(); link.remove()
  // Browser file delivery starts asynchronously after the click dispatch.
  setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
}
