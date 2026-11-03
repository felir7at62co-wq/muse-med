/** Keyless integration of the actual Desktop market row through its Loader. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import Sessions, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Agents, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import * as Persona from '@deepseek-ai/dsh-persona'
import MuseMarket from '@deepseek-ai/dsh-muse-market'
import * as BotSkills from '@deepseek-ai/dsh-muse-market/bot-skills'
import { createMarketPackage } from '@deepseek-ai/dsh-muse-market/package'
import { expect, it, vi } from 'vitest'

type ProductEntry = Omit<Partial<EntryOptions>, 'config'> & {
  config?: Record<string, unknown>
  insert?: Array<Omit<EntryOptions, 'config'> & { config?: Record<string, unknown> }>
}

type RecordedSkillRow =
  | { kind: 'user'; text: string }
  | { kind: 'skill-catalog'; bounded: boolean; entries: string[] }
  | { kind: 'skill-invocation'; name: string }

/** The only simulated boundary: deterministic model streams, with no HTTP client. */
class MarketFixtureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly replies: StreamChunk[][]) { super() }

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model }
  }

  async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const reply = this.replies.shift()
    if (reply === undefined) throw new Error('Offline market model script exhausted')
    for (const chunk of reply) {
      request.signal?.throwIfAborted()
      yield chunk
    }
  }
}

function fixtureReply(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function fixtureCall(id: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(id)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Register the idle listener before waking the real loop, so synchronous replies cannot race it. */
async function fixtureTurn(ctx: Context, agent: Agent, text: string): Promise<void> {
  const idle = Promise.withResolvers<undefined>()
  const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && status === 'idle') idle.resolve(undefined)
  })
  try {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    await idle.promise
  } finally {
    dispose()
  }
}

function skillCatalogs(events: readonly SessionEvent[]) {
  return events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'skill-catalog'
    ? [event.data] : [])
}

function skillInvocations(events: readonly SessionEvent[]) {
  return events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation'
    ? [event.data] : [])
}

