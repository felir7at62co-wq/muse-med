/** Browser-portable publication metadata validation and bounded ZIP preview. */
import { unzipSync, zipSync } from 'fflate'
import { parseDocument } from 'yaml'
import { marketPresetPortraitIds, type MarketLegacyResource, type MarketLimits, type MarketManifest, type MarketPlugin, type MarketPortrait, type MarketPresetPortraitId, type MarketRelease } from './types.ts'

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/
const legacyIdPattern = /^muse\/(?:bots|skills)\/[a-z0-9]+(?:-[a-z0-9]+)*$/
const reservedPlugins = new Set(['@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-muse-market/bot-skills'])

const marketPresetPortraits = new Set<unknown>(marketPresetPortraitIds)

function isMarketPresetPortrait(value: unknown): value is MarketPresetPortraitId {
  return marketPresetPortraits.has(value)
}

function isMarketPortrait(value: unknown): value is MarketPortrait {
  return value === 'storyboard-director' || value === 'screenplay-editor'
}

/** A bounded validation failure suitable for user-facing operation handling. */
export class MarketError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}

/** Identify plain JSON object records at publication input parsers.
 * @param value Untrusted JSON value.
 * @returns Whether fields can be inspected as an object record.
 */
export function marketRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Recognize the identity of a resource in the original Muse catalog.
 * @param value Untrusted catalog identity.
 * @returns Whether the identity is a Muse Bot or Skill path.
 */
export function marketLegacyId(value: unknown): value is string {
  return typeof value === 'string' && legacyIdPattern.test(value)
}

function legacyResource(value: unknown, origin: string): MarketLegacyResource {
  if (!marketRecord(value) || (value.kind !== 'bot' && value.kind !== 'skill')
    || !marketLegacyId(value.id)
    || !value.id.startsWith(`muse/${value.kind}s/`)
    || typeof value.name !== 'string' || typeof value.description !== 'string'
    || typeof value.category !== 'string' || typeof value.version !== 'string'
    || typeof value.validation !== 'string'
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.package !== 'string' || !/^downloads\/[a-zA-Z0-9._-]+\.(?:zip|tgz)$/.test(value.package)
    || !value.package.endsWith(value.kind === 'bot' ? '.tgz' : '.zip')
    || !Array.isArray(value.requirements) || !value.requirements.every((item: unknown): item is string => typeof item === 'string')) {
    throw new MarketError('invalid-response')
  }
  const requiredSkills: unknown = value.requiredSkills ?? []
  if (!Array.isArray(requiredSkills) || !requiredSkills.every((item: unknown): item is string => typeof item === 'string')) {
    throw new MarketError('invalid-response')
  }
  return {
    id: value.id, kind: value.kind, title: value.name, description: value.description, category: value.category,
    version: value.version, requirements: value.requirements, requiredSkills, validation: value.validation,
    sha256: value.sha256, href: `${origin}/market/${value.package}`,
  }
}

/** Validate and filter the original public market catalog for discovery.
 * @param value Untrusted catalog JSON.
 * @param query Search words matched against titles, descriptions and categories.
 * @param kind Optional Bot or Skill filter. An empty string includes both.
 * @param origin Validated cloud origin for Desktop download links. Omit for same-origin website links.
 * @returns Matching original resources with download links confined to the market's download directory.
 */
export function marketLegacyCatalog(value: unknown, query: string, kind: string, origin = ''): MarketLegacyResource[] {
  if (!marketRecord(value) || !Array.isArray(value.entries) || value.entries.length > 500) throw new MarketError('invalid-response')
  const entries = value.entries.map((entry: unknown) => legacyResource(entry, origin))
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new MarketError('invalid-response')
  const words = query.toLowerCase().trim().split(/\s+/)
  return entries.filter((entry) => {
    const searchable = [entry.title, entry.description, entry.category].join(' ').toLowerCase()
    return (!kind || kind === entry.kind) && words.every(word => searchable.includes(word))
  })
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0')
}
function strings(value: unknown, maximum: number, length: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every(item => text(item, length))
}

/** Validate a portable path without creating links or interpreting host paths.
 * @param value Archive entry or manifest resource path.
 * @returns Whether the path is portable to Windows and POSIX installations.
 */
export function marketPath(value: string): boolean {
  return value.length > 0 && value.length <= 240 && !/[\\:\x00-\x1f]/.test(value)
    && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'
      && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
      && !/^\.env(?:\.|$)|^\.git$|^node_modules$|\.(?:pem|key)$/i.test(part))
}

