// Model cards and an independent Worker thread for a Main Bot's new task.
import { splitRef } from './text.js'
import { serviceOf } from './services.js'
import evidence from './task-model-evidence.json' with { type: 'json' }

const CARDS = {
  routine: {
    ref: 'muse-cloud-deepseek-flash-auto/deepseek-v4.1-flash',
    guidance: 'Use for extraction, formatting, summarizing and routine instructions with clear acceptance criteria.',
  },
  advanced: {
    ref: 'muse-cloud-jubian-pro/deepseek-v4-pro',
    guidance: 'Consider for difficult reasoning, reconciling sources and writing review where errors would be costly.',
  },
}

function formatChannel(channel) {
  const { name, wireModel, price, stream, screenplay, historicalSample } = channel
  const lines = [`  - ${name} (${wireModel}).`]
  if (price !== undefined) {
    const rates = price.windows.map(window => `${window.period} ${window.input}/${window.cachedInput ?? 'unlisted'}/${window.output}`).join(', ')
    const basis = price.basis === 'account-sample' ? 'Account-sample' : 'Listed'
    lines[0] += ` ${basis} CNY per 1M tokens (uncached input/cache-hit input/output): ${rates}. ${price.schedule}`
    if (price.sampleDebit !== undefined) lines[0] += ` Peak rate matched ${price.sampleDebit.attempts} account debits.`
  }
  if (stream !== undefined) {
    const { successful, attempts, firstTextMs, completeMs, reportedModel, identityResponses } = stream
    const timings = firstTextMs && completeMs
      ? ` First text p50/p95 ${firstTextMs.p50}/${firstTextMs.p95} ms, completion ${completeMs.p50}/${completeMs.p95} ms.` : ''
    lines.push(`    Streaming ${successful}/${attempts} successful.${timings} Response reported ${reportedModel} in ${identityResponses}/${attempts} requests.`)
  }
  if (historicalSample !== undefined) {
    const { successfulRows, firstResponseMs, observedOn } = historicalSample
    const timing = firstResponseMs?.length ? ` Billing first-response samples: ${firstResponseMs.join(', ')} ms.` : ''
    lines.push(`    Account records on ${observedOn} contain ${successfulRows} successful rows.${timing}`)
  }
  if (screenplay !== undefined) {
    const { score, scored, tasks, caseScores } = screenplay
    const cases = Object.entries(caseScores).map(([task, value]) => `${task} ${value}`).join(', ')
    lines.push(`    Screenplay quality ${score}/100 across ${scored}/${tasks} scored tasks. ${cases}.`)
  }
  return lines.join('\n')
}