it('composes the shipped market policy without network access or opening retired presets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-desktop-'))
  const ctx = new Context()
  const fetchProbe = vi.fn(() => { throw new Error('Unexpected network request in keyless market composition') })
  vi.stubGlobal('fetch', fetchProbe)
  try {
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    for (const plugin of [Llm, Sessions, SessionProjections, Tools, Agents, Skills]) await ctx.plugin(plugin)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(ToolSkill)

    const patch = yaml.load(await readFile(new URL('../config/desktop.cordis.patch.yml', import.meta.url), 'utf8'),
      { schema: entryListSchema }) as ProductEntry[]
    const presetPolicy = patch.find(row => row.id === 'agent-preset-registry')
    expect(presetPolicy?.config).toEqual({ default: 'short-drama', selectablePresets: ['short-drama'] })
    await ctx.plugin(Presets, presetPolicy!.config)
    await ctx.agentPresets.register({ id: 'short-drama', plugins: [] })
    await ctx.agentPresets.register({ id: 'retired', plugins: [] })
    const marketRow = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'muse-market')
    expect(marketRow?.name).toBe('@deepseek-ai/dsh-muse-market')
    expect(marketRow?.config).toMatchObject({ allowedPlugins: [
      '@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-skill',
    ] })

    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-muse-market', MuseMarket],
      ['@deepseek-ai/dsh-persona', Persona],
      ['@deepseek-ai/dsh-tool-skill', ToolSkill],
      ['@deepseek-ai/dsh-muse-market/bot-skills', BotSkills],
    ])
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') },
      getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') },
      load() { throw new Error('Unexpected loader load') },
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
        return modules.get(specifier)
      } }
    await ctx.loader.root.update([{ ...marketRow!, config: { ...marketRow!.config,
      baseUrl: 'http://127.0.0.1:9', root: join(root, 'market'), accountHome: join(root, 'account'),
    } }])
    expect(ctx.museMarket).toBeDefined()
    const archive = createMarketPackage({ formatVersion: 1, kind: 'bot', name: 'fixture-bot',
      title: 'Fixture Bot', description: 'Offline composition fixture', version: '1.0.0', license: 'MIT',
      category: 'test', examples: [], requirements: [],
      skills: [{ name: 'fixture-skill', path: 'skills/fixture-skill/SKILL.md' }],
      plugins: [{ name: '@deepseek-ai/dsh-persona', config: { prefix: 'Offline market persona' } },
        { name: '@deepseek-ai/dsh-tool-skill', config: { scopedCatalogOwner: true } }],
    }, { 'skills/fixture-skill/SKILL.md': Buffer.from('---\nname: fixture-skill\ndescription: Fixture skill\n---\nVerified fixture body') },
    { archiveBytes: 1024 * 1024, expandedBytes: 1024 * 1024, fileCount: 32 }, ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-skill'])
    const installed = await ctx.museMarket.importPackage(Buffer.from(archive).toString('base64'))
    expect((await ctx.agentPresets.remoteExportList()).presets.map(row => row.id)).toEqual(['short-drama'])
    await ctx.museMarket.enable(installed.release.id, true)
    const marketId = `market-${installed.release.id}`
    await expect(ctx.agentPresets.resolveForCreation(marketId)).resolves.toMatchObject({ id: marketId })
    await expect(ctx.agentPresets.resolveForCreation('retired')).rejects.toMatchObject({ code: 'agent-preset/not-selectable' })
    expect(ctx.agentPresets.inspectCompositions().filter(row => row.id === marketId)).toEqual([])

    const adapter = new MarketFixtureAdapter([fixtureReply('local Bot answer')])
    ctx.llm.registerAdapter(['market-fixture'], adapter)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('market-product-fixture'),
      agentOptions: { provider: 'market-fixture', model: 'scripted-offline' },
      setup: async (scope) => { await ctx.agentPresets.mount(scope, 'short-drama') } })
    await ctx.agentPresets.select(agent, marketId)
    expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe(marketId)
    expect((await ctx.skills.get('fixture-skill', { scope: agent }))?.content).toBe('Verified fixture body')
    const prompt = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(prompt.sections.some(section => section.text === 'Offline market persona')).toBe(true)
    await fixtureTurn(ctx, agent, 'Use fixture-skill for this task')
    expect(adapter.requests).toHaveLength(1)
    const catalogs = skillCatalogs(agent.session.snapshotEvents())
    expect(catalogs).toHaveLength(1)
    const catalog = catalogs[0]
    expect(catalog).toBeDefined()
    expect(JSON.stringify(catalog)).toContain('fixture-skill')
    expect(JSON.stringify(catalog)).not.toContain('Verified fixture body')
    const loaded = await ctx.tools.execute({ agent, name: 'skill', arguments: { name: 'fixture-skill' },
      callId: ToolCallId('market-fixture-load'), signal: new AbortController().signal })
    expect(loaded.isError).toBe(false)
    expect(JSON.stringify(loaded.content)).toContain('Verified fixture body')
    await expect(ctx.museMarket.enable(installed.release.id, false)).rejects.toMatchObject({ details: { code: 'release-in-use' } })
    expect(fetchProbe).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
    await rm(root, { recursive: true, force: true })
  }
})

