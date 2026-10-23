/** Host-only bridge from an authorized Catalog image to one Jubian QA generation. */
import { alignedReferenceSize, readReferenceImage, stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import type { JubianLedger } from '@deepseek-ai/dsh-jubian'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  AuthoritativeCharacterReference,
  CharacterReferenceAuthority,
} from '@deepseek-ai/dsh-tool-character-reference'
import {
  CHARACTER_REFERENCE_QA_LEGACY_SYNTHETIC_UNKNOWN_RECEIPT_SHA256,
  type CharacterReferenceQaAuthorizationStore,
  type CharacterReferenceQaBinding,
  type CharacterReferenceEnvironment,
} from './character-reference-qa-authorization.ts'
import {
  type ReferenceUploadDeps,
  uploadReferenceBytes,
} from './reference.ts'

/** Untrusted identities accepted by the managed-upload entry point. Paths and URLs are absent. */
export interface CharacterReferenceQaUploadRequest {
  readonly authorizationId: string
  readonly authorizationVersion: number
  readonly scriptId: number
  readonly characterId: string
  readonly catalogAssetId: string
  readonly imageSha256: string
  readonly idempotencyKey: string
}

/** Model-safe managed reference identity. The provider material URL stays Host-private. */
export interface CharacterReferenceQaUploadResult extends Record<string, unknown> {
  readonly authorization_id: string
  readonly authorization_version: number
  readonly managed_reference_id: string
  readonly script_id: number
  readonly character_id: string
  readonly role_class: CharacterReferenceQaBinding['roleClass']
  readonly catalog_asset_id: string
  readonly image_sha256: string
  readonly catalog_status: 'pending_review'
}

/** Exact identities accepted before preparing one paid generation. URLs remain absent. */
export interface CharacterReferenceQaGenerationRequest extends Omit<CharacterReferenceQaUploadRequest, 'idempotencyKey'> {
  readonly managedReferenceId: string
  readonly idempotencyKey: string
}

/**
 * Host-private generation preparation. `materialUri` must only be injected into the provider request.
 * It must never be returned by a Tool or accepted from model input.
 */
export interface CharacterReferenceQaGenerationPreparation {
  readonly authorizationEnvironment: CharacterReferenceEnvironment
  readonly authorizationId: string
  readonly authorizationVersion: number
  readonly managedReferenceId: string
  readonly materialUri: string
  readonly scriptId: number
  readonly characterId: string
  readonly characterName: string
  readonly roleClass: CharacterReferenceQaBinding['roleClass']
  readonly catalogAssetId: string
  readonly imageSha256: string
  /** Host-private proof authorizing recovery of one request blocked before dispatch. */
  readonly preDispatchRecovery?: CharacterReferenceQaPreDispatchRecoveryEvidence | undefined
  /** Re-read current Host authority and atomically consume the one-shot allowance before budget reservation. */
  readonly beforeReserve: () => Promise<void>
  /** Append a successful provider receipt without exposing it to the model. */
  readonly settleAccepted: (receipt: unknown) => void
  /** Preserve an unknown provider outcome and block every later send. */
  readonly settleUnknown: (receipt?: unknown) => void
  /** Reconcile the exact recorded Jubian-ledger result without another provider request. */
  readonly reconcileRecorded: (outcome: 'accepted' | 'unknown', receipt: unknown) => Promise<void>
}

/** Immutable evidence bound to one Host-authorized pre-dispatch recovery. */
export interface CharacterReferenceQaPreDispatchRecoveryEvidence {
  readonly actor: string
  readonly guardEvidenceSha256: string
  readonly reconciliationEvidenceSha256: string
}

/** Exact Host-only input for recording one audited pre-dispatch recovery. */
export interface CharacterReferenceQaPreDispatchRecoveryRequest
  extends CharacterReferenceQaPreDispatchRecoveryEvidence {
  readonly binding: CharacterReferenceQaBinding
  readonly idempotencyKey: string
  readonly managedReferenceId: string
  readonly recordId: string
  readonly requestSha256: string
  readonly occurredAt: string
  readonly reason: string
}

