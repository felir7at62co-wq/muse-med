/** Exclusive Desktop workspace storage and durable native continuation ownership.
 * @module @deepseek-ai/dsh-desktop-host/workspace-owned-storage
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as schema } from 'zod'
import { StorageError, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { workspaceDomainState, workspaceRecord } from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { generationWorkspaceIdentitySchema } from '@deepseek-ai/dsh-tool-jubian/generation-binding'
import type { GenerationWorkspaceAuthority, GenerationWorkspaceIdentity, GenerationWorkspaceLease } from '@deepseek-ai/dsh-tool-jubian/generation-binding'
import { jsonUnitSourcePath, readJsonUnitSource } from '@deepseek-ai/dsh-storage-json'
import { acquireWorkspaceOwner, publishWorkspacePath } from './workspace-owner-lease.ts'
import { assertWorkspaceMigrationHandoff } from './workspace-handoff.ts'
import type { WorkspaceOwnerLease } from './workspace-owner-lease.ts'

/** Private Desktop storage backend name. */
export const name = 'muse-workspace-owned-storage'
/** Storage hub is needed before registration. */
export const inject = ['storage']
/** Explicit legacy source and isolated successor location. */
export interface Config {
  /** Previously selected live JSON backend serving the complete workspace unit. */
  sourceBackend: string
  /** Absolute directory holding the versioned successor state and migration receipt. */
  root: string
  /** Maximum duration of each first-migration process scan in milliseconds. */
  handoffScanTimeoutMs?: number
}
/** Paths are resolved by the Desktop composition from its actual legacy backend. */
export const Config: z<Config> = z.object({
  sourceBackend: z.string().required(), root: z.string().required(),
  handoffScanTimeoutMs: z.number().step(1).min(1).max(30_000).default(5000),
})