it('replays bounded market catalogs and explicit bodies through the shipped Loader and real local loop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-catalog-'))
  const ctx = new Context()
  const fetchProbe = vi.fn(() => { throw new Error('Unexpected network request in offline catalog regression') })
  vi.stubGlobal('fetch', fetchProbe)
  try {
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    for (const plugin of [Llm, Sessions, SessionProjections, Tools, Agents, Skills]) await ctx.plugin(plugin)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(AgentLoop, { agents: [] })

    const patch = yaml.load(await readFile(new URL('../config/desktop.cordis.patch.yml', import.meta.url), 'utf8'),
      { schema: entryListSchema }) as ProductEntry[]
    const toolSkillRow = patch.find(row => row.id === 'tool-skill')
    expect(toolSkillRow?.config).toEqual({ catalogSourceLimits: { 'muse-market': 3 } })
    const presetPolicy = patch.find(row => row.id === 'agent-preset-registry')
    await ctx.plugin(Presets, presetPolicy!.config)
    await ctx.agentPresets.register({ id: 'short-drama', plugins: [] })
    const marketRow = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'muse-market')
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-muse-market', MuseMarket],
      ['@deepseek-ai/dsh-tool-skill', ToolSkill],
    ])
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') },
      getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') },
      load() { throw new Error('Unexpected loader load') },
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
        return modules.get(specifier)
      } }
    await ctx.loader.root.update([
      { ...toolSkillRow!, id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
      { ...marketRow!, config: { ...marketRow!.config, baseUrl: 'http://127.0.0.1:9',
        root: join(root, 'market'), accountHome: join(root, 'account') } },
    ])

    const limits = { archiveBytes: 1024 * 1024, expandedBytes: 1024 * 1024, fileCount: 32 }
    for (let index = 0; index < 100; index += 1) {
      const suffix = String(index).padStart(3, '0')
      const name = `market-${suffix}`
      const description = index >= 70 && index <= 72 ? `Saffron rubric ${suffix}` : `General fixture ${suffix}`
      const policy = index === 94 ? 'disable-model-invocation: true\n' : index === 95 ? 'user-invocable: false\n' : ''
      const path = `skills/${name}/SKILL.md`
      const archive = createMarketPackage({ formatVersion: 1, kind: 'skill', name, title: name,
        description, version: '1.0.0', license: 'MIT', category: 'test', examples: [], requirements: [],
        skills: [{ name, path }],
      }, { [path]: Buffer.from(`---\nname: ${name}\ndescription: ${description}\n${policy}---\nMARKET_BODY_${suffix}`) }, limits, [])
      const item = await ctx.museMarket.importPackage(Buffer.from(archive).toString('base64'))
      await ctx.museMarket.enable(item.release.id, true)
    }
    expect(await ctx.museMarket.installed()).toHaveLength(100)
    for (const name of ['native-a', 'native-b', 'native-c', 'native-d']) {
      ctx.skills.register({ name, description: `Native summary ${name}`, source: 'bundled', content: `NATIVE_BODY_${name}` })
    }
    ctx.tools.register(defineContentToolFixture({ name: 'fixture-echo', description: 'Local continuation fixture',
      parameters: {}, execute: async () => [{ type: 'text', text: 'local echo complete' }] }))
    const adapter = new MarketFixtureAdapter([
      fixtureReply('catalog ready'),
      fixtureCall('catalog-echo', 'fixture-echo', {}), fixtureReply('four explicit bodies loaded'),
      fixtureCall('user-only-denied', 'skill', { name: 'market-094' }),
      fixtureCall('model-only-loaded', 'skill', { name: 'market-095' }), fixtureReply('policy checks complete'),
    ])
    ctx.llm.registerAdapter(['market-fixture'], adapter)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('market-bounded-recording'),
      agentOptions: { provider: 'market-fixture', model: 'scripted-offline' },
      setup: async (scope) => { await ctx.agentPresets.mount(scope, 'short-drama') } })
    const summaries = await ctx.skills.list({ scope: agent })
    expect(summaries.filter(row => row.source === 'muse-market')).toHaveLength(100)
    expect(summaries.find(row => row.name === 'market-094')?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
    expect(summaries.find(row => row.name === 'market-095')?.invocation).toEqual({ modelInvocable: true, userInvocable: false })

    await fixtureTurn(ctx, agent, 'Use saffron rubrics for this task')
    const first = skillCatalogs(agent.session.snapshotEvents())
    expect(first).toHaveLength(1)
    expect(first[0]?.source).toMatchObject({ bounded: true,
      entries: ['market-070', 'market-071', 'market-072', 'native-a', 'native-b', 'native-c', 'native-d']
        .map(name => ({ name })) })
    expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('MARKET_BODY_')
    expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('NATIVE_BODY_')

    await fixtureTurn(ctx, agent, '/market-090 /market-091 /market-092 /market-093 freely describe the document')
    expect(adapter.requests).toHaveLength(3)
    const secondEvents = agent.session.snapshotEvents()
    const secondCatalogs = skillCatalogs(secondEvents)
    expect(secondCatalogs).toHaveLength(2)
    expect(secondCatalogs[1]?.source).toMatchObject({ bounded: true, update: true,
      entries: ['market-090', 'market-091', 'market-092', 'native-a', 'native-b', 'native-c', 'native-d']
        .map(name => ({ name })) })
    expect(skillInvocations(secondEvents).map(message => message.source)).toEqual(
      ['market-090', 'market-091', 'market-092', 'market-093']
        .map(name => ({ kind: 'skill-invocation', name, form: 'instructions' })))
    for (const suffix of ['090', '091', '092', '093']) {
      expect(JSON.stringify(adapter.requests[1]?.messages)).toContain(`MARKET_BODY_${suffix}`)
    }
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('freely describe the document')
    expect(adapter.requests[2]?.messages.slice(0, adapter.requests[1]?.messages.length)).toEqual(adapter.requests[1]?.messages)

    await fixtureTurn(ctx, agent, '/market-094 /market-095 compare invocation policies')
    expect(adapter.requests).toHaveLength(6)
    const events = agent.session.snapshotEvents()
    expect(skillCatalogs(events)).toHaveLength(3)
    expect(skillInvocations(events).map(message => message.source.kind === 'skill-invocation' && message.source.name))
      .toEqual(['market-090', 'market-091', 'market-092', 'market-093', 'market-094'])
    const toolResults = events.filter(event => event.type === 'tool/result')
    expect(toolResults).toHaveLength(3)
    expect(JSON.stringify(toolResults[1])).toContain('not available for model invocation')
    expect(JSON.stringify(toolResults[2])).toContain('MARKET_BODY_095')
    expect(await ctx.skills.list({ scope: agent })).toHaveLength(104)

    // This owner-local recording is generated by the real loop, not synthesized pre-step decisions.
    const logFile = join(root, 'session-recording.jsonl')
    await writeFile(logFile, events.map(event => JSON.stringify(event)).join('\n') + '\n')
    // Session.create validates each decoded event envelope, payload and surface transition.
    const recorded = (await readFile(logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as SessionEvent)
    const rebuilt = Session.create(agent.id, recorded, agent.session.header)
    expect(rebuilt.deriveMessages()).toEqual(agent.session.deriveMessages())
    expect(skillCatalogs(rebuilt.snapshotEvents())).toEqual(skillCatalogs(events))
    expect(skillInvocations(rebuilt.snapshotEvents())).toEqual(skillInvocations(events))
    const settlements = recorded.filter(event => event.type === 'assistant/message')
    expect(settlements).toHaveLength(adapter.requests.length)
    for (const [index, settlement] of settlements.entries()) {
      const replay = Session.create(SessionId(`market-rebuild-${index}`), recorded.slice(0, settlement.seq))
      expect(replay.deriveMessages()).toEqual(adapter.requests[index]?.messages)
    }

    const projection = recorded.flatMap<RecordedSkillRow>((event) => {
      if (event.type !== 'user/message') return []
      const source = event.data.source
      switch (source.kind) {
        case 'user':
          return [{ kind: source.kind, text: event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') }]
        case 'skill-catalog':
          return [{ kind: source.kind, bounded: source.bounded === true, entries: source.entries.map(entry => entry.name) }]
        case 'skill-invocation':
          return [{ kind: source.kind, name: source.name }]
        default:
          return []
      }
    })
    expect(projection.map(row => JSON.stringify(row)).join('\n') + '\n').toBe(
      await readFile(new URL('./fixtures/muse-market-bounded-recording.expected.jsonl', import.meta.url), 'utf8'))
    expect(fetchProbe).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
