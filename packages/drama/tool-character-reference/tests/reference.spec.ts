import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type {
  CharacterLibraryEntry,
  CharacterLibraryPreview,
  CharacterLibraryPreviewRequest,
  CharacterMatchResult,
  CharacterRecommendationRequest,
  CharacterRoleClass,
} from '@deepseek-ai/dsh-character-library'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import * as CharacterReferenceTool from '../src/index.ts'
import {
  matchCharacterReferences,
  type CharacterLibraryMatcher,
  type CharacterRoleAuthority,
  type CharacterReferenceRequest,
} from '../src/reference.ts'

function entry(overrides: Partial<CharacterLibraryEntry> = {}): CharacterLibraryEntry {
  return {
    catalogAssetId: 'character:muse-character-reference-qa:char_3d_0003',
    originalAssetId: 'char_3d_0003',
    collection: 'urban',
    format: 'phase1_v2',
    metadataStatus: 'pending_review',
    metadataKey: 'secret/metadata.json',
    imageKey: 'secret/face.jpg',
    category: '甜宠女主',
    setting: 'modern',
    artStyle: 'stylized',
    era: ['modern'],
    gender: 'female',
    appearance: ['温柔', '少女感'],
    tags: ['甜妹'],
    safety: { canPublish: false, canReuse: false, canBind: false, applyAllowed: false },
    ...overrides,
  } as CharacterLibraryEntry
}

const request: CharacterReferenceRequest = {
  character_id: 'heroine',
  role_description: '现代甜宠女主，年轻，温柔，有少女感',
  role_class: 'lead',
  collection: 'urban',
  required_era: 'modern',
  gender: 'female',
  style_terms: ['stylized'],
  trait_terms: ['温柔', '少女感'],
  role_terms: ['甜宠女主'],
}

const PROJECT = '/current-project'
const IMAGE_SHA = 'a'.repeat(64)

function authority(roleClass: CharacterRoleClass = 'lead') {
  const read = vi.fn(async (
    _projectDirectory: string,
    characterId: string,
    _signal?: AbortSignal,
  ) => ({ characterId, roleClass }))
  return { read } satisfies CharacterRoleAuthority
}

function fake(result: CharacterMatchResult) {
  const matchCandidates = vi.fn(async (
    _request: CharacterRecommendationRequest,
    _signal?: AbortSignal,
  ) => result)
  return { matchCandidates } satisfies CharacterLibraryMatcher
}

function candidatesResult(overrides: Partial<CharacterLibraryEntry> = {}): CharacterMatchResult {
  return {
    status: 'candidates',
    candidates: [{ entry: entry(overrides), score: 12, matched: ['era', 'trait:少女感'], imageSha256: IMAGE_SHA }],
    reason: 'Metadata-ranked candidates for visual inspection.',
    uncertainties: ['metadata_status:pending_review'],
    applyAllowed: false,
  }
}

it('returns bounded pending candidates with measured image identity and no use permission', async () => {
  const library = fake(candidatesResult())
  const roles = authority()
  const signal = new AbortController().signal
  const result = await matchCharacterReferences(library, roles, PROJECT, request, signal)

  expect(roles.read).toHaveBeenCalledWith(PROJECT, 'heroine', signal)

  expect(library.matchCandidates).toHaveBeenCalledWith({
    roleClass: 'lead',
    collection: 'urban',
    query: request.role_description,
    requiredEra: 'modern',
    gender: 'female',
    styleTerms: ['stylized'],
    traitTerms: ['温柔', '少女感'],
    roleTerms: ['甜宠女主'],
  }, signal)
  expect(result).toMatchObject({
    status: 'candidates',
    character_id: 'heroine',
    candidates: [{
      catalog_asset_id: 'character:muse-character-reference-qa:char_3d_0003',
      original_asset_id: 'char_3d_0003',
      image_sha256: IMAGE_SHA,
      metadata_status: 'pending_review',
      matched_evidence: ['era', 'trait:少女感'],
    }],
    read_only: true,
    can_publish: false,
    can_reuse: false,
    can_bind: false,
    apply_allowed: false,
    local_writes: 0,
    remote_writes: 0,
    paid_requests: 0,
  })
  expect(JSON.stringify(result)).not.toMatch(/metadataKey|imageKey|secret\/|preview_path|metadata_path/)
})

