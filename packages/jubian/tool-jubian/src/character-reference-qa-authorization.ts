/**
 * Host-private, append-only authorization ledger for one-shot character-reference use.
 *
 * Isolated QA requires an explicit external data root and database path; omission
 * disables that deployment. Project-private grants use a separate Host-owned
 * database and require the signed-in owner’s live attestation. The store exposes
 * no model-facing grant or revoke operation.
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { stableSha256 } from '@deepseek-ai/dsh-jubian-api'

/** SQLite application id protecting unrelated databases from being opened as a QA ledger. */
export const CHARACTER_REFERENCE_QA_APPLICATION_ID = 0x44535141
/** Monotonic schema version for the canonical QA authorization ledger. */
export const CHARACTER_REFERENCE_QA_SCHEMA_VERSION = 2

/** Deployment marker accepted by the isolated character-reference QA ledger. */
export const CHARACTER_REFERENCE_QA_ENVIRONMENT = 'isolated_qa' as const
/** A user's own pending image may be attested for one project-private derivative, never public reuse. */
export const CHARACTER_REFERENCE_PRIVATE_ENVIRONMENT = 'project_private' as const
/** Only supported grant scope: one managed upload followed by one generation. */
export const CHARACTER_REFERENCE_QA_SCOPE = 'one_managed_upload_and_one_generation' as const
/** The private grant is likewise one-shot, but is issued by the owner in the live Muse UI. */
export const CHARACTER_REFERENCE_PRIVATE_SCOPE = 'one_project_private_upload_and_generation' as const
/** Exactly one isolated QA or signed-in user project-private authorization domain. */
export type CharacterReferenceEnvironment =
  | typeof CHARACTER_REFERENCE_QA_ENVIRONMENT
  | typeof CHARACTER_REFERENCE_PRIVATE_ENVIRONMENT
/** Exact digest produced by the legacy no-response synthetic unknown receipt. */
export const CHARACTER_REFERENCE_QA_LEGACY_SYNTHETIC_UNKNOWN_RECEIPT_SHA256 = stableSha256({
  outcome: 'unknown',
  response_sha256: null,
})
const CHARACTER_REFERENCE_QA_LEGACY_SYNTHETIC_UNKNOWN_RECEIPT_BASIS
  = '{"outcome":"unknown","response_sha256":null}'

/** Project-bible role classes accepted by the character-reference gate. */
export type CharacterReferenceQaRoleClass = 'lead' | 'important_support' | 'support' | 'extra'

/** Fail-closed error vocabulary exposed to the Host integration. */
export type CharacterReferenceQaAuthorizationErrorCode =
  | 'invalid-config'
  | 'foreign-database'
  | 'invalid-grant'
  | 'missing-authorization'
  | 'revoked'
  | 'binding-mismatch'
  | 'idempotency-conflict'
  | 'invalid-transition'
  | 'unknown-outcome'
  | 'already-consumed'

/** A stable, machine-readable failure from the isolated QA authorization gate. */
export class CharacterReferenceQaAuthorizationError extends Error {
  override readonly name = 'CharacterReferenceQaAuthorizationError'

