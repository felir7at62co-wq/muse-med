import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  MAX_PREVIEW_BYTES,
  type CharacterLibraryPreview,
  type CharacterLibraryPreviewRequest,
  type CharacterMatchResult,
  type CharacterRecommendationRequest,
} from '@deepseek-ai/dsh-character-library'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import { expect, it } from 'vitest'
import * as CharacterReferenceTool from '../src/index.ts'

const IMAGE_SHA = 'a'.repeat(64)
const CATALOG_ID = 'character:muse-character-reference-qa:char_fixture_0001'

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

class FakeCharacterLibrary extends Service {
  readonly previewCalls: CharacterLibraryPreviewRequest[] = []
  previewCatalogAssetId = CATALOG_ID
  previewSha256 = IMAGE_SHA
  previewMetadataStatus: CharacterLibraryPreview['metadataStatus'] = 'pending_review'

  constructor(ctx: Context) { super(ctx, 'characterLibrary') }

  async matchCandidates(_request: CharacterRecommendationRequest): Promise<CharacterMatchResult> {
    return { status: 'no_match', reason: 'unused', uncertainties: [], applyAllowed: false }
  }

  async preview(request: CharacterLibraryPreviewRequest): Promise<CharacterLibraryPreview> {
    this.previewCalls.push(request)
    return {
      catalogAssetId: this.previewCatalogAssetId as CharacterLibraryPreview['catalogAssetId'],
      metadataStatus: this.previewMetadataStatus,
      data: Uint8Array.of(137, 80, 78, 71),
      contentType: 'image/png',
      bytes: 4,
      sha256: this.previewSha256,
      safety: { canPublish: false, canReuse: false, canBind: false, applyAllowed: false },
    }
  }
}

function config(scriptId: number, characters: readonly object[]): string {
  return `${JSON.stringify({
    jubian_script_id: scriptId,
    project_bible: {
      schema_version: 1,
      revision: 1,
      title: `Fixture ${scriptId}`,
      initial_budget_cents: 400_000,
      delivery: { width: 1440, height: 2560, fps: 60, min_bitrate_mbps: 4.6 },
      characters,
    },
  }, null, 2)}\n`
}