it('returns tied candidates for Agent image comparison and preserves no-match', async () => {
  const tied = fake({
    status: 'candidates',
    candidates: [
      { entry: entry(), score: 4, matched: ['trait:温柔'], imageSha256: IMAGE_SHA },
      { entry: entry({ catalogAssetId: 'character:muse-character-reference-qa:char_3d_0004' as CharacterLibraryEntry['catalogAssetId'],
        originalAssetId: 'char_3d_0004' as CharacterLibraryEntry['originalAssetId'] }),
      score: 4, matched: ['trait:温柔'], imageSha256: IMAGE_SHA },
    ],
    reason: 'Top candidates tie.',
    uncertainties: ['metadata_status:pending_review'],
    applyAllowed: false,
  })
  const review = await matchCharacterReferences(tied, authority(), PROJECT, request)
  expect(review).toMatchObject({ status: 'candidates', character_id: 'heroine',
    reason: 'Top candidates tie.', can_bind: false, apply_allowed: false })
  expect(review.candidates.map(candidate => candidate.catalog_asset_id)).toEqual([
    'character:muse-character-reference-qa:char_3d_0003',
    'character:muse-character-reference-qa:char_3d_0004',
  ])

  const none = await matchCharacterReferences(fake({
    status: 'no_match', reason: 'No reliable match.', uncertainties: ['era_unconfirmed'], applyAllowed: false,
  }), authority(), PROJECT, request)
  expect(none).toMatchObject({ status: 'no_match', reason: 'No reliable match.',
    uncertainty: ['era_unconfirmed'], apply_allowed: false })
  expect(none.candidates).toEqual([])
})

it('rejects an unbounded or unverified Host candidate result before model output', async () => {
  const unbounded = fake({
    status: 'candidates',
    candidates: Array.from({ length: 4 }, (_, index) => ({
      entry: entry({ originalAssetId: `char_3d_${index}` as CharacterLibraryEntry['originalAssetId'] }),
      score: 4 - index,
      matched: [],
      imageSha256: IMAGE_SHA,
    })),
    reason: 'invalid unbounded result',
    uncertainties: [],
    applyAllowed: false,
  })
  await expect(matchCharacterReferences(unbounded, authority(), PROJECT, request))
    .rejects.toThrow('one to three bounded candidates')

  const unverified = fake({
    status: 'candidates',
    candidates: [{ entry: entry(), score: 1, matched: [], imageSha256: 'unverified' }],
    reason: 'invalid image digest',
    uncertainties: [],
    applyAllowed: false,
  })
  await expect(matchCharacterReferences(unverified, authority(), PROJECT, request))
    .rejects.toThrow('verified image SHA-256')
})

it('forwards a supporting-role exception and omits absent optional filters', async () => {
  const library = fake({ status: 'no_match', reason: 'Skipped.', uncertainties: [], applyAllowed: false })
  await matchCharacterReferences(library, authority('important_support'), PROJECT, {
    character_id: 'support-01',
    role_description: '古装冷峻男主身边的重要护卫',
    role_class: 'important_support',
    supporting_use_reason: '与主角长期同框，需要稳定人物参考',
  })
  expect(library.matchCandidates).toHaveBeenCalledWith({
    roleClass: 'important_support',
    supportingUseReason: '与主角长期同框，需要稳定人物参考',
    query: '古装冷峻男主身边的重要护卫',
  }, undefined)
})

