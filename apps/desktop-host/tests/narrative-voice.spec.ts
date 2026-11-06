/** Loader-mounted product policies supply the same scoped voice guidance to model requests. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Persona from '@deepseek-ai/dsh-persona'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as yaml from 'js-yaml'
import { expect, it } from 'vitest'
import { MockAdapter, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as CreationPolicy from '../src/creation-policy.ts'
import * as EditingPolicy from '../src/editing-policy.ts'
import NativePreset from '../src/native-preset.ts'

it.each(['short-drama', 'creation'])('delivers one narrative-voice section through the %s policy and withdraws it on disposal', async (preset) => {
  const root = await mkdtemp(join(tmpdir(), 'muse-narrative-voice-'))
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    await ctx.plugin(Llm)
    await ctx.plugin(Sessions)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AgentPresets, { default: preset })
    const raw = await readFile(new URL(`../presets/${preset}/agent.cordis.yml`, import.meta.url), 'utf8')
    const rows = yaml.load(raw, { schema: entryListSchema }) as Array<{ id: string; name: string }>
    const policyId = preset === 'creation' ? 'creation-policy' : 'editing-policy'
    const chosen = rows.filter(row => ['persona', policyId].includes(row.id))
    expect(chosen.map(row => row.id)).toEqual(['persona', policyId])
    const directory = join(root, preset)
    await mkdir(directory)
    await writeFile(join(directory, 'agent.cordis.yml'), yaml.dump(chosen))
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-persona', Persona],
      ['@deepseek-ai/dsh-desktop-host/editing-policy', EditingPolicy],
      ['@deepseek-ai/dsh-desktop-host/creation-policy', CreationPolicy],
    ])
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') },
      getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') },
      load() { throw new Error('Unexpected loader load') }, async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
        return modules.get(specifier)
      } }
    const registration = await ctx.plugin(NativePreset, { id: preset, directory })
    const adapter = new MockAdapter([textResponse('已保留原句与发声语境。')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const handle = await ctx.agents.create({ sessionId: SessionId(`narrative-voice-${preset}`),
      meta: { cwd: root, agentPreset: preset }, agentOptions: { provider: 'mock', model: 'mock' },
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset) } })
    const agent = handle.agent
    const first = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const voices = first.sections.filter(section => section.name === EditingPolicy.NARRATIVE_VOICE_SECTION)
    expect(voices.map(({ name, text }) => ({ name, text }))).toEqual([
      { name: EditingPolicy.NARRATIVE_VOICE_SECTION, text: EditingPolicy.NARRATIVE_VOICE_GUIDANCE },
    ])
    if (preset === 'short-drama') expect(voices[0]!.text).toMatchSnapshot('shared narrative voice')
    expect(first.sections.find(section => section.name === 'editing:format')?.text).not.toContain('OS表示')
    expect((await ctx.systemPrompt.assemble({ agent, scope: agent })).sections
      .filter(section => section.name === EditingPolicy.NARRATIVE_VOICE_SECTION)).toHaveLength(1)
    expect((await ctx.systemPrompt.assemble()).sections
      .some(section => section.name === EditingPolicy.NARRATIVE_VOICE_SECTION)).toBe(false)
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '按原文区分内心表达与说出口的话，不改写来源。' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const system = adapter.requests[0]!.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content).filter(part => part.type === 'text').map(part => part.text).join('\n')
    expect(system.split(EditingPolicy.NARRATIVE_VOICE_GUIDANCE)).toHaveLength(2)
    await handle.dispose()
    await registration.dispose()
    expect((await ctx.systemPrompt.assemble({ scope: agent })).sections
      .some(section => section.name === EditingPolicy.NARRATIVE_VOICE_SECTION)).toBe(false)
    expect((await ctx.systemPrompt.assemble()).sections
      .some(section => section.name === EditingPolicy.NARRATIVE_VOICE_SECTION)).toBe(false)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
