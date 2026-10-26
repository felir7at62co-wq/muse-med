// Muse owns Session history and execution; this service only records team identity.
import { nameProblem } from '../shared/mentions.js'

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
// External titles stay bounded in team metadata; addressable names use 40 characters.
const CHANNEL_NAME_MAX = 512
const channelHint = (value) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalid('A chat name hint must be text')
  const channelName = value.trim().slice(0, CHANNEL_NAME_MAX)
  let name = channelName.replace(/[@`]/gu, character => character === '@' ? '＠' : '｀')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (name === '') return undefined
  if (nameProblem(name) !== undefined) name = `飞书 ${name}`
  return { channelName, name: name.slice(0, 40) }
}
const identity = value => {
  if (typeof value !== 'string' || value === '' || value.trim() !== value || value.length > 200
    || /[\s/\\]/.test(value) || value.includes('\0') || Object.hasOwn(Object.prototype, value)) throw invalid('A valid Session or Bot id is required')
  return value
}

/** Host API for adopting existing root Sessions without changing their execution. */
export class MuseTeamService {
  /** @param {object} rt The owning Muse Bot runtime. */
  constructor(rt) {
    this.runtime = rt
    this.pending = Promise.resolve()
    this.stopped = false
  }

  /**
   * Register one ordinary root Session as a team member, idempotently.
   * @param {string} sessionId Original root Session id.
   * @param {{name?:string,nameHint?:string,role?:string,main?:boolean}} options Explicit user choices and a trusted external chat-name hint; Main defaults to false.
   * @returns {Promise<{botId:string,sessionId:string,created:boolean}>} Saved identity and current Session.
   */
  registerSessionAsBot(sessionId, options = {}) {
    return this.serialize(async () => {
      identity(sessionId)
      if (options === null || typeof options !== 'object' || Array.isArray(options)) throw invalid('Bot options must be an object')
      if (options.main !== undefined && typeof options.main !== 'boolean') throw invalid('Main must be a boolean')
      const hint = channelHint(options.nameHint)
      const rt = this.runtime
      await rt.load()
      this.assertWritable()
      const owner = rt.selfOf(sessionId)
      if (owner !== undefined) {
        if (rt.groupOwners.has(sessionId) || rt.pastOwners.get(sessionId)?.roomId !== undefined) throw invalid('A group member Session cannot become a separate Bot')
        await this.updateChannelName(rt.botOf(owner), hint)
        return { botId: owner, sessionId: rt.chatOf(owner), created: false }
      }
      if (rt.roomOf(sessionId) !== undefined || rt.botOf(sessionId) !== undefined) throw invalid('Session already belongs to the team')
      const agent = await this.rootAgent(sessionId)
      if (rt.selfOf(sessionId) !== undefined || rt.roomOf(sessionId) !== undefined || rt.botOf(sessionId) !== undefined) throw invalid('Session ownership changed while it was being registered')
      const source = rt.agentOf(sessionId)
      const explicitName = options.name !== undefined
      const title = rt.ctx.sessionTitle.get(agent.session)?.title
      const name = explicitName ? options.name : rt.freshBotName(hint?.name ?? (nameProblem(title) === undefined ? title : `Bot ${sessionId.slice(-8)}`))
      if (typeof name !== 'string' || name.trim() === '' || name.length > 40) throw invalid('A Bot name must contain 1 to 40 characters')
      const cleanName = name.trim()
      const problem = nameProblem(cleanName)
      if (problem !== undefined) throw invalid(problem)
      if (options.role !== undefined && typeof options.role !== 'string') throw invalid('A Bot role must be text')
      const selection = rt.sessionSelection(agent.session)
      const workspace = rt.ctx.workspaceRegistry.list().find(entry => entry.sessionIds.includes(sessionId))
      const workDir = rt.sessionFolder(agent.session)
      return rt.holdBotName(cleanName, async () => {
        if (rt.findBot(cleanName) !== undefined) throw invalid(`A Bot named ${cleanName} already exists`)
        this.assertWritable()
        const bot = {
          id: sessionId, sessionId, name: cleanName, role: (options.role ?? '').trim().slice(0, 24),
          instructions: '', createdAt: Date.now(), createdBy: null, capabilities: [],
          modelSource: 'session', interactionSource: 'session',
          nameSource: explicitName ? 'user' : hint === undefined ? 'session' : 'channel',
          ...(explicitName ? {} : { autoName: cleanName }),
          ...(hint === undefined ? {} : { channelName: hint.channelName }),
          ...(selection === undefined ? {} : { model: `${selection.provider}/${selection.model}` }),
          ...(selection?.reasoningEffort === undefined ? {} : { effort: selection.reasoningEffort }),
          ...(workDir === undefined ? {} : { workDir }),
          ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
        }
        const sessions = source?.sessions
        rt.state.bots[sessionId] = bot
        if (options.main === true) rt.state.mainBotIds.push(sessionId)
        if (source !== undefined) source.sessions = sessions.filter(id => id !== sessionId)
        await this.persist(() => {
          delete rt.state.bots[sessionId]
          rt.state.mainBotIds = rt.state.mainBotIds.filter(id => id !== sessionId)
          if (source !== undefined) source.sessions = sessions
        })
        rt.releaseAgentTools(agent)
        return { botId: sessionId, sessionId, created: true }
      })
    })
  }

  /**
   * Resolve a stable Bot identity without creating or activating a Session.
   * @param {string} botId Registered Bot id.
   * @returns {Promise<{botId:string,sessionId:string}>} Current own-chat Session.
   */
  async resolveCurrentSession(botId) {
    identity(botId)
    await this.runtime.load()
    if (this.stopped) throw new Error('Muse Bot has stopped')
    if (this.runtime.botOf(botId) === undefined) throw invalid('Unknown Bot')
    return { botId, sessionId: this.runtime.chatOf(botId) }
  }

  /**
   * Apply an explicit native /new or /use choice; old work remains in its Session.
   * @param {string} botId Stable team identity.
   * @param {string} sessionId Root Session already selected by the native command.
   * @returns {Promise<{botId:string,sessionId:string,previousSessionId:string}>} New mapping and unchanged previous Session id.
   */
  switchCurrentSession(botId, sessionId) {
    return this.serialize(async () => {
      identity(botId)
      identity(sessionId)
      const rt = this.runtime
      await rt.load()
      this.assertWritable()
      const bot = rt.botOf(botId)
      if (bot === undefined) throw invalid('Unknown Bot')
      const previousSessionId = rt.chatOf(botId)
      if (sessionId === previousSessionId) return { botId, sessionId, previousSessionId }
      const owner = rt.selfOf(sessionId)
      if ((owner !== undefined && owner !== botId) || rt.roomOf(sessionId) !== undefined
        || rt.groupOwners.has(sessionId) || rt.pastOwners.get(sessionId)?.roomId !== undefined) throw invalid('Session already belongs to another team conversation')
      const agent = await this.rootAgent(sessionId)
      if (rt.botOf(botId) !== bot || rt.chatOf(botId) !== previousSessionId) throw invalid('The Bot changed while the Session was being selected')
      const selection = rt.sessionSelection(agent.session)
      const source = rt.agentOf(sessionId)
      const sourceSessions = source?.sessions
      const previous = { ...bot }
      const workspace = rt.ctx.workspaceRegistry.list().find(entry => entry.sessionIds.includes(sessionId))
      bot.segments = (bot.segments ?? []).filter(segment => segment.sessionId !== sessionId && segment.sessionId !== previousSessionId)
      bot.segments.push({ sessionId: previousSessionId, endedAt: Date.now(), reason: 'explicit-switch' })
      bot.sessionId = sessionId
      bot.modelSource = 'session'
      bot.interactionSource = 'session'
      bot.model = selection === undefined ? undefined : `${selection.provider}/${selection.model}`
      bot.effort = selection?.reasoningEffort
      bot.workDir = rt.sessionFolder(agent.session)
      bot.workspaceId = workspace?.id
      delete bot.appliedModel
      delete bot.appliedEffort
      if (source !== undefined) source.sessions = sourceSessions.filter(id => id !== sessionId)
      await this.persist(() => {
        for (const key of Object.keys(bot)) delete bot[key]
        Object.assign(bot, previous)
        if (source !== undefined) source.sessions = sourceSessions
      })
      rt.releaseAgentTools(agent)
      return { botId, sessionId, previousSessionId }
    })
  }

  async rootAgent(sessionId) {
    const resolved = await this.runtime.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw Object.assign(new Error(resolved.error.message), { code: resolved.error.code })
    const agent = resolved.agent
    if (agent.session.id !== sessionId || agent.session.header.origin === 'subagent') throw invalid('Only an ordinary root Session can become a Bot')
    this.assertWritable()
    return agent
  }

  async updateChannelName(bot, hint) {
    if (hint === undefined || hint.channelName === bot.channelName) return
    const rt = this.runtime
    const canRename = bot.nameSource === 'session' && bot.autoName === bot.name
    const ownName = rt.findBot(hint.name)?.id === bot.id
    const name = canRename && !ownName ? rt.freshBotName(hint.name) : bot.name
    const update = async () => {
      this.assertWritable()
      const previous = { name: bot.name, nameSource: bot.nameSource, autoName: bot.autoName, channelName: bot.channelName }
      bot.channelName = hint.channelName
      if (canRename) {
        bot.name = name
        bot.nameSource = 'channel'
        bot.autoName = name
      }
      await this.persist(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete bot[key]
          else bot[key] = value
        }
      })
    }
    if (name === bot.name) await update()
    else await rt.holdBotName(name, update)
  }

  assertWritable() {
    if (this.stopped) throw new Error('Muse Bot has stopped')
    const reason = this.runtime.readOnly()
    if (reason !== undefined) throw new Error(reason)
  }

  async persist(undo) {
    try {
      await this.runtime.save({ required: true })
    } catch (error) {
      undo()
      this.runtime.indexSessions()
      await this.runtime.save({ required: true }).catch(rollbackError => this.runtime.warn('Muse Bot identity rollback could not be saved: %s', rollbackError))
      throw error
    }
  }

  serialize(operation) {
    const run = this.pending.then(() => { this.assertWritable(); return operation() })
    this.pending = run.catch(() => {})
    return run
  }

  /** @returns {Promise<void>} Wait for identity writes without stopping Session work. */
  dispose() {
    this.stopped = true
    return this.pending
  }
}

/**
 * Publish the Host-only team API with the plugin's Cordis lifetime.
 * @param {object} rt Muse Bot runtime with native Session services.
 */
export function install(rt) {
  const service = new MuseTeamService(rt)
  rt.museTeam = service
  rt.ctx.provide('museTeam', service)
  rt.ctx.effect(() => () => service.dispose(), 'Muse Bot: Session identity service')
}
