/** Exercise native Main Bot identity and roster output through the Headless Session runner. */
import { install as installPrompt } from '../../../third_party/plugins/ds-bot/src/host/prompt.js'
import { install as installTools } from '../../../third_party/plugins/ds-bot/src/host/tools.js'
import { install as installMemory } from '../../../third_party/plugins/ds-bot/src/host/memory.js'
import { install as installStore } from '../../../third_party/plugins/ds-bot/src/host/store.js'
import { install as installModels } from '../../../third_party/plugins/ds-bot/src/host/models.js'
import { MuseTeamService } from '../../../third_party/plugins/ds-bot/src/host/muse-team.js'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The fixture registers roster and memory without starting the browser-only Bot Host. */
export const name = 'snapshot-muse-bot-roster'
/** The shipped Headless profile provides the actual tool registry and prompt service. */
export const inject = ['tools', 'systemPrompt']

/**
 * Install native identity and list_bots with cold Session metadata in an isolated roster.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Snapshot process context.
 * @returns {Promise<void>}
 */
export async function apply(ctx) {
  const mainBot = { id: 'muse-main', name: 'Muse Bot', role: '主理人', instructions: '', model: 'deepseek-official/deepseek-v4-flash' }
  const previousModel = 'muse-cloud-yunying/gemini-3.1-pro'
  const selected = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' }
  const legacyBot = { id: 'legacy-session', sessionId: 'legacy-session', name: 'Legacy session', role: '', instructions: '',
    autoSessionBot: true, modelSource: 'bot', interactionSource: 'session', model: previousModel,
    appliedModel: previousModel, effort: 'high', appliedEffort: 'high', segments: [{ sessionId: 'legacy-part' }] }
  const independentBot = { id: 'independent-editor', name: 'Independent editor', role: '', instructions: '',
    modelSource: 'bot', model: previousModel, appliedModel: previousModel, effort: 'high', appliedEffort: 'high' }
  const memoryHome = mkdtempSync(join(tmpdir(), 'muse-bot-memory-snapshot-'))
  const statePath = join(memoryHome, 'state.json')
  writeFileSync(statePath, JSON.stringify({ version: 1, mainBotIds: [mainBot.id],
    bots: { [mainBot.id]: mainBot, [legacyBot.id]: legacyBot, [independentBot.id]: independentBot },
    rooms: {}, agents: {}, capabilities: { items: {} }, revision: 0 }))
  const ownMemory = join(memoryHome, 'memory', 'bots', mainBot.id)
  mkdirSync(ownMemory, { recursive: true })
  writeFileSync(join(ownMemory, 'MEMORY.md'), '# Memory\n\n- 用户偏好克制表演，避免夸张运镜。 [source: part 1 #1; added: 2026-10-01]\n\n## Index\n')
  ctx.effect(() => () => rmSync(memoryHome, { recursive: true }), 'Muse Bot snapshot: private memory files')
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('Bot roster snapshot refuses network access') }
    return () => { globalThis.fetch = original }
  }, 'Muse Bot snapshot: no network')
  const items = [
    {
      sessionId: legacyBot.id, cwd: '/project/drama',
      projections: { values: { title: 'Legacy session', modelSelection: { next: selected } } },
    },
    {
      sessionId: 'episode-editor', cwd: '/project/drama',
      projections: { values: { title: 'Episode editor', modelSelection: { next: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' } } } },
    },
    {
      sessionId: 'delegated-editor', cwd: '/project/drama', origin: 'subagent',
      projections: { values: { title: 'Delegated editor' } },
    },
  ]
  const legacySession = { header: { id: legacyBot.id, createdAt: 1783352044766 },
    requestHeader: () => ({ config: { provider: 'muse-cloud-yunying', model: 'gemini-3.1-pro', reasoningEffort: 'high' } }) }
  const rt = {
    ctx: {
      systemPrompt: ctx.systemPrompt,
      effect: (execute, label) => ctx.effect(execute, label),
      tools: {
        register: tool => ['list_bots', 'remember', 'recall', 'forget'].includes(tool.name) ? ctx.effect(() => ctx.tools.register(tool)) : () => {},
        guard: () => () => {},
      },
      on: () => () => {},
      sessions: { get: id => id === legacyBot.id ? legacySession : undefined },
      sessionTitle: { get: () => ({ title: 'Legacy session' }) },
      get: name => name === 'sessionProjections' ? { stateOf: session => {
        assert.equal(session, legacySession)
        return { pending: selected }
      } } : undefined,
      llm: {
        listProviders: () => [{ id: selected.provider }, { id: 'muse-cloud-yunying' }],
        listModels: async provider => [{ id: provider === selected.provider ? selected.model : 'gemini-3.1-pro' }],
        resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
      },
      sessionController: {
        list: async () => ({ items }),
        resolveAgent: () => { throw new Error('Roster synchronization must not restore a cold Agent') },
      },
      workspaceRegistry: { list: () => [{ id: 'drama-workspace', sessionIds: ['episode-editor'] }], archivedSessionIds: [] },
    },
    config: { goals: 'host', autoSessionBots: true, sessionBotSyncIntervalMs: 30000 },
    home: memoryHome,
    statePath,
    sessionFolder: () => '/project/drama',
    freshBotName: base => {
      let name = base
      let suffix = 2
      while (Object.values(state.bots).some(bot => bot.name === name)) name = `${base} ${suffix++}`
      return name
    },
    holdBotName: (_name, operation) => operation(),
    resolveAgent: async id => {
      assert.equal(id, legacyBot.id, 'Only the already loaded native Session may be resolved')
      return { session: legacySession }
    },
    statusOf: () => 'idle',
    warn: (...args) => { throw new Error(args.map(value => value instanceof Error ? value.message : String(value)).join(' ')) },
  }
  installStore(rt)
  const state = rt.state
  await rt.load()
  const adopted = rt.botOf(legacyBot.id)
  assert.equal(adopted.modelSource, 'session')
  assert.equal(adopted.model, previousModel)
  assert.equal(adopted.appliedModel, previousModel)
  assert.deepEqual(adopted.segments, legacyBot.segments)
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).bots[legacyBot.id].modelSource, 'session')
  assert.equal(rt.botOf(independentBot.id).modelSource, 'bot')
  const selfOf = rt.selfOf
  rt.selfOf = id => selfOf(id) ?? (id === undefined ? undefined : mainBot.id)
  rt.isBotSession = id => id !== undefined
  installModels(rt)
  assert.equal(await rt.desiredModel(adopted), `${selected.provider}/${selected.model}`)
  assert.equal(await rt.desiredEffort(adopted, await rt.desiredModel(adopted)), 'low')
  assert.deepEqual(rt.modelView(adopted), { model: `${selected.provider}/${selected.model}`, effort: 'low',
    appliedModel: undefined, appliedEffort: undefined })
  assert.equal(await rt.desiredModel(rt.botOf(independentBot.id)), previousModel)
  assert.equal(await rt.desiredEffort(rt.botOf(independentBot.id), previousModel), 'high')
  assert.deepEqual(rt.modelView(rt.botOf(independentBot.id)), {})
  rt.museTeam = new MuseTeamService(rt, () => 1783352044766)
  ctx.effect(() => () => rt.museTeam.dispose(), 'Muse Bot snapshot: Session identity service')
  installPrompt(rt)
  installTools(rt)
  installMemory({ ...rt, config: { ...rt.config, memoryReview: true }, readOnly: () => 'Read-only recorded Session' })
}
