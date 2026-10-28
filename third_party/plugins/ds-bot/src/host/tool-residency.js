// Modified for Muse Bot; upstream DS Bot 0.2.2 is retained under Apache-2.0.
// Bot state owns durable residency; the Harness owns tool selection and execution.

/** Validate exact tool names from saved state, API requests, or model arguments.
 * @param {unknown} input A complete resident-tool list.
 * @returns {string[]} Unique names in deterministic order.
 */
export function cleanResidentTools(input) {
  if (!Array.isArray(input) || input.length > 512 || input.some(name => typeof name !== 'string'
    || name.length === 0 || name.length > 256 || /\s|\0/u.test(name))) {
    throw new TypeError('resident_tools must be an array of at most 512 exact tool names')
  }
  return [...new Set(input)].sort()
}

/** Connect Bot residency to the shared Harness tool-discovery service.
 * @param {object} rt The owning Bot runtime.
 */
export function install(rt) {
  const { ctx } = rt
  const registrations = new Map()
  let stopped = false
  const botFor = agent => rt.botOf(rt.selfOf(agent.session?.id ?? agent.id))
  const serviceFor = agent => agent?.ctx?.get?.('toolDiscovery') ?? ctx.get?.('toolDiscovery')
  const provider = {
    matches: agent => botFor(agent) !== undefined,
    async read(agent) {
      await rt.load()
      const bot = botFor(agent)
      if (bot === undefined) throw new Error('The conversation no longer belongs to a Bot')
      return cleanResidentTools(bot.resident_tools ?? [])
    },
    async write(agent, names) {
      await rt.load()
      const reason = rt.readOnly()
      if (reason !== undefined) throw new Error(reason)
      const bot = botFor(agent)
      if (bot === undefined) throw new Error('The conversation no longer belongs to a Bot')
      const previous = bot.resident_tools
      const next = cleanResidentTools(names)
      bot.resident_tools = next
      try {
        await rt.save({ required: true })
      } catch (error) {
        if (bot.resident_tools === next) {
          if (previous === undefined) delete bot.resident_tools
          else bot.resident_tools = previous
        }
        throw error
      }
    },
  }
  const attach = async (agent) => {
    await rt.load()
    if (stopped || botFor(agent) === undefined) return
    const service = serviceFor(agent)
    if (service === undefined) return
    if (!registrations.has(service)) registrations.set(service, service.registerResidency(provider))
    await service.refresh(agent)
  }
  // A newly created Bot enters the roster after agent/created. The next accepted
  // step observes that ownership before assembling its first model request.
  ctx.on('agent/created', ({ agent }) => attach(agent))
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    await attach(agent)
    return next()
  })
  rt.refreshResidentTools = async (botId) => {
    for (const agent of ctx.agents?.list?.() ?? []) {
      if (botId === undefined || botFor(agent)?.id === botId) await attach(agent)
    }
  }
  ctx.effect(() => async () => {
    stopped = true
    const disposers = [...registrations.values()]
    registrations.clear()
    await Promise.all(disposers.map(dispose => dispose()))
  }, 'ds-bot: tool residency provider')
}