const storedSchema = schema.object({
  schemaVersion: schema.literal(1),
  authorityId: schema.uuid(),
  unitVersion: schema.number().int().nonnegative(),
  global: workspaceDomainState.strict().nullable(),
  workspaces: schema.record(schema.string(), workspaceRecord.strict()),
  epochs: schema.record(schema.string(), schema.record(schema.string(), schema.uuid())),
}).strict()
type StoredState = schema.infer<typeof storedSchema>
const receiptSchema = schema.object({
  schemaVersion: schema.literal(1), sourceBackend: schema.string(), sourcePath: schema.string(),
  sourceSha256: schema.string().regex(/^[a-f0-9]{64}$/).nullable(),
  authorityId: schema.uuid(), initialStateSha256: schema.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const legacySchema = schema.object({
  unit: schema.object({ name: schema.literal('workspace'), version: schema.number().int().nonnegative() }).strict(),
  global: workspaceDomainState.strict().nullable(),
  tables: schema.object({ workspaces: schema.record(schema.string(), workspaceRecord.strict()) }).strict(),
}).strict()
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const encode = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/**
 * One process owns the successor while its workspace domain is open. The old
 * store remains untouched and is never read again after migration publication.
 */
export class OwnedWorkspaceStorage implements StorageBackend, GenerationWorkspaceAuthority {
  readonly kv = { open: (descriptor: KvUnitDescriptor) => this.openUnit(descriptor) }
  private opening: Promise<KvUnit> | undefined
  private state: StoredState | undefined
  private writeVersion: number | undefined
  private readonly handoffScanTimeoutMs: number
  private owner: WorkspaceOwnerLease | undefined
  private closed = false
  private closing = false
  private disposal: Promise<void> | undefined
  private unitDisposal: Promise<void> | undefined
  private unitGeneration = 0
  private unitClosing = false
  private failure: StorageError | undefined
  private tail: Promise<void> = Promise.resolve()
  private readonly active = new Map<string, { identity: GenerationWorkspaceIdentity; lease: GenerationWorkspaceLease }>()

  /**
   * @param config - Explicit source backend identity and successor directory.
   * @param sourceBackend - The actual registered source backend, never a guessed home path.
   */
  constructor(private readonly config: Config, private readonly sourceBackend: StorageBackend) {
    if (!isAbsolute(config.root)) throw new Error('workspace storage root must be absolute')
    this.handoffScanTimeoutMs = config.handoffScanTimeoutMs ?? 5000
  }

  private openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    if (this.closing || this.closed) return Promise.reject(new StorageError('closed', 'workspace successor is closed'))
    if (this.opening !== undefined) return Promise.reject(new Error('workspace successor unit is already open'))
    if (descriptor.name !== 'workspace' || descriptor.tables.length !== 1 || descriptor.tables[0] !== 'workspaces'
      || !descriptor.hasGlobal || descriptor.layout === 'per-record') return Promise.reject(new Error('workspace successor accepts only the workspace domain'))
    const generation = ++this.unitGeneration
    this.unitClosing = false
    this.unitDisposal = undefined
    this.failure = undefined
    this.opening = this.initialize(descriptor, generation)
    this.opening.catch(() => {
      if (this.unitGeneration === generation && !this.unitClosing) this.opening = undefined
    })
    return this.opening
  }

  private async initialize(descriptor: KvUnitDescriptor, generation: number): Promise<KvUnit> {
    this.owner = await acquireWorkspaceOwner(`${this.config.root}.lock`)
    try {
      this.assertUnitInitialization()
      const sourcePath = await jsonUnitSourcePath(this.sourceBackend, descriptor)
      if (sourcePath === join(resolve(this.config.root), 'state.json')) {
        throw new Error('workspace successor must differ from its source')
      }
      await this.migrate(descriptor, sourcePath)
      const state = storedSchema.parse(JSON.parse(await readFile(join(this.config.root, 'state.json'), 'utf8')))
      if (state.unitVersion !== descriptor.version && !descriptor.compatibleVersions?.includes(state.unitVersion)) {
        throw new StorageError('version-mismatch', 'workspace successor unit version is unsupported')
      }
      const receipt = receiptSchema.parse(JSON.parse(await readFile(join(this.config.root, 'migration.json'), 'utf8')))
      if (receipt.authorityId !== state.authorityId || receipt.sourcePath !== sourcePath
        || receipt.sourceBackend !== this.config.sourceBackend) {
        throw new Error('workspace successor authority does not match its migration source')
      }
      validateState(state)
      this.state = state
      this.writeVersion = descriptor.version
      this.assertUnitInitialization()
      return {
        loadAll: () => this.forUnit(generation, () => Promise.resolve(this.snapshot())),
        putRecord: (table, key, value) => this.mutate((current) => {
          this.requireTable(table)
          const record = workspaceRecord.strict().parse(value)
          const epochs = Object.fromEntries(record.sessionIds.map(id => [id, current.epochs[key]?.[id] ?? randomUUID()]))
          return { ...current, workspaces: { ...current.workspaces, [key]: record }, epochs: { ...current.epochs, [key]: epochs } }
        }, generation),
        deleteRecord: (table, key) => this.remove(table, [key], generation),
        deleteRecords: (table, keys) => this.remove(table, keys, generation),
        setGlobal: value => this.mutate((current) => {
          const global = workspaceDomainState.strict().parse(value)
          const epochs = structuredClone(current.epochs)
          const previous = new Set(current.global?.archivedSessionIds ?? [])
          const next = new Set(global.archivedSessionIds)
          for (const members of Object.values(epochs)) for (const id of Object.keys(members)) {
            if ([...previous].some(value => value === id) !== [...next].some(value => value === id)) members[id] = randomUUID()
          }
          return { ...current, global, epochs }
        }, generation),
        close: () => this.closeUnit(generation),
      }
    } catch (error) {
      await this.owner.release()
      this.owner = undefined
      throw error
    }
  }

  private async migrate(descriptor: KvUnitDescriptor, sourcePath: string): Promise<void> {
    try {
      const info = await lstat(this.config.root)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('workspace successor root is not a directory')
      await syncDirectory(dirname(this.config.root))
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await assertWorkspaceMigrationHandoff(this.handoffScanTimeoutMs)
    const snapshot = await readJsonUnitSource(this.sourceBackend, descriptor)
    if (snapshot.path !== sourcePath) throw new Error('workspace migration source changed location')
    const source = snapshot.text
    const legacy = source === undefined ? undefined : legacySchema.parse(JSON.parse(source))
    if (legacy !== undefined && legacy.unit.version !== descriptor.version
      && !descriptor.compatibleVersions?.includes(legacy.unit.version)) {
      throw new StorageError('version-mismatch', 'legacy workspace version cannot be migrated')
    }
    const workspaces = legacy?.tables.workspaces ?? {}
    const epochs: StoredState['epochs'] = {}
    for (const [id, record] of Object.entries(workspaces)) {
      epochs[id] = Object.fromEntries(record.sessionIds.map(session => [session, randomUUID()]))
    }
    const state: StoredState = { schemaVersion: 1, authorityId: randomUUID(), unitVersion: descriptor.version,
      global: legacy?.global ?? null, workspaces, epochs }
    validateState(state, true)
    const text = encode(state)
    const staging = await mkdtemp(join(dirname(this.config.root), `.${basename(this.config.root)}-migration-`))
    // A crash before publication retains an unreferenced staging directory. It
    // is never adopted without a complete receipt and is not another authority.
    await durableReplace(join(staging, 'state.json'), text)
    await durableReplace(join(staging, 'migration.json'), encode({ schemaVersion: 1, sourceBackend: this.config.sourceBackend, sourcePath,
      sourceSha256: source === undefined ? null : digest(source), authorityId: state.authorityId, initialStateSha256: digest(text) }))
    this.assertUnitInitialization()
    await assertWorkspaceMigrationHandoff(this.handoffScanTimeoutMs)
    await publishWorkspacePath(staging, this.config.root, false)
    await syncDirectory(dirname(this.config.root))
  }

  capture(sessionId: SessionId, signal: AbortSignal): Promise<GenerationWorkspaceIdentity | undefined> {
    return waitForOwner(this.enqueue(() => {
      signal.throwIfAborted()
      if (this.closing || this.unitClosing) throw new StorageError('closed', 'workspace successor is closing')
      return Promise.resolve(identityOf(this.requireState(), sessionId))
    }), signal)
  }

  acquire(identity: GenerationWorkspaceIdentity, signal: AbortSignal): Promise<GenerationWorkspaceLease> {
    return waitForOwner(this.enqueue(() => {
      signal.throwIfAborted()
      if (this.closing || this.unitClosing) throw new StorageError('closed', 'workspace successor is closing')
      if (this.active.has(identity.sessionId)) throw new Error('workspace Session already has an active continuation')
      if (!matches(this.requireState(), identity)) throw new Error('original workspace membership changed')
      const controller = new AbortController()
      const release = () => {
        if (controller.signal.aborted) return
        signal.removeEventListener('abort', release)
        if (this.active.get(identity.sessionId)?.lease === lease) this.active.delete(identity.sessionId)
        controller.abort(new Error('workspace ownership lease released'))
      }
      const lease: GenerationWorkspaceLease = { signal: controller.signal, release, assertCurrent: () => {
        controller.signal.throwIfAborted()
        if (!matches(this.requireState(), identity)) { release(); throw new Error('original workspace membership changed') }
      } }
      this.active.set(identity.sessionId, { identity, lease })
      signal.addEventListener('abort', release, { once: true })
      return Promise.resolve(lease)
    }), signal)
  }

  private snapshot() {
    const current = this.requireState()
    return { tables: { workspaces: structuredClone(current.workspaces) }, global: structuredClone(current.global) }
  }
  private requireState(): StoredState {
    if (this.closed) throw new StorageError('closed', 'workspace successor is closed')
    if (this.failure !== undefined) throw this.failure
    if (this.state === undefined || this.owner === undefined) throw new Error('workspace successor has no active owner')
    return this.state
  }
  private requireTable(table: string): void { if (table !== 'workspaces') throw new Error('workspace successor table is unknown') }
  private remove(table: string, keys: readonly string[], generation: number): Promise<void> {
    this.requireTable(table)
    return this.mutate((current) => {
      const removed = new Set(keys)
      const workspaces = Object.fromEntries(Object.entries(current.workspaces).filter(([key]) => !removed.has(key)))
      const epochs = Object.fromEntries(Object.entries(current.epochs).filter(([key]) => !removed.has(key)))
      return { ...current, workspaces, epochs }
    }, generation)
  }
  private mutate(nextState: (current: StoredState) => StoredState, generation: number): Promise<void> {
    return this.forUnit(generation, async () => {
      if (this.writeVersion === undefined) throw new Error('workspace unit version is unavailable')
      const next = { ...nextState(this.requireState()), unitVersion: this.writeVersion }
      // User mutations retain their normal behavior. Revoke affected automatic
      // work before committing an ownership change, including forced archival.
      for (const { identity, lease } of this.active.values()) if (!matches(next, identity)) lease.release()
      try { await durableReplace(join(this.config.root, 'state.json'), encode(next)) }
      catch (error) {
        if (error instanceof StorageError && error.code === 'unknown-state') this.failure = error
        throw error
      }
      this.state = next
    })
  }
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.closing || this.closed || this.unitClosing) return Promise.reject(new StorageError('closed', 'workspace successor is closed'))
    const result = this.tail.then(job)
    this.tail = result.then(() => {}, () => {})
    return result
  }
  private assertUnitInitialization(): void {
    if (this.closing || this.closed || this.unitClosing) throw new StorageError('closed', 'workspace successor is closing')
  }
  private forUnit<T>(generation: number, job: () => Promise<T>): Promise<T> {
    if (this.unitClosing || generation !== this.unitGeneration) {
      return Promise.reject(new StorageError('closed', 'workspace unit handle is closed'))
    }
    return this.enqueue(() => {
      if (generation !== this.unitGeneration) throw new StorageError('closed', 'workspace unit handle is stale')
      return job()
    })
  }
  private closeUnit(generation: number): Promise<void> {
    if (generation !== this.unitGeneration) return Promise.resolve()
    this.unitDisposal ??= this.disposeUnit()
    return this.unitDisposal
  }
  private async disposeUnit(): Promise<void> {
    this.unitClosing = true
    for (const { lease } of this.active.values()) lease.release()
    await this.opening?.catch(() => undefined)
    await this.tail
    await this.owner?.release()
    this.owner = undefined
    this.state = undefined
    this.writeVersion = undefined
    this.opening = undefined
  }
  close(): Promise<void> {
    this.disposal ??= this.dispose()
    return this.disposal
  }
  private async dispose(): Promise<void> {
    this.closing = true
    await this.closeUnit(this.unitGeneration)
    this.closed = true
  }
}

