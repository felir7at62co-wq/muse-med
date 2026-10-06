/** Pinned community source copies retain upstream text; Muse-owned plugins remain maintained. */
import sources from '../third_party/plugins/sources.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

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