function safeConfig(value: unknown, depth = 0): boolean {
  if (depth > 20) return false
  if (typeof value === 'string') return !/^(?:[a-z]:[\\/]|\/|\\\\|~[\\/])/i.test(value)
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return true
  if (Array.isArray(value)) return value.every(item => safeConfig(item, depth + 1))
  return marketRecord(value) && Object.entries(value).every(([key, item]) =>
    !['__proto__', 'constructor', 'prototype', '__jsExpr'].includes(key) && safeConfig(item, depth + 1))
}

function plugins(value: unknown, allowed: ReadonlySet<string>, depth = 0): value is MarketPlugin[] {
  return depth < 8 && Array.isArray(value) && value.length <= 128 && value.every((row) => {
    if (!marketRecord(row) || Object.keys(row).some(key => !['name', 'config', 'disabled', 'group'].includes(key))
      || typeof row.name !== 'string' || row.disabled !== undefined && typeof row.disabled !== 'boolean') return false
    if (row.name === 'cordis:group' && row.group === true) return plugins(row.config, allowed, depth + 1)
    // A Bot-local loader must retain its catalog through the Desktop Host's loader.
    // Reject incompatible declarations instead of silently rewriting published config.
    if (row.name === '@deepseek-ai/dsh-tool-skill'
      && (!marketRecord(row.config) || row.config.scopedCatalogOwner !== true)) return false
    return !reservedPlugins.has(row.name) && allowed.has(row.name) && row.group === undefined
      && (row.config === undefined || marketRecord(row.config) && safeConfig(row.config))
  })
}

/** Validate publication metadata at the archive and HTTP input parser.
 * @param value Untrusted JSON manifest.
 * @param allowedPlugins Deployment-owned plugin allowlist.
 * @returns Validated execution manifest.
 */
export function marketManifest(value: unknown, allowedPlugins: readonly string[]): MarketManifest {
  const skillRows: unknown[] | undefined = marketRecord(value) && Array.isArray(value.skills) ? value.skills : undefined
  if (!marketRecord(value) || value.formatVersion !== 1 || !['bot', 'skill'].includes(String(value.kind))
    || !text(value.name, 64) || !namePattern.test(value.name) || !text(value.title, 100)
    || !text(value.description, 2000) || !text(value.version, 80) || !versionPattern.test(value.version)
    || !text(value.license, 2000) || !text(value.category, 60)
    || !strings(value.examples, 8, 1000) || !strings(value.requirements, 20, 300)
    || !skillRows || skillRows.length > 64
    || !skillRows.every(item => marketRecord(item) && text(item.name, 64) && namePattern.test(item.name)
      && typeof item.path === 'string' && marketPath(item.path) && item.path === `skills/${item.name}/SKILL.md`)
    || new Set(skillRows.map(item => (item as Record<string, unknown>).name)).size !== skillRows.length
    || value.portrait !== undefined && (value.kind !== 'bot' || !isMarketPortrait(value.portrait))
    || value.presetPortrait !== undefined && (value.kind !== 'bot' || !isMarketPresetPortrait(value.presetPortrait))
    || value.kind === 'skill' && (skillRows.length !== 1 || value.plugins !== undefined)
    || value.kind === 'bot' && value.plugins !== undefined && !plugins(value.plugins, new Set(allowedPlugins))) throw new MarketError('invalid-manifest')
  const skills = skillRows as { name: string; path: string }[]
  return {
    formatVersion: 1, kind: value.kind === 'bot' ? 'bot' : 'skill', name: value.name, title: value.title,
    description: value.description, version: value.version, license: value.license, category: value.category,
    examples: value.examples, requirements: value.requirements,
    ...(value.portrait === undefined ? {} : { portrait: value.portrait }),
    ...(value.presetPortrait === undefined ? {} : { presetPortrait: value.presetPortrait }),
    skills: skills.map(item => ({ name: item.name, path: item.path })),
    ...(value.kind === 'bot' ? { plugins: (value.plugins ?? []) as MarketPlugin[] } : {}),
  }
}

/** Read one Skill instruction without resolving executable YAML tags.
 * @param body Complete UTF-8 SKILL.md content.
 * @param expected Invocation name declared by the package.
 * @returns Validated description and instruction text.
 */
export function marketSkill(body: string, expected: string): {
  description: string
  content: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(body)
  if (!match) throw new MarketError('invalid-skill')
  const parsed = parseDocument(match[1] ?? '')
  if (parsed.errors.length || parsed.warnings.length) throw new MarketError('invalid-skill')
  const data: unknown = parsed.toJSON()
  if (!marketRecord(data) || data.name !== expected || !text(data.description, 2000) || !match[2]?.trim()
    || data['disable-model-invocation'] !== undefined && typeof data['disable-model-invocation'] !== 'boolean'
    || data['user-invocable'] !== undefined && typeof data['user-invocable'] !== 'boolean') throw new MarketError('invalid-skill')
  return { description: data.description, content: match[2],
    invocation: { modelInvocable: data['disable-model-invocation'] !== true, userInvocable: data['user-invocable'] !== false } }
}

