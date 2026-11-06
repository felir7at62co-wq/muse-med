/** Convert original Skill archives into validated local market packages. */
import { unzipSync } from 'fflate'
import { createMarketPackage, MarketError, marketDigest, marketPath } from './package.ts'
import type { MarketLegacyResource, MarketLimits } from './types.ts'

const officeSkills = ['office-docx', 'office-pptx', 'office-xlsx']
const officeHelperPath = 'scripts/check_office.py'
const officeHelperSha256 = 'd94afa67593a284751e0f2dc000877e836f885d39954a882033cf22a13278f66'

/** Convert one verified original Skill and its resources to a local publication ZIP.
 * @param resource Catalog metadata for the selected Skill.
 * @param archive Exact bytes from the original download.
 * @param limits Deployment-owned compressed and expanded bounds.
 * @param allowedPlugins Deployment-owned Bot plugin allowlist used by the publication validator.
 * @returns Validated publication bytes with the original invocation name and resources.
 */
export function createLegacySkillPackage(resource: MarketLegacyResource, archive: Uint8Array, limits: MarketLimits,
  allowedPlugins: readonly string[]): Uint8Array {
  const name = /^muse\/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(resource.id)?.[1]
  if (resource.kind !== 'skill' || !name) throw new MarketError('invalid-release')
  if (!archive.byteLength || archive.byteLength > limits.archiveBytes) throw new MarketError('archive-too-large', 413)
  if (marketDigest(archive) !== resource.sha256) throw new MarketError('digest-mismatch')

  const prefix = `${name}/`
  const skillPath = `skills/${prefix}SKILL.md`
  const office = officeSkills.includes(name)
  const publicationPath = (path: string): string => `skills/${office && path === officeHelperPath ? prefix : ''}${path}`
  let count = 0
  let expanded = 0
  const paths = new Set<string>()
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(archive, { filter(entry) {
      if (++count > limits.fileCount || (expanded += entry.originalSize) > limits.expandedBytes) {
        throw new MarketError('expanded-limit', 413)
      }
      const directory = entry.name.endsWith('/')
      const path = directory ? entry.name.slice(0, -1) : entry.name
      const allowed = (directory && entry.name === prefix) || path.startsWith(prefix)
        || (!directory && office && path === officeHelperPath)
      const target = publicationPath(path)
      const key = target.normalize('NFC').toLowerCase()
      if (!allowed || !marketPath(target) || paths.has(key)) throw new MarketError('invalid-path')
      paths.add(key)
      return !directory
    } })
  } catch (error) {
    if (error instanceof MarketError) throw error
    throw new MarketError('invalid-archive')
  }
  if (Object.values(entries).reduce((total, file) => total + file.byteLength, 0) > limits.expandedBytes) {
    throw new MarketError('expanded-limit', 413)
  }
  const files = Object.fromEntries(Object.entries(entries).map(([path, bytes]) => [publicationPath(path), bytes]))
  const instructions = files[skillPath]
  if (!instructions) throw new MarketError('missing-skill')
  if (entries[officeHelperPath]) {
    if (marketDigest(entries[officeHelperPath]) !== officeHelperSha256) throw new MarketError('digest-mismatch')
    const original = Buffer.from(instructions)
    const text = original.toString('utf8')
    const oldReference = `<skill-directory>/../${officeHelperPath}`
    if (!Buffer.from(text).equals(original) || !text.includes(oldReference)) throw new MarketError('invalid-skill')
    files[skillPath] = Buffer.from(text.replaceAll(oldReference, `<skill-directory>/${officeHelperPath}`))
  }
  return createMarketPackage({ formatVersion: 1, kind: 'skill', name, title: resource.title,
    description: resource.description, version: resource.version, license: 'NOASSERTION', category: resource.category,
    examples: [], requirements: resource.requirements, skills: [{ name, path: skillPath }],
  }, files, limits, allowedPlugins)
}
