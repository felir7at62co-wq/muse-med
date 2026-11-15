/**
 * JSON storage backend: one human-readable document per unit under a
 * configured root — a whole-unit file (`single` layout) or one document per
 * record (`per-record` layout), published by atomic rewrite. Registers as
 * backend `json` on the storage hub.
 * @module @deepseek-ai/dsh-storage-json
 */

import { mkdir, open, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { openSingleUnit } from './single-unit.ts'
import { openPerRecordUnit } from './per-record-unit.ts'
import { parse } from './format.ts'

/** Cordis plugin name. */
export const name = 'storage-json'
/** The hub must exist before the backend can register. */
export const inject = ['storage']

/**
 * Plugin configuration.
 * `root` has NO default on purpose: a `process.cwd()` fallback would scatter
 * unit files wherever the process happens to start; assemblies state the
 * location explicitly.
 */
export interface Config {
  /** Directory holding one `<unit>.json` file (or `<unit>/` tree) per unit. */
  root: string
}

/** Config schema. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
})

/** JSON backend: owns the file-tree root and serves the `kv` facet. */
export class JsonStorageBackend implements StorageBackend {
  private readonly open = new Map<string, KvUnit>()
  // Reserved synchronously at open() entry so a concurrent open of the same
  // unit fails, and close() can await opens still in flight.
  private readonly opening = new Map<string, Promise<KvUnit>>()
  private closed = false

  constructor(private readonly root: string) { sourceRoots.set(this, root) }

  readonly kv: KvFacet = {
    // The body up to the first await runs synchronously, so the opening-slot
    // reservation below still excludes a concurrent open of the same unit.
    open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      if (this.closed) throw new StorageError('closed', 'json backend is closed')
      validateDescriptor(descriptor)
      if (this.open.has(descriptor.name) || this.opening.has(descriptor.name)) {
        // Double-open is a caller bug, not a medium condition.
        throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`)
      }
      const opening = this.openUnit(descriptor)
      this.opening.set(descriptor.name, opening)
      return opening.finally(() => this.opening.delete(descriptor.name))
    },
  }

  private async openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    // The two layouts differ in medium shape only; each opener owns its own
    // path convention under the shared root.
    const onClose = () => this.open.delete(descriptor.name)
    const unit = descriptor.layout === 'per-record'
      ? await openPerRecordUnit(descriptor, this.root, onClose)
      : await openSingleUnit(descriptor, this.root, onClose)
    if (this.closed) {
      // The backend closed while this open was in flight: do not hand out a
      // live unit past close().
      await unit.close()
      throw new StorageError('closed', 'json backend is closed')
    }
    this.open.set(descriptor.name, unit)
    return unit
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      sourceRoots.delete(this)
    }
    await Promise.allSettled([...this.opening.values()])
    for (const unit of [...this.open.values()]) {
      await unit.close()
    }
  }
}

function validateDescriptor(descriptor: KvUnitDescriptor): void {
  if (!UNIT_NAME_RE.test(descriptor.name)) {
    throw new StorageError('malformed-medium', `invalid unit name '${descriptor.name}'`)
  }
  for (const table of descriptor.tables) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new StorageError('malformed-medium', `invalid table name '${table}' in unit '${descriptor.name}'`)
    }
  }
}

/**
 * Register the `json` backend on the storage hub.
 * @param ctx - Plugin context.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config) {
  const backend = new JsonStorageBackend(config.root)
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register('json', backend)
    return async () => {
      unregister()
      await backend.close()
    }
  })
  ctx.provide(storageBackendServiceKey('json'), backend)
}


const sourceRoots = new WeakMap<StorageBackend, string>()

/** Complete on-disk single-unit snapshot for an explicitly selected migration source. */
export interface JsonUnitSource {
  /** Canonical configured unit file, independent of an opened unit's cache. */
  readonly path: string
  /** Undefined only when the canonical unit file does not exist. */
  readonly text: string | undefined
}

/**
 * Resolve the real JSON backend's single-unit source without reading its memory cache.
 * @param backend - The registered source backend instance.
 * @param descriptor - Exact single-layout domain identity to migrate.
 * @returns the canonical root's unit path; an absent root retains its absolute spelling.
 */
export async function jsonUnitSourcePath(backend: StorageBackend, descriptor: KvUnitDescriptor): Promise<string> {
  validateDescriptor(descriptor)
  const root = sourceRoots.get(backend)
  if (root === undefined) throw new Error('migration source is not a live JSON storage backend')
  if (descriptor.layout === 'per-record') throw new Error('migration source must use the complete single-unit layout')
  let canonical: string
  try { canonical = await realpath(root) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    canonical = resolve(root)
  }
  return join(canonical, `${descriptor.name}.json`)
}

/**
 * Read one stable whole-unit document from the selected JSON backend.
 * @param backend - Registered source backend whose original path remains authoritative.
 * @param descriptor - Exact unit name, version and complete table declaration.
 * @returns source path and complete bytes; a concurrent replacement or malformed document rejects.
 */
export async function readJsonUnitSource(backend: StorageBackend, descriptor: KvUnitDescriptor): Promise<JsonUnitSource> {
  const path = await jsonUnitSourcePath(backend, descriptor)
  let handle
  try { handle = await open(path, 'r') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { path, text: undefined }
  }
  try {
    const before = await handle.stat({ bigint: true })
    const text = await handle.readFile('utf8')
    const after = await handle.stat({ bigint: true })
    const current = await stat(path, { bigint: true })
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('JSON unit changed while reading its migration source')
    }
    parse(text, descriptor)
    if (!sourceRoots.has(backend)) throw new Error('migration source JSON backend closed while reading')
    return { path, text }
  } finally { await handle.close() }
}
