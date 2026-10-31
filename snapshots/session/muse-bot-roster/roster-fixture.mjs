/** Exercise native Main Bot identity and roster output through the Headless Session runner. */
import { install as installPrompt } from '../../../third_party/plugins/ds-bot/src/host/prompt.js'
import { install as installTools } from '../../../third_party/plugins/ds-bot/src/host/tools.js'
import { install as installMemory } from '../../../third_party/plugins/ds-bot/src/host/memory.js'
import { MuseTeamService } from '../../../third_party/plugins/ds-bot/src/host/muse-team.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The fixture registers roster and memory without starting the browser-only Bot Host. */
export const name = 'snapshot-muse-bot-roster'
/** The shipped Headless profile provides the actual tool registry and prompt service. */
export const inject = ['tools', 'systemPrompt']

/**
 * Install native identity and list_bots with cold Session metadata in an isolated roster.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Snapshot process context.
 * @returns {void}
 */
export function apply(ctx) {
  const mainBot = { id: 'muse-main', name: 'Muse Bot', role: '主理人', instructions: '', model: 'deepseek-official/deepseek-v4-flash' }
  const state = { bots: { [mainBot.id]: mainBot }, rooms: {}, agents: {}, revision: 0 }
  const memoryHome = mkdtempSync(join(tmpdir(), 'muse-bot-memory-snapshot-'))
  const ownMemory = join(memoryHome, 'memory', 'bots', mainBot.id)
  mkdirSync(ownMemory, { recursive: true })
  writeFileSync(join(ownMemory, 'MEMORY.md'), '# Memory\n\n- 用户偏好克制表演，避免夸张运镜。 [source: part 1 #1; added: 2026-10-01]\n\n## Index\n')
  ctx.effect(() => () => rmSync(memoryHome, { recursive: true }), 'Muse Bot snapshot: private memory files')
  const items = [
    {
      sessionId: 'episode-editor', cwd: '/project/drama',
      projections: { values: { title: 'Episode editor', modelSelection: { next: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' } } } },
    },
    {
      sessionId: 'delegated-editor', cwd: '/project/drama', origin: 'subagent',
      projections: { values: { title: 'Delegated editor' } },
    },
  ]
  const rt = {
    ctx: {
      systemPrompt: ctx.systemPrompt,
      effect: (execute, label) => ctx.effect(execute, label),
      tools: {
        register: tool => ['list_bots', 'remember', 'recall', 'forget'].includes(tool.name) ? ctx.effect(() => ctx.tools.register(tool)) : () => {},
        guard: () => () => {},
      },
      on: () => () => {},
      sessions: { get: () => undefined },
      sessionController: {
        list: async () => ({ items }),
        resolveAgent: () => { throw new Error('Roster synchronization must not restore a cold Agent') },
      },
      workspaceRegistry: { list: () => [{ id: 'drama-workspace', sessionIds: ['episode-editor'] }], archivedSessionIds: [] },
    },
    config: { goals: 'host', autoSessionBots: true, sessionBotSyncIntervalMs: 30000 },
    home: memoryHome,
    groupOwners: new Map(),
    pastOwners: new Map(),
    state,
    load: async () => {},
    save: async () => { state.revision += 1 },
    readOnly: () => undefined,
    freshBotName: base => {
      let name = base
      let suffix = 2
      while (Object.values(state.bots).some(bot => bot.name === name)) name = `${base} ${suffix++}`
      return name
    },
    holdBotName: (_name, operation) => operation(),
    selfOf: id => id === undefined ? undefined : mainBot.id,
    botOf: id => state.bots[id],
    isMain: id => id === mainBot.id,
    modelView: bot => ({ model: bot.model }),
    roomOf: () => undefined,
    isBotSession: id => id !== undefined,
    statusOf: () => 'idle',
    warn: message => { throw new Error(message) },
  }
  rt.museTeam = new MuseTeamService(rt, () => 1783352044766)
  ctx.effect(() => () => rt.museTeam.dispose(), 'Muse Bot snapshot: Session identity service')
  installPrompt(rt)
  installTools(rt)
  installMemory({ ...rt, config: { ...rt.config, memoryReview: true }, readOnly: () => 'Read-only recorded Session' })
}
