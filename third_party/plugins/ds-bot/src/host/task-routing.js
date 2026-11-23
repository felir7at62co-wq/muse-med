// Model cards and an independent Worker thread for a Main Bot's new task.
import { splitRef } from './text.js'
import { serviceOf } from './services.js'

const CARDS = {
  routine: {
    ref: 'muse-cloud-deepseek-flash-auto/deepseek-v4.1-flash',
    guidance: 'DeepSeek V4.1 Flash — lower relative cost. Prefer for extraction, formatting, summarizing and routine instructions with clear acceptance criteria.',
  },
  advanced: {
    ref: 'muse-cloud-jubian-pro/deepseek-v4-pro',
    guidance: 'DeepSeek V4 Pro — higher relative cost. Prefer for difficult reasoning, cross-source synthesis, subtle writing review and complex changes that need verification.',
  },
}

/** Install the optional Main Bot model cards and task routing operations. */
export function install(rt) {
  const { ctx } = rt
  rt.selectTaskSessionModel = select
  const config = rt.config.taskRouting
  if (config === undefined || config === false) return
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('ds-bot: taskRouting must be false or a mapping with enabled, flash and pro fields')
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new Error('ds-bot: taskRouting.enabled must be true or false')
  if (config.enabled !== true) return
  const cards = {
    routine: { ...CARDS.routine, ref: config.flash ?? CARDS.routine.ref },
    advanced: { ...CARDS.advanced, ref: config.pro ?? CARDS.advanced.ref },
  }
  for (const { ref } of Object.values(cards)) {
    if (typeof ref !== 'string' || !/^[^/\s]+\/[^\s]+$/.test(ref)) throw new Error('ds-bot: taskRouting flash and pro must be exact provider/model refs')
  }
  if (cards.routine.ref === cards.advanced.ref) throw new Error('ds-bot: taskRouting needs distinct flash and pro model refs')

  const catalog = async () => (await rt.catalog({ fresh: true })).filter(entry => entry.selectable !== false && entry.needsKey !== true && !rt.isLocalAgentRef(entry.ref))

  async function modelCards() {
    const available = new Map((await catalog()).map(entry => [entry.ref, entry]))
    return Promise.all(Object.entries(cards).filter(([, card]) => available.has(card.ref)).map(async ([difficulty, card]) => {
      const entry = available.get(card.ref)
      const info = await serviceOf(ctx, 'llm')?.resolveModelInfo(entry.provider, entry.id).catch(() => undefined)
      return { ...card, difficulty, input: info?.inputModalities ?? entry.input, context: info?.context?.contextWindow }
    }))
  }

  async function resolve({ task_model, task_difficulty }) {
    const available = await catalog()
    if (task_model !== undefined) {
      const ref = task_model.trim()
      if (!available.some(entry => entry.ref === ref)) return { error: `Task model "${ref}" is unavailable. Check list_bot_models or use the Worker’s existing model.` }
      return { ref }
    }
    const ref = cards[task_difficulty]?.ref
    return available.some(entry => entry.ref === ref) ? { ref } : {}
  }

  async function select(sessionId, ref) {
    const route = splitRef(ref)
    const result = await ctx.sessionController.selectModel({ sessionId, ...route, saveDefault: false })
    const selected = result?.selected
    if (selected?.provider !== route.provider || selected?.model !== route.model) throw new Error(`Could not confirm task model ${ref}`)
    const agent = await rt.resolveAgent(sessionId)
    await ctx.sessions.flush(agent.session)
  }

  async function createThread(bot, ref) {
    const sessionId = await rt.createSession(bot.name, { dir: rt.workDirOf({ botId: bot.id }) })
    const part = { sessionId, startedAt: Date.now(), taskModel: ref }
    try {
      await select(sessionId, ref)
      await rt.applyPermission(bot, sessionId, undefined)
      if (rt.botOf(bot.id) !== bot) throw new Error('The Worker changed before its task session could start')
      if (rt.localAgentOf(bot) !== undefined) throw new Error('The Worker moved to a local agent before its task session could start')
      ;(bot.openParts ??= []).push(part)
      rt.chatOwners.set(sessionId, bot.id)
      await rt.save({ required: true })
      return sessionId
    } catch (error) {
      if (bot.openParts?.includes(part)) bot.openParts.splice(bot.openParts.indexOf(part), 1)
      rt.chatOwners.delete(sessionId)
      await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
        .catch(archiveError => rt.warn('ds-bot: unused task of %s not archived: %s', bot.name, archiveError))
      throw error
    }
  }

  rt.taskRouting = { modelCards, resolve, createThread }
}
