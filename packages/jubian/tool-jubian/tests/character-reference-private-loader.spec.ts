/** Real normal-Host composition: an Agent calls the authorization Tool and the Host asks the user. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { CharacterReferenceAuthority } from '@deepseek-ai/dsh-tool-character-reference'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MuseAccountService } from '@deepseek-ai/dsh-muse-account'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

it('prompts the live signed-in owner and persists a private grant without a provider request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'character-private-loader-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const status = vi.fn(async () => ({ state: 'signed-in' as const, username: 'FixtureOwner', verified: true }))
  const read = vi.fn(async () => ({
    projectDirectory: join(root, 'project'), scriptId: 4661,
    characterId: 'char_wangzongjian', characterName: '王总监', roleClass: 'important_support' as const,
    catalogAssetId: 'character:fixture:male006', imageSha256: 'a'.repeat(64),
    metadataStatus: 'pending_review' as const, contentType: 'image/png' as const,
    data: Uint8Array.of(137, 80, 78, 71),
  }))
  const Authority = { apply(ctx: Context) {
    ctx.provide('characterReferenceAuthority', { read } satisfies CharacterReferenceAuthority)
  } }
  const Account = { apply(ctx: Context) {
    ctx.plugin(MuseAccountService, { controller: {
      status,
      login: async () => { throw new Error('Fixture login is unavailable') },
      logout: status,
    } })
  } }
  const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected provider request'))
  let ctx: Context | undefined
  try {
    const fixture = await configurationFixture({
      hmr: false,
      rows: [
        { id: 'prompt', name: 'cordis:prompt' },
        { id: 'tools', name: 'cordis:tools' },
        { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'fixture-token' } },
        { id: 'character-reference-authority', name: 'cordis:character-reference-authority' },
        { id: 'muse-account', name: 'cordis:muse-account' },
        { id: 'tool-jubian', name: 'cordis:jubian', config: { ledgerRoot: join(root, 'ledger'), workspaceSecrets: false } },
      ],
      builtins: {
        prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials,
        'character-reference-authority': Authority, 'muse-account': Account, jubian: Jubian,
      },
    })
    ctx = fixture.ctx
    await ctx.plugin(Llm)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestions)
    const question = vi.fn(async () => ({ answers: [{ id: 'character-reference-private-rights',
      selected: ['确认：我委托生成并亲自上传此图，拥有本项目参考生图权利'] }] }))
    ctx.on('user-questions/request', question)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([
      toolCallResponse('private-attestation', 'jubian_character_reference_authorize', {
        script_id: 4661, character_id: 'char_wangzongjian',
        catalog_asset_id: 'character:fixture:male006', image_sha256: 'a'.repeat(64),
      }),
      textResponse('The user granted one project-private derivative; no provider call was sent.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(
      SessionId('private-owner-loader'), { provider: 'mock', model: 'mock' }, { cwd: root },
    )
    agent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Authorize my uploaded image for project 4661 only.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data.message.isError).toBe(false)
    expect(question).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(2)
    expect(status).toHaveBeenCalledTimes(2)
    expect(transport).not.toHaveBeenCalled()
  } finally {
    transport.mockRestore()
    await ctx?.fiber.dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(root, { recursive: true, force: true })
  }
})
