import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  AuthoritativeCharacterReference,
  CharacterReferenceAuthority,
} from '@deepseek-ai/dsh-tool-character-reference'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHARACTER_REFERENCE_QA_ENVIRONMENT,
  CHARACTER_REFERENCE_QA_LEGACY_SYNTHETIC_UNKNOWN_RECEIPT_SHA256,
  CHARACTER_REFERENCE_QA_SCOPE,
  openCharacterReferenceQaAuthorizationStore,
  type CharacterReferenceQaAuthorizationStore,
  type CharacterReferenceQaBinding,
  type CharacterReferenceQaGrant,
} from '../src/character-reference-qa-authorization.ts'
import {
  authorizeCharacterReferenceQaPreDispatchRecovery,
  createCharacterReferenceQaBridge,
  type CharacterReferenceQaUploadRequest,
} from '../src/character-reference-qa-bridge.ts'

const PROJECT_ID = 91_001
const CHARACTER_ID = 'fixture_executive'
const CHARACTER_NAME = 'Fixture Executive'
const CATALOG_ID = 'character:fixture-library:modern-executive-001'
const PNG = (() => {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, 1024)
  view.setUint32(20, 1536)
  return bytes
})()
const IMAGE_SHA = createHash('sha256').update(PNG).digest('hex')
const MATERIAL_URI = 'https://example.invalid/host-managed-reference.png'
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function grant(): CharacterReferenceQaGrant {
  return {
    authorizationId: 'qa-fixture-one-shot',
    authorizationVersion: 1,
    environment: CHARACTER_REFERENCE_QA_ENVIRONMENT,
    actorId: 'qa-operator',
    reviewerId: 'qa-reviewer',
    sourceDeclaration: 'Synthetic fixture selected for one isolated QA generation only.',
    projectId: PROJECT_ID,
    characterId: CHARACTER_ID,
    roleClass: 'important_support',
    catalogId: CATALOG_ID,
    imageSha256: IMAGE_SHA,
    catalogStatus: 'pending_review',
    scope: CHARACTER_REFERENCE_QA_SCOPE,
    maxGenerationUses: 1,
    allowPublish: false,
    allowFormalBind: false,
    allowCrossProjectReuse: false,
    productionApproved: false,
    createdAt: '2026-10-20T12:00:00.000Z',
  }
}

function binding(): CharacterReferenceQaBinding {
  const value = grant()
  return {
    authorizationId: value.authorizationId,
    authorizationVersion: value.authorizationVersion,
    projectId: value.projectId,
    characterId: value.characterId,
    roleClass: value.roleClass,
    catalogId: value.catalogId,
    imageSha256: value.imageSha256,
    catalogStatus: value.catalogStatus,
  }
}

function request(): CharacterReferenceQaUploadRequest {
  const value = binding()
  return {
    authorizationId: value.authorizationId,
    authorizationVersion: value.authorizationVersion,
    scriptId: value.projectId,
    characterId: value.characterId,
    catalogAssetId: value.catalogId,
    imageSha256: value.imageSha256,
    idempotencyKey: 'fixture-upload-fixed',
  }
}

async function opened(): Promise<CharacterReferenceQaAuthorizationStore> {
  const dir = await mkdtemp(join(tmpdir(), 'character-reference-qa-bridge-'))
  dirs.push(dir)
  const store = await openCharacterReferenceQaAuthorizationStore({
    dataRoot: dir,
    databasePath: join(dir, 'authorization.sqlite'),
  })
  if (store === undefined) throw new Error('absolute QA authorization path unexpectedly disabled the store')
  store.appendGrant(grant())
  return store
}

function authoritative(overrides: Partial<AuthoritativeCharacterReference> = {}): AuthoritativeCharacterReference {
  return {
    projectDirectory: 'C:/fixture/workspace/project-91001',
    scriptId: PROJECT_ID,
    characterId: CHARACTER_ID,
    characterName: CHARACTER_NAME,
    roleClass: 'important_support',
    catalogAssetId: CATALOG_ID,
    imageSha256: IMAGE_SHA,
    metadataStatus: 'pending_review',
    contentType: 'image/png',
    data: PNG,
    ...overrides,
  }
}

