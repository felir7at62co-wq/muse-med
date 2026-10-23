import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CharacterReferenceAuthority } from '@deepseek-ai/dsh-tool-character-reference'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHARACTER_REFERENCE_PRIVATE_ENVIRONMENT,
  CHARACTER_REFERENCE_PRIVATE_SCOPE,
  openCharacterReferenceQaAuthorizationStore,
} from '../src/character-reference-qa-authorization.ts'
import { createCharacterReferenceQaBridge } from '../src/character-reference-qa-bridge.ts'
import {
  authorizeProjectPrivateCharacterReference,
  type ProjectPrivateQuestionService,
} from '../src/character-reference-private-authorize.ts'

const directories: string[] = []
const image = new Uint8Array(24)
image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
const dimensions = new DataView(image.buffer)
dimensions.setUint32(8, 13)
image.set([0x49, 0x48, 0x44, 0x52], 12)
dimensions.setUint32(16, 1024)
dimensions.setUint32(20, 1536)
const sha = createHash('sha256').update(image).digest('hex')
const owner = { session: { id: 'session-owner' } as Session }
const other = { id: 'session-other' } as Session
const ownerId = JSON.stringify(['muse-owner', owner.session.id])
const request = {
  scriptId: 4661,
  characterId: 'char_wangzongjian',
  catalogAssetId: 'character:fixture:male006',
  imageSha256: sha,
}
const reference = {
  projectDirectory: 'C:/fixture/project-4661',
  scriptId: request.scriptId,
  characterId: request.characterId,
  characterName: '王总监',
  roleClass: 'important_support' as const,
  catalogAssetId: request.catalogAssetId,
  imageSha256: sha,
  metadataStatus: 'pending_review' as const,
  contentType: 'image/png' as const,
  data: image,
}

afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'character-private-'))
  directories.push(root)
  const store = await openCharacterReferenceQaAuthorizationStore({
    dataRoot: root,
    databasePath: join(root, 'private.sqlite'),
    environment: CHARACTER_REFERENCE_PRIVATE_ENVIRONMENT,
  })
  if (store === undefined) throw new Error('private ledger did not open')
  const read = vi.fn(async () => reference)
  const authority: CharacterReferenceAuthority = { read }
  return { store, authority, read }
}

describe('project-private owner attestation', () => {
  it('asks the live user, binds exact project/role/SHA, and never grants public use', async () => {
    const { store, authority, read } = await fixture()
    const ask = vi.fn(async (input: Parameters<ProjectPrivateQuestionService['ask']>[0]) => {
      expect(input.questions[0]?.detail).toContain(sha)
      return { answers: [{ id: 'character-reference-private-rights',
        selected: ['确认：我委托生成并亲自上传此图，拥有本项目参考生图权利'] }] }
    })
    const result = await authorizeProjectPrivateCharacterReference({
      authority, store, questions: { ask }, agent: owner, ownerId,
      verifyOwner: async () => ownerId, request,
      now: () => new Date('2026-10-21T10:00:00.000Z'),
    })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ script_id: 4661, character_id: request.characterId,
      image_sha256: sha, scope: CHARACTER_REFERENCE_PRIVATE_SCOPE,
      can_publish: false, can_formally_bind: false, can_cross_project_reuse: false })
    const binding = {
      authorizationId: result.authorization_id,
      authorizationVersion: 1,
      projectId: request.scriptId,
      characterId: request.characterId,
      roleClass: reference.roleClass,
      catalogId: request.catalogAssetId,
      imageSha256: sha,
      catalogStatus: 'pending_review' as const,
    }
    const state = store.inspect(binding)
    expect(state.grant).toMatchObject({ environment: CHARACTER_REFERENCE_PRIVATE_ENVIRONMENT,
      actorId: ownerId, productionApproved: false, allowPublish: false,
      allowFormalBind: false, allowCrossProjectReuse: false, maxGenerationUses: 1 })
    expect(() => { store.appendGrant({ ...state.grant, authorizationId: 'other-owner-grant',
      actorId: JSON.stringify(['other-muse-user', 'session-other']),
      reviewerId: 'self-attested:other-muse-user' }) })
      .toThrow('already claimed by another Muse account')

    const upload = vi.fn(async () => ({ materialUrl: 'https://example.invalid/private.png',
      reencoded: false, sha256: `sha256:${sha}` }))
    const bridge = createCharacterReferenceQaBridge({ authority, store, upload,
      ownerIdentity: async session => JSON.stringify(['muse-owner', session.id]) })
    const uploadRequest = { ...request, authorizationId: result.authorization_id,
      authorizationVersion: 1, idempotencyKey: 'private-upload-1' }
    await expect(bridge.upload(other, uploadRequest)).rejects.toThrow('another Muse account or conversation')
    const differentAccount = createCharacterReferenceQaBridge({ authority, store, upload,
      ownerIdentity: async session => JSON.stringify(['different-account', session.id]) })
    await expect(differentAccount.upload(owner.session, uploadRequest)).rejects.toThrow('another Muse account')
    await expect(bridge.upload(owner.session, { ...uploadRequest, scriptId: 4609 })).rejects.toThrow()
    expect(upload).not.toHaveBeenCalled()
    const managed = await bridge.upload(owner.session, uploadRequest)
    expect(upload).toHaveBeenCalledTimes(1)
    const generation = await bridge.prepareGeneration(owner.session, {
      ...uploadRequest, managedReferenceId: managed.managed_reference_id,
      idempotencyKey: 'private-generation-1',
    })
    await generation.beforeReserve()
    generation.settleUnknown({ error_class: 'transport' })
    const repeated = await bridge.prepareGeneration(owner.session, {
      ...uploadRequest, managedReferenceId: managed.managed_reference_id,
      idempotencyKey: 'private-generation-2',
    })
    await expect(repeated.beforeReserve()).rejects.toMatchObject({ code: 'already-consumed' })
    expect(store.inspect(binding).generation.state).toBe('unknown')
    expect(() => { store.appendGrant({ ...state.grant,
      authorizationId: 'same-owner-new-key', actorId: JSON.stringify(['muse-owner', 'another-session']) }) })
      .toThrow('still requires read-only reconciliation')
    store.close()
  })

  it('does not create a grant after decline, missing answer, or changed image', async () => {
    for (const selected of ['取消，不授权', '其他']) {
      const { store, authority } = await fixture()
      await expect(authorizeProjectPrivateCharacterReference({
        authority, store,
        questions: { ask: async () => ({ answers: [{ id: 'character-reference-private-rights', selected: [selected] }] }) },
        agent: owner, ownerId, verifyOwner: async () => ownerId, request,
      })).rejects.toThrow('did not explicitly authorize')
      store.close()
    }
    const { store } = await fixture()
    let calls = 0
    const authority: CharacterReferenceAuthority = { read: async () => {
      calls++
      return calls === 1 ? reference : { ...reference, imageSha256: 'b'.repeat(64) }
    } }
    await expect(authorizeProjectPrivateCharacterReference({
      authority, store,
      questions: { ask: async () => ({ answers: [{ id: 'character-reference-private-rights',
        selected: ['确认：我委托生成并亲自上传此图，拥有本项目参考生图权利'] }] }) },
      agent: owner, ownerId, verifyOwner: async () => ownerId, request,
    })).rejects.toThrow('changed while awaiting')
    store.close()
  })
})