/**
 * Record matching generic-ledger and QA-ledger proof for a request blocked before dispatch.
 * This Host-only operation never calls the provider and never accepts Agent-supplied paths or URLs.
 * @param ledger - Generic append-only provider-write ledger.
 * @param store - Isolated QA authorization ledger.
 * @param request - Exact original identity and trusted evidence digests.
 * @returns The resulting generic and QA recovery states.
 */
export async function authorizeCharacterReferenceQaPreDispatchRecovery(
  ledger: JubianLedger,
  store: CharacterReferenceQaAuthorizationStore,
  request: CharacterReferenceQaPreDispatchRecoveryRequest,
): Promise<{ ledgerOutcome: 'not_sent'; qaState: 'authorized' }> {
  if (!/^[a-f0-9]{64}$/u.test(request.guardEvidenceSha256)
    || !/^[a-f0-9]{64}$/u.test(request.reconciliationEvidenceSha256)
    || !request.reason.trim()
    || !Number.isFinite(Date.parse(request.occurredAt))) {
    throw new Error('Character-reference QA pre-dispatch recovery evidence is malformed.')
  }
  const current = store.inspect(request.binding)
  if (current.revoked) throw new Error('Character-reference QA authorization is revoked.')
  if (current.grant.actorId !== request.actor
    || current.generation.state !== 'unknown'
    || (current.generation.receiptSha256 !== null
      && current.generation.receiptSha256 !== CHARACTER_REFERENCE_QA_LEGACY_SYNTHETIC_UNKNOWN_RECEIPT_SHA256)
    || current.generation.idempotencyKey !== request.idempotencyKey
    || current.generation.managedReferenceId !== request.managedReferenceId) {
    throw new Error('Character-reference QA pre-dispatch recovery conflicts with current Host evidence.')
  }
  const recorded = await ledger.find(request.idempotencyKey)
  if (recorded === undefined
    || recorded.record_id !== request.recordId
    || recorded.method !== 'image_generate'
    || recorded.script_id !== request.binding.projectId
    || recorded.request_sha256 !== request.requestSha256
    || (recorded.outcome !== 'unknown' && recorded.outcome !== 'not_sent')
    || recorded.http_status !== null
    || recorded.application_code !== null
    || recorded.response_sha256 !== null) {
    throw new Error('Character-reference QA pre-dispatch recovery differs from the recorded project request.')
  }
  const ledgerRecord = await ledger.preDispatchAbort({
    recordId: request.recordId,
    idempotencyKey: request.idempotencyKey,
    method: 'image_generate',
    requestSha256: request.requestSha256,
    actor: request.actor,
    guardEvidenceSha256: request.guardEvidenceSha256,
    reconciliationEvidenceSha256: request.reconciliationEvidenceSha256,
  })
  const qa = store.authorizeGenerationPreDispatchRecovery(
    request.binding,
    request.idempotencyKey,
    request.managedReferenceId,
    request.actor,
    request.guardEvidenceSha256,
    request.reconciliationEvidenceSha256,
    request.occurredAt,
    request.reason,
  )
  if (ledgerRecord.outcome !== 'not_sent' || qa.state !== 'authorized') {
    throw new Error('Character-reference QA pre-dispatch recovery did not reach an authorized state.')
  }
  return { ledgerOutcome: ledgerRecord.outcome, qaState: qa.state }
}

/** Dependencies for the isolated QA bridge. */
export interface CharacterReferenceQaBridgeOptions {
  readonly authority: CharacterReferenceAuthority
  readonly store: CharacterReferenceQaAuthorizationStore
  /** Recheck the signed-in Muse account before every project-private upload or paid claim. */
  readonly ownerIdentity?: (session: Session) => Promise<string>
  readonly upload?: typeof uploadReferenceBytes
  readonly referenceUploadDeps?: ReferenceUploadDeps
  readonly now?: () => Date
}

