/** Shared bounded extraction and reviewed Office relocation for original Skill archives. */
import { unzipSync } from 'fflate'
import { MarketError, marketPath } from './format-values.ts'
import type { MarketLegacyResource } from './legacy.ts'
import type { MarketLimits, MarketManifest } from './types.ts'

const officeSkills = ['office-docx', 'office-pptx', 'office-xlsx']
const officeHelperPath = 'scripts/check_office.py'

/** SHA-256 of the only shared helper admitted outside an original Office Skill directory. */
export const officeHelperSha256 = 'd94afa67593a284751e0f2dc000877e836f885d39954a882033cf22a13278f66'

/** Extracted original resources whose archive and optional helper hashes require independent verification. */
export interface LegacySkillContent {
  readonly manifest: MarketManifest
  readonly files: Readonly<Record<string, Uint8Array>>
  readonly skillPath: string
  readonly officeHelper?: Uint8Array
}

/** Extract one bounded original Skill while confining every resource to its canonical directory.
 * @param resource - Validated selected catalog resource.
 * @param archive - Original bytes whose digest must be checked by the caller before extraction.
 * @param limits - Local compressed, expanded, entry and manifest bounds.
 * @returns Extracted resources and the optional reviewed helper to verify before relocation.
 */
export function readLegacySkillContent(resource: MarketLegacyResource, archive: Uint8Array, limits: MarketLimits): LegacySkillContent {
  const prefix = `${resource.name}/`, skillPath = `skills/${prefix}SKILL.md`
  const office = officeSkills.includes(resource.name)
  const publicationPath = (path: string): string => `skills/${office && path === officeHelperPath ? prefix : ''}${path}`
  let expanded = 0, count = 0
  const names = new Set<string>()
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(archive, { filter(entry) {
      if (++count > limits.fileCount || (expanded += entry.originalSize) > limits.expandedBytes) throw new MarketError('expanded-limit')
      const directory = entry.name.endsWith('/'), path = directory ? entry.name.slice(0, -1) : entry.name
      const allowed = directory && entry.name === prefix || path.startsWith(prefix) || !directory && office && path === officeHelperPath
      const target = publicationPath(path), key = target.normalize('NFC').toLowerCase()
      if (!allowed || !marketPath(target) || names.has(key)) throw new MarketError('invalid-path')
      names.add(key)
      return !directory
    } })
  } catch (error) {
    if (error instanceof MarketError) throw error
    throw new MarketError('invalid-archive')
  }
  if (Object.values(entries).reduce((size, bytes) => size + bytes.byteLength, 0) > limits.expandedBytes) throw new MarketError('expanded-limit')
  const files = Object.fromEntries(Object.entries(entries).map(([path, bytes]) => [publicationPath(path), bytes]))
  if (files[skillPath] === undefined) throw new MarketError('missing-skill')
  return { manifest: { formatVersion: 1, kind: 'skill', name: resource.name, title: resource.title,
    description: resource.description, version: resource.version, license: 'NOASSERTION', category: resource.category,
    requirements: resource.requirements, examples: [], skills: [{ name: resource.name, path: skillPath }],
  }, files, skillPath, ...(entries[officeHelperPath] === undefined ? {} : { officeHelper: entries[officeHelperPath] }) }
}

/** Replace the reviewed Office helper reference after its digest has been verified.
 * @param content - Extracted content with a verified optional helper.
 * @returns Original resource bytes, with only the Office instruction reference changed when present.
 */
export function completeLegacySkillFiles(content: LegacySkillContent): Readonly<Record<string, Uint8Array>> {
  if (content.officeHelper === undefined) return content.files
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(content.files[content.skillPath]) }
  catch (_error) { throw new MarketError('invalid-skill') }
  const reference = `<skill-directory>/../${officeHelperPath}`
  if (!text.includes(reference)) throw new MarketError('invalid-skill')
  return { ...content.files,
    [content.skillPath]: new TextEncoder().encode(text.replaceAll(reference, `<skill-directory>/${officeHelperPath}`)) }
}
