/** Muse-owned Agent composition, routing, file delivery, and channel lifecycle. */
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'muse-feishu-channel'

/** The existing row continues to own its editable credentials and pairing policy. */
export const Config = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default('').volatile(),
  appSecret: z.string().role('secret').default('').volatile(),
  registeredBy: z.string().default('').volatile(),
  allowFrom: z.array(z.string()).default([]).volatile(),
  activeSessionId: z.string().default('').volatile(),
  requireMention: z.boolean().default(true),
  denyTools: z.array(z.string()).default(['exit_plan_mode']),
  agentPreset: z.string().default('short-drama'),
  defaultCwd: z.string().required(false),
  dataDir: z.string().required(false),
  cardThrottleMs: z.number().min(100).max(5000).default(400),
  maxFileBytes: z.number().min(1).default(100 * 1024 * 1024),
  inboundClaimRetentionMs: z.number().step(1).min(1).default(7 * 24 * 60 * 60 * 1000),
  inboundClaimMaxEntries: z.number().step(1).min(1).default(100000),
  retainedCardOwners: z.number().step(1).min(1).default(1000),
  digestIntervalSec: z.number().min(1).default(30),
  approvalTimeoutSec: z.number().min(1).default(600),
  maxMessageChars: z.number().min(200).default(2000),
  sendChunkDelayMs: z.number().min(100).max(1000).default(200),
})

function contains(root, file) {
  const path = relative(root, file)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

/** Read only a regular file physically contained in the Session workspace. */
async function inspectWorkspaceFile(cwd, path, maxFileBytes) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || typeof path !== 'string') throw new Error('Feishu file has no Session workspace')
  const requested = resolve(cwd, path)
  if (!contains(cwd, requested)) throw new Error('Feishu file is outside the Session workspace')
  const [workspace, file] = await Promise.all([realpath(cwd), realpath(requested)])
  if (!contains(workspace, file)) throw new Error('Feishu file is outside the physical Session workspace')
  const info = await stat(file)
  if (!info.isFile() || info.size > maxFileBytes) throw new Error('Feishu file is not a regular file within the configured size limit')
  return { name: basename(file), path: file }
}

/** Read a validated workspace file for a real outbound delivery. */
export async function readWorkspaceFile(cwd, path, maxFileBytes) {
  const file = await inspectWorkspaceFile(cwd, path, maxFileBytes)
  return { ...file, bytes: new Uint8Array(await readFile(file.path)) }
}

/** Preserve the product preset and persisted model choice when creating or resuming an Agent. */
export function createMuseAgentStore(ctx, config, selectionFor, owned, setupTools = () => {}) {
  const checkHeader = header => {
    if (header?.origin === 'subagent' || header?.parentSession !== undefined) throw new Error('Feishu cannot adopt a delegated Session')
  }
  const liveAgent = id => {
    const agent = ctx.agents.get(id)
    if (agent !== undefined) checkHeader(agent.session.header)
    return agent
  }
  const compose = async (header, creating) => {
    checkHeader(header)
    const presets = ctx.agentPresets
    const selected = header?.agentPreset ?? config.agentPreset
    const preset = await (creating ? presets.resolveForCreation(selected) : presets.resolve(selected))
    return {
      id: preset.id,
      setup: async (agentCtx, agent) => {
        const pending = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending
        const logged = agent.session.requestHeader()?.config
        const defaults = ctx.agentDefaultModel.currentSelection()
        const model = pending ?? logged ?? defaults
        selectionFor(agentCtx).current = {
          provider: model.provider, model: model.model,
          ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
        }
        await presets.mount(agentCtx, preset.id)
        setupTools(agentCtx, agent)
        const denied = new Set(config.denyTools.filter(tool => tool !== 'ask_user_question'))
        if (denied.size > 0) agentCtx.effect(() => agentCtx.tools.guard(execution => denied.has(execution.name)
          ? `${execution.name} is unavailable in this Feishu conversation.` : undefined))
      },
    }
  }
  return {
    get: liveAgent,
    async create(id, cwd) {
      const preset = await compose(undefined, true)
      const handle = await ctx.agents.create({ sessionId: id, meta: { cwd, agentPreset: preset.id },
        agentOptions: ctx.agentDefaultModel.currentSelection(), setup: preset.setup })
      owned.add(handle)
      return handle.agent
    },
    async resume(id) {
      const live = liveAgent(id)
      if (live !== undefined) return live
      const snapshot = await ctx.sessionPersistence.stat(id)
      if (snapshot === undefined) throw Object.assign(new Error('No persisted Session exists for this identity'), { code: 'MUSE_SESSION_NOT_FOUND' })
      const preset = await compose(snapshot.header, false)
      const handle = await ctx.agents.resume({ resumeSessionId: id,
        agentOptions: ctx.agentDefaultModel.currentSelection(), setup: preset.setup })
      owned.add(handle)
      return handle.agent
    },
  }
}

