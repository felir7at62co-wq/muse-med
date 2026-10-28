/** Stable discovery instructions and a bounded directory of authorized capabilities. */
import type { CapabilitySummary } from './capabilities.ts'

interface DirectoryEntry { id: string; title: string; description: string }

const instructions = 'Some authorized tools are not loaded upfront. Missing initial definitions or local scripts do not establish that a capability is unavailable. For specialized work, use tool_search by task or exact name before building a shell or web substitute. If a search misses, rephrase or browse with no arguments. Matching full definitions load next step; discovery does not execute tools or grant permissions.'

/** Render discovery guidance without including per-session tool loading or preferences.
 * @param capabilities - Groups containing at least one currently authorized tool.
 * @param maxDirectoryChars - Maximum serialized directory characters, excluding fixed instructions.
 * @param maxDescriptionChars - Maximum Unicode characters of a capability description preview.
 * @returns Fixed usage guidance and complete directory entries with an omission count.
 */
export function discoveryGuidance(
  capabilities: readonly CapabilitySummary[], maxDirectoryChars: number, maxDescriptionChars: number,
): string {
  const directory: { capabilities: DirectoryEntry[]; omitted_capabilities: number } = {
    capabilities: [], omitted_capabilities: capabilities.length,
  }
  const included: Array<{ entry: DirectoryEntry; description: string }> = []
  for (const capability of capabilities) {
    const entry = { id: capability.id, title: capability.title, description: '' }
    directory.capabilities.push(entry)
    directory.omitted_capabilities--
    if (JSON.stringify(directory).length <= maxDirectoryChars) included.push({ entry, description: capability.description })
    else {
      directory.capabilities.pop()
      directory.omitted_capabilities++
    }
  }
  for (const [index, { entry, description }] of included.entries()) {
    const characters = Array.from(description.split(/\r?\n/, 1)[0]?.trim() ?? '').slice(0, maxDescriptionChars)
    const allowance = Math.floor((maxDirectoryChars - JSON.stringify(directory).length) / (included.length - index))
    const currentLength = JSON.stringify(directory).length
    let low = 0
    let high = characters.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      entry.description = characters.slice(0, middle).join('')
      if (JSON.stringify(directory).length - currentLength <= allowance) low = middle
      else high = middle - 1
    }
    entry.description = characters.slice(0, low).join('')
  }
  return `${instructions}\n\nAvailable capability groups (an empty or cropped directory does not limit global search):\n\n${JSON.stringify(directory)}`
}