it('rejects malformed tool input before calling the Host service', async () => {
  const library = fake({ status: 'no_match', reason: 'unused', uncertainties: [], applyAllowed: false })
  const roles = authority()
  const cases: CharacterReferenceRequest[] = [
    { ...request, character_id: ' ' },
    { ...request, character_id: 'bad\u0000id' },
    { ...request, role_description: ' ' },
    { ...request, role_description: '角'.repeat(201) },
    { ...request, supporting_use_reason: ' ' },
    { ...request, required_era: '年'.repeat(81) },
    { ...request, gender: '性'.repeat(81) },
    { ...request, style_terms: Array.from({ length: 17 }, () => 'x') },
    { ...request, style_terms: [1] as never },
    { ...request, style_terms: ['bad\u2028term'] },
    { ...request, trait_terms: [] },
    { ...request, role_terms: [' '] },
  ]
  for (const value of cases.filter(value => value.trait_terms?.length !== 0)) {
    await expect(matchCharacterReferences(library, roles, PROJECT, value)).rejects.toThrow(/bounded|at most 16/)
  }
  await expect(matchCharacterReferences(library,
    roles, PROJECT, cases.find(value => value.trait_terms?.length === 0)!)).resolves.toMatchObject({ status: 'no_match' })
  expect(library.matchCandidates).toHaveBeenCalledTimes(1)
})

it('fails closed on missing or conflicting authoritative project role before library access', async () => {
  const library = fake(candidatesResult())
  const missingRole: CharacterRoleAuthority = {
    read: vi.fn(async () => { throw new Error('current project character has no role_class') }),
  }
  await expect(matchCharacterReferences(library, missingRole, PROJECT, request))
    .rejects.toThrow('no role_class')

  const wrongRole = authority('support')
  await expect(matchCharacterReferences(library, wrongRole, PROJECT, request))
    .rejects.toThrow('conflicts with the current project bible')

  const absentCharacter: CharacterRoleAuthority = {
    read: vi.fn(async () => { throw new Error('character_id does not identify a project character') }),
  }
  await expect(matchCharacterReferences(library, absentCharacter, PROJECT, request))
    .rejects.toThrow('does not identify')

  await expect(matchCharacterReferences(library, authority(), PROJECT, {
    ...request, role_class: undefined as never,
  })).rejects.toThrow('valid role_class')
  await expect(matchCharacterReferences(library, authority(), PROJECT, {
    ...request, character_id: undefined as never,
  })).rejects.toThrow('bounded character_id')
  expect(library.matchCandidates).not.toHaveBeenCalled()
})

it('stops before the service when the execution signal is already aborted', async () => {
  const library = fake(candidatesResult())
  const roles = authority()
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await expect(matchCharacterReferences(library, roles, PROJECT, request, controller.signal)).rejects.toThrow('cancelled')
  expect(roles.read).not.toHaveBeenCalled()
  expect(library.matchCandidates).not.toHaveBeenCalled()
})

