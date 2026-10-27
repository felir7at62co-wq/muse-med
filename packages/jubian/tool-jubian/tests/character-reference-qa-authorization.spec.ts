import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHARACTER_REFERENCE_QA_SCHEMA_VERSION,
  CHARACTER_REFERENCE_QA_ENVIRONMENT,
  CHARACTER_REFERENCE_QA_LEGACY_SYNTHETIC_UNKNOWN_RECEIPT_SHA256,
  CHARACTER_REFERENCE_QA_SCOPE,
  CharacterReferenceQaAuthorizationStore,
  openCharacterReferenceQaAuthorizationStore,
  type CharacterReferenceQaBinding,
  type CharacterReferenceQaGrant,
} from '../src/character-reference-qa-authorization.ts'

const PROJECT_ID = 91_101
const OTHER_PROJECT_ID = 91_102
const CHARACTER_ID = 'fixture_supporting_character'
const CATALOG_ID = 'character:synthetic-fixture:character-support-001'
const IMAGE_SHA = '1'.repeat(64)
const RECEIPT_SHA = 'a'.repeat(64)
const GENERATION_RECEIPT_SHA = 'b'.repeat(64)
const GUARD_EVIDENCE_SHA = 'd'.repeat(64)
const RECONCILIATION_EVIDENCE_SHA = 'e'.repeat(64)
const RECOVERY_REASON = 'Durable pre-dispatch guard and provider reconciliation both prove no request was sent.'
const CREATED_AT = '2026-10-20T12:00:00.000Z'
const ACTOR_ID = 'fixture-operator'
const REVIEWER_ID = 'fixture-reviewer'
const SOURCE_DECLARATION = 'Synthetic test fixture authorized for one isolated QA generation only.'
const dirs: string[] = []
const stores: CharacterReferenceQaAuthorizationStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function grant(overrides: Partial<CharacterReferenceQaGrant> = {}): CharacterReferenceQaGrant {
  return {
    authorizationId: 'qa-synthetic-one-shot',
    authorizationVersion: 1,
    environment: CHARACTER_REFERENCE_QA_ENVIRONMENT,
    actorId: ACTOR_ID,
    reviewerId: REVIEWER_ID,
    sourceDeclaration: SOURCE_DECLARATION,
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
    createdAt: CREATED_AT,
    ...overrides,
  }
}

function binding(value = grant()): CharacterReferenceQaBinding {
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

async function opened(): Promise<{ store: CharacterReferenceQaAuthorizationStore; path: string; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'character-reference-qa-auth-'))
  dirs.push(dir)
  const path = join(dir, 'database', 'authorization.sqlite')
  const store = await openCharacterReferenceQaAuthorizationStore({ dataRoot: dir, databasePath: path })
  if (store === undefined) throw new Error('test path unexpectedly disabled the QA authorization store')
  stores.push(store)
  return { store, path, root: dir }
}

function expectCode(code: string): { code: string } {
  return { code }
}

function settleUpload(store: CharacterReferenceQaAuthorizationStore, current = binding()): string {
  const claim = store.claimManagedUpload(current, 'upload-fixed', '2026-10-20T12:01:00.000Z')
  store.settleManagedUpload(
    current,
    'upload-fixed',
    claim.managedReferenceId,
    'https://example.invalid/qa-reference.png',
    IMAGE_SHA,
    RECEIPT_SHA,
    '2026-10-20T12:02:00.000Z',
  )
  return claim.managedReferenceId
}

function establishUnknownGeneration(
  store: CharacterReferenceQaAuthorizationStore,
  receiptSha256: string | null = null,
  current = binding(),
): string {
  const managedReferenceId = settleUpload(store, current)
  store.claimGeneration(current, 'generation-fixed', managedReferenceId, '2026-10-20T12:03:00.000Z')
  store.markGenerationUnknown(
    current,
    'generation-fixed',
    managedReferenceId,
    receiptSha256,
    '2026-10-20T12:04:00.000Z',
  )
  return managedReferenceId
}

function authorizeRecovery(
  store: CharacterReferenceQaAuthorizationStore,
  managedReferenceId: string,
  overrides: {
    idempotencyKey?: string
    actorId?: string
    guardEvidenceSha256?: string
    reconciliationEvidenceSha256?: string
    occurredAt?: string
    reason?: string
  } = {},
  current = binding(),
) {
  return store.authorizeGenerationPreDispatchRecovery(
    current,
    overrides.idempotencyKey ?? 'generation-fixed',
    managedReferenceId,
    overrides.actorId ?? ACTOR_ID,
    overrides.guardEvidenceSha256 ?? GUARD_EVIDENCE_SHA,
    overrides.reconciliationEvidenceSha256 ?? RECONCILIATION_EVIDENCE_SHA,
    overrides.occurredAt ?? '2026-10-20T12:05:00.000Z',
    overrides.reason ?? RECOVERY_REASON,
  )
}

