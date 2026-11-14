/** Pinned community source copies retain upstream text; Muse-owned plugins remain maintained. */
import sources from '../third_party/plugins/sources.json' with { type: 'json' }
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const embeddedSources = [
  { plugin: 'muse-reverse-tools', directory: 'resources/reverse-skill' },
  { plugin: 'muse-fanqie-download', directory: 'python/vendor' },
] as const

/** Exact embedded upstream directories; surrounding Muse implementation and docs remain maintained. */
export const embeddedPluginSourcePrefixes = embeddedSources.map(({ plugin, directory }) => `third_party/plugins/${plugin}/${directory}/`)

/** Exact directory prefixes declared by the community source inventory. */
export const retainedPluginSourcePrefixes = [
  ...Object.keys(sources).map(name => `third_party/plugins/${name}/`),
  ...embeddedPluginSourcePrefixes,
]

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** One integrity-checked upstream file, optionally with unchanged-line mapping for maintained source. */
export type RetainedPluginOrigin = { readonly kind: 'exact' } | {
  readonly kind: 'maintained'
  readonly upstream: string
  readonly originalLine: (currentLine: number) => number | undefined
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !value.startsWith('/') && !value.includes('\\')
    && !value.includes(':') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

/**
 * Read repository files without following source-path links or leaving the canonical repository.
 * @param repoRoot - Regular repository directory whose canonical path bounds every source.
 * @returns Reader which skips absent files but rejects invalid paths, non-files and links at any level.
 */
export function createRegularRepositorySourceReader(repoRoot: string): (path: string) => Buffer | undefined {
  const root = resolve(repoRoot), rootInfo = lstatSync(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Repository source root must be a regular directory')
  const canonicalRoot = realpathSync(root)
  return (path) => {
    if (!safeRelativePath(path)) throw new Error(`Invalid repository source path: ${String(path)}`)
    const parts = path.split('/')
    let absolute = root
    for (const [index, part] of parts.entries()) {
      absolute = join(absolute, part)
      const info = lstatSync(absolute, { throwIfNoEntry: false })
      if (info === undefined) return undefined
      if (info.isSymbolicLink()) throw new Error(`Repository source link is unsupported: ${path}`)
      const canonical = realpathSync(absolute), inside = relative(canonicalRoot, canonical)
      if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) throw new Error(`Repository source escaped its canonical root: ${path}`)
      if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) throw new Error(`Repository source must be a regular file: ${path}`)
    }
    return readFileSync(absolute)
  }
}

function sourceBytes(repoRoot: string, path: string): Buffer {
  const bytes = createRegularRepositorySourceReader(repoRoot)(path)
  if (bytes === undefined) throw new Error(`Retained source is missing: ${path}`)
  return bytes
}

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function unchangedLines(repoRoot: string, original: string, current: string): (line: number) => number | undefined {
  const diff = spawnSync('git', ['diff', '--no-index', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv',
    '--ignore-cr-at-eol', '--', resolve(repoRoot, original), resolve(repoRoot, current)], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 10_000,
  })
  if (diff.error !== undefined) throw diff.error
  if (diff.status !== 0 && diff.status !== 1) throw new Error(`Retained source diff failed: ${current}: ${diff.stderr}`)
  const hunks = [...diff.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu)].map(match => ({
    oldStart: Number(match[1]), oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]), newCount: match[4] === undefined ? 1 : Number(match[4]),
  }))
  if (diff.status === 1 && hunks.length === 0) throw new Error(`Retained source diff has no text mapping: ${current}`)
  return (line) => {
    let offset = 0
    for (const hunk of hunks) {
      if (hunk.newCount > 0 && line >= hunk.newStart && line < hunk.newStart + hunk.newCount) return undefined
      const afterNew = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart + hunk.newCount
      const afterOld = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart + hunk.oldCount
      if (line >= afterNew) offset = afterOld - afterNew
    }
    return line + offset
  }
}

/**
 * Read exact upstream source identities, never a directory-wide source exemption.
 * @param repoRoot - Repository containing reviewed pins and origin lock.
 * @returns Only integrity-verified files; maintained files expose a conservative unchanged-line mapping.
 */