function clock(): () => Date {
  let offset = 0
  return () => new Date(Date.parse('2026-10-20T12:01:00.000Z') + offset++ * 1000)
}

const session = Object.freeze({}) as Session

describe('character-reference isolated QA bridge', () => {
  it('authorizes an exact pre-dispatch abort and reconciles an accepted result after the QA claim', async () => {
    const store = await opened()
    const authority: CharacterReferenceAuthority = { read: async () => authoritative() }
    const bridge = createCharacterReferenceQaBridge({
      authority,
      store,
      upload: async () => ({ materialUrl: MATERIAL_URI, reencoded: false, sha256: `sha256:${IMAGE_SHA}` }),
      now: clock(),
    })
    const uploaded = await bridge.upload(session, request())
    const generation = {
      ...request(),
      idempotencyKey: 'fixture-generation-recovery',
      managedReferenceId: uploaded.managed_reference_id,
    }
    const initial = await bridge.prepareGeneration(session, generation)
    await initial.beforeReserve()
    initial.settleUnknown({ outcome: 'unknown', response_sha256: null })
    expect(store.inspect(binding()).generation.receiptSha256)
      .toBe(CHARACTER_REFERENCE_QA_LEGACY_SYNTHETIC_UNKNOWN_RECEIPT_SHA256)

    const ledgerRoot = await mkdtemp(join(tmpdir(), 'character-reference-qa-recovery-ledger-'))
    dirs.push(ledgerRoot)
    const ledger = new JubianLedger({ root: ledgerRoot })
    const requestSha256 = `sha256:${'5'.repeat(64)}`
    const began = await ledger.begin({ idempotencyKey: generation.idempotencyKey,
      method: 'image_generate', requestSha256, scriptId: PROJECT_ID,
      quotedAmount: '0.12', quoteUnit: 'CNY' })
    await ledger.settle(generation.idempotencyKey, { httpStatus: null, applicationCode: null,
      responseSha256: null, outcome: 'unknown' })
    const evidence = {
      binding: binding(),
      idempotencyKey: generation.idempotencyKey,
      managedReferenceId: generation.managedReferenceId,
      recordId: began.record.record_id,
      requestSha256,
      actor: grant().actorId,
      guardEvidenceSha256: '6'.repeat(64),
      reconciliationEvidenceSha256: '7'.repeat(64),
      occurredAt: '2026-10-20T12:05:00.000Z',
      reason: 'Trusted guard stopped the exact request before dispatch; provider snapshot found no conflict.',
    }
    const wrongProjectRoot = await mkdtemp(join(tmpdir(), 'character-reference-qa-wrong-project-ledger-'))
    dirs.push(wrongProjectRoot)
    const wrongProjectLedger = new JubianLedger({ root: wrongProjectRoot })
    const wrongProject = await wrongProjectLedger.begin({
      idempotencyKey: generation.idempotencyKey,
      method: 'image_generate',
      requestSha256,
      scriptId: PROJECT_ID + 1,
    })
    await wrongProjectLedger.settle(generation.idempotencyKey, { httpStatus: null, applicationCode: null,
      responseSha256: null, outcome: 'unknown' })
    await expect(authorizeCharacterReferenceQaPreDispatchRecovery(wrongProjectLedger, store, {
      ...evidence,
      recordId: wrongProject.record.record_id,
    })).rejects.toThrow('recorded project request')
    expect((await wrongProjectLedger.find(generation.idempotencyKey))?.outcome).toBe('unknown')

    for (const responseEvidence of [
      { httpStatus: 502, applicationCode: null, responseSha256: null },
      { httpStatus: null, applicationCode: 500, responseSha256: null },
      { httpStatus: null, applicationCode: null, responseSha256: `sha256:${'a'.repeat(64)}` },
    ]) {
      const providerEvidenceRoot = await mkdtemp(join(tmpdir(), 'character-reference-qa-provider-evidence-ledger-'))
      dirs.push(providerEvidenceRoot)
      const providerEvidenceLedger = new JubianLedger({ root: providerEvidenceRoot })
      const providerEvidence = await providerEvidenceLedger.begin({
        idempotencyKey: generation.idempotencyKey,
        method: 'image_generate',
        requestSha256,
        scriptId: PROJECT_ID,
      })
      await providerEvidenceLedger.settle(generation.idempotencyKey, {
        ...responseEvidence,
        outcome: 'unknown',
      })
      await expect(authorizeCharacterReferenceQaPreDispatchRecovery(providerEvidenceLedger, store, {
        ...evidence,
        recordId: providerEvidence.record.record_id,
      })).rejects.toThrow('recorded project request')
      expect((await providerEvidenceLedger.find(generation.idempotencyKey))?.outcome).toBe('unknown')
      expect(store.listGenerationRecoveryEvents(binding())).toEqual([])
    }

    await ledger.preDispatchAbort({
      recordId: evidence.recordId,
      idempotencyKey: evidence.idempotencyKey,
      method: 'image_generate',
      requestSha256: evidence.requestSha256,
      actor: evidence.actor,
      guardEvidenceSha256: evidence.guardEvidenceSha256,
      reconciliationEvidenceSha256: evidence.reconciliationEvidenceSha256,
    })
    await expect(authorizeCharacterReferenceQaPreDispatchRecovery(ledger, store, {
      ...evidence,
      guardEvidenceSha256: '9'.repeat(64),
    })).rejects.toThrow()
    expect(store.listGenerationRecoveryEvents(binding())).toEqual([])
    expect(await authorizeCharacterReferenceQaPreDispatchRecovery(ledger, store, evidence))
      .toEqual({ ledgerOutcome: 'not_sent', qaState: 'authorized' })
    expect(await authorizeCharacterReferenceQaPreDispatchRecovery(ledger, store, evidence))
      .toEqual({ ledgerOutcome: 'not_sent', qaState: 'authorized' })

    const first = await bridge.prepareGeneration(session, generation)
    expect(first.preDispatchRecovery).toMatchObject({ actor: grant().actorId,
      guardEvidenceSha256: evidence.guardEvidenceSha256 })
    await first.beforeReserve()
    expect(store.inspect(binding()).generationRecovery.state).toBe('claimed')

    const afterInterruptedLedgerHandoff = await bridge.prepareGeneration(session, generation)
    expect(afterInterruptedLedgerHandoff.preDispatchRecovery).toBeUndefined()
    await expect(afterInterruptedLedgerHandoff.beforeReserve()).rejects.toThrow('must be reconciled')
    const acceptedReceipt = { outcome: 'accepted', response_sha256: `sha256:${'8'.repeat(64)}` }
    await afterInterruptedLedgerHandoff.reconcileRecorded('accepted', acceptedReceipt)
    expect(store.inspect(binding()).generationRecovery.state).toBe('settled')
    await expect(afterInterruptedLedgerHandoff.reconcileRecorded('accepted', acceptedReceipt)).resolves.toBeUndefined()
    expect(store.listGenerationRecoveryEvents(binding()).map(event => event.type)).toEqual([
      'recovery_authorized', 'recovery_claim', 'recovery_settle',
    ])
    store.close()
  })

  it('uploads Host-read bytes once, hides the URI, and consumes one generation only at beforeReserve', async () => {
    const store = await opened()
    const read = vi.fn(async () => authoritative())
    const authority: CharacterReferenceAuthority = { read }
    const upload = vi.fn(async () => ({
      materialUrl: MATERIAL_URI,
      materialType: 'image',
      sortOrder: 1,
      reencoded: false,
      sha256: `sha256:${IMAGE_SHA}`,
    }))
    const bridge = createCharacterReferenceQaBridge({ authority, store, upload, now: clock() })
    const untrusted = { ...request(), image_path: 'C:/private/forged.png', materialUrl: 'https://evil.invalid/image.png' }

    const result = await bridge.upload(session, untrusted)
    expect(result.managed_reference_id.length).toBeGreaterThan(0)
    expect(result).toMatchObject({
      script_id: PROJECT_ID,
      character_id: CHARACTER_ID,
      catalog_asset_id: CATALOG_ID,
      image_sha256: IMAGE_SHA,
      catalog_status: 'pending_review',
    })
    expect(JSON.stringify(result)).not.toContain('material')
    expect(JSON.stringify(store.listEvents(binding()))).not.toContain('evil.invalid')
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledWith(PNG, undefined)

    const prepared = await bridge.prepareGeneration(session, {
      ...request(),
      idempotencyKey: 'fixture-generation-fixed',
      managedReferenceId: result.managed_reference_id,
    })
    expect(prepared.materialUri).toBe(MATERIAL_URI)
    expect(prepared.characterName).toBe(CHARACTER_NAME)
    expect(store.inspect(binding()).generation.state).toBe('not_started')
    await prepared.beforeReserve()
    expect(store.inspect(binding()).generation.state).toBe('claimed')
    prepared.settleAccepted({ task_id: 70001, asset_id: 80001 })
    expect(store.inspect(binding()).generation.state).toBe('settled')
    expect(store.listEvents(binding()).map(event => event.type)).toEqual([
      'grant', 'upload_claim', 'upload_settle', 'generation_claim', 'generation_settle',
    ])
    expect(read).toHaveBeenCalledTimes(3)
    store.close()
  })

  it('rejects changed bytes, changed bindings, non-pending status, and revocation before upload', async () => {
    const cases: Array<{
      name: string
      reference?: AuthoritativeCharacterReference
      revoke?: boolean
    }> = [
      { name: 'changed SHA', reference: authoritative({ imageSha256: 'b'.repeat(64) }) },
      { name: 'changed role', reference: authoritative({ roleClass: 'lead' }) },
      { name: 'changed Catalog status', reference: authoritative({ metadataStatus: 'approved_claim' }) },
      { name: 'revoked grant', revoke: true },
    ]
    for (const item of cases) {
      const store = await opened()
      if (item.revoke === true) {
        store.appendRevocation(binding(), 'qa-reviewer', 'fixture revocation', '2026-10-20T12:00:30.000Z')
      }
      const authority: CharacterReferenceAuthority = { read: async () => item.reference ?? authoritative() }
      const upload = vi.fn(async () => ({ materialUrl: MATERIAL_URI, reencoded: false, sha256: `sha256:${IMAGE_SHA}` }))
      const bridge = createCharacterReferenceQaBridge({ authority, store, upload, now: clock() })
      await expect(bridge.upload(session, request()), item.name).rejects.toThrow()
      expect(upload, item.name).not.toHaveBeenCalled()
      expect(store.listEvents(binding()).some(event => event.type === 'upload_claim'), item.name).toBe(false)
      store.close()
    }
  })

  it('records an unknown upload and never repeats the external call for the fixed key', async () => {
    const store = await opened()
    const authority: CharacterReferenceAuthority = { read: async () => authoritative() }
    const upload = vi.fn(async () => { throw new Error('connection ended after request dispatch') })
    const bridge = createCharacterReferenceQaBridge({ authority, store, upload, now: clock() })

    await expect(bridge.upload(session, request())).rejects.toThrow('connection ended')
    expect(store.inspect(binding()).upload.state).toBe('unknown')
    await expect(bridge.upload(session, request())).rejects.toThrow('reconciled by the Host')
    expect(upload).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('rechecks current project and image identity immediately before the paid allowance is claimed', async () => {
    const store = await opened()
    let current = authoritative()
    const authority: CharacterReferenceAuthority = { read: async () => current }
    const bridge = createCharacterReferenceQaBridge({
      authority,
      store,
      upload: async () => ({ materialUrl: MATERIAL_URI, reencoded: false, sha256: `sha256:${IMAGE_SHA}` }),
      now: clock(),
    })
    const uploaded = await bridge.upload(session, request())
    const prepared = await bridge.prepareGeneration(session, {
      ...request(),
      idempotencyKey: 'fixture-generation-fixed',
      managedReferenceId: uploaded.managed_reference_id,
    })
    current = authoritative({ scriptId: 91_002 })

    await expect(prepared.beforeReserve()).rejects.toThrow('conflicting identity')
    expect(store.inspect(binding()).generation.state).toBe('not_started')
    expect(() => { prepared.settleAccepted({ task_id: 70001 }) }).toThrow('not claimed')
    store.close()
  })

  it('records an unknown paid outcome and blocks every later key without another provider send', async () => {
    const store = await opened()
    const authority: CharacterReferenceAuthority = { read: async () => authoritative() }
    const bridge = createCharacterReferenceQaBridge({
      authority,
      store,
      upload: async () => ({ materialUrl: MATERIAL_URI, reencoded: false, sha256: `sha256:${IMAGE_SHA}` }),
      now: clock(),
    })
    const uploaded = await bridge.upload(session, request())
    const prepared = await bridge.prepareGeneration(session, {
      ...request(),
      idempotencyKey: 'fixture-generation-fixed',
      managedReferenceId: uploaded.managed_reference_id,
    })
    await prepared.beforeReserve()
    prepared.settleUnknown({ error_class: 'transport' })
    expect(store.inspect(binding()).generation.state).toBe('unknown')

    const next = await bridge.prepareGeneration(session, {
      ...request(),
      idempotencyKey: 'fixture-generation-other',
      managedReferenceId: uploaded.managed_reference_id,
    })
    await expect(next.beforeReserve()).rejects.toMatchObject({ code: 'already-consumed' })
    expect(store.listEvents(binding()).filter(event => event.type === 'generation_claim')).toHaveLength(1)
    store.close()
  })

  it('settles a claimed generation from the same-key accepted ledger replay', async () => {
    const store = await opened()
    const authority: CharacterReferenceAuthority = { read: async () => authoritative() }
    const bridge = createCharacterReferenceQaBridge({
      authority,
      store,
      upload: async () => ({ materialUrl: MATERIAL_URI, reencoded: false, sha256: `sha256:${IMAGE_SHA}` }),
      now: clock(),
    })
    const uploaded = await bridge.upload(session, request())
    const generation = {
      ...request(),
      idempotencyKey: 'fixture-generation-fixed',
      managedReferenceId: uploaded.managed_reference_id,
    }
    const initial = await bridge.prepareGeneration(session, generation)
    await initial.beforeReserve()
    expect(store.inspect(binding()).generation.state).toBe('claimed')

    const replay = await bridge.prepareGeneration(session, generation)
    const receipt = { outcome: 'accepted' as const, response_sha256: 'sha256:fixture-provider-response' }
    await replay.reconcileRecorded('accepted', receipt)
    expect(store.inspect(binding()).generation.state).toBe('settled')

    const repeatedReplay = await bridge.prepareGeneration(session, generation)
    await repeatedReplay.reconcileRecorded('accepted', receipt)
    expect(store.listEvents(binding()).filter(event => event.type === 'generation_settle')).toHaveLength(1)
    store.close()
  })

  it('preserves unknown generation evidence instead of upgrading it from an accepted replay', async () => {
    const store = await opened()
    const authority: CharacterReferenceAuthority = { read: async () => authoritative() }
    const bridge = createCharacterReferenceQaBridge({
      authority,
      store,
      upload: async () => ({ materialUrl: MATERIAL_URI, reencoded: false, sha256: `sha256:${IMAGE_SHA}` }),
      now: clock(),
    })
    const uploaded = await bridge.upload(session, request())
    const generation = {
      ...request(),
      idempotencyKey: 'fixture-generation-fixed',
      managedReferenceId: uploaded.managed_reference_id,
    }
    const initial = await bridge.prepareGeneration(session, generation)
    await initial.beforeReserve()
    await initial.reconcileRecorded('unknown', { outcome: 'unknown', response_sha256: null })
    expect(store.inspect(binding()).generation.state).toBe('unknown')

    const replay = await bridge.prepareGeneration(session, generation)
    await expect(replay.reconcileRecorded('accepted', {
      outcome: 'accepted', response_sha256: 'sha256:conflicting-provider-response',
    })).rejects.toThrow('cannot be upgraded')
    expect(store.inspect(binding()).generation.state).toBe('unknown')
    expect(store.listEvents(binding()).filter(event => event.type === 'generation_unknown')).toHaveLength(1)
    store.close()
  })
})