it('provides a current-project authority that rechecks project, role, and image identity', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-character-reference-authority-')))
  const other = await realpath(await mkdtemp(join(tmpdir(), 'muse-character-reference-other-')))
  const configPath = join(root, 'project_config.json')
  const otherConfigPath = join(other, 'project_config.json')
  await writeFile(configPath, config(91001, [
    { character_id: 'fixture_role', name: 'Fixture Role', role_class: 'important_support' },
  ]))
  await writeFile(otherConfigPath, config(91999, [
    { character_id: 'outside_role', name: 'Outside Role', role_class: 'lead' },
  ]))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const settingsFiber = await ctx.plugin(FakeSettings)
    await settingsFiber.await()
    const libraryFiber = await ctx.plugin(FakeCharacterLibrary)
    await libraryFiber.await()
    const toolFiber = await ctx.plugin(CharacterReferenceTool)
    await toolFiber.await()
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('character-reference-authority'), {}, { cwd: root })
    const library = ctx.characterLibrary
    expect(library).toBeInstanceOf(FakeCharacterLibrary)
    if (!(library instanceof FakeCharacterLibrary)) throw new Error('Missing fake character library')
    const authority = ctx.get('characterReferenceAuthority')
    expect(authority).toBeDefined()
    if (authority === undefined) throw new Error('Missing character reference authority')

    const request = {
      scriptId: 91001,
      characterId: 'fixture_role',
      catalogAssetId: CATALOG_ID,
      expectedSha256: IMAGE_SHA,
      // A caller cannot redirect the Host-owned Session project resolver.
      projectDirectory: other,
    }
    await expect(authority.read(agent.session, { ...request, scriptId: 0 }))
      .rejects.toThrow('valid project identity')
    await expect(authority.read(agent.session, { ...request, expectedSha256: 'not-a-digest' }))
      .rejects.toThrow('verified image SHA-256')
    await expect(authority.read(agent.session, { ...request, characterId: ' ' }))
      .rejects.toThrow('bounded character identity')
    await expect(authority.read(agent.session, { ...request, catalogAssetId: 'bad\u0000id' }))
      .rejects.toThrow('bounded Catalog identity')
    expect(library.previewCalls).toHaveLength(0)
    const result = await authority.read(agent.session, request)
    expect(result).toEqual({
      projectDirectory: root,
      scriptId: 91001,
      characterId: 'fixture_role',
      characterName: 'Fixture Role',
      roleClass: 'important_support',
      catalogAssetId: CATALOG_ID,
      imageSha256: IMAGE_SHA,
      metadataStatus: 'pending_review',
      contentType: 'image/png',
      data: Uint8Array.of(137, 80, 78, 71),
    })
    expect(library.previewCalls).toEqual([{
      catalogAssetId: CATALOG_ID,
      expectedSha256: IMAGE_SHA,
      maxBytes: MAX_PREVIEW_BYTES,
    }])

    await writeFile(configPath, config(91001, [
      { character_id: 'fixture_role', name: 'Fixture Role' },
    ]))
    await expect(authority.read(agent.session, request))
      .rejects.toThrow('current project character to have role_class')
    expect(library.previewCalls).toHaveLength(1)
    await writeFile(configPath, config(91001, [
      { character_id: 'fixture_role', name: 'Fixture Role', role_class: 'important_support' },
    ]))

    const beforeProjectFailures = library.previewCalls.length
    await expect(authority.read(agent.session, { ...request, scriptId: 91002 }))
      .rejects.toThrow('conflicting current project identity')
    await expect(authority.read(agent.session, { ...request, characterId: 'missing_role' }))
      .rejects.toThrow('exactly one current project character')
    expect(library.previewCalls).toHaveLength(beforeProjectFailures)

    library.previewCatalogAssetId = 'character:muse-character-reference-qa:changed'
    await expect(authority.read(agent.session, request)).rejects.toThrow('changed image identity')
    library.previewCatalogAssetId = CATALOG_ID
    library.previewSha256 = 'b'.repeat(64)
    await expect(authority.read(agent.session, request)).rejects.toThrow('changed image identity')
    library.previewSha256 = IMAGE_SHA
    library.previewMetadataStatus = 'rejected_claim'
    await expect(authority.read(agent.session, request)).rejects.toThrow('withdrawn Catalog record')

    library.previewMetadataStatus = 'approved_claim'
    await writeFile(configPath, config(91002, [
      { character_id: 'fixture_role', name: 'Fixture Role', role_class: 'important_support' },
    ]))
    const beforeSwitch = library.previewCalls.length
    await expect(authority.read(agent.session, request)).rejects.toThrow('conflicting current project identity')
    expect(library.previewCalls).toHaveLength(beforeSwitch)

    await toolFiber.dispose()
    expect(ctx.get('characterReferenceAuthority')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})

it('rejects an ambiguous workspace before reading candidate bytes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-character-reference-ambiguous-')))
  const workshop = join(root, 'short-drama')
  await mkdir(join(workshop, 'fixture-91001'), { recursive: true })
  await mkdir(join(workshop, 'fixture-91002'), { recursive: true })
  await writeFile(join(workshop, 'fixture-91001', 'project_config.json'), config(91001, [
    { character_id: 'fixture_role', name: 'Fixture Role', role_class: 'important_support' },
  ]))
  await writeFile(join(workshop, 'fixture-91002', 'project_config.json'), config(91002, [
    { character_id: 'fixture_role', name: 'Other Role', role_class: 'support' },
  ]))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const settingsFiber = await ctx.plugin(FakeSettings)
    await settingsFiber.await()
    const libraryFiber = await ctx.plugin(FakeCharacterLibrary)
    await libraryFiber.await()
    const toolFiber = await ctx.plugin(CharacterReferenceTool)
    await toolFiber.await()
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('character-reference-authority-ambiguous'), {}, { cwd: root })
    const authority = ctx.get('characterReferenceAuthority')
    if (authority === undefined) throw new Error('Missing character reference authority')
    await expect(authority.read(agent.session, {
      scriptId: 91001,
      characterId: 'fixture_role',
      catalogAssetId: CATALOG_ID,
      expectedSha256: IMAGE_SHA,
    })).rejects.toThrow('Select the current drama project explicitly')
    const library = ctx.characterLibrary
    expect(library).toBeInstanceOf(FakeCharacterLibrary)
    if (!(library instanceof FakeCharacterLibrary)) throw new Error('Missing fake character library')
    expect(library.previewCalls).toHaveLength(0)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