/** Register the channel-only file tool; a successful call includes a real transport receipt. */
export function registerMuseSendFile(ctx, host, maxFileBytes) {
  return ctx.tools.register(defineTool({
    name: 'send_file',
    description: '把当前会话工作区内的文件或图片发送到对应飞书聊天。视频以可下载文件附件发送。',
    parameters: {
      path: { type: 'string', required: true, description: '工作区内的相对或绝对文件路径。' },
      description: { type: 'string', description: '随文件显示的简短说明。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const session = exec.agent?.session
      const chatId = session === undefined ? undefined : host.sessionMap.chatFor(session.id)
      if (chatId === undefined) throw new Error('This Session has no authorized Feishu chat')
      const file = await inspectWorkspaceFile(session.header.cwd, args.path, maxFileBytes)
      await ctx.serial('deliverables/validate', [file.path], exec.signal)
      exec.signal.throwIfAborted()
      const bytes = new Uint8Array(await readFile(file.path))
      if (typeof args.description === 'string' && args.description.trim()) await host.transport.sendText(chatId, args.description)
      if (/\.(?:png|jpe?g|gif|webp)$/iu.test(file.name)) await host.transport.sendImage(chatId, file.name, bytes)
      else await host.transport.sendFile(chatId, file.name, bytes)
      return { name: file.name, sent: true }
    },
  }))
}

/** Await the retained socket after the SDK removes its previous event listeners during close. */
export async function stopMuseTransport(transport) {
  const socket = transport.ws?.wsConfig?.getWSInstance?.()
  await transport.stop()
  if (socket && socket.readyState !== 3) await once(socket, 'close')
}

/** Cancel owned Agents and wait for all admitted work before reporting teardown failures. */
export async function drainMuseOperations(owned, operations) {
  for (const handle of owned) handle.agent.cancel({ kind: 'user' })
  const results = await Promise.allSettled([...owned].map(handle => handle.dispose()))
  while (operations.size > 0) await Promise.allSettled([...operations])
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (errors.length > 0) throw new AggregateError(errors, 'Muse Feishu Agents could not be fully disposed')
}

/** Mount the native card surface on the existing Host without replacing its account or remote bridge. */
export function mountMuseFeishu(ctx, raw, upstream, dependencies) {
  if (!raw.enabled) return
  if (ctx.fiber.entry?.options.id !== 'feishu-channel') throw new Error('The Muse Feishu provider must be mounted as feishu-channel')
  const config = { ...raw, ...Object.fromEntries(['appId', 'appSecret', 'registeredBy', 'allowFrom', 'activeSessionId'].map(key => [key, raw[key].get()])) }
  if (!config.appId || !config.appSecret) throw new Error('Feishu requires an app ID and secret before activation')
  ctx.inject(['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'agentPresets', 'agentDefaultModel', 'tools', 'settings'], async scope => {
    const identity = createHash('sha256').update(JSON.stringify([config.appId, config.registeredBy])).digest('hex')
    const dataDir = join(config.dataDir ?? dshHomePath('feishu'), 'accounts', identity)
    const defaultCwd = config.defaultCwd ?? dshHomePath('default-workspace')
    if (!isAbsolute(dataDir) || !isAbsolute(defaultCwd)) throw new Error('Feishu data and workspace directories must be absolute')
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    mkdirSync(defaultCwd, { recursive: true })
    const claims = dependencies.createInboundClaims(join(dataDir, 'inbound-claims.json'), {
      retentionMs: config.inboundClaimRetentionMs, maxEntries: config.inboundClaimMaxEntries,
    })
    const owned = new Set()
    const fileTools = new Map()
    const operations = new Set()
    const requesters = new Map()
    const cardOwners = new Map()
    const approvedNewChats = new Set()
    const allowed = new Set(config.allowFrom.length > 0 ? config.allowFrom : config.registeredBy ? [config.registeredBy] : [])
    let closing = false
    let surface
    let starting
    let inbound = Promise.resolve()
    const track = promise => {
      operations.add(promise)
      promise.catch(error => { if (!closing) scope.logger.error(error) }).finally(() => operations.delete(promise))
      return promise
    }
    const installFileTool = (agentCtx, agent) => {
      if (fileTools.has(agent)) return
      const unregister = registerMuseSendFile(agentCtx, surface, config.maxFileBytes)
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        unregister()
        fileTools.delete(agent)
      }
      fileTools.set(agent, dispose)
      agentCtx.effect(() => dispose)
    }
    scope.effect(() => () => { for (const dispose of fileTools.values()) dispose() })
    const legacyHeaders = [...(await scope.sessionPersistence.list()).map(record => record.header), ...scope.sessions.list().map(session => session.header)]
    const legacy = dependencies.migration.resolveLegacyFeishuSession({ home: dshHomePath(), config, headers: legacyHeaders })
    const wrapTransport = transport => new Proxy(transport, {
      get(target, key) {
        if (key === 'onMessage') return handler => target.onMessage(message => {
          const operation = inbound.then(async () => {
          if (closing) return
          const sender = message.chatType === 'group' ? message.chatId : message.senderOpenId
          if (allowed.size > 0 && !allowed.has(sender)) return
          if (message.chatType === 'group' && config.requireMention
            && (!target.getBotOpenId() || !message.mentions.includes(target.getBotOpenId()))) return
          if (allowed.size === 0) {
            if (!message.text.trim()) return
            await scope.settings.update('feishu-channel', { allowFrom: [sender] })
            allowed.add(sender)
          }
          if (!claims.claim(message.messageId)) return
          requesters.set(message.chatId, message.senderOpenId)
          if (/^\/(?:permission|plan)(?:\s|$)/iu.test(message.text)) {
            await target.sendText(message.chatId, 'Muse 使用统一的短剧编导模式和完全权限；此处不提供模式或权限切换。')
            return
          }
          const map = surface?.sessionMap
          const legacyChoice = map === undefined ? { kind: 'unavailable' } : dependencies.migration.legacyFeishuChoice(legacy, map, message.chatId)
          if (legacyChoice.kind === 'available' && !approvedNewChats.has(message.chatId)) {
            if (/^\/(?:new|clear)(?:\s|$)/u.test(message.text)) approvedNewChats.add(message.chatId)
            else if (!/^\/(?:sessions|resume|panel|help)(?:\s|$)/u.test(message.text)) {
              track(target.sendText(message.chatId, `已找到原飞书会话，尚未把它绑定到这个聊天。发送 /resume ${legacyChoice.session.sessionId} 继续原会话，或 /new 新建；也可通过 /sessions 查看会话。`))
              return
            }
          }
          handler(message)
          })
          inbound = operation.then(() => undefined, () => undefined)
          track(operation)
        })
        if (key === 'onCardAction') return handler => target.onCardAction(action => {
          if (closing) return
          const sender = action.chatId.startsWith('oc_') && allowed.has(action.chatId) ? action.chatId : action.operatorOpenId
          if (!allowed.has(sender)) return
          const owner = cardOwners.get(action.messageId)
          if (owner !== undefined && owner !== action.operatorOpenId) return
          if (action.value.kind === 'permission-pick' || action.value.command === 'permission' || action.value.command === 'plan') return
          if (action.value.kind === 'send-produced') {
            const sessionId = surface?.sessionMap.get(action.chatId)
            const cwd = sessionId === undefined ? undefined : scope.sessions.get(sessionId)?.header.cwd
            track(inspectWorkspaceFile(cwd, action.value.path, config.maxFileBytes)
              .then(file => handler({ ...action, value: { ...action.value, path: file.path } }))
              .catch(error => target.sendText(action.chatId, `文件未发送：${error.message}`)))
            return
          }
          handler(action)
        })
        if (key === 'start') return () => {
          starting = target.start()
          return track(starting)
        }
        if (key === 'stop') return () => stopMuseTransport(target)
        if (typeof target[key] !== 'function') return target[key]
        if (['sendText', 'sendFile', 'sendImage', 'sendCard', 'updateCard', 'downloadFile', 'downloadImage'].includes(key)) return (...args) => {
          if (closing) return Promise.reject(new Error('Feishu channel is closing'))
          const operation = Promise.resolve(target[key](...args))
          if (key === 'sendCard') operation.then(sent => {
            const owner = requesters.get(args[0])
            if (owner !== undefined) cardOwners.set(sent.messageId, owner)
            while (cardOwners.size > config.retainedCardOwners) cardOwners.delete(cardOwners.keys().next().value)
          }).catch(error => { if (!closing) scope.logger.error(error) })
          return track(operation)
        }
        return target[key].bind(target)
      },
    })
    upstream.apply(scope, {
      appId: config.appId, appSecret: config.appSecret, dataDir, defaultCwd,
      groupMentionMode: 'never', requireWorkingDir: false, locale: 'zh-CN', cardThrottleMs: config.cardThrottleMs,
    }, {
      createTransport: (credentials, logger) => wrapTransport(dependencies.createTransport(credentials, logger)),
      createAgentStore: () => createMuseAgentStore(scope, config, dependencies.selectionFor, owned, installFileTool),
      onSessionAdopt: id => {
        const agent = scope.agents.get(id)
        if (agent === undefined) return
        installFileTool(agent.ctx, agent)
        const chatId = surface.sessionMap.chatFor(id)
        if (chatId !== undefined && agent.session.header.cwd !== undefined) surface.sessionMap.setCwd(chatId, agent.session.header.cwd)
      },
      trackOperation: track,
      strictSessionRestore: true,
      registerSendFileTool: () => undefined,
      onBridge: (bridge, sessionMap, transport) => {
        surface = { bridge, sessionMap, transport }
        scope.on('session/event', (session, event) => {
          if (event.type !== 'deliverables/presented') return
          const chatId = sessionMap.chatFor(session.id)
          if (chatId === undefined || closing) return
          track((async () => {
            for (const item of event.data.files) {
              const file = await readWorkspaceFile(session.header.cwd, item.path, config.maxFileBytes)
              if (item.description) await transport.sendText(chatId, item.description)
              if (/\.(?:png|jpe?g|gif|webp)$/iu.test(file.name)) await transport.sendImage(chatId, file.name, file.bytes)
              else await transport.sendFile(chatId, file.name, file.bytes)
            }
          })().catch(error => transport.sendText(chatId, `交付文件未发送：${error.message}`)))
        })
      },
      close: () => { closing = true },
      drain: async () => {
        await drainMuseOperations(owned, operations)
      },
    })
    if (starting !== undefined) await starting
  })
}
