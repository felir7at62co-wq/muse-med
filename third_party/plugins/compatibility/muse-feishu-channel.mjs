/** Optional Feishu provider; credentials remain in the existing feishu-channel section. */
import { once } from 'node:events'
import z from '@deepseek-ai/schemastery'
import { sendWorkspaceFile } from './muse-feishu-files.mjs'

/** Stable Cordis plugin name for the optional channel. */
export const name = 'muse-feishu-channel'
/** Credentials and inbound policy persisted in the active profile section. */
export const Config = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default('').volatile(),
  appSecret: z.string().role('secret').default('').volatile(),
  registeredBy: z.string().default('').volatile(),
  allowFrom: z.array(z.string()).default([]).volatile(),
  activeSessionId: z.string().default('').volatile(),
  requireMention: z.boolean().default(true),
  denyTools: z.array(z.string()).default(['ask_user_question', 'exit_plan_mode']),
  digestIntervalSec: z.number().min(1).default(30),
  approvalTimeoutSec: z.number().min(1).default(600),
  maxMessageChars: z.number().min(200).default(2000),
  sendChunkDelayMs: z.number().min(100).max(1000).default(200),
})

/**
 * Mount the upstream Feishu gateway and conversation node after explicit activation.
 * @param {object} ctx Cordis owner of channel registrations and teardown.
 * @param {object} config Resolved Config, including volatile credential cells.
 * @returns {void}
 */
export function apply(ctx, config) {
  if (!config.enabled) return
  config = { ...config, ...Object.fromEntries(['appId', 'appSecret', 'registeredBy', 'allowFrom', 'activeSessionId'].map(key => [key, config[key].get()])) }
  if (!config.appId || !config.appSecret) throw new Error('Feishu requires an app ID and secret before activation')
  ctx.inject(['sessions', 'agents', 'approval', 'settings', 'workspaceRegistry', 'sessionPersistence', 'sessionProjectionCache', 'sessionTitle', 'agentPresets', 'agentDefaultModel'], async scope => {
    const { FeishuGateway } = await import('./upstream/feishu/gateway.js')
    const { FeishuConversationNode } = await import('./upstream/feishu/node.js')
    const operations = new Set()
    let closing = false
    const track = operation => {
      operations.add(operation)
      operation.catch(error => { if (!closing) scope.logger.error(error) }).finally(() => operations.delete(operation))
      return operation
    }
    class Gateway extends FeishuGateway {
      _startWatchdog() {
        // The maintained SDK owns reconnect and heartbeat timers.
      }
      async stop() {
        this._closing = true
        this._stopWatchdog()
        await this._startingPromise
        this._closing = true
        this._stopWatchdog()
        const socket = this.wsClient?.wsConfig?.getWSInstance?.()
        this.wsClient?.close({ force: true })
        if (socket && socket.readyState !== 3) await once(socket, 'close')
        this.client = null
        this.wsClient = null
        this.eventDispatcher = null
        this.setStatus('offline')
      }
    }
    for (const method of ['sendText', 'sendCard', 'sendMarkdownCard', 'patchCard', 'sendLocalImage', 'sendLocalFile', 'sendMediaFile', 'downloadMessageResource']) {
      Gateway.prototype[method] = function (...args) {
        return closing ? Promise.resolve(null) : track(FeishuGateway.prototype[method].apply(this, args))
      }
    }
    const gateway = new Gateway(scope, { appId: config.appId, appSecret: config.appSecret })
    const nodeScope = scope.inject(['feishu'], bound => {
      class Node extends FeishuConversationNode {
        _handleInbound(event) {
          if (closing) return
          const sender = event.isGroup ? event.peerId : event.senderId
          if ((this.config.allowFrom.length > 0 && !this.config.allowFrom.includes(sender)) || (this.config.allowFrom.length === 0 && !event.text)) return
          if (event.isGroup && config.requireMention && !event.raw?.message?.mentions?.some(mention => mention.id?.open_id === gateway.botInfo?.openId && gateway.botInfo?.openId)) return
          return track(super._handleInbound(event))
        }
        _handleAction(event) {
          if (!closing) return track(super._handleAction(event))
        }
        _sendTextNow(text, options) {
          return closing ? Promise.resolve() : track(super._sendTextNow(text, options))
        }
        async _composeAgentPreset(id) {
          const composed = await super._composeAgentPreset(id)
          return { ...composed, setup: async agentCtx => {
            await composed.setup?.(agentCtx)
            const denied = new Set(config.denyTools)
            const tools = agentCtx.get('tools')
            if (tools && denied.size) agentCtx.effect(() => tools.guard(execution => denied.has(execution.name)
              ? `${execution.name} is unavailable in this chat channel: its answer would surface on a different interface. Ask the user directly in your reply instead, and continue when they answer.`
              : undefined))
          } }
        }
      }
      const persisted = patch => track(bound.settings.update('feishu-channel', patch))
      const node = new Node(bound, {
        ...config,
        allowFrom: config.allowFrom.length ? config.allowFrom : config.registeredBy ? [config.registeredBy] : [],
        activeSessionId: config.activeSessionId || undefined,
      }, bound.logger, {
        onFirstSender: () => persisted({ allowFrom: [...node.config.allowFrom] }),
        onActiveSessionChange: activeSessionId => persisted({ activeSessionId }),
      })
      const sendMediaFile = node.platform.sendMediaFile.bind(node.platform)
      node.platform.sendMediaFile = (peerId, filePath, options) => track(sendWorkspaceFile({
        cwd: node.activeSession()?.header.cwd,
        filePath,
        send: canonicalFile => sendMediaFile(peerId, canonicalFile, options),
      }))
      bound.effect(() => async () => {
        closing = true
        const queued = node._inboundQueue
        node.dispose()
        await Promise.allSettled([queued, ...operations])
        while (operations.size) await Promise.allSettled([...operations])
      })
    })
    scope.effect(() => async () => {
      closing = true
      await nodeScope.dispose()
      await gateway.stop()
      while (operations.size) await Promise.allSettled([...operations])
    })
    if (!await gateway.start()) throw new Error('Feishu could not establish its configured connection')
  })
}