export function readRetainedPluginOrigins(repoRoot: string): ReadonlyMap<string, RetainedPluginOrigin> {
  const pinPath = 'third_party/plugins/sources.json'
  const lockPath = 'scripts/retained-plugin-origins.json'
  const readSource = createRegularRepositorySourceReader(repoRoot)
  const pinBytes = readSource(pinPath), lockBytes = readSource(lockPath)
  if (pinBytes === undefined && lockBytes === undefined) return new Map()
  if (pinBytes === undefined || lockBytes === undefined) throw new Error('Retained source pins and origin lock must both exist')
  const pins: unknown = JSON.parse(pinBytes.toString('utf8'))
  const lock: unknown = JSON.parse(lockBytes.toString('utf8'))
  if (!record(pins) || !record(lock) || lock.version !== 1 || !Array.isArray(lock.files) || lock.files.length === 0) {
    throw new Error('Invalid retained source origin inventory')
  }
  const result = new Map<string, RetainedPluginOrigin>()
  for (const item of lock.files) {
    if (!record(item) || !safeRelativePath(item.path) || !/^third_party\/plugins\/[^/]+\/.+/u.test(item.path)
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw new Error('Invalid retained source origin record')
    const [, , plugin, ...relative] = item.path.split('/')
    const pin = plugin === undefined ? undefined : pins[plugin]
    if (!record(pin) || typeof item.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(item.commit)
      || pin.commit !== item.commit || pin.repository !== item.repository || pin.license !== item.license) {
      throw new Error(`Retained source pin mismatch: ${item.path}`)
    }
    if (result.has(item.path)) throw new Error(`Duplicate retained source origin: ${item.path}`)
    const bytes = sourceBytes(repoRoot, item.path)
    const maintained = record(pin.localModifications) && record(pin.localModifications.files)
      ? pin.localModifications.files[relative.join('/')] : undefined
    if (maintained === undefined) {
      if (digest(bytes.toString('utf8').replaceAll('\r\n', '\n')) !== item.sha256) throw new Error(`Retained upstream source hash mismatch: ${item.path}`)
      result.set(item.path, { kind: 'exact' })
      continue
    }
    if (!record(maintained) || maintained.upstreamSha256 !== item.sha256 || maintained.sha256 !== digest(bytes)) {
      throw new Error(`Maintained retained source hash mismatch: ${item.path}`)
    }
    if (!safeRelativePath(item.upstreamText) || !item.upstreamText.startsWith('scripts/fixtures/retained-plugin-origins/')
      || !safeRelativePath(item.licenseFile) || !item.licenseFile.startsWith(`third_party/plugins/${plugin}/`)) {
      throw new Error(`Maintained retained source requires its upstream text and license: ${item.path}`)
    }
    const upstream = sourceBytes(repoRoot, item.upstreamText).toString('utf8').replaceAll('\r\n', '\n')
    sourceBytes(repoRoot, item.licenseFile)
    if (digest(upstream) !== item.sha256) throw new Error(`Retained original text hash mismatch: ${item.path}`)
    result.set(item.path, { kind: 'maintained', upstream, originalLine: unchangedLines(repoRoot, item.upstreamText, item.path) })
  }
  return result
}

/**
 * Require complete hash inventories for prose excluded as embedded upstream source.
 * @param repoRoot - Repository containing the plugin inventories and resources.
 */
export function assertEmbeddedPluginSourceIntegrity(repoRoot: string): void {
  for (const { plugin, directory } of embeddedSources) {
    const root = join(repoRoot, 'third_party/plugins', plugin)
    const metadata: unknown = JSON.parse(readFileSync(join(root, 'SOURCE.json'), 'utf8'))
    if (!record(metadata) || !Array.isArray(metadata.files) || metadata.files.length === 0) throw new Error(`Missing embedded source inventory: ${plugin}`)
    const expected = new Map<string, string>()
    for (const item of metadata.files) {
      if (!record(item) || typeof item.path !== 'string' || typeof item.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/u.test(item.sha256) || item.path.startsWith('/') || item.path.includes('\\')
        || item.path.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error(`Invalid embedded source record: ${plugin}`)
      const path = plugin === 'muse-reverse-tools' ? item.path : item.path.slice(`${directory}/`.length)
      if (plugin !== 'muse-reverse-tools' && !item.path.startsWith(`${directory}/`)) throw new Error(`Source record outside embedded directory: ${plugin}`)
      if (expected.has(path)) throw new Error(`Duplicate embedded source record: ${plugin}/${path}`)
      expected.set(path, item.sha256)
    }
    const actual = new Set<string>()
    function scan(prefix: string): void {
      for (const name of readdirSync(join(root, directory, prefix))) {
        const path = prefix ? `${prefix}/${name}` : name
        const absolute = join(root, directory, path), info = lstatSync(absolute)
        if (info.isSymbolicLink()) throw new Error(`Embedded source link refused: ${plugin}/${path}`)
        if (info.isDirectory()) { scan(path); continue }
        if (!info.isFile() || expected.get(path) !== createHash('sha256').update(readFileSync(absolute)).digest('hex')) throw new Error(`Embedded source hash mismatch: ${plugin}/${path}`)
        actual.add(path)
      }
    }
    scan('')
    if (actual.size !== expected.size) throw new Error(`Incomplete embedded source files: ${plugin}`)
  }
}