/** Parse release metadata at HTTP and local-ledger read boundaries.
 * @param value Untrusted release record.
 * @param allowedPlugins Deployment-owned plugin allowlist.
 * @returns Validated release with opaque identifiers.
 */
export function marketRelease(value: unknown, allowedPlugins: readonly string[]): MarketRelease {
  if (!marketRecord(value) || typeof value.id !== 'string' || !/^[a-f0-9]{32,64}$/.test(value.id)
    || typeof value.publisherId !== 'string' || !/^[a-f0-9]{16,64}$/.test(value.publisherId)
    || !text(value.publisher, 100) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes <= 0
    || !['draft', 'pending', 'published', 'rejected', 'withdrawn'].includes(String(value.status))
    || typeof value.reviewNote !== 'string' || value.reviewNote.length > 2000
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !text(value.createdAt, 40) || !Number.isFinite(Date.parse(value.createdAt))) throw new MarketError('invalid-release')
  return { id: value.id as MarketRelease['id'], publisherId: value.publisherId as MarketRelease['publisherId'],
    publisher: value.publisher, sha256: value.sha256, bytes: value.bytes, status: value.status as MarketRelease['status'],
    reviewNote: value.reviewNote, revision: value.revision, createdAt: value.createdAt,
    manifest: marketManifest(value.manifest, allowedPlugins) }
}


/** Inspect ZIP metadata for a local preview without treating it as an accepted publication.
 * @param archive User-selected archive bytes.
 * @param limits Explicit deployment resource bounds.
 * @param allowedPlugins Deployment-owned Bot plugin allowlist.
 * @returns Validated metadata; the server still validates resource bodies and digests on upload.
 */
export function previewMarketPackage(archive: Uint8Array, limits: MarketLimits, allowedPlugins: readonly string[]): MarketManifest {
  return marketManifest(readPreviewArchive(archive, limits, false).value, allowedPlugins)
}

function readPreviewArchive(archive: Uint8Array, limits: MarketLimits, includeResources: boolean) {
  if (!archive.byteLength || archive.byteLength > limits.archiveBytes) throw new MarketError('archive-too-large', 413)
  let count = 0, expanded = 0
  const names = new Set<string>()
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(archive, { filter(entry) {
      if (++count > limits.fileCount || (expanded += entry.originalSize) > limits.expandedBytes) throw new MarketError('expanded-limit', 413)
      const path = entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name
      const key = path.normalize('NFC').toLowerCase()
      if (!marketPath(path) || names.has(key)) throw new MarketError('invalid-path')
      names.add(key)
      if (entry.name !== 'muse-package.json') return includeResources && !entry.name.endsWith('/')
      if (entry.originalSize > 128 * 1024) throw new MarketError('invalid-manifest')
      return true
    } })
  } catch (error) {
    if (error instanceof MarketError) throw error
    throw new MarketError('invalid-archive')
  }
  const bytes = entries['muse-package.json']
  if (!bytes || bytes.length > 128 * 1024) throw new MarketError('invalid-manifest')
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new MarketError('invalid-manifest') }
  return { entries, value }
}

/** Write the selected built-in portrait into a Bot archive before upload.
 * @param archive Original Bot archive.
 * @param portrait Selected built-in portrait.
 * @param limits Deployment resource bounds.
 * @param allowedPlugins Deployment-owned Bot plugin allowlist.
 * @returns Archive with the updated manifest and preserved resource bytes.
 */
export function bindMarketPortrait(
  archive: Uint8Array, portrait: MarketPortrait | MarketPresetPortraitId, limits: MarketLimits, allowedPlugins: readonly string[],
): Uint8Array {
  const { entries, value } = readPreviewArchive(archive, limits, true)
  if (!marketRecord(value)) throw new MarketError('invalid-manifest')
  const manifest = { ...value }
  if (isMarketPortrait(portrait)) {
    manifest.portrait = portrait
    delete manifest.presetPortrait
  } else {
    manifest.presetPortrait = portrait
  }
  marketManifest(manifest, allowedPlugins)
  entries['muse-package.json'] = new TextEncoder().encode(JSON.stringify(manifest))
  if (entries['muse-package.json'].length > 128 * 1024
    || Object.values(entries).reduce((total, bytes) => total + bytes.length, 0) > limits.expandedBytes) throw new MarketError('expanded-limit', 413)
  const result = zipSync(entries, { mtime: new Date(1980, 0, 1) })
  if (result.length > limits.archiveBytes) throw new MarketError('archive-too-large', 413)
  return result
}