/** Host-only operations mounted by the Jubian tool plugin when an isolated QA ledger is configured. */
export interface CharacterReferenceQaBridge {
  /** Upload exact Host-read bytes once and return only a managed identity. */
  readonly upload: (
    session: Session,
    request: CharacterReferenceQaUploadRequest,
    signal?: AbortSignal,
  ) => Promise<CharacterReferenceQaUploadResult>
  /** Prepare one Host-injected reference and one-shot generation controller. */
  readonly prepareGeneration: (
    session: Session,
    request: CharacterReferenceQaGenerationRequest,
    signal?: AbortSignal,
  ) => Promise<CharacterReferenceQaGenerationPreparation>
}

interface AuthorizedRead {
  readonly binding: CharacterReferenceQaBinding
  readonly reference: AuthoritativeCharacterReference
}

function receiptSha256(receipt: unknown): string {
  return stableSha256(receipt)
}

function iso(now: () => Date): string {
  const value = now()
  if (!Number.isFinite(value.getTime())) throw new Error('Character-reference QA bridge requires a valid clock.')
  return value.toISOString()
}

function publicResult(
  binding: CharacterReferenceQaBinding,
  managedReferenceId: string,
): CharacterReferenceQaUploadResult {
  return {
    authorization_id: binding.authorizationId,
    authorization_version: binding.authorizationVersion,
    managed_reference_id: managedReferenceId,
    script_id: binding.projectId,
    character_id: binding.characterId,
    role_class: binding.roleClass,
    catalog_asset_id: binding.catalogId,
    image_sha256: binding.imageSha256,
    catalog_status: binding.catalogStatus,
  }
}

function uploadEvidence(result: Record<string, unknown>, expectedSha256: string): {
  readonly materialUri: string
  readonly receiptSha256: string
} {
  const materialUri = result.materialUrl
  const measuredSha256 = result.sha256
  if (typeof materialUri !== 'string' || !materialUri.startsWith('https://')
    || typeof measuredSha256 !== 'string' || measuredSha256 !== `sha256:${expectedSha256}`
    || result.reencoded !== false) {
    throw new Error('Character-reference QA upload did not preserve the authorized image identity.')
  }
  return { materialUri, receiptSha256: receiptSha256(result) }
}

/**
 * Create the Host-only, one-shot QA reference bridge.
 * @param options - Current-project authority, append-only authorization store, upload seam, and clock.
 * @returns Managed upload and paid-generation preparation operations.
 */
