/** Disable retired product plugins without loading their modules or modifying their saved data. */
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAlias, isMap, isSeq, parseDocument, type YAMLSeq } from 'yaml'

const BOT_NAMES = ['ds-bot', 'muse-bot'] as const

/** @param name Stored package/bundle name. @returns Whether it is a retired built-in Bot bundle. */
export function isRetiredBotBundle(name: string): boolean { return BOT_NAMES.some(bot => name === bot) }

/**
 * Preserve all row configuration while forcing retired Bot rows inactive, including inserted rows.
 * Disabled tombstones keep old id-only overrides addressable without importing an archived package.
 * No expression is evaluated; comments and !!js scalars remain in the YAML document.
 * @param text Existing profile patch text.
 * @returns Rewritten text only when a Bot row needs disabling or a missing tombstone is required.
 */
export function retiredBotProfilePatch(text: string): string | undefined {
  return retiredPluginProfilePatch(text, BOT_NAMES, BOT_NAMES, 'Bot')
}

function retiredPluginProfilePatch(
  text: string,
  names: readonly [string, ...string[]],
  knownIds: readonly string[],
  subject: string,
): string | undefined {
  const moduleName = (value: unknown): value is string => typeof value === 'string'
    && names.some(name => value === name || value.startsWith(`${name}/`))
  const document = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length > 0) throw new Error(`desktop project: invalid profile patch while retiring ${subject} rows`)
  if (document.contents === null) return undefined
  if (!isSeq(document.contents)) throw new Error('desktop project: profile patch must be a YAML sequence')
  const rows: YAMLSeq = document.contents
  const insertedIds = new Set<string>(), retiredIds = new Set<string>(knownIds), overrides = new Map<string, string>()
  let changed = false
  const collected = new Set<YAMLSeq>(), visited = new Set<YAMLSeq>()
  const collect = (rows: YAMLSeq): void => {
    if (collected.has(rows)) return
    collected.add(rows)
    for (const value of rows.items) {
      const row = isAlias(value) ? value.resolve(document) : value
      if (!isMap(row)) continue
      const id = row.get('id'), name = row.get('name')
      if (typeof id === 'string' && moduleName(name)) retiredIds.add(id)
      const inserted = row.get('insert', true), children = row.get('config', true)
      if (isSeq(inserted)) collect(inserted)
      if (row.get('group') === true && isSeq(children)) collect(children)
    }
  }
  collect(rows)
  const visit = (rows: YAMLSeq, patches: boolean): void => {
    if (visited.has(rows)) return
    visited.add(rows)
    for (const value of rows.items) {
      const row = isAlias(value) ? value.resolve(document) : value
      if (!isMap(row)) continue
      const inserted = row.get('insert', true)
      if (isSeq(inserted)) visit(inserted, false)
      const id = row.get('id'), name = row.get('name')
      if (!patches && typeof id === 'string') insertedIds.add(id)
      if (!row.has('insert') && (moduleName(name) || typeof id === 'string' && retiredIds.has(id) && name === undefined)) {
        if (row.get('disabled') !== true) { row.set('disabled', document.createNode(true)); changed = true }
        if (patches && typeof id === 'string') overrides.set(id, moduleName(name) ? name : names[0])
      }
      const children = row.get('config', true)
      if (row.get('group') === true && isSeq(children)) visit(children, false)
    }
  }
  visit(rows, true)
  const tombstones: Array<{ id: string; name: string; disabled: true }> = []
  for (const [id, name] of overrides) if (!insertedIds.has(id)) tombstones.push({ id, name, disabled: true })
  if (tombstones.length > 0) {
    rows.items.unshift(document.createNode({ insert: tombstones }))
    changed = true
  }
  return changed ? String(document) : undefined
}

function privateFile(filename: string, bytes: string | Buffer): void {
  const descriptor = openSync(filename, 'wx', 0o600)
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor) }
  finally { closeSync(descriptor) }
}

/**
 * Under the Desktop profile transaction lock, retain the exact original patch and replace it privately.
 * Backups stay beside the profile patch and never contain rewritten content.
 * @param profileDir Reserved Desktop profile directory; caller excludes concurrent writes and Host use.
 * @returns The unique backup path when changed, or undefined when absent/already retired.
 */
export function disableRetiredBotProfilePatch(profileDir: string): string | undefined {
  return disableRetiredProfilePatch(profileDir, retiredBotProfilePatch, 'bot')
}

/**
 * Disable the replaced subscription plugin and retain its configuration in private YAML backups.
 * Missing old ids receive disabled rows so saved preference overrides remain addressable.
 * @param profileDir Reserved Desktop profile directory; caller owns its transaction lock and shutdown.
 * @returns The exact-content backup path when changed, or undefined when already inactive or absent.
 */
export function disableRetiredSubscriptionProfilePatch(profileDir: string): string | undefined {
  return disableRetiredProfilePatch(profileDir,
    text => retiredPluginProfilePatch(text, ['dsh-codex-subscription'], ['codex-subscription'], 'subscription'), 'subscription')
}

function disableRetiredProfilePatch(
  profileDir: string,
  rewrite: (text: string) => string | undefined,
  backupKind: string,
): string | undefined {
  const filename = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(filename)) return undefined
  if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink()) throw new Error('desktop project: profile patch must be a regular file')
  const original = readFileSync(filename)
  const next = rewrite(original.toString('utf8'))
  if (next === undefined) return undefined
  const backup = `${filename}.${backupKind}-retired-${randomUUID()}.bak`
  privateFile(backup, original)
  const temporary = `${filename}.${randomUUID()}.tmp`
  privateFile(temporary, next)
  try { renameSync(temporary, filename) }
  catch (error) {
    unlinkSync(temporary)
    throw error
  }
  return backup
}