it('registers bounded search and image view in a Cordis composition', async () => {
  const calls: CharacterRecommendationRequest[] = []
  const previewCalls: CharacterLibraryPreviewRequest[] = []
  let previewCatalogId = entry().catalogAssetId
  let previewSha = IMAGE_SHA
  let previewMetadataStatus: CharacterLibraryPreview['metadataStatus'] = 'pending_review'
  class FakeCharacterLibrary extends Service {
    constructor(ctx: Context) { super(ctx, 'characterLibrary') }
    async matchCandidates(value: CharacterRecommendationRequest): Promise<CharacterMatchResult> {
      calls.push(value)
      return candidatesResult()
    }
    async preview(value: CharacterLibraryPreviewRequest): Promise<CharacterLibraryPreview> {
      previewCalls.push(value)
      return {
        catalogAssetId: previewCatalogId,
        metadataStatus: previewMetadataStatus,
        data: Uint8Array.of(137, 80, 78, 71),
        contentType: 'image/png',
        bytes: 4,
        sha256: previewSha,
        safety: { canPublish: false, canReuse: false, canBind: false, applyAllowed: false },
      }
    }
  }
  class FakeAttachments extends AttachmentStore {
    readonly imageLimits = {
      maxImageBytes: 1024,
      maxImagesPerMessage: 1,
      maxMessageImageBytes: 1024,
      maxImagePixels: 1_000_000,
      maxImageDimension: 1000,
      mediaTypes: ['image/png'] as ('image/png' | 'image/jpeg')[],
    }
    readonly saved: SaveImageAttachment[] = []
    includeDetails = false
    async validateImage(_input: SaveImageAttachment): Promise<void> {}
    async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
      this.saved.push(input)
      return { attachmentId: AttachmentId('character-image-1'), mediaType: 'image/png',
        bytes: input.data.byteLength, width: 1, height: 1,
        ...(this.includeDetails ? { name: 'candidate.png', originalDimensions: { width: 1, height: 1 } } : {}),
      }
    }
    async readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
      throw new Error('not used by this tool test')
    }
  }
  class FakeSettings extends Service {
    constructor(ctx: Context) { super(ctx, 'settings') }
    describe() {
      return [{
        ns: 'drama-settings',
        value: {
          seriesBudgetCents: 400_000,
          deliverySpec: { width: 1440, height: 2560, fps: 60, minBitrateMbps: 4.6 },
        },
      }]
    }
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-character-reference-role-')))
  const configPath = join(root, 'project_config.json')
  const recordSecret = 'DO_NOT_LEAK_PROJECT_CHARACTER_RECORD'
  const config = (characters?: readonly object[]): string => `${JSON.stringify({
    project_bible: {
      schema_version: 1,
      revision: 1,
      initial_budget_cents: 400_000,
      delivery: { width: 1440, height: 2560, fps: 60, min_bitrate_mbps: 4.6 },
      ...(characters === undefined ? {} : { characters }),
    },
  }, null, 2)}\n`
  const ctx = new Context()
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
  try {
    await mountAgentLoopTestDependencies(ctx)
    const settingsFiber = await ctx.plugin(FakeSettings)
    await settingsFiber.await()
    const libraryFiber = await ctx.plugin(FakeCharacterLibrary)
    await libraryFiber.await()
    const attachmentFiber = await ctx.plugin(FakeAttachments)
    await attachmentFiber.await()
    const characterToolFiber = await ctx.plugin(CharacterReferenceTool)
    await characterToolFiber.await()
    const harness = await mountAgentLoopTestHarness(ctx)
    const agentWithoutCwd = await harness.create(SessionId('character-reference-without-cwd'))
    const projectAgent = await harness.create(SessionId('character-reference-current-project'), {}, { cwd: root })
    const definitions = ctx.tools.schemas()
    expect(definitions.map(value => value.name)).toEqual([
      'drama_character_references', 'drama_character_reference_view',
    ])
    const definition = ctx.tools.get('drama_character_references')
    if (!definition) throw new Error('Missing character reference tool')
    expect(Object.keys(definition.parameters.properties ?? {})).toEqual([
      'character_id', 'role_description', 'role_class', 'supporting_use_reason', 'collection',
      'required_era', 'gender', 'style_terms', 'trait_terms', 'role_terms',
    ])
    expect(JSON.stringify(definition.parameters)).not.toMatch(/path|key|index|upload/i)
    expect(validateJsonSchemaValue(definition.parameters, request, '')).toEqual([])
    const run = async (
      id: string,
      argumentsValue: CharacterReferenceRequest,
      agent?: typeof projectAgent,
    ) => await ctx.tools.execute({
      callId: ToolCallId(id), name: 'drama_character_references', arguments: argumentsValue,
      ...(agent === undefined ? {} : { agent }), signal: new AbortController().signal,
    })
    const expectRejectedBeforeLibrary = async (
      id: string,
      argumentsValue: CharacterReferenceRequest,
      agent?: typeof projectAgent,
    ): Promise<void> => {
      const before = calls.length
      const outcome = await run(id, argumentsValue, agent)
      expect(outcome.isError).toBe(true)
      expect(calls).toHaveLength(before)
      expect(JSON.stringify(outcome.content)).not.toContain(root)
      expect(JSON.stringify(outcome.content)).not.toContain(recordSecret)
    }

    await writeFile(configPath, config([{ character_id: 'heroine', name: recordSecret, role_class: 'lead' }]))
    await expectRejectedBeforeLibrary('character-reference-without-agent', request)
    await expectRejectedBeforeLibrary('character-reference-without-cwd', request, agentWithoutCwd)
    await expectRejectedBeforeLibrary('character-reference-without-character-id', {
      ...request,
      character_id: undefined as never,
    }, projectAgent)
    await expectRejectedBeforeLibrary('character-reference-without-role-class', {
      ...request,
      role_class: undefined as never,
    }, projectAgent)

    await writeFile(configPath, '{}\n')
    await expectRejectedBeforeLibrary('character-reference-unconfigured', request, projectAgent)

    await writeFile(configPath, '{ invalid json\n')
    await expectRejectedBeforeLibrary('character-reference-unreadable-project', request, projectAgent)

    await writeFile(configPath, config())
    await expectRejectedBeforeLibrary('character-reference-without-characters', request, projectAgent)

    await writeFile(configPath, config([{ character_id: 'someone-else', name: recordSecret, role_class: 'lead' }]))
    await expectRejectedBeforeLibrary('character-reference-missing-character', request, projectAgent)

    await writeFile(configPath, config([{ character_id: 'heroine', name: recordSecret }]))
    await expectRejectedBeforeLibrary('character-reference-missing-role', request, projectAgent)

    await writeFile(configPath, config([{ character_id: 'heroine', name: recordSecret, role_class: 'lead' }]))
    await expectRejectedBeforeLibrary('character-reference-conflicting-role', {
      ...request,
      role_class: 'support',
    }, projectAgent)

    const execution = await run('character-reference-service', request, projectAgent)
    expect(execution.isError, JSON.stringify(execution.content)).not.toBe(true)
    expect(validateJsonSchemaValue(definition.output.schema, execution.value, '')).toEqual([])
    expect(execution.value).toMatchObject({ status: 'candidates',
      candidates: [{ metadata_status: 'pending_review', image_sha256: IMAGE_SHA }],
      can_bind: false, apply_allowed: false })
    expect(execution.content).toEqual([{ type: 'text', text: JSON.stringify(execution.value, null, 2) }])
    expect(calls).toHaveLength(1)
    expect(network).not.toHaveBeenCalled()
    await expect(JSON.stringify({
      tool_names: definitions.map(value => value.name),
      parameter_names: Object.keys(definition.parameters.properties ?? {}),
      result: execution.content,
    }, null, 2) + '\n').toMatchFileSnapshot(fileURLToPath(
      new URL('./expected/reference-model-visible.json', import.meta.url),
    ))

    const visualAgent = await harness.create(SessionId('character-reference-image-route'),
      { provider: 'vision-fixture', model: 'vision-fixture' }, { cwd: root })
    const resolveModelInfo = vi.spyOn(ctx.llm, 'resolveModelInfo').mockResolvedValue({
      provider: 'vision-fixture', id: 'vision-fixture', name: 'Vision fixture',
      inputModalities: ['text', 'image'],
    })
    const view = async (
      id: string,
      sha256 = IMAGE_SHA,
      agent: typeof visualAgent | null = visualAgent,
    ) => await ctx.tools.execute({
      callId: ToolCallId(id),
      name: 'drama_character_reference_view',
      arguments: { catalog_asset_id: entry().catalogAssetId, expected_sha256: sha256 },
      ...(agent === null ? {} : { agent }),
      signal: new AbortController().signal,
    })
    try {
      expect((await view('missing-agent', IMAGE_SHA, null)).isError).toBe(true)
      expect((await view('missing-cwd', IMAGE_SHA, agentWithoutCwd)).isError).toBe(true)
      expect((await view('missing-model', IMAGE_SHA, projectAgent)).isError).toBe(true)
      expect(previewCalls).toHaveLength(0)
      resolveModelInfo.mockResolvedValueOnce({
        provider: 'vision-fixture', id: 'vision-fixture', name: 'Text fixture',
        inputModalities: ['text'],
      })
      expect((await view('text-route')).isError).toBe(true)
      expect(previewCalls).toHaveLength(0)
      expect((await view('bad-sha', 'not-a-sha')).isError).toBe(true)
      expect(previewCalls).toHaveLength(0)

      const imageStore = ctx.attachments as FakeAttachments
      imageStore.imageLimits.maxImagesPerMessage = 0
      expect((await view('image-limit')).isError).toBe(true)
      imageStore.imageLimits.maxImagesPerMessage = 1
      expect(previewCalls).toHaveLength(0)

      imageStore.imageLimits.mediaTypes.splice(0)
      expect((await view('media-type')).isError).toBe(true)
      imageStore.imageLimits.mediaTypes.push('image/png')
      previewCalls.length = 0
      expect(imageStore.saved).toHaveLength(0)

      const viewed = await view('verified-image')
      expect(viewed.isError, JSON.stringify(viewed.content)).not.toBe(true)
      expect(viewed.value).toMatchObject({
        catalog_asset_id: entry().catalogAssetId,
        image_sha256: IMAGE_SHA,
        metadata_status: 'pending_review',
        can_bind: false,
        attachment_saved: true,
        tos_writes: 0,
        paid_requests: 0,
      })
      expect(viewed.content).toHaveLength(2)
      expect(viewed.content[0]).toMatchObject({ type: 'text' })
      expect(viewed.content[1]).toMatchObject({ type: 'image',
        attachment: { attachmentId: AttachmentId('character-image-1') } })
      expect(previewCalls).toEqual([{
        catalogAssetId: entry().catalogAssetId,
        expectedSha256: IMAGE_SHA,
        maxBytes: 1024,
      }])
      expect(imageStore.saved).toHaveLength(1)
      expect(JSON.stringify(viewed.content)).not.toMatch(/secret\/|base64|metadataKey|imageKey/u)
      expect(network).not.toHaveBeenCalled()

      previewCatalogId = entry({
        catalogAssetId: 'character:muse-character-reference-qa:char_3d_0004' as CharacterLibraryEntry['catalogAssetId'],
      }).catalogAssetId
      expect((await view('changed-id')).isError).toBe(true)
      previewCatalogId = entry().catalogAssetId
      previewSha = 'b'.repeat(64)
      expect((await view('changed-sha')).isError).toBe(true)
      expect(imageStore.saved).toHaveLength(1)

      previewSha = IMAGE_SHA
      previewMetadataStatus = 'rejected_claim'
      expect((await view('withdrawn-claim')).isError).toBe(true)
      expect(imageStore.saved).toHaveLength(1)
      previewMetadataStatus = 'pending_review'
      imageStore.includeDetails = true
      const detailed = await view('verified-image-with-details')
      expect(detailed.isError).toBe(false)
      expect(detailed.content[1]).toMatchObject({ type: 'image', attachment: {
        name: 'candidate.png', originalDimensions: { width: 1, height: 1 },
      } })
      expect(imageStore.saved).toHaveLength(2)

      await attachmentFiber.dispose()
      expect((await view('missing-attachments')).isError).toBe(true)
    } finally {
      resolveModelInfo.mockRestore()
    }
  } finally {
    network.mockRestore()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