function identityOf(state: StoredState, sessionId: SessionId): GenerationWorkspaceIdentity | undefined {
  if (state.global === null || state.global.archivedSessionIds.includes(sessionId)) return undefined
  const global = state.global
  const owners = Object.entries(state.workspaces).filter(([id, record]) =>
    global.workspaceIds.some(value => value === id) && record.sessionIds.includes(sessionId))
  if (owners.length !== 1 || owners[0] === undefined) return undefined
  const [workspaceId, record] = owners[0]
  const epoch = state.epochs[workspaceId]?.[sessionId]
  if (epoch === undefined) return undefined
  return generationWorkspaceIdentitySchema.parse({ version: 1, authorityId: state.authorityId, workspaceId,
    workspaceCreatedAt: record.createdAt, workspacePath: record.path, membershipEpoch: epoch, sessionId })
}
function matches(state: StoredState, identity: GenerationWorkspaceIdentity): boolean {
  const current = identityOf(state, identity.sessionId)
  return current !== undefined && current.authorityId === identity.authorityId
    && current.workspaceId === identity.workspaceId && current.workspaceCreatedAt === identity.workspaceCreatedAt
    && current.workspacePath === identity.workspacePath && current.membershipEpoch === identity.membershipEpoch
    && current.sessionId === identity.sessionId
}
function validateState(state: StoredState, complete = false): void {
  const ids = state.global?.workspaceIds ?? []
  if (new Set(ids).size !== ids.length) throw new Error('workspace successor order contains duplicate ids')
  if (complete && state.global?.pendingMutation !== undefined) throw new Error('legacy workspace mutation must finish before migration')
  if (complete && (Object.keys(state.workspaces).length !== ids.length || ids.some(id => state.workspaces[id] === undefined))) {
    throw new Error('legacy workspace order and records disagree')
  }
  const seen = new Set<string>()
  for (const [id, record] of Object.entries(state.workspaces)) for (const session of record.sessionIds) {
    if (seen.has(session)) throw new Error('workspace successor has ambiguous Session ownership')
    seen.add(session)
    if (state.epochs[id]?.[session] === undefined) throw new Error('workspace successor lacks membership epoch')
  }
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function durableReplace(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
  let committed = false
  try {
    await publishWorkspacePath(temp, path, true)
    committed = true
    await syncDirectory(dirname(path))
  } catch (error) {
    if (committed) throw new StorageError('unknown-state', 'workspace publication durability is unknown; reopen required', { cause: error })
    await rm(temp, { force: true })
    throw error
  }
}

/** Register the private successor backend and its exact workspace authority. */
export function apply(ctx: Context, config: Config): void {
  if (config.sourceBackend === 'muse-workspace-owned') throw new Error('workspace migration source cannot be its successor')
  ctx.inject([storageBackendServiceKey(config.sourceBackend)], (scope) => {
    const backend = new OwnedWorkspaceStorage(config, scope.storage.backend.get(config.sourceBackend))
    scope.effect(() => {
      const unregister = scope.storage.backend.register('muse-workspace-owned', backend)
      return async () => { unregister(); await backend.close() }
    })
    scope.provide(storageBackendServiceKey('muse-workspace-owned'), backend)
    scope.provide('generationWorkspaceAuthority', backend)
  })
}

function waitForOwner<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('workspace acquisition cancelled', { cause: signal.reason }))
    }
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    pending.then((value) => { signal.removeEventListener('abort', cancel); resolve(value) },
      (error: unknown) => {
        signal.removeEventListener('abort', cancel)
        reject(error instanceof Error ? error : new Error('workspace acquisition failed', { cause: error }))
      })
  })
}
