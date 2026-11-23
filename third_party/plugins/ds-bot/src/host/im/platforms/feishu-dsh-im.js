// dsh-im owns the Feishu connection. DS Bot owns chat bindings and prompts.
import { createHash } from 'node:crypto'
import { createFeishuHttp } from './feishu.js'
import { toPlain } from '../format.js'

const MAX_SEEN = 2048
const ACCEPTED = Object.freeze({ accepted: true })
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Locate the legacy account for each existing DS Bot connection. */
export function feishuDshImConfig(value = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid feishuDshIm configuration')
  const entries = Object.entries(value)
  if (entries.some(([id, bot]) => !/^im_[a-f0-9]{8}$/.test(id) || typeof bot !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(bot))) {
    throw new Error('feishuDshIm must map IM connection IDs to dsh-im Bot IDs')
  }
  if (new Set(entries.map(([, bot]) => bot)).size !== entries.length) throw new Error('Each dsh-im Bot needs a single Muse connection')
  return new Map(entries)
}

/** Attach the existing connection to an exclusive dsh-im account. */
export async function connectDshImFeishu(service, botId, conn, fields, env, onMessage, signal, onAction) {
  if (service?.inboundVersion !== 1) throw new Error('Feishu requires the dsh-im inbound service')
  const verified = await service.describeBot(botId)
  const fingerprint = hash({ provider: 'feishu', domain: fields.domain === 'lark' ? 'lark' : 'feishu',
    appId: fields.appId, botOpenId: conn.account?.id })
  if (verified?.channel !== 'feishu' || verified.account?.fingerprint !== fingerprint
    || !['exclusive-text-consumer', 'reply-text-checked'].every(item => verified.capabilities?.includes(item))) {
    throw new Error('The configured dsh-im Bot does not match this Feishu connection')
  }
  signal.throwIfAborted()
  const rich = verified.capabilities.includes('muse-rich-consumer') && typeof onAction === 'function'
  const http = createFeishuHttp(fields, env)
  const saved = env.runtime.get().dshImFeishuSeen
  const seen = new Set(Array.isArray(saved) ? saved.slice(-MAX_SEEN) : [])
  const running = new Map()
  const options = { expectedFingerprint: fingerprint, signal }
  const dispose = await service.consumeInbound(botId, { ...options, rich, onEvent(event, context) {
    const inboxSignal = AbortSignal.any([signal, context.signal])
    inboxSignal.throwIfAborted()
    if (event.version !== 1 || event.channel !== 'feishu' || event.botId !== botId || event.fingerprint !== fingerprint) {
      throw new Error('Unexpected dsh-im Feishu sender account')
    }
    if (rich && event.kind === 'card') {
      return Promise.resolve(onAction({ chat: { key: event.conversationId, kind: 'direct', title: '' },
        sender: { id: event.actorId }, messageId: event.messageId, data: event.value })).then(() => ACCEPTED)
    }
    const requestKey = hash([fingerprint, event.messageId])
    if (seen.has(requestKey)) return ACCEPTED
    const pending = running.get(requestKey)
    if (pending !== undefined) return pending
    const accept = (async () => {
      const kind = event.conversation.kind === 'dm' ? 'direct' : 'group'
      const key = event.conversation.id
      const names = await http.names(key, kind === 'direct')
      inboxSignal.throwIfAborted()
      const name = event.actor.name || names.members.get(event.actor.id) || event.actor.id
      const mentions = new Set(event.mentions.map(mention => mention.key))
      const images = []
      if (rich && event.imageKey) images.push(await http.image(event.messageId, event.imageKey))
      inboxSignal.throwIfAborted()
      await onMessage({
        chat: { key, kind, title: kind === 'direct' ? (name !== event.actor.id ? name : '') : names.title, reply: event.reply },
        sender: { id: event.actor.id, name },
        text: event.text.replace(/@_user_\d+/g, key => mentions.has(key) ? '' : key).trim(),
        images,
        voice: event.audioKey ? context.voice ?? null : undefined,
        stepPushMode: event.stepPushMode,
        mentioned: event.mentionedAccount,
        allowKnownGroup: rich && event.groupResponseMode === 'all',
        messageId: event.messageId,
        requestId: `im:feishu:${requestKey}`,
        signal: inboxSignal,
      })
      seen.add(requestKey)
      if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value)
      env.runtime.set({ dshImFeishuSeen: [...seen] })
      return ACCEPTED
    })().finally(() => { running.delete(requestKey) })
    running.set(requestKey, accept)
    return accept
  } })
  return {
    rich,
    ...(rich ? { edit: http.edit, progress: http.progress } : {}),
    stop: dispose,
    async send(chat, job) {
      signal.throwIfAborted()
      if (rich && (job.buttons !== undefined || chat.reply === undefined)) return http.send(chat, job)
      if (chat.reply === undefined || chat.reply.conversationId !== chat.key) {
        throw Object.assign(new Error('Feishu reply has no active source message'), { permanent: true })
      }
      const body = toPlain(job.text).trim()
      let messageId
      let remaining = body
      try {
        while (remaining.length > 0) {
          // dsh-im counts UTF-16 units. Avoid splitting a surrogate pair at its limit.
          const cut = remaining.length > 4000 && /[\uD800-\uDBFF]/u.test(remaining[3999]) ? 3999 : 4000
          const part = remaining.slice(0, cut).trim()
          remaining = remaining.slice(cut).trimStart()
          if (part === '') continue
          const receipt = await service.replyChecked(botId, chat.reply, part, options)
          if (receipt?.sent !== true) throw Object.assign(new Error('Feishu reply status is unknown'), { code: 'reply-result-unknown' })
          messageId ??= receipt.messageId
        }
        return { messageId }
      } catch (error) {
        if (messageId !== undefined || error?.code === 'reply-result-unknown' || signal.aborted) {
          throw Object.assign(new Error('Feishu could not confirm the complete reply'), { unknown: true, cause: error })
        }
        throw Object.assign(new Error('Feishu rejected the reply'), { permanent: true, cause: error })
      }
    },
  }
}