describe('character-reference isolated QA authorization store', () => {
  it('stays disabled only when both location fields are omitted and rejects incomplete or uncontained paths', async () => {
    expect(await openCharacterReferenceQaAuthorizationStore({})).toBeUndefined()
    expect(await openCharacterReferenceQaAuthorizationStore({ dataRoot: '', databasePath: '' })).toBeUndefined()
    const root = await mkdtemp(join(tmpdir(), 'character-reference-qa-location-'))
    dirs.push(root)
    await expect(openCharacterReferenceQaAuthorizationStore({ databasePath: join(root, 'authorization.sqlite') }))
      .rejects.toMatchObject(expectCode('invalid-config'))
    await expect(openCharacterReferenceQaAuthorizationStore({ dataRoot: root }))
      .rejects.toMatchObject(expectCode('invalid-config'))
    await expect(openCharacterReferenceQaAuthorizationStore({
      dataRoot: root,
      databasePath: 'relative/authorization.sqlite',
    })).rejects.toMatchObject(expectCode('invalid-config'))
    await expect(openCharacterReferenceQaAuthorizationStore({
      dataRoot: join(root, 'trusted'),
      databasePath: join(root, 'authorization.sqlite'),
    })).rejects.toMatchObject(expectCode('invalid-config'))
  })

  it.skipIf(process.platform === 'win32')('refuses existing POSIX directories and files accessible beyond the owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'character-reference-qa-mode-'))
    dirs.push(root)
    const nested = join(root, 'database')
    const path = join(nested, 'authorization.sqlite')
    await mkdir(nested, { mode: 0o755 })
    await expect(openCharacterReferenceQaAuthorizationStore({ dataRoot: root, databasePath: path }))
      .rejects.toMatchObject(expectCode('invalid-config'))
    await chmod(nested, 0o700)
    await writeFile(path, '', { mode: 0o644 })
    await expect(openCharacterReferenceQaAuthorizationStore({ dataRoot: root, databasePath: path }))
      .rejects.toMatchObject(expectCode('invalid-config'))
  })

  it('rejects a SQLite sidecar path occupied by a directory on every platform', async () => {
    const root = await mkdtemp(join(tmpdir(), 'character-reference-qa-sidecar-'))
    dirs.push(root)
    const path = join(root, 'database', 'authorization.sqlite')
    await mkdir(join(root, 'database'), { mode: 0o700 })
    await mkdir(`${path}-wal`)
    await expect(openCharacterReferenceQaAuthorizationStore({ dataRoot: root, databasePath: path }))
      .rejects.toMatchObject(expectCode('invalid-config'))
  })

  it('persists the synthetic one-shot grant and protects grants and events from mutation', async () => {
    const { store, path } = await opened()
    const value = grant()
    store.appendGrant(value)
    expect(store.inspect(binding(value))).toEqual({
      grant: value,
      revoked: false,
      upload: {
        state: 'not_started', idempotencyKey: null, managedReferenceId: null, materialUri: null, imageSha256: null,
      },
      generation: {
        state: 'not_started', idempotencyKey: null, managedReferenceId: null, receiptSha256: null,
      },
      generationRecovery: {
        state: 'not_authorized',
        actorId: null,
        authorizedAt: null,
        idempotencyKey: null,
        managedReferenceId: null,
        guardEvidenceSha256: null,
        reconciliationEvidenceSha256: null,
        reason: null,
        receiptSha256: null,
      },
    })
    expect(store.listEvents(binding(value))).toMatchObject([{
      type: 'grant', actorId: ACTOR_ID, note: value.sourceDeclaration,
    }])
    store.close()

    const db = new DatabaseSync(path)
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
        .toBe(CHARACTER_REFERENCE_QA_SCHEMA_VERSION)
      expect(() => { db.exec("UPDATE character_reference_qa_authorizations SET reviewer_id = 'other'") })
        .toThrow(/append-only/u)
      expect(() => { db.exec("UPDATE character_reference_qa_events SET actor_id = 'other'") })
        .toThrow(/append-only/u)
      expect(() => { db.exec('DELETE FROM character_reference_qa_events') }).toThrow(/append-only/u)
    } finally {
      db.close()
    }
  })

  it.each([
    ['catalog status', { catalogStatus: 'approved' }],
    ['scope', { scope: 'unbounded' }],
    ['use count', { maxGenerationUses: 2 }],
    ['publish', { allowPublish: true }],
    ['formal bind', { allowFormalBind: true }],
    ['cross-project reuse', { allowCrossProjectReuse: true }],
    ['production approval', { productionApproved: true }],
    ['role class', { roleClass: 'invented_role' }],
    ['SHA', { imageSha256: 'not-a-sha' }],
  ] as const)('rejects a grant that broadens isolated QA authority: %s', async (_name, override) => {
    const { store } = await opened()
    expect(() => { store.appendGrant(grant(override as Partial<CharacterReferenceQaGrant>)) })
      .toThrow(expect.objectContaining(expectCode('invalid-grant')))
    store.close()
  })

  it('binds one upload and one generation key, and permits same-key reconciliation only', async () => {
    const { store } = await opened()
    const current = binding()
    store.appendGrant(grant())

    const upload = store.claimManagedUpload(current, 'upload-fixed', '2026-10-20T12:01:00.000Z')
    expect(upload).toMatchObject({ action: 'send', state: 'claimed', idempotencyKey: 'upload-fixed' })
    expect(store.claimManagedUpload(current, 'upload-fixed', '2026-10-20T12:01:01.000Z'))
      .toEqual({ ...upload, action: 'reconcile' })
    expect(() => store.claimManagedUpload(current, 'upload-other', '2026-10-20T12:01:02.000Z'))
      .toThrow(expect.objectContaining(expectCode('idempotency-conflict')))

    store.settleManagedUpload(
      current,
      'upload-fixed',
      upload.managedReferenceId,
      'https://example.invalid/reference.png',
      IMAGE_SHA,
      RECEIPT_SHA,
      '2026-10-20T12:02:00.000Z',
    )
    expect(store.claimManagedUpload(current, 'upload-fixed', '2026-10-20T12:02:01.000Z'))
      .toMatchObject({ action: 'reconcile', state: 'settled' })
    expect(store.requireManagedReference(current)).toEqual({
      managedReferenceId: upload.managedReferenceId,
      materialUri: 'https://example.invalid/reference.png',
      imageSha256: IMAGE_SHA,
    })

    const generation = store.claimGeneration(
      current,
      'generation-fixed',
      upload.managedReferenceId,
      '2026-10-20T12:03:00.000Z',
    )
    expect(generation).toMatchObject({ action: 'send', state: 'claimed', idempotencyKey: 'generation-fixed' })
    expect(store.claimGeneration(
      current,
      'generation-fixed',
      upload.managedReferenceId,
      '2026-10-20T12:03:01.000Z',
    )).toMatchObject({ action: 'reconcile', state: 'claimed' })
    expect(() => store.claimGeneration(
      current,
      'generation-other',
      upload.managedReferenceId,
      '2026-10-20T12:03:02.000Z',
    )).toThrow(expect.objectContaining(expectCode('already-consumed')))

    store.settleGeneration(
      current,
      'generation-fixed',
      upload.managedReferenceId,
      GENERATION_RECEIPT_SHA,
      '2026-10-20T12:04:00.000Z',
    )
    expect(store.claimGeneration(
      current,
      'generation-fixed',
      upload.managedReferenceId,
      '2026-10-20T12:04:01.000Z',
    )).toMatchObject({ action: 'reconcile', state: 'settled' })
    expect(store.listEvents(current).map(event => event.type)).toEqual([
      'grant', 'upload_claim', 'upload_settle', 'generation_claim', 'generation_settle',
    ])
    store.close()
  })

  it.each([
    ['project', { projectId: OTHER_PROJECT_ID }],
    ['character', { characterId: 'char_other' }],
    ['role class', { roleClass: 'lead' }],
    ['Catalog id', { catalogId: 'character:other' }],
    ['SHA', { imageSha256: 'c'.repeat(64) }],
  ] as const)('fails closed when the current binding changes: %s', async (_name, override) => {
    const { store } = await opened()
    store.appendGrant(grant())
    expect(() => store.inspect({ ...binding(), ...override })).toThrow(
      expect.objectContaining(expectCode('binding-mismatch')),
    )
    store.close()
  })

  it('fails closed for missing and revoked authorization while retaining terminal evidence recording', async () => {
    const { store } = await opened()
    expect(() => store.inspect(binding())).toThrow(expect.objectContaining(expectCode('missing-authorization')))

    store.appendGrant(grant())
    const current = binding()
    const upload = store.claimManagedUpload(current, 'upload-fixed', '2026-10-20T12:01:00.000Z')
    store.appendRevocation(current, ACTOR_ID, 'isolated QA approval withdrawn', '2026-10-20T12:01:30.000Z')
    expect(() => store.claimManagedUpload(current, 'upload-fixed', '2026-10-20T12:01:31.000Z'))
      .toThrow(expect.objectContaining(expectCode('revoked')))
    expect(() => store.claimGeneration(current, 'generation-fixed', upload.managedReferenceId, CREATED_AT))
      .toThrow(expect.objectContaining(expectCode('revoked')))

    // A late provider result may still be appended as evidence; it grants no new use.
    store.markManagedUploadUnknown(
      current, 'upload-fixed', upload.managedReferenceId, null, '2026-10-20T12:02:00.000Z',
    )
    expect(store.inspect(current)).toMatchObject({ revoked: true, upload: { state: 'unknown' } })
    store.close()
  })

  it('blocks generation when upload evidence is incomplete, unknown, or has the wrong SHA', async () => {
    const { store } = await opened()
    const current = binding()
    store.appendGrant(grant())
    expect(() => store.claimGeneration(current, 'generation-fixed', 'missing', CREATED_AT))
      .toThrow(expect.objectContaining(expectCode('invalid-transition')))

    const upload = store.claimManagedUpload(current, 'upload-fixed', '2026-10-20T12:01:00.000Z')
    expect(() => {
      store.settleManagedUpload(
        current,
        'upload-fixed',
        upload.managedReferenceId,
        'https://example.invalid/reference.png',
        'c'.repeat(64),
        RECEIPT_SHA,
        '2026-10-20T12:02:00.000Z',
      )
    }).toThrow(expect.objectContaining(expectCode('binding-mismatch')))
    store.markManagedUploadUnknown(
      current, 'upload-fixed', upload.managedReferenceId, RECEIPT_SHA, '2026-10-20T12:02:01.000Z',
    )
    expect(() => store.requireManagedReference(current)).toThrow(
      expect.objectContaining(expectCode('unknown-outcome')),
    )
    expect(() => store.claimGeneration(
      current,
      'generation-fixed',
      upload.managedReferenceId,
      '2026-10-20T12:03:00.000Z',
    )).toThrow(expect.objectContaining(expectCode('unknown-outcome')))
    expect(store.claimManagedUpload(current, 'upload-fixed', '2026-10-20T12:03:01.000Z'))
      .toMatchObject({ action: 'reconcile', state: 'unknown' })
    store.close()
  })

  it('treats an unknown generation as consumed and never authorizes another send', async () => {
    const { store } = await opened()
    const current = binding()
    store.appendGrant(grant())
    const managedReferenceId = settleUpload(store, current)
    store.claimGeneration(current, 'generation-fixed', managedReferenceId, '2026-10-20T12:03:00.000Z')
    store.markGenerationUnknown(
      current,
      'generation-fixed',
      managedReferenceId,
      null,
      '2026-10-20T12:04:00.000Z',
    )
    expect(store.claimGeneration(
      current,
      'generation-fixed',
      managedReferenceId,
      '2026-10-20T12:04:01.000Z',
    )).toMatchObject({ action: 'reconcile', state: 'unknown' })
    expect(() => store.claimGeneration(
      current,
      'generation-other',
      managedReferenceId,
      '2026-10-20T12:04:02.000Z',
    )).toThrow(expect.objectContaining(expectCode('already-consumed')))
    expect(store.inspect(current).generationRecovery.state).toBe('not_authorized')
    expect(store.listGenerationRecoveryEvents(current)).toEqual([])
    store.close()
  })

  it('rejects recovery with receipt evidence, incomplete proof, or mismatched identity', async () => {
    const { store } = await opened()
    const current = binding()
    store.appendGrant(grant())
    const managedReferenceId = establishUnknownGeneration(store, GENERATION_RECEIPT_SHA, current)
    expect(() => authorizeRecovery(store, managedReferenceId, {}, current))
      .toThrow(expect.objectContaining(expectCode('unknown-outcome')))
    store.close()

    const second = await opened()
    second.store.appendGrant(grant())
    const recoverableReferenceId = establishUnknownGeneration(second.store)
    expect(() => authorizeRecovery(second.store, recoverableReferenceId, {
      guardEvidenceSha256: 'not-a-digest',
    })).toThrow(expect.objectContaining(expectCode('invalid-grant')))
    expect(() => authorizeRecovery(second.store, recoverableReferenceId, {
      reconciliationEvidenceSha256: '',
    })).toThrow(expect.objectContaining(expectCode('invalid-grant')))
    expect(() => authorizeRecovery(second.store, recoverableReferenceId, {
      actorId: 'different-operator',
    })).toThrow(expect.objectContaining(expectCode('binding-mismatch')))
    expect(() => authorizeRecovery(second.store, recoverableReferenceId, {
      idempotencyKey: 'different-generation-key',
    })).toThrow(expect.objectContaining(expectCode('idempotency-conflict')))
    expect(() => authorizeRecovery(second.store, 'different-managed-reference'))
      .toThrow(expect.objectContaining(expectCode('binding-mismatch')))
    second.store.appendRevocation(
      current,
      ACTOR_ID,
      'recovery authority withdrawn',
      '2026-10-20T12:04:30.000Z',
    )
    expect(() => authorizeRecovery(second.store, recoverableReferenceId))
      .toThrow(expect.objectContaining(expectCode('revoked')))
    expect(second.store.listGenerationRecoveryEvents(current)).toEqual([])
    second.store.close()
  })

  it('accepts only the exact legacy synthetic unknown receipt and binds its basis into the audit reason', async () => {
    expect(CHARACTER_REFERENCE_QA_LEGACY_SYNTHETIC_UNKNOWN_RECEIPT_SHA256)
      .toBe('d867c1daf262bc8bb3725e894647f46624217afa0d6018276c210d2c9f2b5cca')
    const { store } = await opened()
    const current = binding()
    store.appendGrant(grant())
    const managedReferenceId = establishUnknownGeneration(
      store,
      CHARACTER_REFERENCE_QA_LEGACY_SYNTHETIC_UNKNOWN_RECEIPT_SHA256,
      current,
    )

    const recovery = authorizeRecovery(store, managedReferenceId, {}, current)
    expect(recovery.state).toBe('authorized')
    expect(recovery.reason).toContain(
      'legacy_synthetic_receipt_basis={"outcome":"unknown","response_sha256":null}',
    )
    expect(recovery.reason).toContain(
      `legacy_synthetic_receipt_sha256=${CHARACTER_REFERENCE_QA_LEGACY_SYNTHETIC_UNKNOWN_RECEIPT_SHA256}`,
    )
    expect(store.listGenerationRecoveryEvents(current)).toEqual([
      expect.objectContaining({ type: 'recovery_authorized', reason: recovery.reason }),
    ])
    store.close()
  })

  it('authorizes one evidenced pre-dispatch recovery and consumes it at the recovery claim', async () => {
    const { store, path } = await opened()
    const current = binding()
    store.appendGrant(grant())
    const managedReferenceId = establishUnknownGeneration(store)

    expect(authorizeRecovery(store, managedReferenceId)).toEqual({
      state: 'authorized',
      actorId: ACTOR_ID,
      authorizedAt: '2026-10-20T12:05:00.000Z',
      idempotencyKey: 'generation-fixed',
      managedReferenceId,
      guardEvidenceSha256: GUARD_EVIDENCE_SHA,
      reconciliationEvidenceSha256: RECONCILIATION_EVIDENCE_SHA,
      reason: RECOVERY_REASON,
      receiptSha256: null,
    })
    // The prepare step is retry-safe across another ledger's append/crash window.
    expect(authorizeRecovery(store, managedReferenceId, {
      occurredAt: '2026-10-20T12:05:30.000Z',
    })).toMatchObject({ state: 'authorized', authorizedAt: '2026-10-20T12:05:00.000Z' })
    expect(store.listGenerationRecoveryEvents(current)).toHaveLength(1)

    expect(store.claimGeneration(
      current,
      'generation-fixed',
      managedReferenceId,
      '2026-10-20T12:06:00.000Z',
    )).toMatchObject({ action: 'send', state: 'claimed' })
    expect(store.claimGeneration(
      current,
      'generation-fixed',
      managedReferenceId,
      '2026-10-20T12:06:01.000Z',
    )).toMatchObject({ action: 'reconcile', state: 'claimed' })
    store.settleGeneration(
      current,
      'generation-fixed',
      managedReferenceId,
      GENERATION_RECEIPT_SHA,
      '2026-10-20T12:07:00.000Z',
    )
    expect(() => {
      store.markGenerationUnknown(
        current,
        'generation-fixed',
        managedReferenceId,
        null,
        '2026-10-20T12:07:01.000Z',
      )
    }).toThrow(expect.objectContaining(expectCode('invalid-transition')))
    expect(store.inspect(current).generationRecovery).toMatchObject({
      state: 'settled',
      guardEvidenceSha256: GUARD_EVIDENCE_SHA,
      reconciliationEvidenceSha256: RECONCILIATION_EVIDENCE_SHA,
      receiptSha256: GENERATION_RECEIPT_SHA,
    })
    expect(store.listEvents(current).map(event => event.type)).toEqual([
      'grant', 'upload_claim', 'upload_settle', 'generation_claim', 'generation_unknown',
    ])
    expect(store.listGenerationRecoveryEvents(current).map(event => event.type)).toEqual([
      'recovery_authorized', 'recovery_claim', 'recovery_settle',
    ])
    store.close()

    const db = new DatabaseSync(path)
    try {
      expect(() => {
        db.exec("UPDATE character_reference_qa_generation_recovery_events SET actor_id = 'other'")
      }).toThrow(/append-only/u)
      expect(() => { db.exec('DELETE FROM character_reference_qa_generation_recovery_events') })
        .toThrow(/append-only/u)
    } finally {
      db.close()
    }
  })

  it('never grants a second recovery after the recovery outcome is unknown', async () => {
    const { store } = await opened()
    const current = binding()
    store.appendGrant(grant())
    const managedReferenceId = establishUnknownGeneration(store)
    authorizeRecovery(store, managedReferenceId)
    expect(store.claimGeneration(
      current,
      'generation-fixed',
      managedReferenceId,
      '2026-10-20T12:06:00.000Z',
    )).toMatchObject({ action: 'send' })
    store.markGenerationUnknown(
      current,
      'generation-fixed',
      managedReferenceId,
      null,
      '2026-10-20T12:07:00.000Z',
    )
    expect(() => {
      store.settleGeneration(
        current,
        'generation-fixed',
        managedReferenceId,
        GENERATION_RECEIPT_SHA,
        '2026-10-20T12:07:01.000Z',
      )
    }).toThrow(expect.objectContaining(expectCode('invalid-transition')))

    expect(store.claimGeneration(
      current,
      'generation-fixed',
      managedReferenceId,
      '2026-10-20T12:08:00.000Z',
    )).toMatchObject({ action: 'reconcile', state: 'unknown' })
    expect(authorizeRecovery(store, managedReferenceId, {
      occurredAt: '2026-10-20T12:08:01.000Z',
    })).toMatchObject({ state: 'unknown' })
    expect(() => authorizeRecovery(store, managedReferenceId, {
      reconciliationEvidenceSha256: 'f'.repeat(64),
      occurredAt: '2026-10-20T12:08:02.000Z',
    })).toThrow(expect.objectContaining(expectCode('already-consumed')))
    expect(store.listGenerationRecoveryEvents(current).map(event => event.type)).toEqual([
      'recovery_authorized', 'recovery_claim', 'recovery_unknown',
    ])
    store.close()
  })

  it('atomically migrates schema v1 without changing canonical events and permits recovery', async () => {
    const { store, path, root } = await opened()
    const current = binding()
    store.appendGrant(grant())
    const managedReferenceId = establishUnknownGeneration(store)
    const originalEvents = store.listEvents(current)
    store.close()

    const legacy = new DatabaseSync(path)
    try {
      legacy.exec('DROP TABLE character_reference_qa_generation_recovery_events')
      legacy.exec('PRAGMA user_version = 1')
    } finally {
      legacy.close()
    }

    const migrated = await openCharacterReferenceQaAuthorizationStore({ dataRoot: root, databasePath: path })
    if (migrated === undefined) throw new Error('v1 database unexpectedly disabled the store')
    expect(migrated.listEvents(current)).toEqual(originalEvents)
    expect(migrated.listGenerationRecoveryEvents(current)).toEqual([])
    authorizeRecovery(migrated, managedReferenceId)
    expect(migrated.claimGeneration(
      current,
      'generation-fixed',
      managedReferenceId,
      '2026-10-20T12:06:00.000Z',
    )).toMatchObject({ action: 'send', state: 'claimed' })
    migrated.close()

    const verified = new DatabaseSync(path)
    try {
      expect((verified.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
        .toBe(CHARACTER_REFERENCE_QA_SCHEMA_VERSION)
    } finally {
      verified.close()
    }
  })

  it('commits each short transaction before an external caller can continue work', async () => {
    const { store, path, root } = await opened()
    const current = binding()
    store.appendGrant(grant())
    const claim = store.claimManagedUpload(current, 'upload-fixed', '2026-10-20T12:01:00.000Z')

    // A second connection can read and append the terminal event immediately;
    // no transaction is held across the caller's external upload interval.
    const second = await openCharacterReferenceQaAuthorizationStore({ dataRoot: root, databasePath: path })
    if (second === undefined) throw new Error('existing absolute path unexpectedly disabled the store')
    expect(second.inspect(current)).toMatchObject({ upload: { state: 'claimed' } })
    second.settleManagedUpload(
      current,
      'upload-fixed',
      claim.managedReferenceId,
      'https://example.invalid/reference.png',
      IMAGE_SHA,
      RECEIPT_SHA,
      '2026-10-20T12:02:00.000Z',
    )
    expect(store.inspect(current)).toMatchObject({ upload: { state: 'settled' } })
    second.close()
    store.close()
  })
  it('rejects invalid grant and binding identities, duplicate revocation and closed stores', async () => {
    const { store } = await opened()
    for (const patch of [{ authorizationVersion: 0 }, { projectId: 0 }, { environment: 'other' },
      { actorId: 'contains\u0000control' }, { createdAt: 'invalid' }]) {
      expect(() => { store.appendGrant({ ...grant(), ...patch }) }).toThrow()
    }
    store.appendGrant(grant())
    for (const patch of [{ authorizationVersion: 0 }, { projectId: 0 }]) {
      expect(() => store.inspect({ ...binding(), ...patch })).toThrow()
    }
    expect(() => store.claimManagedUpload(binding(), 'a'.repeat(201), CREATED_AT)).toThrow('too long')
    expect(() => store.requireManagedReference(binding())).toThrow('has not settled')
    store.appendRevocation(binding(), ACTOR_ID, 'withdrawn', CREATED_AT)
    expect(() => { store.appendRevocation(binding(), ACTOR_ID, 'withdrawn', CREATED_AT) }).toThrow('already revoked')
    expect(() => store.requireManagedReference(binding())).toThrow('revoked')
    store.close()
    store.close()
    expect(() => store.inspect(binding())).toThrow('closed')
  })

  it('keeps private grants bound to one account and blocks renewal while an earlier attempt is unresolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'private-reference-grants-'))
    dirs.push(root)
    const store = await openCharacterReferenceQaAuthorizationStore({ dataRoot: root,
      databasePath: join(root, 'private.sqlite'), environment: 'project_private' })
    if (store === undefined) throw new Error('private store unavailable')
    stores.push(store)
    const value = grant({ environment: 'project_private', scope: 'one_project_private_upload_and_generation',
      actorId: JSON.stringify(['account', 'session']) })
    expect(() => { store.appendGrant(grant()) }).toThrow('environment differs')
    for (const actorId of ['not-json', '{}', '[]', '[1,"session"]', '["","session"]', '["account",1]', '["account",""]']) {
      expect(() => { store.appendGrant({ ...value, actorId }) }).toThrow('verified account and Session')
    }
    store.appendGrant(value)
    expect(() => { store.appendGrant({ ...value, authorizationVersion: 2, actorId: JSON.stringify(['other-account', 'session']) }) })
      .toThrow('another Muse account')
    const current = binding(value)
    const claim = store.claimManagedUpload(current, 'upload', CREATED_AT)
    expect(() => { store.appendGrant({ ...value, authorizationVersion: 2 }) }).toThrow('requires read-only reconciliation')
    store.markManagedUploadUnknown(current, 'upload', claim.managedReferenceId, null, CREATED_AT)
    expect(() => { store.appendGrant({ ...value, authorizationVersion: 2 }) }).toThrow('requires read-only reconciliation')
    store.appendGrant({ ...value, authorizationVersion: 2, characterId: 'another-character' })
    store.close()
  })

  it('does not overwrite failed or terminal upload and generation evidence', async () => {
    const { store } = await opened()
    store.appendGrant(grant())
    const current = binding()
    expect(() => { store.markManagedUploadUnknown(current, 'upload', 'missing', null, CREATED_AT) }).toThrow('not been claimed')
    const id = settleUpload(store)
    expect(() => { store.markManagedUploadUnknown(current, 'upload-fixed', id, null, CREATED_AT) }).toThrow('terminal event')
    expect(() => store.claimGeneration(current, 'generation', 'other', CREATED_AT)).toThrow('authorized upload')
    expect(() => authorizeRecovery(store, id)).toThrow('requires an unknown')
    store.claimGeneration(current, 'generation-fixed', id, CREATED_AT)
    store.markGenerationUnknown(current, 'generation-fixed', id, null, CREATED_AT)
    expect(() => { store.markGenerationUnknown(current, 'generation-fixed', id, null, CREATED_AT) }).toThrow('terminal event')
    store.close()
  })

  it('refuses foreign application IDs, unsupported schemas and extra or missing tables without rewriting them', async () => {
    for (const setup of [
      'PRAGMA application_id = 7',
      'CREATE TABLE unrelated (id INTEGER)',
      'PRAGMA application_id = 1146310977; PRAGMA user_version = 9',
      'PRAGMA application_id = 1146310977; PRAGMA user_version = 2; CREATE TABLE unexpected (id INTEGER)',
      'PRAGMA application_id = 1146310977; PRAGMA user_version = 2',
    ]) {
      const root = await mkdtemp(join(tmpdir(), 'foreign-reference-db-'))
      dirs.push(root)
      const path = join(root, 'authorization.sqlite')
      const db = new DatabaseSync(path)
      db.exec(setup)
      db.close()
      await chmod(path, 0o600)
      await expect(openCharacterReferenceQaAuthorizationStore({ dataRoot: root, databasePath: path })).rejects.toMatchObject({ code: 'foreign-database' })
    }
    const { store, root, path } = await opened()
    store.close()
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE unexpected (id INTEGER)')
    db.close()
    await expect(openCharacterReferenceQaAuthorizationStore({ dataRoot: root, databasePath: path })).rejects.toThrow('unexpected: unexpected; missing: none')
  })

  it('rejects a non-file SQLite sidecar on every platform', async () => {
    const root = await mkdtemp(join(tmpdir(), 'character-reference-qa-sidecar-'))
    dirs.push(root)
    const path = join(root, 'authorization.sqlite')
    await mkdir(path + '-wal')
    await expect(openCharacterReferenceQaAuthorizationStore({ dataRoot: root, databasePath: path }))
      .rejects.toThrow('real file')
  })

  it('refuses non-file and symlink entries and insecure SQLite sidecars', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reference-db-path-'))
    dirs.push(root)
    const path = join(root, 'authorization.sqlite')
    await mkdir(path, { mode: 0o700 })
    await expect(openCharacterReferenceQaAuthorizationStore({ dataRoot: root, databasePath: path })).rejects.toThrow('real file')
    await rm(path, { recursive: true })
    await mkdir(path + '-wal', { mode: 0o700 })
    await expect(openCharacterReferenceQaAuthorizationStore({ dataRoot: root, databasePath: path }))
      .rejects.toThrow('SQLite wal sidecar must be a real file')
    await rm(path + '-wal', { recursive: true })
    await rm(path)
    if (process.platform !== 'win32') {
      await symlink(join(root, 'elsewhere'), path)
      await expect(openCharacterReferenceQaAuthorizationStore({ dataRoot: root, databasePath: path })).rejects.toThrow('real file')
      await rm(path)
      await writeFile(path + '-wal', '', { mode: 0o644 })
      await expect(openCharacterReferenceQaAuthorizationStore({ dataRoot: root, databasePath: path })).rejects.toThrow('accessible beyond its owner')
    }
    const fileRoot = join(root, 'not-a-directory')
    await writeFile(fileRoot, 'blocked')
    await expect(openCharacterReferenceQaAuthorizationStore({ dataRoot: fileRoot, databasePath: join(fileRoot, 'db.sqlite') }))
      .rejects.toMatchObject({ code: 'invalid-config', cause: { code: 'EEXIST' } })
  })

  it('refuses malformed durable rows and inconsistent managed-reference evidence', async () => {
    const original = await opened()
    original.store.appendGrant(grant())
    const id = establishUnknownGeneration(original.store)
    authorizeRecovery(original.store, id)
    original.store.close()
    const db = new DatabaseSync(':memory:')
    db.prepare('ATTACH DATABASE ? AS original').run(original.path)
    for (const table of ['character_reference_qa_authorizations', 'character_reference_qa_events',
      'character_reference_qa_generation_recovery_events']) {
      db.exec(`CREATE TABLE ${table} AS SELECT * FROM original.${table}`)
    }
    const store = new CharacterReferenceQaAuthorizationStore(db)
    stores.push(store)
    const cases = [
      ["UPDATE character_reference_qa_authorizations SET role_class = 'invalid'", () => store.inspect(binding()), 'role class'],
      ["UPDATE character_reference_qa_authorizations SET actor_id = x'00'", () => store.inspect(binding()), 'actor_id'],
      ["UPDATE character_reference_qa_authorizations SET project_id = 'invalid'", () => store.inspect(binding()), 'project_id'],
      ["UPDATE character_reference_qa_events SET note = x'00'", () => store.inspect(binding()), 'note'],
      ["UPDATE character_reference_qa_events SET event_type = 'invalid'", () => store.inspect(binding()), 'event_type'],
      ["UPDATE character_reference_qa_generation_recovery_events SET event_type = 'invalid'", () => store.inspect(binding()), 'event_type'],
      ["UPDATE character_reference_qa_authorizations SET environment = 'project_private'", () => store.inspect(binding()), 'another Host authorization environment'],
      ["UPDATE character_reference_qa_events SET material_uri = NULL WHERE event_type = 'upload_settle'", () => store.requireManagedReference(binding()), 'missing from append-only evidence'],
      ["UPDATE character_reference_qa_events SET managed_reference_id = 'other' WHERE event_type = 'generation_claim'", () => store.claimGeneration(binding(), 'generation-fixed', id, CREATED_AT), 'fixed claim'],
      ["UPDATE character_reference_qa_generation_recovery_events SET idempotency_key = 'other'", () => store.claimGeneration(binding(), 'generation-fixed', id, CREATED_AT), 'recovery key'],
      ["UPDATE character_reference_qa_generation_recovery_events SET managed_reference_id = 'other'", () => store.claimGeneration(binding(), 'generation-fixed', id, CREATED_AT), 'recovery managed reference'],
    ] as const
    for (const [sql, read, message] of cases) {
      db.exec(sql)
      expect(read, sql).toThrow(message)
      for (const table of ['character_reference_qa_authorizations', 'character_reference_qa_events', 'character_reference_qa_generation_recovery_events']) {
        db.exec(`DELETE FROM ${table}; INSERT INTO ${table} SELECT * FROM original.${table}`)
      }
    }
    store.close()
  })

  it('rejects duplicate grants and retains the original transaction failure if rollback also fails', async () => {
    const { store } = await opened()
    store.appendGrant(grant())
    expect(() => { store.appendGrant(grant()) }).toThrow('new immutable grant')
    const exec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'exec')?.value as (this: DatabaseSync, sql: string) => void
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === 'ROLLBACK') throw new Error('rollback unavailable')
      exec.call(this, sql)
    })
    try { expect(() => { store.appendGrant(grant()) }).toThrow('new immutable grant') }
    finally { spy.mockRestore(); store.close() }
  })

  it('renews a private grant only after every earlier upload and generation has settled', async () => {
    for (const state of ['not_started', 'claimed', 'unknown', 'settled'] as const) {
      const root = await mkdtemp(join(tmpdir(), 'reference-private-renewal-'))
      dirs.push(root)
      const store = await openCharacterReferenceQaAuthorizationStore({ dataRoot: root,
        databasePath: join(root, 'authorization.sqlite'), environment: 'project_private' })
      if (store === undefined) throw new Error('private store unavailable')
      stores.push(store)
      const value = grant({ environment: 'project_private', scope: 'one_project_private_upload_and_generation',
        actorId: JSON.stringify(['account', 'session']), roleClass: 'lead' })
      store.appendGrant(value)
      const current = binding(value)
      const id = settleUpload(store, current)
      if (state !== 'not_started') store.claimGeneration(current, 'generation-fixed', id, CREATED_AT)
      if (state === 'unknown') store.markGenerationUnknown(current, 'generation-fixed', id, null, CREATED_AT)
      if (state === 'settled') store.settleGeneration(current, 'generation-fixed', id, GENERATION_RECEIPT_SHA, CREATED_AT)
      if (state === 'claimed' || state === 'unknown') {
        expect(() => { store.appendGrant({ ...value, authorizationVersion: 2 }) }).toThrow('requires read-only reconciliation')
      } else {
        expect(() => { store.appendGrant({ ...value, authorizationVersion: 2 }) }).not.toThrow()
      }
      store.close()
    }
  })

})
