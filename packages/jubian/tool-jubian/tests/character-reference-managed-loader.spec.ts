/** Real Loader composition for the isolated managed character-reference route. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type {
  AuthoritativeCharacterReference,
  CharacterReferenceAuthority,
} from '@deepseek-ai/dsh-tool-character-reference'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import {
  CHARACTER_REFERENCE_QA_ENVIRONMENT,
  CHARACTER_REFERENCE_QA_SCOPE,
  openCharacterReferenceQaAuthorizationStore,
} from '../src/character-reference-qa-authorization.ts'
import * as Jubian from '../src/index.ts'

const PROJECT_ID = 91_301
const CHARACTER_ID = 'fixture_managed_lead'
const CATALOG_ID = 'character:fixture-library:managed-lead-001'
const IMAGE_SHA256 = 'a'.repeat(64)
const AUTHORIZATION_ID = 'fixture-managed-reference-authorization'

it('resolves the preset-scoped authority for the current Agent through the real Loader', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'character-reference-managed-loader-'))
  const databasePath = join(dataRoot, 'authorization', 'authorization.sqlite')
  const store = await openCharacterReferenceQaAuthorizationStore({ dataRoot, databasePath })
  if (store === undefined) throw new Error('Synthetic QA authorization store was not configured')
  store.appendGrant({
    authorizationId: AUTHORIZATION_ID,
    authorizationVersion: 1,
    environment: CHARACTER_REFERENCE_QA_ENVIRONMENT,
    actorId: 'fixture-host-operator',
    reviewerId: 'fixture-host-reviewer',
    sourceDeclaration: 'Synthetic Loader composition fixture only.',
    projectId: PROJECT_ID,
    characterId: CHARACTER_ID,
    roleClass: 'lead',
    catalogId: CATALOG_ID,
    imageSha256: IMAGE_SHA256,
    catalogStatus: 'pending_review',
    scope: CHARACTER_REFERENCE_QA_SCOPE,
    maxGenerationUses: 1,
    allowPublish: false,
    allowFormalBind: false,
    allowCrossProjectReuse: false,
    productionApproved: false,
    createdAt: '2026-10-20T08:00:00.000Z',
  })
  store.close()

  const authorityReads: Array<{ scriptId: number; characterId: string; catalogAssetId: string; expectedSha256: string }> = []
  const authority: CharacterReferenceAuthority = {
    read: async (_session, request): Promise<AuthoritativeCharacterReference> => {
      authorityReads.push(request)
      return {
        projectDirectory: join(dataRoot, 'synthetic-project'),
        scriptId: PROJECT_ID,
        characterId: CHARACTER_ID,
        characterName: 'Synthetic Managed Lead',
        // The Host reread sees a changed role, so the persisted exact grant must deny the upload.
        roleClass: 'important_support',
        catalogAssetId: CATALOG_ID,
        imageSha256: IMAGE_SHA256,
        metadataStatus: 'pending_review',
        contentType: 'image/png',
        data: Uint8Array.of(137, 80, 78, 71),
      }
    },
  }
  const presetServiceRequests: string[] = []
  const hostAuthority: CharacterReferenceAuthority = {
    read: async () => { throw new Error('The Host-global authority must not replace the current Agent preset authority.') },
  }
  const Authority = {
    apply(ctx: Context) { ctx.provide('characterReferenceAuthority', hostAuthority) },
  }
  const PresetLookup = {
    apply(ctx: Context) {
      ctx.provide('agentPresets', {
        serviceFor(_agent: { readonly ctx: Context }, name: string) {
          presetServiceRequests.push(name)
          return name === 'characterReferenceAuthority' ? authority : undefined
        },
      })
    },
  }
  const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external request expected'))

  const { ctx } = await configurationFixture({
    hmr: false,
    rows: [
      { id: 'prompt', name: 'cordis:prompt' },
      { id: 'tools', name: 'cordis:tools' },
      { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'fixture-token' } },
      { id: 'character-reference-authority', name: 'cordis:character-reference-authority' },
      { id: 'agent-presets', name: 'cordis:agent-presets' },
      { id: 'tool-jubian', name: 'cordis:jubian', config: {
        ledgerRoot: join(dataRoot, 'jubian-ledger'),
        workspaceSecrets: false,
        characterReferenceQaAuthorizationDataRoot: dataRoot,
        characterReferenceQaAuthorizationDatabasePath: databasePath,
      } },
    ],
    builtins: {
      prompt: SystemPrompt,
      tools: Tools,
      credentials: MemoryCredentials,
      'character-reference-authority': Authority,
      'agent-presets': PresetLookup,
      jubian: Jubian,
    },
  })

  try {
    expect(ctx.get('characterReferenceAuthority')).toBe(hostAuthority)
    expect(ctx.get('agentPresets')).toBeDefined()
    expect(ctx.tools.get('jubian_asset')).toBeDefined()
    await ctx.plugin(Llm)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([
      toolCallResponse('denied-confirm', 'jubian_asset', {
        method: 'confirm_casting', material_id: 71, idempotency_key: 'fixture-denied-confirm',
      }),
      toolCallResponse('denied-register', 'jubian_asset', {
        method: 'register', script_id: PROJECT_ID, asset_name: 'Synthetic Managed Lead', asset_type: 1,
        asset_url: 'https://fixture.invalid/reference.png', idempotency_key: 'fixture-denied-register',
      }),
      toolCallResponse('denied-unmanaged-generation', 'jubian_video', {
        method: 'image_generate', script_id: PROJECT_ID, asset_name: 'Synthetic Managed Lead', asset_type: 1,
        prompt: 'Synthetic portrait.', idempotency_key: 'fixture-denied-unmanaged-generation',
      }),
      toolCallResponse('denied-storyboard-create', 'jubian_storyboard', {
        method: 'create', body: { scriptId: PROJECT_ID }, idempotency_key: 'fixture-denied-storyboard-create',
      }),
      toolCallResponse('denied-media-download', 'jubian_media', {
        method: 'download', media_url: 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture.png',
        media_kind: 'image', output_path: join(dataRoot, 'denied-download.png'),
      }),
      toolCallResponse('managed-upload', 'jubian_asset', {
        method: 'upload_character_reference',
        script_id: PROJECT_ID,
        idempotency_key: 'fixture-managed-upload-fixed',
        character_reference: {
          authorization_id: AUTHORIZATION_ID,
          authorization_version: 1,
          character_id: CHARACTER_ID,
          catalog_asset_id: CATALOG_ID,
          image_sha256: IMAGE_SHA256,
        },
      }),
      textResponse('The Host rejected the stale synthetic role binding.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(
      SessionId('character-reference-managed-loader'),
      { provider: 'mock', model: 'mock' },
      { cwd: dataRoot },
    )
    agent.followup(createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Run the synthetic managed-reference composition check.' }],
    }))
    await agent.whenIdle()

    expect(presetServiceRequests).toEqual(['characterReferenceAuthority'])
    expect(authorityReads).toEqual([{
      scriptId: PROJECT_ID,
      characterId: CHARACTER_ID,
      catalogAssetId: CATALOG_ID,
      expectedSha256: IMAGE_SHA256,
    }])
    expect(transport).not.toHaveBeenCalled()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(6)
    for (const result of results.slice(0, 5)) {
      expect(result.data.message.isError).toBe(true)
      const denied = result.data.message.content[0]
      if (denied?.type !== 'text') throw new Error('Missing managed-QA firewall error text')
      expect(denied.text).toContain('Isolated character-reference QA allows only read operations')
    }
    expect(results[5]!.data.message.isError).toBe(true)
    const block = results[5]!.data.message.content[0]
    if (block?.type !== 'text') throw new Error('Missing managed-upload error text')
    expect(block.text).toContain('current project, role, Catalog identity, SHA, or status differs from the authorization')

    const toolRow = [...ctx.loader.entries()].find(row => row.options.name === 'cordis:jubian')
    await toolRow?.fiber?.dispose()
    expect(ctx.tools.get('jubian_asset')).toBeUndefined()
    await rm(dataRoot, { recursive: true })

    const authorityRow = [...ctx.loader.entries()]
      .find(row => row.options.name === 'cordis:character-reference-authority')
    await authorityRow?.fiber?.dispose()
    expect(ctx.get('characterReferenceAuthority')).toBeUndefined()
    const presetRow = [...ctx.loader.entries()].find(row => row.options.name === 'cordis:agent-presets')
    await presetRow?.fiber?.dispose()
    expect(ctx.get('agentPresets')).toBeUndefined()
  } finally {
    transport.mockRestore()
    await ctx.fiber.dispose()
    await rm(dataRoot, { recursive: true, force: true })
  }
})