/** Install the optional Main Bot model cards and task routing operations. */
export function install(rt) {
  const { ctx } = rt
  rt.selectTaskSessionModel = select
  const config = rt.config.taskRouting
  if (config === undefined || config === false) return
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('ds-bot: taskRouting must be false or a mapping')
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new Error('ds-bot: taskRouting.enabled must be true or false')
  if (config.mode !== undefined && config.mode !== 'auto' && config.mode !== 'manual') throw new Error('ds-bot: taskRouting.mode must be auto or manual')
  if (config.enabled !== true) return
  const autoEnabled = config.mode === 'auto'
  const tiers = {
    routine: { ...CARDS.routine, ref: config.flash ?? CARDS.routine.ref },
    advanced: { ...CARDS.advanced, ref: config.pro ?? CARDS.advanced.ref },
  }
  for (const { ref } of Object.values(tiers)) {
    if (typeof ref !== 'string' || !/^[^/\s]+\/[^\s]+$/.test(ref)) throw new Error('ds-bot: taskRouting flash and pro must be exact provider/model refs')
  }
  if (tiers.routine.ref === tiers.advanced.ref) throw new Error('ds-bot: taskRouting needs distinct flash and pro model refs')

  const cards = new Map(Object.entries(tiers).filter(([, card]) => !autoEnabled || Object.hasOwn(evidence.models, card.ref))
    .map(([tier, card]) => [card.ref, { ...card, tier }]))
  if (autoEnabled) for (const [ref, measured] of Object.entries(evidence.models)) {
    if (!cards.has(ref)) cards.set(ref, { ref, guidance: measured.guidance })
  }

  const catalog = async () => (await rt.catalog({ fresh: true })).filter(entry => entry.selectable !== false && entry.needsKey !== true && !rt.isLocalAgentRef(entry.ref))
  const infoOf = entry => serviceOf(ctx, 'llm')?.resolveModelInfo(entry.provider, entry.id).catch(() => undefined)

  async function modelCards() {
    const available = new Map((await catalog()).map(entry => [entry.ref, entry]))
    const visible = [...cards.values()].filter(card => available.has(card.ref))
    if (visible.length === 0) return undefined
    const sections = await Promise.all(visible.map(async (card) => {
      const entry = available.get(card.ref)
      const info = await infoOf(entry)
      const input = (info?.inputModalities ?? entry.input)?.join(', ') || 'unspecified'
      const context = info?.context?.contextWindow
      const outputBudget = info?.defaultMaxTokens === undefined ? '' : ` Default output budget: ${info.defaultMaxTokens} tokens.`
      const efforts = info?.reasoning?.efforts?.map(effort => effort.id).join(', ')
      const effortLine = efforts ? ` Advertised thinking: ${efforts}${info.reasoning.defaultEffort === undefined ? '' : ` (default ${info.reasoning.defaultEffort})`}.` : ''
      const measured = evidence.models[card.ref]
      const guidance = card.guidance ? ` ${card.guidance}` : ''
      const label = card.tier === undefined ? card.ref : `${card.tier}: ${card.ref}`
      const header = `- ${label}.${guidance} Advertised input: ${input}. Context: ${context === undefined ? 'unspecified' : `${context} tokens`}.${outputBudget}${effortLine}`
      return measured === undefined
        ? `${header} No benchmark data for this exact route.`
        : [header, measured.finding, measured.verification, ...(measured.channels ?? []).map(formatChannel)].filter(Boolean).join('\n')
    }))
    const notes = visible.some(card => Object.hasOwn(evidence.models, card.ref)) ? evidence.notes : []
    return [...sections, ...notes].join('\n')
  }

  async function resolve({ task_model, task_card, task_difficulty, task_effort }, worker) {
    const available = await catalog()
    const explicit = task_model !== undefined
    const manual = autoEnabled && !explicit && rt.modelModeOf?.(worker) === 'manual'
    const fallback = autoEnabled && task_difficulty === undefined && task_card === undefined
    const cardRef = task_card?.trim() ?? (fallback ? tiers.routine.ref : tiers[task_difficulty]?.ref)
    const ref = task_model?.trim() ?? (manual ? worker.model ?? worker.appliedModel : cardRef)
    if (manual && ref === undefined) return { error: 'The Worker is in manual mode. Select its model or switch it to Auto before dispatch.' }
    if (autoEnabled && !explicit && !manual && !cards.has(ref)) {
      return { error: 'Choose an available tested route from list_bot_model_cards for this task.' }
    }
    const entry = available.find(entry => entry.ref === ref)
    if (entry === undefined) {
      if (!autoEnabled && !explicit) return {}
      return { error: `Task model "${ref}" is unavailable. Check ${explicit || manual ? 'list_bot_models' : 'list_bot_model_cards'} before dispatch.` }
    }
    const effort = manual ? worker.effort : task_effort?.trim()
    if (effort !== undefined) {
      const offered = (await infoOf(entry))?.reasoning?.efforts?.map(level => level.id) ?? []
      if (!offered.includes(effort)) {
        return { error: offered.length === 0
          ? `Task model "${ref}" does not advertise thinking levels. Use its provider default.`
          : `Thinking level "${effort}" is unavailable for "${ref}". Available: ${offered.join(', ')}. Omit task_effort for the provider default.` }
      }
    }
    const reason = manual ? 'Use the Worker’s manual model setting.'
      : fallback && !explicit ? 'Use the routine model card for an unspecified assignment.' : undefined
    return { ref, effort, reason }
  }

  async function select(sessionId, { ref, effort }) {
    const route = splitRef(ref)
    const result = await ctx.sessionController.selectModel({ sessionId, ...route, ...(effort === undefined ? {} : { reasoningEffort: effort }), saveDefault: false })
    const selected = result?.selected
    if (selected?.provider !== route.provider || selected?.model !== route.model || selected.reasoningEffort !== effort) {
      throw new Error(`Could not confirm task model ${ref}`)
    }
    const agent = await rt.resolveAgent(sessionId)
    await ctx.sessions.flush(agent.session)
  }

  async function createThread(bot, route) {
    const { ref, effort } = route
    const sessionId = await rt.createSession(bot.name, { dir: rt.workDirOf({ botId: bot.id }) })
    const part = { sessionId, startedAt: Date.now(), taskModel: ref, ...(effort === undefined ? {} : { taskEffort: effort }) }
    try {
      await select(sessionId, route)
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

  rt.taskRouting = { autoEnabled, modelCards, resolve, createThread }
}
