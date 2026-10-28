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
const emptySync = () => ({ created: [], failures: [] })
const sessionName = (title, sessionId) => {
  let name = typeof title === 'string' ? title.replace(/[@`]/gu, value => value === '@' ? '＠' : '｀')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim() : ''
  if (name === '') name = `Bot ${sessionId.slice(-8)}`
  if (nameProblem(name) !== undefined) name = `Bot ${name}`
  return name.slice(0, 40)
}

const ownedSessions = (state) => {
  const owned = new Set()
  for (const bot of Object.values(state.bots)) {
    for (const id of [bot.id, bot.sessionId, ...(bot.segments ?? []).map(part => part.sessionId)]) if (id) owned.add(id)
  }
  for (const room of Object.values(state.rooms)) {
    owned.add(room.id)
    for (const id of Object.values(room.sessions ?? {})) owned.add(id)
    for (const parts of Object.values(room.segments ?? {})) for (const part of parts) owned.add(part.sessionId)
  }
  for (const agent of Object.values(state.agents)) for (const id of agent.sessions) owned.add(id)
  return owned
}
// An untouched automatic entry has no independent team settings to transfer.
const SESSION_BOT_FIELDS = new Set(['id', 'sessionId', 'name', 'autoName', 'autoTitle', 'sessionTitle', 'nameSource', 'role',
  'autoSessionBot', 'instructions', 'createdAt', 'createdBy', 'capabilities', 'modelSource', 'interactionSource',
  'workDir', 'workspaceId', 'model', 'effort', 'sessionArchived', 'sessionMissing'])

/** Host API for adopting existing root Sessions without changing their execution. */
export class MuseTeamService {
  /** @param {object} rt The owning Muse Bot runtime. @param {() => number} now Clock for synchronization deadlines. */
  constructor(rt, now = Date.now) {
    this.runtime = rt
    this.pending = Promise.resolve()
    this.stopped = false
    this.now = now
    this.sessionBotsDirty = true
    this.sessionBotsDeadline = 0
    this.sessionBotsFlight = undefined
    this.sessionBotsFingerprint = undefined
    this.sessionBotsArchives = undefined
    this.warnedMissingList = false
    this.feishuProviders = new Set()
  }

  /** Register a Feishu binding reader for its active bridge lifetime. */
  registerFeishuProvider(provider) {
    this.feishuProviders.add(provider)
    return () => this.feishuProviders.delete(provider)
  }

  /** Return Bot ids with a currently reachable Feishu chat binding. */
  async connectedFeishuBots() {
    const ids = new Set()
    for (const provider of this.feishuProviders) {
      try {
        for (const id of await provider()) if (this.runtime.botOf(id) !== undefined) ids.add(id)
      } catch (error) {
        this.runtime.warn('Muse Bot could not read Feishu binding status: %s', error?.code ?? 'unavailable')
      }
    }
    return [...ids].sort()
  }

  /** Mark the next requested Session-list reconciliation as stale without starting it. */
  invalidateSessionBots() {
    this.sessionBotsDirty = true
  }

  /** @param {object} bot Registered Bot. @returns {boolean} Whether its automatically listed Session remains available. */
  isSessionBotVisible(bot) {
    return bot.autoSessionBot !== true || (!bot.sessionArchived && !bot.sessionMissing)
  }

  /**
   * Register visible independent Sessions using list metadata without restoring their Agents.
   * Existing ownership is retained; unavailable automatic entries remain saved but are hidden.
   * Invalid metadata is isolated. Listing or batch-save failures reject the request, and a
   * failed save restores the complete batch. Concurrent callers share the reconciliation.
   * @param {AbortSignal} [signal] Cancellation for the cold-safe Session listing.
   * @returns {Promise<{created:string[],failures:{sessionId:string,message:string}[]}>} Newly saved Bot ids and per-item failures.
   */
  syncSessionsAsBots(signal) {
    if (this.runtime.config.autoSessionBots === false) return Promise.resolve(emptySync())
    if (this.sessionBotsFlight !== undefined) return this.sessionBotsFlight
    const flight = this.serialize(async () => {
      const rt = this.runtime
      await rt.load()
      if (rt.readOnly() !== undefined) return emptySync()
      if ((rt.pendingTeamSessionCreates ?? 0) > 0) { this.invalidateSessionBots(); return emptySync() }
      signal?.throwIfAborted()
      const archives = [...(rt.ctx.workspaceRegistry.archivedSessionIds ?? [])].sort()
      const archiveStamp = JSON.stringify(archives)
      if (archiveStamp !== this.sessionBotsArchives) this.invalidateSessionBots()
      if (!this.sessionBotsDirty && this.now() < this.sessionBotsDeadline) return emptySync()
      const list = rt.ctx.sessionController.list
      if (typeof list !== 'function') {
        if (!this.warnedMissingList) rt.warn('Muse Bot cannot synchronize Sessions: the native Session list service is unavailable')
        this.warnedMissingList = true
        return emptySync()
      }
      const dirty = this.sessionBotsDirty
      this.sessionBotsDirty = false
      try {
        const { items } = await list.call(rt.ctx.sessionController, {}, signal)
        signal?.throwIfAborted()
        this.assertWritable()
        if ((rt.pendingTeamSessionCreates ?? 0) > 0) { this.invalidateSessionBots(); return emptySync() }
        const fingerprint = () => JSON.stringify([rt.state.revision, archiveStamp, items])
        const result = emptySync()
        if (dirty || fingerprint() !== this.sessionBotsFingerprint) {
          const archived = new Set(archives)
          const workspaces = rt.ctx.workspaceRegistry.list()
          const workspaceOf = new Map(workspaces.flatMap(workspace => workspace.sessionIds.map(id => [id, workspace])))
          const listed = new Map(items.map(item => [item.sessionId, item]))
          const owned = ownedSessions(rt.state)
          const undo = []
          const restore = () => { for (const revert of undo.toReversed()) revert() }
          try {
            for (const bot of Object.values(rt.state.bots)) {
              if (bot.autoSessionBot !== true) continue
              const sessionId = rt.chatOf(bot.id)
              const item = listed.get(sessionId)
              try {
                const patch = { sessionArchived: archived.has(sessionId), sessionMissing: item === undefined }
                if (item !== undefined && !patch.sessionArchived) {
                  const metadata = this.sessionMetadata(item, workspaceOf)
                  patch.workDir = metadata.workDir
                  patch.workspaceId = metadata.workspace?.id
                  if (bot.modelSource === 'session') {
                    patch.model = metadata.selection == null ? undefined : `${metadata.selection.provider}/${metadata.selection.model}`
                    patch.effort = metadata.selection?.reasoningEffort
                  }
                  if (bot.nameSource === 'session') patch.sessionTitle = metadata.sourceTitle
                  if (bot.nameSource === 'session' && bot.autoName === bot.name && bot.autoTitle !== metadata.title) {
                    patch.name = metadata.title === bot.name ? bot.name : rt.freshBotName(metadata.title)
                    patch.autoName = patch.name
                    patch.autoTitle = metadata.title
                  }
                }
                if (Object.entries(patch).some(([key, value]) => bot[key] !== value)) {
                  const previous = Object.entries(patch).map(([key, value]) => ({ key, value, had: Object.hasOwn(bot, key), before: bot[key] }))
                  undo.push(() => {
                    if (rt.state.bots[bot.id] !== bot) return
                    for (const { key, value, had, before } of previous) {
                      if (bot[key] !== value) continue
                      if (had) bot[key] = before
                      else delete bot[key]
                    }
                  })
                  Object.assign(bot, patch)
                }
              } catch (error) {
                result.failures.push({ sessionId, message: error.message ?? String(error) })
                rt.warn('Muse Bot could not synchronize Session %s: %s', sessionId, error)
              }
            }
            for (const item of items) {
              const sessionId = item.sessionId
              if (archived.has(sessionId) || rt.teamSessionIds?.has(sessionId) || owned.has(sessionId)) continue
              try {
                identity(sessionId)
                const session = rt.ctx.sessions.get(sessionId)
                if (item.origin === 'subagent' || session?.header.origin === 'subagent'
                  || (session?.header.delegationDepth ?? 0) > 0) continue
                const { title, sourceTitle, hasTitle, selection, workspace, workDir } = this.sessionMetadata(item, workspaceOf)
                if (workDir === undefined || (item.blank === true && !hasTitle)) continue
                const name = rt.freshBotName(title)
                const bot = {
                  id: sessionId, sessionId, name, autoName: name, autoTitle: title, sessionTitle: sourceTitle, nameSource: 'session', role: '', autoSessionBot: true,
                  instructions: '', createdAt: session?.header.createdAt ?? this.now(), createdBy: null, capabilities: [],
                  modelSource: 'session', interactionSource: 'session', workDir, sessionArchived: false, sessionMissing: false,
                  ...(selection == null ? {} : { model: `${selection.provider}/${selection.model}` }),
                  ...(selection?.reasoningEffort === undefined ? {} : { effort: selection.reasoningEffort }),
                  ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
                }
                rt.state.bots[sessionId] = bot
                undo.push(() => { if (rt.state.bots[sessionId] === bot) delete rt.state.bots[sessionId] })
                owned.add(sessionId)
                result.created.push(sessionId)
              } catch (error) {
                result.failures.push({ sessionId, message: error.message ?? String(error) })
                rt.warn('Muse Bot could not register Session %s: %s', sessionId, error)
              }
            }
            signal?.throwIfAborted()
            this.assertWritable()
          } catch (error) {
            restore()
            rt.indexSessions()
            throw error
          }
          if (undo.length > 0) await this.persist(restore)
        }
        this.sessionBotsArchives = archiveStamp
        this.sessionBotsDeadline = this.now() + rt.config.sessionBotSyncIntervalMs
        this.sessionBotsFingerprint = result.failures.length === 0 ? fingerprint() : undefined
        return result
      } catch (error) {
        this.invalidateSessionBots()
        throw error
      }
    }, { writable: false }).finally(() => {
      if (this.sessionBotsFlight === flight) this.sessionBotsFlight = undefined
    })
    this.sessionBotsFlight = flight
    return flight
  }

  sessionMetadata(item, workspaceOf) {
    const rt = this.runtime
    const sessionId = item.sessionId
    const session = rt.ctx.sessions.get(sessionId)
    const values = item.projections?.values ?? {}
    const title = session === undefined ? values.title : rt.ctx.sessionTitle.get(session)?.title ?? values.title
    return {
      title: sessionName(title, sessionId),
      sourceTitle: typeof title === 'string' ? title.slice(0, CHANNEL_NAME_MAX) : undefined,
      hasTitle: typeof title === 'string' && title.trim() !== '',
      workDir: session === undefined ? item.cwd : rt.sessionFolder(session),
      selection: session === undefined ? values.modelSelection?.next : rt.sessionSelection(session),
      workspace: workspaceOf.get(sessionId),
    }
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
   * An untouched automatic target entry is removed while its Session joins this stable Bot.
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
      const automatic = owner !== undefined && owner !== botId ? this.absorbableSessionBot(sessionId) : undefined
      if ((owner !== undefined && owner !== botId && automatic === undefined) || rt.roomOf(sessionId) !== undefined
        || rt.groupOwners.has(sessionId) || rt.pastOwners.get(sessionId)?.roomId !== undefined) throw invalid('Session already belongs to another team conversation')
      const agent = await this.rootAgent(sessionId)
      if (rt.botOf(botId) !== bot || rt.chatOf(botId) !== previousSessionId) throw invalid('The Bot changed while the Session was being selected')
      if (automatic !== undefined && (this.absorbableSessionBot(sessionId) !== automatic
        || automatic.workDir !== rt.sessionFolder(agent.session))) throw invalid('Session already belongs to another team conversation')
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
      if (automatic !== undefined) delete rt.state.bots[automatic.id]
      if (source !== undefined) source.sessions = sourceSessions.filter(id => id !== sessionId)
      const changed = ['segments', 'sessionId', 'modelSource', 'interactionSource', 'model', 'effort', 'workDir', 'workspaceId', 'appliedModel', 'appliedEffort']
        .filter(key => bot[key] !== previous[key] || Object.hasOwn(bot, key) !== Object.hasOwn(previous, key))
        .map(key => ({ key, value: bot[key], had: Object.hasOwn(bot, key), segments: key === 'segments' ? JSON.stringify(bot[key]) : undefined }))
      await this.persist(() => {
        if (rt.botOf(botId) === bot) {
          for (const { key, value, had, segments } of changed) {
            if (bot[key] !== value || Object.hasOwn(bot, key) !== had
              || (segments !== undefined && JSON.stringify(bot[key]) !== segments)) continue
            if (Object.hasOwn(previous, key)) bot[key] = previous[key]
            else delete bot[key]
          }
        }
        if (automatic !== undefined && rt.botOf(automatic.id) === undefined) rt.state.bots[automatic.id] = automatic
        if (source !== undefined) source.sessions = sourceSessions
      })
      rt.releaseAgentTools(agent)
      return { botId, sessionId, previousSessionId }
    })
  }

  absorbableSessionBot(sessionId) {
    const rt = this.runtime
    const bot = rt.botOf(sessionId)
    if (bot?.autoSessionBot !== true || rt.chatOf(bot.id) !== sessionId || !this.isSessionBotVisible(bot)
      || rt.state.mainBotIds.includes(bot.id) || bot.nameSource !== 'session' || bot.autoName !== bot.name
      || bot.modelSource !== 'session' || bot.interactionSource !== 'session' || bot.createdBy !== null
      || bot.role !== '' || bot.instructions !== '' || bot.capabilities.length !== 0
      || Object.keys(bot).some(key => !SESSION_BOT_FIELDS.has(key))) return undefined
    if (Object.values(rt.state.rooms).some(room => room.members.includes(bot.id))
      || rt.state.exchanges?.some(entry => entry.from === bot.id || entry.to === bot.id)
      || Object.values(rt.state.works ?? {}).some(work => work.from === bot.id || work.to === bot.id)
      || Object.keys(rt.state.requests ?? {}).some(key => key.startsWith(`${bot.id}\0`))
      || (rt.state.exchangeTurns?.[sessionId]?.length ?? 0) > 0
      || rt.state.questions?.[sessionId] !== undefined || rt.state.views?.[sessionId] !== undefined
      || rt.state.switching?.[sessionId] !== undefined) return undefined
    return bot
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

  serialize(operation, { writable = true } = {}) {
    const run = this.pending.then(() => {
      if (this.stopped) throw new Error('Muse Bot has stopped')
      if (writable) this.assertWritable()
      return operation()
    })
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
  rt.ctx.on('session/created', () => service.invalidateSessionBots())
  rt.ctx.on('session/disposed', () => service.invalidateSessionBots())
  rt.ctx.on('session/event', (_session, event) => {
    if (event.type === 'session/title' || event.type === 'model/selection' || event.type === 'turn/start') service.invalidateSessionBots()
  })
  rt.ctx.effect(() => () => service.dispose(), 'Muse Bot: Session identity service')
}