export function createCharacterReferenceQaBridge(options: CharacterReferenceQaBridgeOptions): CharacterReferenceQaBridge {
  const now = options.now ?? (() => new Date())
  const uploadBytes = options.upload ?? uploadReferenceBytes

  const readAuthorized = async (
    session: Session,
    request: Omit<CharacterReferenceQaUploadRequest, 'idempotencyKey'>,
    signal?: AbortSignal,
  ): Promise<AuthorizedRead> => {
    signal?.throwIfAborted()
    const reference = await options.authority.read(session, {
      scriptId: request.scriptId,
      characterId: request.characterId,
      catalogAssetId: request.catalogAssetId,
      expectedSha256: request.imageSha256,
    }, signal)
    signal?.throwIfAborted()
    if (reference.scriptId !== request.scriptId
      || reference.characterId !== request.characterId
      || reference.catalogAssetId !== request.catalogAssetId
      || reference.imageSha256 !== request.imageSha256.toLowerCase()) {
      throw new Error('Character-reference QA authority returned a conflicting identity.')
    }
    if (reference.metadataStatus !== 'pending_review') {
      throw new Error('Character-reference QA authorization only permits the recorded pending_review sample.')
    }
    const binding: CharacterReferenceQaBinding = {
      authorizationId: request.authorizationId,
      authorizationVersion: request.authorizationVersion,
      projectId: reference.scriptId,
      characterId: reference.characterId,
      roleClass: reference.roleClass,
      catalogId: reference.catalogAssetId,
      imageSha256: reference.imageSha256,
      catalogStatus: reference.metadataStatus,
    }
    const authorization = options.store.inspect(binding)
    if (authorization.revoked) throw new Error('Character-reference authorization was revoked.')
    if (authorization.grant.environment === 'project_private') {
      if (options.ownerIdentity === undefined
        || authorization.grant.actorId !== await options.ownerIdentity(session)) {
        throw new Error('This project-private reference belongs to another Muse account or conversation.')
      }
    }
    return { binding, reference }
  }

  const upload = async (
    session: Session,
    request: CharacterReferenceQaUploadRequest,
    signal?: AbortSignal,
  ): Promise<CharacterReferenceQaUploadResult> => {
    const current = await readAuthorized(session, request, signal)
    const image = readReferenceImage(current.reference.data)
    if (!alignedReferenceSize(image).aligned) {
      throw new Error('Character-reference QA upload requires byte-preserving aligned image dimensions.')
    }
    const claim = options.store.claimManagedUpload(current.binding, request.idempotencyKey, iso(now))
    if (claim.action === 'reconcile') {
      if (claim.state !== 'settled') {
        throw new Error('Character-reference QA upload must be reconciled by the Host before another send.')
      }
      const settled = options.store.requireManagedReference(current.binding)
      return publicResult(current.binding, settled.managedReferenceId)
    }

    let receipt: Record<string, unknown> | undefined
    try {
      signal?.throwIfAborted()
      receipt = await uploadBytes(current.reference.data.slice(), options.referenceUploadDeps)
      const evidence = uploadEvidence(receipt, current.binding.imageSha256)
      options.store.settleManagedUpload(
        current.binding,
        request.idempotencyKey,
        claim.managedReferenceId,
        evidence.materialUri,
        current.binding.imageSha256,
        evidence.receiptSha256,
        iso(now),
      )
    } catch (error) {
      try {
        options.store.markManagedUploadUnknown(
          current.binding,
          request.idempotencyKey,
          claim.managedReferenceId,
          receipt === undefined ? null : receiptSha256(receipt),
          iso(now),
        )
      } catch (_recordError) {
        // The original upload or settlement failure remains authoritative.
      }
      throw error
    }
    signal?.throwIfAborted()
    return publicResult(current.binding, claim.managedReferenceId)
  }

  const prepareGeneration = async (
    session: Session,
    request: CharacterReferenceQaGenerationRequest,
    signal?: AbortSignal,
  ): Promise<CharacterReferenceQaGenerationPreparation> => {
    const current = await readAuthorized(session, request, signal)
    const managed = options.store.requireManagedReference(current.binding)
    if (managed.managedReferenceId !== request.managedReferenceId
      || managed.imageSha256 !== current.binding.imageSha256) {
      throw new Error('Character-reference QA managed reference no longer matches the authorized image.')
    }
    let claimed = false
    let terminal = false
    const recovery = options.store.inspect(current.binding).generationRecovery
    const preDispatchRecovery = recovery.state === 'authorized'
      && recovery.idempotencyKey === request.idempotencyKey
      && recovery.managedReferenceId === request.managedReferenceId
      ? {
        actor: recovery.actorId as string,
        guardEvidenceSha256: recovery.guardEvidenceSha256 as string,
        reconciliationEvidenceSha256: recovery.reconciliationEvidenceSha256 as string,
      }
      : undefined

    const beforeReserve = async (): Promise<void> => {
      if (claimed) throw new Error('Character-reference QA generation allowance was already claimed.')
      const latest = await readAuthorized(session, request, signal)
      const decision = options.store.claimGeneration(
        latest.binding,
        request.idempotencyKey,
        request.managedReferenceId,
        iso(now),
      )
      if (decision.action !== 'send') {
        throw new Error('Character-reference QA generation must be reconciled by the Host; it cannot be sent again.')
      }
      claimed = true
    }

    const requireClaim = (): void => {
      if (!claimed) throw new Error('Character-reference QA generation was not claimed before settlement.')
      if (terminal) throw new Error('Character-reference QA generation already has terminal evidence.')
    }

    const reconcileRecorded = async (outcome: 'accepted' | 'unknown', receipt: unknown): Promise<void> => {
      const latest = await readAuthorized(session, request, signal)
      const state = options.store.inspect(latest.binding)
      if (state.generation.idempotencyKey !== request.idempotencyKey
        || state.generation.managedReferenceId !== managed.managedReferenceId) {
        throw new Error('Character-reference QA ledger replay conflicts with the fixed generation claim.')
      }
      if (state.generation.state === 'not_started') {
        throw new Error('Character-reference QA ledger replay has no matching generation claim.')
      }
      const digest = receiptSha256(receipt)
      const recordOutcome = (): void => {
        if (outcome === 'accepted') {
          options.store.settleGeneration(
            latest.binding,
            request.idempotencyKey,
            managed.managedReferenceId,
            digest,
            iso(now),
          )
        } else {
          options.store.markGenerationUnknown(
            latest.binding,
            request.idempotencyKey,
            managed.managedReferenceId,
            digest,
            iso(now),
          )
        }
        terminal = true
      }
      if (state.generationRecovery.state === 'claimed') {
        recordOutcome()
        return
      }
      if (state.generationRecovery.state === 'settled') {
        if (outcome !== 'accepted' || state.generationRecovery.receiptSha256 !== digest) {
          throw new Error('Character-reference QA recovery evidence conflicts with the Jubian ledger replay.')
        }
        terminal = true
        return
      }
      if (state.generationRecovery.state === 'unknown') {
        if (outcome !== 'unknown' || state.generationRecovery.receiptSha256 !== digest) {
          throw new Error('Character-reference QA unknown recovery evidence cannot be upgraded from a replay.')
        }
        terminal = true
        return
      }
      if (state.generationRecovery.state === 'authorized') {
        throw new Error('Character-reference QA recovery was not claimed before provider settlement.')
      }
      if (state.generation.state === 'unknown') {
        if (outcome === 'accepted') {
          throw new Error('Character-reference QA unknown evidence cannot be upgraded from a replay.')
        }
        terminal = true
        return
      }
      if (state.generation.state === 'settled') {
        if (outcome !== 'accepted' || state.generation.receiptSha256 !== digest) {
          throw new Error('Character-reference QA terminal evidence conflicts with the Jubian ledger replay.')
        }
        terminal = true
        return
      }
      recordOutcome()
    }

    return {
      authorizationEnvironment: options.store.environment,
      authorizationId: current.binding.authorizationId,
      authorizationVersion: current.binding.authorizationVersion,
      managedReferenceId: managed.managedReferenceId,
      materialUri: managed.materialUri,
      scriptId: current.binding.projectId,
      characterId: current.binding.characterId,
      characterName: current.reference.characterName,
      roleClass: current.binding.roleClass,
      catalogAssetId: current.binding.catalogId,
      imageSha256: current.binding.imageSha256,
      ...(preDispatchRecovery === undefined ? {} : { preDispatchRecovery }),
      beforeReserve,
      settleAccepted: (receipt) => {
        requireClaim()
        options.store.settleGeneration(
          current.binding,
          request.idempotencyKey,
          managed.managedReferenceId,
          receiptSha256(receipt),
          iso(now),
        )
        terminal = true
      },
      settleUnknown: (receipt) => {
        requireClaim()
        options.store.markGenerationUnknown(
          current.binding,
          request.idempotencyKey,
          managed.managedReferenceId,
          receipt === undefined ? null : receiptSha256(receipt),
          iso(now),
        )
        terminal = true
      },
      reconcileRecorded,
    }
  }

  return { upload, prepareGeneration }
}