  constructor(
    readonly code: CharacterReferenceQaAuthorizationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** Immutable operator-authored authorization record. */
export interface CharacterReferenceQaGrant {
  authorizationId: string
  authorizationVersion: number
  environment: CharacterReferenceEnvironment
  actorId: string
  reviewerId: string
  sourceDeclaration: string
  projectId: number
  characterId: string
  roleClass: CharacterReferenceQaRoleClass
  catalogId: string
  imageSha256: string
  catalogStatus: 'pending_review'
  scope: typeof CHARACTER_REFERENCE_QA_SCOPE | typeof CHARACTER_REFERENCE_PRIVATE_SCOPE
  maxGenerationUses: 1
  allowPublish: false
  allowFormalBind: false
  allowCrossProjectReuse: false
  productionApproved: false
  createdAt: string
}

/** Runtime input accepted from the trusted operator surface before literal values are narrowed. */
export type CharacterReferenceQaGrantInput = Omit<CharacterReferenceQaGrant,
  | 'environment'
  | 'catalogStatus'
  | 'scope'
  | 'maxGenerationUses'
  | 'allowPublish'
  | 'allowFormalBind'
  | 'allowCrossProjectReuse'
  | 'productionApproved'> & {
    environment: string
    catalogStatus: string
    scope: string
    maxGenerationUses: number
    allowPublish: boolean
    allowFormalBind: boolean
    allowCrossProjectReuse: boolean
    productionApproved: boolean
  }

/** Exact identity reread from the current Host project and Catalog before each side effect. */
export interface CharacterReferenceQaBinding {
  authorizationId: string
  authorizationVersion: number
  projectId: number
  characterId: string
  roleClass: CharacterReferenceQaRoleClass
  catalogId: string
  imageSha256: string
  catalogStatus: 'pending_review'
}

/** Immutable event kinds recorded while a one-shot QA grant is consumed. */
export type CharacterReferenceQaEventType =
  | 'grant'
  | 'revoke'
  | 'upload_claim'
  | 'upload_settle'
  | 'upload_unknown'
  | 'generation_claim'
  | 'generation_settle'
  | 'generation_unknown'

/** Append-only audit row. Fields not used by an event are null. */
export interface CharacterReferenceQaEvent {
  sequence: number
  authorizationId: string
  authorizationVersion: number
  type: CharacterReferenceQaEventType
  actorId: string
  occurredAt: string
  idempotencyKey: string | null
  managedReferenceId: string | null
  materialUri: string | null
  imageSha256: string | null
  receiptSha256: string | null
  note: string | null
}

/** Immutable event kinds for the single, explicitly authorized pre-dispatch recovery. */
export type CharacterReferenceQaGenerationRecoveryEventType =
  | 'recovery_authorized'
  | 'recovery_claim'
  | 'recovery_settle'
  | 'recovery_unknown'

/** Append-only recovery evidence kept separate from the canonical one-shot event history. */
export interface CharacterReferenceQaGenerationRecoveryEvent {
  sequence: number
  authorizationId: string
  authorizationVersion: number
  type: CharacterReferenceQaGenerationRecoveryEventType
  actorId: string
  occurredAt: string
  idempotencyKey: string
  managedReferenceId: string
  guardEvidenceSha256: string | null
  reconciliationEvidenceSha256: string | null
  receiptSha256: string | null
  reason: string | null
}

/** Derived lifecycle state for one managed external operation. */
export type CharacterReferenceQaOperationState = 'not_started' | 'claimed' | 'settled' | 'unknown'

/** Derived state of the only permitted pre-dispatch recovery. */
export type CharacterReferenceQaGenerationRecoveryState =
  | 'not_authorized'
  | 'authorized'
  | 'claimed'
  | 'settled'
  | 'unknown'

/** Auditable authorization, identity, and evidence for pre-dispatch recovery. */
export interface CharacterReferenceQaGenerationRecoverySnapshot {
  state: CharacterReferenceQaGenerationRecoveryState
  actorId: string | null
  authorizedAt: string | null
  idempotencyKey: string | null
  managedReferenceId: string | null
  guardEvidenceSha256: string | null
  reconciliationEvidenceSha256: string | null
  reason: string | null
  receiptSha256: string | null
}

/** Current grant, revocation, upload, and generation state derived from append-only events. */
export interface CharacterReferenceQaSnapshot {
  grant: CharacterReferenceQaGrant
  revoked: boolean
  upload: {
    state: CharacterReferenceQaOperationState
    idempotencyKey: string | null
    managedReferenceId: string | null
    materialUri: string | null
    imageSha256: string | null
  }
  generation: {
    state: CharacterReferenceQaOperationState
    idempotencyKey: string | null
    managedReferenceId: string | null
    receiptSha256: string | null
  }
  generationRecovery: CharacterReferenceQaGenerationRecoverySnapshot
}

/** Decision returned before an external operation: send once or reconcile without sending. */
export interface CharacterReferenceQaClaimDecision {
  /** Only `send` permits one outbound side effect. `reconcile` never does. */
  action: 'send' | 'reconcile'
  state: Exclude<CharacterReferenceQaOperationState, 'not_started'>
  idempotencyKey: string
  managedReferenceId: string
}

/** Settled Host-managed reference used without exposing its URI to the Agent. */
export interface CharacterReferenceQaManagedReference {
  managedReferenceId: string
  materialUri: string
  imageSha256: string
}

const V1_TABLES = new Set(['character_reference_qa_authorizations', 'character_reference_qa_events'])
const V2_TABLES = new Set([...V1_TABLES, 'character_reference_qa_generation_recovery_events'])
const SHA256_RE = /^[0-9a-f]{64}$/u

/** Explicit repository-external location of the isolated QA authorization ledger. */
export interface CharacterReferenceQaAuthorizationStoreLocation {
  /** Absolute owner-private directory trusted to contain the database and its SQLite sidecars. */
  dataRoot?: string
  /** Absolute SQLite path strictly below the configured data root. */
  databasePath?: string
  /** Defaults to isolated QA. Project-private stores must use a distinct Host-private path. */
  environment?: CharacterReferenceEnvironment
}

/**
 * Open an explicitly configured QA ledger. Missing configuration keeps the gate disabled.
 * Both paths are required when enabled, and existing POSIX entries must already be owner-only.
 * @param location - Trusted data root and the database path contained by it.
 * @returns an opened ledger, or undefined when both location fields are omitted.
 */
export async function openCharacterReferenceQaAuthorizationStore(
  location: CharacterReferenceQaAuthorizationStoreLocation,
): Promise<CharacterReferenceQaAuthorizationStore | undefined> {
  const dataRoot = nonblank(location.dataRoot)
  const databasePath = nonblank(location.databasePath)
  if (dataRoot === undefined && databasePath === undefined) return undefined
  if (dataRoot === undefined || databasePath === undefined) {
    throw failure('invalid-config',
      'character-reference QA authorization requires both data root and database path')
  }
  if (!isAbsolute(dataRoot) || !isAbsolute(databasePath)) {
    throw failure('invalid-config',
      'character-reference QA authorization data root and database path must be absolute')
  }
  const actualRoot = resolve(dataRoot)
  const actual = resolve(databasePath)
  if (!isStrictDescendant(actualRoot, actual)) {
    throw failure('invalid-config',
      'character-reference QA authorization database path must be inside its trusted data root')
  }
  try {
    await preparePrivateDatabaseLocation(actualRoot, actual)
    const environment = location.environment ?? CHARACTER_REFERENCE_QA_ENVIRONMENT
    return new CharacterReferenceQaAuthorizationStore(openDatabase(actual, environment), environment)
  } catch (error) {
    if (error instanceof CharacterReferenceQaAuthorizationError) throw error
    throw failure('invalid-config', 'character-reference QA authorization storage is unavailable', error)
  }
}

const GROUP_OTHER_BITS = 0o077
const SQLITE_SIDECAR_SUFFIXES = ['-journal', '-shm', '-wal'] as const

function nonblank(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return value
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

async function preparePrivateDatabaseLocation(dataRoot: string, databasePath: string): Promise<void> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  await assertPrivateEntry(dataRoot, 'trusted data root', 'directory')
  const canonicalRoot = await realpath(dataRoot)
  const databaseDirectory = dirname(databasePath)
  await mkdir(databaseDirectory, { recursive: true, mode: 0o700 })
  await assertPrivateDirectoryChain(dataRoot, databaseDirectory)
  const canonicalDirectory = await realpath(databaseDirectory)
  if (canonicalDirectory !== canonicalRoot && !isStrictDescendant(canonicalRoot, canonicalDirectory)) {
    throw failure('invalid-config',
      'character-reference QA authorization database directory resolves outside its trusted data root')
  }
  try {
    const handle = await open(databasePath, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await assertPrivateEntry(databasePath, 'authorization database', 'file')
  const canonicalDatabase = await realpath(databasePath)
  if (!isStrictDescendant(canonicalRoot, canonicalDatabase)) {
    throw failure('invalid-config',
      'character-reference QA authorization database resolves outside its trusted data root')
  }
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    await assertPrivateEntryIfPresent(`${databasePath}${suffix}`, `SQLite ${suffix.slice(1)} sidecar`, 'file')
  }
}

async function assertPrivateDirectoryChain(dataRoot: string, directory: string): Promise<void> {
  await assertPrivateEntry(dataRoot, 'trusted data root', 'directory')
  const path = relative(dataRoot, directory)
  if (path === '') return
  let current = dataRoot
  for (const segment of path.split(sep)) {
    current = resolve(current, segment)
    await assertPrivateEntry(current, 'authorization database directory', 'directory')
  }
}

async function assertPrivateEntryIfPresent(
  path: string,
  label: string,
  kind: 'directory' | 'file',
): Promise<void> {
  try {
    await assertPrivateEntry(path, label, kind)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

async function assertPrivateEntry(path: string, label: string, kind: 'directory' | 'file'): Promise<void> {
  const entry = await lstat(path)
  if (entry.isSymbolicLink() || (kind === 'directory' ? !entry.isDirectory() : !entry.isFile())) {
    throw failure('invalid-config', `character-reference QA ${label} must be a real ${kind}`)
  }
  /* v8 ignore next 6 -- Windows ACLs have no POSIX mode equivalent; POSIX CI exercises this branch. */
  if (process.platform !== 'win32' && (entry.mode & GROUP_OTHER_BITS) !== 0) {
    const expected = kind === 'directory' ? '700' : '600'
    throw failure('invalid-config',
      `character-reference QA ${label} is accessible beyond its owner (mode ${(entry.mode & 0o777).toString(8)});`
      + ` run "chmod ${expected} ${path}" before starting again`)
  }
}

/** Host-only owner of the isolated QA authorization database. */
export class CharacterReferenceQaAuthorizationStore {
  private closed = false

  constructor(
    private readonly db: DatabaseSync,
    readonly environment: CharacterReferenceEnvironment = CHARACTER_REFERENCE_QA_ENVIRONMENT,
  ) {}

  /** Close the database owned by this store. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  /**
   * Append one immutable, narrowly scoped operator grant. This method is never registered as a Tool.
   * @param grant - Exact operator-authored QA authorization to record once.
   */
  appendGrant(grant: CharacterReferenceQaGrantInput): void {
    this.ensureOpen()
    assertGrant(grant)
    if (grant.environment !== this.environment) {
      throw failure('invalid-grant', 'authorization environment differs from its private Host ledger')
    }
    this.transaction(() => {
      if (grant.environment === CHARACTER_REFERENCE_PRIVATE_ENVIRONMENT) {
        const priorGrants = this.db.prepare(`
          SELECT * FROM character_reference_qa_authorizations
          WHERE environment = ? AND catalog_id = ? AND image_sha256 = ?
        `).all(CHARACTER_REFERENCE_PRIVATE_ENVIRONMENT, grant.catalogId, grant.imageSha256)
        const account = privateAccountFromActor(grant.actorId)
        if (priorGrants.some(row => privateAccountFromActor(dbString(row, 'actor_id')) !== account)) {
          throw failure('binding-mismatch', 'this Catalog image was already claimed by another Muse account')
        }
        for (const row of priorGrants) {
          const prior = grantFromRow(row)
          if (prior.projectId !== grant.projectId || prior.characterId !== grant.characterId) continue
          const priorBinding = bindingFromGrant(prior)
          const state = snapshot(prior, this.eventsFor(priorBinding), this.recoveryEventsFor(priorBinding))
          if (state.upload.state === 'claimed' || state.upload.state === 'unknown'
            || state.generation.state === 'claimed' || state.generation.state === 'unknown') {
            throw failure('unknown-outcome',
              'an earlier upload or paid generation for this project image still requires read-only reconciliation')
          }
        }
      }
      try {
        this.db.prepare(`
          INSERT INTO character_reference_qa_authorizations (
            authorization_id, authorization_version, environment, actor_id, reviewer_id,
            source_declaration, project_id, character_id, role_class, catalog_id,
            image_sha256, catalog_status, scope, max_generation_uses, allow_publish,
            allow_formal_bind, allow_cross_project_reuse, production_approved, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          grant.authorizationId,
          grant.authorizationVersion,
          grant.environment,
          grant.actorId,
          grant.reviewerId,
          grant.sourceDeclaration,
          grant.projectId,
          grant.characterId,
          grant.roleClass,
          grant.catalogId,
          grant.imageSha256,
          grant.catalogStatus,
          grant.scope,
          grant.maxGenerationUses,
          0,
          0,
          0,
          0,
          grant.createdAt,
        )
      } catch (error) {
        throw failure('invalid-grant', 'authorization id and version must identify one new immutable grant', error)
      }
      this.insertEvent({
        binding: bindingFromGrant(grant),
        type: 'grant',
        actorId: grant.actorId,
        occurredAt: grant.createdAt,
        note: grant.sourceDeclaration,
      })
    })
  }

  /**
   * Append a revocation without changing or deleting the original grant. This method is never registered as a Tool.
   * @param binding - Exact immutable grant identity to revoke.
   * @param actorId - Trusted operator recording the revocation.
   * @param reason - Human-readable revocation reason retained for audit.
   * @param occurredAt - ISO timestamp of the revocation decision.
   */
  appendRevocation(binding: CharacterReferenceQaBinding, actorId: string, reason: string, occurredAt: string): void {
    this.ensureOpen()
    assertText(actorId, 'revocation actor')
    assertText(reason, 'revocation reason')
    assertTimestamp(occurredAt, 'revocation timestamp')
    this.transaction(() => {
      this.requireMatchingGrant(binding)
      if (this.eventsFor(binding).some(event => event.type === 'revoke')) {
        throw failure('revoked', 'character-reference QA authorization is already revoked')
      }
      this.insertEvent({ binding, type: 'revoke', actorId, occurredAt, note: reason })
    })
  }

  /**
   * Inspect the current derived state after validating the exact project, role, Catalog identity, and SHA.
   * @param binding - Exact Host-reread identity expected to match the grant.
   * @returns Current state derived from the immutable grant and event history.
   */
  inspect(binding: CharacterReferenceQaBinding): CharacterReferenceQaSnapshot {
    this.ensureOpen()
    const grant = this.requireMatchingGrant(binding)
    return snapshot(grant, this.eventsFor(binding), this.recoveryEventsFor(binding))
  }

  /**
   * Atomically bind the first upload idempotency key before an external upload.
   * Reusing that key returns `reconcile`; a different key is rejected.
   * @param binding - Exact Host-reread authorization identity.
   * @param idempotencyKey - Fixed key for the only managed upload attempt.
   * @param occurredAt - ISO timestamp recorded before the external call.
   * @returns Whether to send once or reconcile the already claimed operation.
   */
  claimManagedUpload(
    binding: CharacterReferenceQaBinding,
    idempotencyKey: string,
    occurredAt: string,
  ): CharacterReferenceQaClaimDecision {
    this.ensureOpen()
    assertIdempotencyKey(idempotencyKey)
    assertTimestamp(occurredAt, 'upload claim timestamp')
    return this.transaction(() => {
      const grant = this.requireActiveGrant(binding)
      const current = snapshot(grant, this.eventsFor(binding), this.recoveryEventsFor(binding))
      if (current.upload.idempotencyKey !== null) {
        if (current.upload.idempotencyKey !== idempotencyKey) {
          throw failure('idempotency-conflict', 'managed upload is already bound to a different idempotency key')
        }
        return {
          action: 'reconcile',
          state: requireStarted(current.upload.state),
          idempotencyKey,
          managedReferenceId: required(current.upload.managedReferenceId, 'managed reference id'),
        }
      }
      const managedReferenceId = randomUUID()
      this.insertEvent({
        binding,
        type: 'upload_claim',
        actorId: grant.actorId,
        occurredAt,
        idempotencyKey,
        managedReferenceId,
      })
      return { action: 'send', state: 'claimed', idempotencyKey, managedReferenceId }
    })
  }

  /**
   * Append successful managed-upload evidence for the already-claimed fixed key.
   * @param binding - Exact Host-reread authorization identity.
   * @param idempotencyKey - Fixed upload key claimed before the external call.
   * @param managedReferenceId - Host-private identifier allocated at claim time.
   * @param materialUri - Provider URI retained only in the private Host ledger.
   * @param imageSha256 - SHA-256 of the uploaded bytes.
   * @param receiptSha256 - SHA-256 of the provider receipt evidence.
   * @param occurredAt - ISO timestamp of settlement.
   */
  settleManagedUpload(
    binding: CharacterReferenceQaBinding,
    idempotencyKey: string,
    managedReferenceId: string,
    materialUri: string,
    imageSha256: string,
    receiptSha256: string,
    occurredAt: string,
  ): void {
    this.appendUploadTerminal({
      binding,
      idempotencyKey,
      managedReferenceId,
      type: 'upload_settle',
      materialUri,
      imageSha256,
      receiptSha256,
      occurredAt,
    })
  }

  /**
   * Append an unknown managed-upload outcome. Unknown outcomes block generation and all new upload keys.
   * @param binding - Exact Host-reread authorization identity.
   * @param idempotencyKey - Fixed upload key claimed before the external call.
   * @param managedReferenceId - Host-private identifier allocated at claim time.
   * @param receiptSha256 - Optional digest of partial response evidence.
   * @param occurredAt - ISO timestamp when the outcome became unknown.
   */
  markManagedUploadUnknown(
    binding: CharacterReferenceQaBinding,
    idempotencyKey: string,
    managedReferenceId: string,
    receiptSha256: string | null,
    occurredAt: string,
  ): void {
    this.appendUploadTerminal({
      binding,
      idempotencyKey,
      managedReferenceId,
      type: 'upload_unknown',
      receiptSha256,
      occurredAt,
    })
  }

  /**
   * Return the only settled managed reference, rejecting unknown or incomplete upload evidence.
   * @param binding - Exact Host-reread authorization identity.
   * @returns Settled provider URI and byte identity for the managed generation seam.
   */
  requireManagedReference(binding: CharacterReferenceQaBinding): CharacterReferenceQaManagedReference {
    const state = this.inspect(binding)
    if (state.revoked) throw failure('revoked', 'character-reference QA authorization is revoked')
    if (state.upload.state === 'unknown') {
      throw failure('unknown-outcome', 'managed upload outcome is unknown and must only be reconciled')
    }
    if (state.upload.state !== 'settled') {
      throw failure('invalid-transition', 'managed reference has not settled successfully')
    }
    return {
      managedReferenceId: required(state.upload.managedReferenceId, 'managed reference id'),
      materialUri: required(state.upload.materialUri, 'managed material URI'),
      imageSha256: required(state.upload.imageSha256, 'managed image SHA-256'),
    }
  }

  /**
   * Authorize the only pre-dispatch recovery after the trusted local send guard proves that
   * dispatch never began and a read-only provider snapshot observes no conflicting result.
   * The provider snapshot is corroborating evidence rather than an idempotency lookup. This
   * Host-only operation is idempotent for the same identity and evidence so a caller can safely
   * retry across a crash before a second ledger commits its corresponding resume event.
   * @param binding - Exact Host-reread authorization identity.
   * @param idempotencyKey - Original generation key whose outcome is unknown.
   * @param managedReferenceId - Original settled managed reference.
   * @param actorId - Operator identity; it must match the grant actor.
   * @param guardEvidenceSha256 - Digest of durable local pre-dispatch guard evidence.
   * @param reconciliationEvidenceSha256 - Digest of provider-side absence evidence.
   * @param occurredAt - ISO timestamp of the first authorization decision.
   * @param reason - Human-readable reason retained for audit.
   * @returns The existing or newly appended auditable recovery state.
   */
  authorizeGenerationPreDispatchRecovery(
    binding: CharacterReferenceQaBinding,
    idempotencyKey: string,
    managedReferenceId: string,
    actorId: string,
    guardEvidenceSha256: string,
    reconciliationEvidenceSha256: string,
    occurredAt: string,
    reason: string,
  ): CharacterReferenceQaGenerationRecoverySnapshot {
    this.ensureOpen()
    assertIdempotencyKey(idempotencyKey)
    assertText(managedReferenceId, 'managed reference id')
    assertText(actorId, 'recovery actor')
    assertSha256(guardEvidenceSha256, 'pre-dispatch guard evidence SHA-256')
    assertSha256(reconciliationEvidenceSha256, 'reconciliation evidence SHA-256')
    assertTimestamp(occurredAt, 'recovery authorization timestamp')
    assertText(reason, 'recovery authorization reason')
    return this.transaction(() => {
      const grant = this.requireActiveGrant(binding)
      if (actorId !== grant.actorId) {
        throw failure('binding-mismatch', 'pre-dispatch recovery actor does not match the authorization actor')
      }
      const current = snapshot(grant, this.eventsFor(binding), this.recoveryEventsFor(binding))
      if (current.generation.state !== 'unknown') {
        throw failure('invalid-transition', 'pre-dispatch recovery requires an unknown generation outcome')
      }
      const generationReceiptSha256 = current.generation.receiptSha256
      if (generationReceiptSha256 !== null
        && generationReceiptSha256 !== CHARACTER_REFERENCE_QA_LEGACY_SYNTHETIC_UNKNOWN_RECEIPT_SHA256) {
        throw failure('unknown-outcome', 'generation receipt contains possible provider evidence')
      }
      const normalizedReason = generationReceiptSha256 === null
        ? reason.trim()
        : `${reason.trim()} [legacy_synthetic_receipt_basis=${CHARACTER_REFERENCE_QA_LEGACY_SYNTHETIC_UNKNOWN_RECEIPT_BASIS}; legacy_synthetic_receipt_sha256=${CHARACTER_REFERENCE_QA_LEGACY_SYNTHETIC_UNKNOWN_RECEIPT_SHA256}]`
      assertClaim(current.generation, idempotencyKey, managedReferenceId, 'generation recovery')
      const recovery = current.generationRecovery
      if (recovery.state !== 'not_authorized') {
        if (
          recovery.actorId === actorId
          && recovery.idempotencyKey === idempotencyKey
          && recovery.managedReferenceId === managedReferenceId
          && recovery.guardEvidenceSha256 === guardEvidenceSha256
          && recovery.reconciliationEvidenceSha256 === reconciliationEvidenceSha256
          && recovery.reason === normalizedReason
        ) {
          return recovery
        }
        throw failure('already-consumed', 'generation recovery is already bound to different identity or evidence')
      }
      this.insertRecoveryEvent({
        binding,
        type: 'recovery_authorized',
        actorId,
        occurredAt,
        idempotencyKey,
        managedReferenceId,
        guardEvidenceSha256,
        reconciliationEvidenceSha256,
        reason: normalizedReason,
      })
      return generationRecoverySnapshot(this.recoveryEventsFor(binding))
    })
  }

  /**
   * Atomically consume the generation allowance before the paid request. A same-key
   * pre-dispatch recovery may return `send` once after its separate authorization is appended.
   * The returned managed reference is derived from settled Host evidence rather than Agent input.
   * @param binding - Exact Host-reread authorization identity.
   * @param idempotencyKey - Fixed key for the only generation attempt.
   * @param managedReferenceId - Settled managed upload selected for generation.
   * @param occurredAt - ISO timestamp recorded before the paid call.
   * @returns Whether to send or reconcile, together with the settled managed reference.
   */
  claimGeneration(
    binding: CharacterReferenceQaBinding,
    idempotencyKey: string,
    managedReferenceId: string,
    occurredAt: string,
  ): CharacterReferenceQaClaimDecision & { reference: CharacterReferenceQaManagedReference } {
    this.ensureOpen()
    assertIdempotencyKey(idempotencyKey)
    assertText(managedReferenceId, 'managed reference id')
    assertTimestamp(occurredAt, 'generation claim timestamp')
    return this.transaction(() => {
      const grant = this.requireActiveGrant(binding)
      const current = snapshot(grant, this.eventsFor(binding), this.recoveryEventsFor(binding))
      if (current.upload.state === 'unknown') {
        throw failure('unknown-outcome', 'managed upload outcome is unknown and cannot authorize generation')
      }
      if (current.upload.state !== 'settled') {
        throw failure('invalid-transition', 'generation requires one settled managed upload')
      }
      if (current.upload.managedReferenceId !== managedReferenceId) {
        throw failure('binding-mismatch', 'generation managed reference does not match the authorized upload')
      }
      const reference = {
        managedReferenceId,
        materialUri: required(current.upload.materialUri, 'managed material URI'),
        imageSha256: required(current.upload.imageSha256, 'managed image SHA-256'),
      }
      if (current.generation.idempotencyKey !== null) {
        if (current.generation.idempotencyKey !== idempotencyKey) {
          throw failure('already-consumed', 'single generation allowance is already bound to another idempotency key')
        }
        if (current.generation.managedReferenceId !== managedReferenceId) {
          throw failure('binding-mismatch', 'generation managed reference does not match the fixed claim')
        }
        if (current.generation.state === 'unknown' && current.generationRecovery.state === 'authorized') {
          assertRecoveryClaim(current.generationRecovery, idempotencyKey, managedReferenceId)
          this.insertRecoveryEvent({
            binding,
            type: 'recovery_claim',
            actorId: grant.actorId,
            occurredAt,
            idempotencyKey,
            managedReferenceId,
          })
          return { action: 'send', state: 'claimed', idempotencyKey, managedReferenceId, reference }
        }
        if (
          current.generation.state === 'unknown'
          && current.generationRecovery.state !== 'not_authorized'
          && current.generationRecovery.state !== 'authorized'
        ) {
          assertRecoveryClaim(current.generationRecovery, idempotencyKey, managedReferenceId)
          return {
            action: 'reconcile',
            state: current.generationRecovery.state,
            idempotencyKey,
            managedReferenceId,
            reference,
          }
        }
        return {
          action: 'reconcile',
          state: requireStarted(current.generation.state),
          idempotencyKey,
          managedReferenceId,
          reference,
        }
      }
      this.insertEvent({
        binding,
        type: 'generation_claim',
        actorId: grant.actorId,
        occurredAt,
        idempotencyKey,
        managedReferenceId,
      })
      return { action: 'send', state: 'claimed', idempotencyKey, managedReferenceId, reference }
    })
  }

  /**
   * Append a successful provider-generation receipt for the one claimed key.
   * @param binding - Exact Host-reread authorization identity.
   * @param idempotencyKey - Fixed generation key claimed before the paid call.
   * @param managedReferenceId - Settled managed upload used by the request.
   * @param receiptSha256 - SHA-256 of the accepted provider receipt.
   * @param occurredAt - ISO timestamp of settlement.
   */
  settleGeneration(
    binding: CharacterReferenceQaBinding,
    idempotencyKey: string,
    managedReferenceId: string,
    receiptSha256: string,
    occurredAt: string,
  ): void {
    this.appendGenerationTerminal({
      binding,
      idempotencyKey,
      managedReferenceId,
      type: 'generation_settle',
      receiptSha256,
      occurredAt,
    })
  }

  /**
   * Append an unknown provider-generation outcome. It can only be reconciled with the same key,
   * except for one separately evidenced and authorized pre-dispatch recovery.
   * @param binding - Exact Host-reread authorization identity.
   * @param idempotencyKey - Fixed generation key claimed before the paid call.
   * @param managedReferenceId - Settled managed upload used by the request.
   * @param receiptSha256 - Optional digest of partial response evidence.
   * @param occurredAt - ISO timestamp when the outcome became unknown.
   */
  markGenerationUnknown(
    binding: CharacterReferenceQaBinding,
    idempotencyKey: string,
    managedReferenceId: string,
    receiptSha256: string | null,
    occurredAt: string,
  ): void {
    this.appendGenerationTerminal({
      binding,
      idempotencyKey,
      managedReferenceId,
      type: 'generation_unknown',
      receiptSha256,
      occurredAt,
    })
  }

  /**
   * Read the immutable event history for operator audit.
   * @param binding - Exact Host-reread authorization identity.
   * @returns Ordered immutable audit events for the matching grant.
   */
  listEvents(binding: CharacterReferenceQaBinding): CharacterReferenceQaEvent[] {
    this.ensureOpen()
    this.requireMatchingGrant(binding)
    return this.eventsFor(binding)
  }

  /**
   * Read the separate append-only pre-dispatch recovery history for operator audit.
   * @param binding - Exact Host-reread authorization identity.
   * @returns Ordered immutable recovery events for the matching grant.
   */
  listGenerationRecoveryEvents(
    binding: CharacterReferenceQaBinding,
  ): CharacterReferenceQaGenerationRecoveryEvent[] {
    this.ensureOpen()
    this.requireMatchingGrant(binding)
    return this.recoveryEventsFor(binding)
  }

  private appendUploadTerminal(input: {
    binding: CharacterReferenceQaBinding
    idempotencyKey: string
    managedReferenceId: string
    type: 'upload_settle' | 'upload_unknown'
    materialUri?: string
    imageSha256?: string
    receiptSha256: string | null
    occurredAt: string
  }): void {
    this.ensureOpen()
    assertIdempotencyKey(input.idempotencyKey)
    assertText(input.managedReferenceId, 'managed reference id')
    assertTimestamp(input.occurredAt, 'upload terminal timestamp')
    if (input.type === 'upload_settle') {
      assertText(input.materialUri, 'managed material URI')
      assertSha256(input.imageSha256, 'managed image SHA-256')
      assertSha256(input.receiptSha256, 'upload receipt SHA-256')
    } else if (input.receiptSha256 !== null) {
      assertSha256(input.receiptSha256, 'upload receipt SHA-256')
    }
    this.transaction(() => {
      const grant = this.requireMatchingGrant(input.binding)
      const current = snapshot(
        grant,
        this.eventsFor(input.binding),
        this.recoveryEventsFor(input.binding),
      )
      assertClaim(current.upload, input.idempotencyKey, input.managedReferenceId, 'managed upload')
      if (current.upload.state !== 'claimed') {
        throw failure('invalid-transition', 'managed upload already has a terminal event')
      }
      if (input.type === 'upload_settle' && input.imageSha256 !== grant.imageSha256) {
        throw failure('binding-mismatch', 'managed upload SHA-256 differs from the authorized Catalog image')
      }
      this.insertEvent({
        binding: input.binding,
        type: input.type,
        actorId: grant.actorId,
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
        managedReferenceId: input.managedReferenceId,
        ...(input.materialUri === undefined ? {} : { materialUri: input.materialUri }),
        ...(input.imageSha256 === undefined ? {} : { imageSha256: input.imageSha256 }),
        receiptSha256: input.receiptSha256,
      })
    })
  }

  private appendGenerationTerminal(input: {
    binding: CharacterReferenceQaBinding
    idempotencyKey: string
    managedReferenceId: string
    type: 'generation_settle' | 'generation_unknown'
    receiptSha256: string | null
    occurredAt: string
  }): void {
    this.ensureOpen()
    assertIdempotencyKey(input.idempotencyKey)
    assertText(input.managedReferenceId, 'managed reference id')
    assertTimestamp(input.occurredAt, 'generation terminal timestamp')
    if (input.receiptSha256 !== null) assertSha256(input.receiptSha256, 'generation receipt SHA-256')
    else if (input.type === 'generation_settle') invalidGrant('generation receipt SHA-256 is required on settlement')
    this.transaction(() => {
      const grant = this.requireMatchingGrant(input.binding)
      const current = snapshot(
        grant,
        this.eventsFor(input.binding),
        this.recoveryEventsFor(input.binding),
      )
      assertClaim(current.generation, input.idempotencyKey, input.managedReferenceId, 'generation')
      if (current.generation.state === 'unknown' && current.generationRecovery.state === 'claimed') {
        assertRecoveryClaim(current.generationRecovery, input.idempotencyKey, input.managedReferenceId)
        this.insertRecoveryEvent({
          binding: input.binding,
          type: input.type === 'generation_settle' ? 'recovery_settle' : 'recovery_unknown',
          actorId: grant.actorId,
          occurredAt: input.occurredAt,
          idempotencyKey: input.idempotencyKey,
          managedReferenceId: input.managedReferenceId,
          receiptSha256: input.receiptSha256,
        })
        return
      }
      if (current.generation.state !== 'claimed') {
        throw failure('invalid-transition', 'generation already has a terminal event')
      }
      this.insertEvent({
        binding: input.binding,
        type: input.type,
        actorId: grant.actorId,
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
        managedReferenceId: input.managedReferenceId,
        receiptSha256: input.receiptSha256,
      })
    })
  }

  private requireActiveGrant(binding: CharacterReferenceQaBinding): CharacterReferenceQaGrant {
    const grant = this.requireMatchingGrant(binding)
    if (this.eventsFor(binding).some(event => event.type === 'revoke')) {
      throw failure('revoked', 'character-reference QA authorization is revoked')
    }
    return grant
  }

  private requireMatchingGrant(binding: CharacterReferenceQaBinding): CharacterReferenceQaGrant {
    assertBinding(binding)
    const row = this.db.prepare(`
      SELECT * FROM character_reference_qa_authorizations
      WHERE authorization_id = ? AND authorization_version = ?
    `).get(binding.authorizationId, binding.authorizationVersion)
    if (row === undefined) {
      throw failure('missing-authorization', 'character-reference QA authorization was not found')
    }
    const grant = grantFromRow(row)
    if (grant.environment !== this.environment) {
      throw failure('binding-mismatch', 'authorization belongs to another Host authorization environment')
    }
    if (
      grant.projectId !== binding.projectId
      || grant.characterId !== binding.characterId
      || grant.roleClass !== binding.roleClass
      || grant.catalogId !== binding.catalogId
      || grant.imageSha256 !== binding.imageSha256
    ) {
      throw failure('binding-mismatch', 'current project, role, Catalog identity, SHA, or status differs from the authorization')
    }
    return grant
  }

  private eventsFor(binding: CharacterReferenceQaBinding): CharacterReferenceQaEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM character_reference_qa_events
      WHERE authorization_id = ? AND authorization_version = ?
      ORDER BY sequence
    `).all(binding.authorizationId, binding.authorizationVersion)
    return rows.map(eventFromRow)
  }

  private recoveryEventsFor(
    binding: CharacterReferenceQaBinding,
  ): CharacterReferenceQaGenerationRecoveryEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM character_reference_qa_generation_recovery_events
      WHERE authorization_id = ? AND authorization_version = ?
      ORDER BY sequence
    `).all(binding.authorizationId, binding.authorizationVersion)
    return rows.map(recoveryEventFromRow)
  }

  private insertEvent(input: {
    binding: CharacterReferenceQaBinding
    type: CharacterReferenceQaEventType
    actorId: string
    occurredAt: string
    idempotencyKey?: string
    managedReferenceId?: string
    materialUri?: string
    imageSha256?: string
    receiptSha256?: string | null
    note?: string
  }): void {
    this.db.prepare(`
      INSERT INTO character_reference_qa_events (
        authorization_id, authorization_version, event_type, actor_id, occurred_at,
        idempotency_key, managed_reference_id, material_uri, image_sha256, receipt_sha256, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.binding.authorizationId,
      input.binding.authorizationVersion,
      input.type,
      input.actorId,
      input.occurredAt,
      input.idempotencyKey ?? null,
      input.managedReferenceId ?? null,
      input.materialUri ?? null,
      input.imageSha256 ?? null,
      input.receiptSha256 ?? null,
      input.note ?? null,
    )
  }

  private insertRecoveryEvent(input: {
    binding: CharacterReferenceQaBinding
    type: CharacterReferenceQaGenerationRecoveryEventType
    actorId: string
    occurredAt: string
    idempotencyKey: string
    managedReferenceId: string
    guardEvidenceSha256?: string
    reconciliationEvidenceSha256?: string
    receiptSha256?: string | null
    reason?: string
  }): void {
    this.db.prepare(`
      INSERT INTO character_reference_qa_generation_recovery_events (
        authorization_id, authorization_version, event_type, actor_id, occurred_at,
        idempotency_key, managed_reference_id, guard_evidence_sha256,
        reconciliation_evidence_sha256, receipt_sha256, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.binding.authorizationId,
      input.binding.authorizationVersion,
      input.type,
      input.actorId,
      input.occurredAt,
      input.idempotencyKey,
      input.managedReferenceId,
      input.guardEvidenceSha256 ?? null,
      input.reconciliationEvidenceSha256 ?? null,
      input.receiptSha256 ?? null,
      input.reason ?? null,
    )
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* the original failure remains authoritative */ }
      throw error
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw failure('invalid-config', 'character-reference QA authorization store is closed')
  }
}

function openDatabase(path: string, environment: CharacterReferenceEnvironment): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    const applicationId = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id
    const schemaVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    ).all() as Array<{ name: string }>).map(row => row.name)
    if (applicationId !== 0 && applicationId !== CHARACTER_REFERENCE_QA_APPLICATION_ID) {
      throw failure('foreign-database', `QA authorization database at "${path}" belongs to another application`)
    }
    if (applicationId === 0 && tables.length > 0) {
      throw failure('foreign-database', `QA authorization database at "${path}" is not empty or recognized`)
    }
    if (applicationId === CHARACTER_REFERENCE_QA_APPLICATION_ID) {
      if (schemaVersion === 1) assertExactTables(tables, V1_TABLES, schemaVersion)
      else if (schemaVersion === 2) assertExactTables(tables, V2_TABLES, schemaVersion)
      else throw failure('foreign-database', `QA authorization database schema ${schemaVersion} is unsupported`)
    }
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 1000')
    db.exec('PRAGMA journal_mode = WAL')
    if (applicationId === 0) createFreshSchemaV2(db, environment)
    else if (schemaVersion === 1) migrateSchemaV1ToV2(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function assertExactTables(tables: readonly string[], expected: ReadonlySet<string>, schemaVersion: number): void {
  const unexpected = tables.filter(table => !expected.has(table))
  const missing = [...expected].filter(table => !tables.includes(table))
  if (unexpected.length > 0 || missing.length > 0) {
    throw failure(
      'foreign-database',
      `QA authorization database schema ${schemaVersion} has invalid tables`
      + ` (unexpected: ${unexpected.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`,
    )
  }
}

function createFreshSchemaV2(db: DatabaseSync, environment: CharacterReferenceEnvironment): void {
  const scope = environment === CHARACTER_REFERENCE_QA_ENVIRONMENT
    ? CHARACTER_REFERENCE_QA_SCOPE : CHARACTER_REFERENCE_PRIVATE_SCOPE
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`PRAGMA application_id = ${CHARACTER_REFERENCE_QA_APPLICATION_ID}`)
    db.exec(`
    CREATE TABLE IF NOT EXISTS character_reference_qa_authorizations (
      authorization_id          TEXT NOT NULL,
      authorization_version     INTEGER NOT NULL CHECK (authorization_version > 0),
      environment               TEXT NOT NULL CHECK (environment = '${environment}'),
      actor_id                  TEXT NOT NULL,
      reviewer_id               TEXT NOT NULL,
      source_declaration        TEXT NOT NULL,
      project_id                INTEGER NOT NULL CHECK (project_id > 0),
      character_id              TEXT NOT NULL,
      role_class                TEXT NOT NULL CHECK (role_class IN ('lead', 'important_support', 'support', 'extra')),
      catalog_id                TEXT NOT NULL,
      image_sha256              TEXT NOT NULL,
      catalog_status            TEXT NOT NULL CHECK (catalog_status = 'pending_review'),
      scope                     TEXT NOT NULL CHECK (scope = '${scope}'),
      max_generation_uses       INTEGER NOT NULL CHECK (max_generation_uses = 1),
      allow_publish             INTEGER NOT NULL CHECK (allow_publish = 0),
      allow_formal_bind         INTEGER NOT NULL CHECK (allow_formal_bind = 0),
      allow_cross_project_reuse INTEGER NOT NULL CHECK (allow_cross_project_reuse = 0),
      production_approved       INTEGER NOT NULL CHECK (production_approved = 0),
      created_at                TEXT NOT NULL,
      PRIMARY KEY (authorization_id, authorization_version)
    ) STRICT
  `)
    db.exec(`
    CREATE TABLE IF NOT EXISTS character_reference_qa_events (
      sequence              INTEGER PRIMARY KEY AUTOINCREMENT,
      authorization_id      TEXT NOT NULL,
      authorization_version INTEGER NOT NULL,
      event_type            TEXT NOT NULL CHECK (event_type IN (
        'grant', 'revoke', 'upload_claim', 'upload_settle', 'upload_unknown',
        'generation_claim', 'generation_settle', 'generation_unknown'
      )),
      actor_id              TEXT NOT NULL,
      occurred_at           TEXT NOT NULL,
      idempotency_key       TEXT,
      managed_reference_id  TEXT,
      material_uri          TEXT,
      image_sha256          TEXT,
      receipt_sha256        TEXT,
      note                  TEXT,
      FOREIGN KEY (authorization_id, authorization_version)
        REFERENCES character_reference_qa_authorizations (authorization_id, authorization_version)
    ) STRICT
  `)
    db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS character_reference_qa_one_grant
    ON character_reference_qa_events (authorization_id, authorization_version)
    WHERE event_type = 'grant'
  `)
    db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS character_reference_qa_one_revoke
    ON character_reference_qa_events (authorization_id, authorization_version)
    WHERE event_type = 'revoke'
  `)
    db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS character_reference_qa_one_upload_claim
    ON character_reference_qa_events (authorization_id, authorization_version)
    WHERE event_type = 'upload_claim'
  `)
    db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS character_reference_qa_one_upload_terminal
    ON character_reference_qa_events (authorization_id, authorization_version)
    WHERE event_type IN ('upload_settle', 'upload_unknown')
  `)
    db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS character_reference_qa_one_generation_claim
    ON character_reference_qa_events (authorization_id, authorization_version)
    WHERE event_type = 'generation_claim'
  `)
    db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS character_reference_qa_one_generation_terminal
    ON character_reference_qa_events (authorization_id, authorization_version)
    WHERE event_type IN ('generation_settle', 'generation_unknown')
  `)
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS character_reference_qa_authorizations_no_update
    BEFORE UPDATE ON character_reference_qa_authorizations
    BEGIN SELECT RAISE(ABORT, 'character-reference QA grants are append-only'); END
  `)
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS character_reference_qa_authorizations_no_delete
    BEFORE DELETE ON character_reference_qa_authorizations
    BEGIN SELECT RAISE(ABORT, 'character-reference QA grants are append-only'); END
  `)
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS character_reference_qa_events_no_update
    BEFORE UPDATE ON character_reference_qa_events
    BEGIN SELECT RAISE(ABORT, 'character-reference QA events are append-only'); END
  `)
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS character_reference_qa_events_no_delete
    BEFORE DELETE ON character_reference_qa_events
    BEGIN SELECT RAISE(ABORT, 'character-reference QA events are append-only'); END
  `)
    createGenerationRecoverySchema(db)
    db.exec(`PRAGMA user_version = ${CHARACTER_REFERENCE_QA_SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* the original failure remains authoritative */ }
    throw error
  }
}

function migrateSchemaV1ToV2(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    createGenerationRecoverySchema(db)
    db.exec(`PRAGMA user_version = ${CHARACTER_REFERENCE_QA_SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* the original failure remains authoritative */ }
    throw error
  }
}

function createGenerationRecoverySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_reference_qa_generation_recovery_events (
      sequence                       INTEGER PRIMARY KEY AUTOINCREMENT,
      authorization_id               TEXT NOT NULL,
      authorization_version          INTEGER NOT NULL,
      event_type                     TEXT NOT NULL CHECK (event_type IN (
        'recovery_authorized', 'recovery_claim', 'recovery_settle', 'recovery_unknown'
      )),
      actor_id                       TEXT NOT NULL,
      occurred_at                    TEXT NOT NULL,
      idempotency_key                TEXT NOT NULL,
      managed_reference_id           TEXT NOT NULL,
      guard_evidence_sha256           TEXT,
      reconciliation_evidence_sha256  TEXT,
      receipt_sha256                  TEXT,
      reason                          TEXT,
      CHECK (
        (event_type = 'recovery_authorized'
          AND guard_evidence_sha256 IS NOT NULL
          AND reconciliation_evidence_sha256 IS NOT NULL
          AND receipt_sha256 IS NULL
          AND reason IS NOT NULL)
        OR (event_type = 'recovery_claim'
          AND guard_evidence_sha256 IS NULL
          AND reconciliation_evidence_sha256 IS NULL
          AND receipt_sha256 IS NULL
          AND reason IS NULL)
        OR (event_type = 'recovery_settle'
          AND guard_evidence_sha256 IS NULL
          AND reconciliation_evidence_sha256 IS NULL
          AND receipt_sha256 IS NOT NULL
          AND reason IS NULL)
        OR (event_type = 'recovery_unknown'
          AND guard_evidence_sha256 IS NULL
          AND reconciliation_evidence_sha256 IS NULL
          AND reason IS NULL)
      ),
      FOREIGN KEY (authorization_id, authorization_version)
        REFERENCES character_reference_qa_authorizations (authorization_id, authorization_version)
    ) STRICT
  `)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS character_reference_qa_one_recovery_authorization
    ON character_reference_qa_generation_recovery_events (authorization_id, authorization_version)
    WHERE event_type = 'recovery_authorized'
  `)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS character_reference_qa_one_recovery_claim
    ON character_reference_qa_generation_recovery_events (authorization_id, authorization_version)
    WHERE event_type = 'recovery_claim'
  `)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS character_reference_qa_one_recovery_terminal
    ON character_reference_qa_generation_recovery_events (authorization_id, authorization_version)
    WHERE event_type IN ('recovery_settle', 'recovery_unknown')
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS character_reference_qa_generation_recovery_events_no_update
    BEFORE UPDATE ON character_reference_qa_generation_recovery_events
    BEGIN SELECT RAISE(ABORT, 'character-reference QA recovery events are append-only'); END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS character_reference_qa_generation_recovery_events_no_delete
    BEFORE DELETE ON character_reference_qa_generation_recovery_events
    BEGIN SELECT RAISE(ABORT, 'character-reference QA recovery events are append-only'); END
  `)
}

function assertGrant(grant: CharacterReferenceQaGrantInput): asserts grant is CharacterReferenceQaGrant {
  assertText(grant.authorizationId, 'authorization id')
  if (!Number.isSafeInteger(grant.authorizationVersion) || grant.authorizationVersion <= 0) {
    throw failure('invalid-grant', 'authorization version must be a positive safe integer')
  }
  if (grant.environment !== CHARACTER_REFERENCE_QA_ENVIRONMENT
    && grant.environment !== CHARACTER_REFERENCE_PRIVATE_ENVIRONMENT) {
    invalidGrant('environment must be isolated_qa or project_private')
  }
  assertText(grant.actorId, 'actor id')
  if (grant.environment === CHARACTER_REFERENCE_PRIVATE_ENVIRONMENT) privateAccountFromActor(grant.actorId)
  assertText(grant.reviewerId, 'reviewer id')
  assertText(grant.sourceDeclaration, 'source declaration')
  if (!Number.isSafeInteger(grant.projectId) || grant.projectId <= 0) invalidGrant('project id must be positive')
  assertText(grant.characterId, 'character id')
  assertRoleClass(grant.roleClass)
  assertText(grant.catalogId, 'Catalog id')
  assertSha256(grant.imageSha256, 'image SHA-256')
  if (grant.catalogStatus !== 'pending_review') invalidGrant('grant must retain pending_review status')
  if (grant.scope !== (grant.environment === CHARACTER_REFERENCE_QA_ENVIRONMENT
    ? CHARACTER_REFERENCE_QA_SCOPE : CHARACTER_REFERENCE_PRIVATE_SCOPE)) {
    invalidGrant('authorization scope does not match its one-shot environment')
  }
  if (grant.maxGenerationUses !== 1) invalidGrant('authorization must allow exactly one generation')
  if (grant.allowPublish || grant.allowFormalBind || grant.allowCrossProjectReuse || grant.productionApproved) {
    invalidGrant('pending-review authorization cannot publish, formally bind, cross projects, or approve public use')
  }
  assertTimestamp(grant.createdAt, 'grant timestamp')
}

function privateAccountFromActor(actorId: string): string {
  let identity: unknown
  try { identity = JSON.parse(actorId) } catch { invalidGrant('private actor must be a verified account and Session pair') }
  if (!Array.isArray(identity) || identity.length !== 2
    || typeof identity[0] !== 'string' || !identity[0].trim()
    || typeof identity[1] !== 'string' || !identity[1].trim()) {
    invalidGrant('private actor must be a verified account and Session pair')
  }
  return identity[0]
}

function assertBinding(binding: CharacterReferenceQaBinding): void {
  assertText(binding.authorizationId, 'authorization id')
  if (!Number.isSafeInteger(binding.authorizationVersion) || binding.authorizationVersion <= 0) {
    throw failure('binding-mismatch', 'authorization version must be a positive safe integer')
  }
  if (!Number.isSafeInteger(binding.projectId) || binding.projectId <= 0) {
    throw failure('binding-mismatch', 'project id must be positive')
  }
  assertText(binding.characterId, 'character id')
  assertRoleClass(binding.roleClass)
  assertText(binding.catalogId, 'Catalog id')
  assertSha256(binding.imageSha256, 'image SHA-256')
}

function assertText(value: string | undefined, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalidGrant(`${label} must be a non-empty control-free string`)
  }
}

function assertIdempotencyKey(value: string): void {
  assertText(value, 'idempotency key')
  if (value.length > 200) invalidGrant('idempotency key is too long')
}

function assertRoleClass(value: string): asserts value is CharacterReferenceQaRoleClass {
  switch (value) {
    case 'lead':
    case 'important_support':
    case 'support':
    case 'extra':
      return
    default:
      invalidGrant('role class must be lead, important_support, support, or extra')
  }
}

function assertSha256(value: string | null | undefined, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) invalidGrant(`${label} must be 64 lowercase hexadecimal characters`)
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) invalidGrant(`${label} must be an ISO-compatible timestamp`)
}

function invalidGrant(message: string): never {
  throw failure('invalid-grant', message)
}

function bindingFromGrant(grant: CharacterReferenceQaGrant): CharacterReferenceQaBinding {
  return {
    authorizationId: grant.authorizationId,
    authorizationVersion: grant.authorizationVersion,
    projectId: grant.projectId,
    characterId: grant.characterId,
    roleClass: grant.roleClass,
    catalogId: grant.catalogId,
    imageSha256: grant.imageSha256,
    catalogStatus: grant.catalogStatus,
  }
}

function grantFromRow(row: Record<string, SQLOutputValue>): CharacterReferenceQaGrant {
  return {
    authorizationId: dbString(row, 'authorization_id'),
    authorizationVersion: dbInteger(row, 'authorization_version'),
    environment: dbString(row, 'environment') as CharacterReferenceEnvironment,
    actorId: dbString(row, 'actor_id'),
    reviewerId: dbString(row, 'reviewer_id'),
    sourceDeclaration: dbString(row, 'source_declaration'),
    projectId: dbInteger(row, 'project_id'),
    characterId: dbString(row, 'character_id'),
    roleClass: roleClassFromRow(dbString(row, 'role_class')),
    catalogId: dbString(row, 'catalog_id'),
    imageSha256: dbString(row, 'image_sha256'),
    catalogStatus: dbString(row, 'catalog_status') as 'pending_review',
    scope: dbString(row, 'scope') as typeof CHARACTER_REFERENCE_QA_SCOPE | typeof CHARACTER_REFERENCE_PRIVATE_SCOPE,
    maxGenerationUses: dbInteger(row, 'max_generation_uses') as 1,
    allowPublish: Boolean(dbInteger(row, 'allow_publish')) as false,
    allowFormalBind: Boolean(dbInteger(row, 'allow_formal_bind')) as false,
    allowCrossProjectReuse: Boolean(dbInteger(row, 'allow_cross_project_reuse')) as false,
    productionApproved: Boolean(dbInteger(row, 'production_approved')) as false,
    createdAt: dbString(row, 'created_at'),
  }
}

function eventFromRow(row: Record<string, SQLOutputValue>): CharacterReferenceQaEvent {
  return {
    sequence: dbInteger(row, 'sequence'),
    authorizationId: dbString(row, 'authorization_id'),
    authorizationVersion: dbInteger(row, 'authorization_version'),
    type: dbEventType(row, 'event_type'),
    actorId: dbString(row, 'actor_id'),
    occurredAt: dbString(row, 'occurred_at'),
    idempotencyKey: dbNullableString(row, 'idempotency_key'),
    managedReferenceId: dbNullableString(row, 'managed_reference_id'),
    materialUri: dbNullableString(row, 'material_uri'),
    imageSha256: dbNullableString(row, 'image_sha256'),
    receiptSha256: dbNullableString(row, 'receipt_sha256'),
    note: dbNullableString(row, 'note'),
  }
}

function recoveryEventFromRow(
  row: Record<string, SQLOutputValue>,
): CharacterReferenceQaGenerationRecoveryEvent {
  return {
    sequence: dbInteger(row, 'sequence'),
    authorizationId: dbString(row, 'authorization_id'),
    authorizationVersion: dbInteger(row, 'authorization_version'),
    type: dbRecoveryEventType(row, 'event_type'),
    actorId: dbString(row, 'actor_id'),
    occurredAt: dbString(row, 'occurred_at'),
    idempotencyKey: dbString(row, 'idempotency_key'),
    managedReferenceId: dbString(row, 'managed_reference_id'),
    guardEvidenceSha256: dbNullableString(row, 'guard_evidence_sha256'),
    reconciliationEvidenceSha256: dbNullableString(row, 'reconciliation_evidence_sha256'),
    receiptSha256: dbNullableString(row, 'receipt_sha256'),
    reason: dbNullableString(row, 'reason'),
  }
}

function roleClassFromRow(value: string): CharacterReferenceQaRoleClass {
  switch (value) {
    case 'lead':
    case 'important_support':
    case 'support':
    case 'extra':
      return value
    default:
      throw failure('foreign-database', 'QA authorization row has an invalid role class')
  }
}

function dbString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw failure('foreign-database', `QA authorization row has invalid ${key}`)
  return value
}

function dbNullableString(row: Record<string, SQLOutputValue>, key: string): string | null {
  const value = row[key]
  if (value === null) return null
  if (typeof value !== 'string') throw failure('foreign-database', `QA authorization row has invalid ${key}`)
  return value
}

function dbInteger(row: Record<string, SQLOutputValue>, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw failure('foreign-database', `QA authorization row has invalid ${key}`)
  }
  return value
}

function dbEventType(row: Record<string, SQLOutputValue>, key: string): CharacterReferenceQaEventType {
  const value = dbString(row, key)
  switch (value) {
    case 'grant':
    case 'revoke':
    case 'upload_claim':
    case 'upload_settle':
    case 'upload_unknown':
    case 'generation_claim':
    case 'generation_settle':
    case 'generation_unknown':
      return value
    default:
      throw failure('foreign-database', `QA authorization row has invalid ${key}`)
  }
}

function dbRecoveryEventType(
  row: Record<string, SQLOutputValue>,
  key: string,
): CharacterReferenceQaGenerationRecoveryEventType {
  const value = dbString(row, key)
  switch (value) {
    case 'recovery_authorized':
    case 'recovery_claim':
    case 'recovery_settle':
    case 'recovery_unknown':
      return value
    default:
      throw failure('foreign-database', `QA authorization recovery row has invalid ${key}`)
  }
}

function snapshot(
  grant: CharacterReferenceQaGrant,
  events: readonly CharacterReferenceQaEvent[],
  recoveryEvents: readonly CharacterReferenceQaGenerationRecoveryEvent[],
): CharacterReferenceQaSnapshot {
  const uploadClaim = events.find(event => event.type === 'upload_claim')
  const uploadTerminal = events.find(event => event.type === 'upload_settle' || event.type === 'upload_unknown')
  const generationClaim = events.find(event => event.type === 'generation_claim')
  const generationTerminal = events.find(
    event => event.type === 'generation_settle' || event.type === 'generation_unknown',
  )
  return {
    grant,
    revoked: events.some(event => event.type === 'revoke'),
    upload: {
      state: operationState(uploadClaim, uploadTerminal),
      idempotencyKey: uploadClaim?.idempotencyKey ?? null,
      managedReferenceId: uploadClaim?.managedReferenceId ?? null,
      materialUri: uploadTerminal?.type === 'upload_settle' ? uploadTerminal.materialUri : null,
      imageSha256: uploadTerminal?.type === 'upload_settle' ? uploadTerminal.imageSha256 : null,
    },
    generation: {
      state: operationState(generationClaim, generationTerminal),
      idempotencyKey: generationClaim?.idempotencyKey ?? null,
      managedReferenceId: generationClaim?.managedReferenceId ?? null,
      receiptSha256: generationTerminal?.receiptSha256 ?? null,
    },
    generationRecovery: generationRecoverySnapshot(recoveryEvents),
  }
}

function generationRecoverySnapshot(
  events: readonly CharacterReferenceQaGenerationRecoveryEvent[],
): CharacterReferenceQaGenerationRecoverySnapshot {
  const authorization = events.find(event => event.type === 'recovery_authorized')
  const claim = events.find(event => event.type === 'recovery_claim')
  const terminal = events.find(event => event.type === 'recovery_settle' || event.type === 'recovery_unknown')
  let state: CharacterReferenceQaGenerationRecoveryState = 'not_authorized'
  if (terminal?.type === 'recovery_unknown') state = 'unknown'
  else if (terminal?.type === 'recovery_settle') state = 'settled'
  else if (claim !== undefined) state = 'claimed'
  else if (authorization !== undefined) state = 'authorized'
  return {
    state,
    actorId: authorization?.actorId ?? null,
    authorizedAt: authorization?.occurredAt ?? null,
    idempotencyKey: authorization?.idempotencyKey ?? null,
    managedReferenceId: authorization?.managedReferenceId ?? null,
    guardEvidenceSha256: authorization?.guardEvidenceSha256 ?? null,
    reconciliationEvidenceSha256: authorization?.reconciliationEvidenceSha256 ?? null,
    reason: authorization?.reason ?? null,
    receiptSha256: terminal?.receiptSha256 ?? null,
  }
}

function operationState(
  claim: CharacterReferenceQaEvent | undefined,
  terminal: CharacterReferenceQaEvent | undefined,
): CharacterReferenceQaOperationState {
  if (terminal?.type.endsWith('_unknown')) return 'unknown'
  if (terminal?.type.endsWith('_settle')) return 'settled'
  if (claim !== undefined) return 'claimed'
  return 'not_started'
}

function assertClaim(
  state: { idempotencyKey: string | null; managedReferenceId: string | null },
  idempotencyKey: string,
  managedReferenceId: string,
  label: string,
): void {
  if (state.idempotencyKey === null) throw failure('invalid-transition', `${label} has not been claimed`)
  if (state.idempotencyKey !== idempotencyKey) {
    throw failure('idempotency-conflict', `${label} idempotency key does not match the fixed claim`)
  }
  if (state.managedReferenceId !== managedReferenceId) {
    throw failure('binding-mismatch', `${label} managed reference id does not match the claim`)
  }
}

function assertRecoveryClaim(
  state: CharacterReferenceQaGenerationRecoverySnapshot,
  idempotencyKey: string,
  managedReferenceId: string,
): void {
  if (state.idempotencyKey !== idempotencyKey) {
    throw failure('idempotency-conflict', 'generation recovery key does not match its authorization')
  }
  if (state.managedReferenceId !== managedReferenceId) {
    throw failure('binding-mismatch', 'generation recovery managed reference does not match its authorization')
  }
}

function requireStarted(state: CharacterReferenceQaOperationState): Exclude<CharacterReferenceQaOperationState, 'not_started'> {
  if (state === 'not_started') throw failure('invalid-transition', 'operation has not started')
  return state
}

function required(value: string | null, label: string): string {
  if (value === null) throw failure('invalid-transition', `${label} is missing from append-only evidence`)
  return value
}

function failure(
  code: CharacterReferenceQaAuthorizationErrorCode,
  message: string,
  cause?: unknown,
): CharacterReferenceQaAuthorizationError {
  return new CharacterReferenceQaAuthorizationError(code, message, cause === undefined ? undefined : { cause })
}
