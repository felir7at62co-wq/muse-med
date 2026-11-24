// Any dsh-im channel through dsh-im's external-consumer service: dsh-im owns the
// platform account and the wire, DS Bot owns chat bindings, access and prompts. One
// adapter serves every channel; what a channel can do comes from describeBot().
import { createHash } from 'node:crypto'
import { toPlain } from '../format.js'

const MAX_SEEN = 2048
const ACCEPTED = Object.freeze({ accepted: true })
const STATUS_MS = 30_000
// What one inbound message may bring in; larger attachments are left out with a note.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_PART = 4000
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const DSH_IM_BOT = /^[a-zA-Z0-9_-]{1,128}$/
const CONNECTION = /^im_[a-f0-9]{8}$/

/** Map existing DS Bot connection IDs to dsh-im bot IDs (`dshIm`, or the older `feishuDshIm`). */
export function dshImConfig(value = {}, key = 'dshIm') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${key} configuration`)
  const entries = Object.entries(value)
  if (entries.some(([id, bot]) => !CONNECTION.test(id) || typeof bot !== 'string' || !DSH_IM_BOT.test(bot))) {
    throw new Error(`${key} must map IM connection IDs to dsh-im Bot IDs`)
  }
  if (new Set(entries.map(([, bot]) => bot)).size !== entries.length) throw new Error('Each dsh-im Bot needs a single Muse connection')
  return new Map(entries)
}

/** True for a dsh-im bot id. */
export const isDshImBotId = value => typeof value === 'string' && DSH_IM_BOT.test(value)

/** A dsh-im bot a channel-neutral consumer may take, from describeBot(). */
export const consumable = described => described?.version === 1 && typeof described.channel === 'string'
  && /^[a-f0-9]{64}$/.test(described.account?.fingerprint ?? '')
  && ['exclusive-text-consumer', 'reply-text-checked'].every(item => described.capabilities?.includes(item))

const imageType = (data) => {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return undefined
}

// Split at the dsh-im reply limit without cutting a surrogate pair in half.
const parts = (text) => {
  const out = []
  let rest = text
  while (rest.length > 0) {
    const cut = rest.length > MAX_PART && /[\uD800-\uDBFF]/u.test(rest[MAX_PART - 1]) ? MAX_PART - 1 : MAX_PART
    const part = rest.slice(0, cut).trim()
    rest = rest.slice(cut).trimStart()
    if (part !== '') out.push(part)
  }
  return out
}

/**
 * Take one dsh-im bot's inbound messages for a DS Bot connection.
 *
 * @param {object} service - The `dshIm` service.
 * @param {object} link - `{ botId, fingerprint? }`: the dsh-im bot, and the account fingerprint pinned when it was linked.
 * @param {object} env - The connection's IM environment (`runtime`, `log`).
 * @param {object} handlers - `onMessage(msg)`, `onStatus(status)`, `routeOf(chatKey)` for a chat's saved delivery target.
 * @param {AbortSignal} signal - Aborted when the connection stops.
 * @returns {Promise<object>} The send handle: `channel`, `account`, `formats`, `send(chat, job)`, `stop()`.
 */
export async function connectDshIm(service, link, env, { onMessage, onStatus, routeOf }, signal) {
  if (service?.inboundVersion !== 1) throw new Error('dsh-im is not running in this Muse')
  const described = await service.describeBot(link.botId)
  if (!consumable(described)) throw new Error('This dsh-im account cannot be used by Bots')
  const fingerprint = described.account.fingerprint
  if (link.fingerprint !== undefined && link.fingerprint !== fingerprint) {
    throw new Error('The dsh-im account behind this connection changed; remove it and link the account again')
  }
  signal.throwIfAborted()
  const channel = described.channel
  const formats = Array.isArray(described.formats) ? described.formats : ['plain']
  const canPush = described.capabilities.includes('proactive-text-checked') && typeof service.pushChecked === 'function'
  const options = { expectedFingerprint: fingerprint, signal }
  const saved = env.runtime.get().dshImSeen
  const seen = new Set(Array.isArray(saved) ? saved.slice(-MAX_SEEN) : [])
  const running = new Map()

  const attachments = (event, context, signal) => async () => {
    const images = []
    const files = []
    const skipped = []
    for (const [index, item] of (event.attachments ?? []).entries()) {
      const image = item.kind === 'image'
      try {
        const loaded = await context.loadAttachment(index, { signal, maxBytes: image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES })
        const data = Buffer.from(loaded.data)
        const mediaType = image ? (imageType(data) ?? (loaded.mediaType?.startsWith('image/') ? loaded.mediaType : undefined)) : undefined
        if (image && mediaType !== undefined) images.push({ mediaType, data: data.toString('base64') })
        else files.push({ name: loaded.name ?? item.name ?? item.kind, data })
      } catch (error) {
        signal.throwIfAborted()
        skipped.push(item.name ?? item.kind)
        env.log?.warn('ds-bot: a %s attachment from %s was not loaded: %s', item.kind, channel, error?.code ?? error?.message ?? error)
      }
    }
    return { images, files, skipped }
  }

  const dispose = await service.consumeInbound(link.botId, { ...options, onEvent(event, context) {
    const inboxSignal = AbortSignal.any([signal, context.signal])
    inboxSignal.throwIfAborted()
    if (event?.version !== 1 || event.channel !== channel || event.botId !== link.botId || event.fingerprint !== fingerprint) {
      throw new Error('Unexpected dsh-im sender account')
    }
    const requestKey = hash([fingerprint, event.messageId])
    if (seen.has(requestKey)) return ACCEPTED
    const pending = running.get(requestKey)
    if (pending !== undefined) return pending
    const accept = (async () => {
      const kind = event.conversation.kind === 'dm' ? 'direct' : 'group'
      const name = event.actor.name || event.actor.id
      // Feishu names mentions with placeholders; other channels send clean text.
      const mentions = new Set((event.mentions ?? []).map(mention => mention.key))
      let text = String(event.text ?? '').replace(/@_user_\d+/g, key => mentions.has(key) ? '' : key).trim()
      if (event.quote?.text) text = `${event.quote.text.split('\n').map(line => `> ${line}`).join('\n')}\n\n${text}`.trim()
      await onMessage({
        chat: {
          key: event.conversation.id,
          kind,
          title: event.conversation.title ?? (kind === 'direct' && name !== event.actor.id ? name : ''),
          reply: event.reply,
          ...(event.target !== undefined ? { route: event.target } : {}),
        },
        sender: { id: event.actor.id, name },
        text,
        attachments: typeof context.loadAttachment === 'function' && (event.attachments ?? []).length > 0
          ? attachments(event, context, inboxSignal) : undefined,
        mentioned: event.mentionedAccount === true,
        messageId: event.messageId,
        requestId: `im:${channel}:${requestKey}`,
        signal: inboxSignal,
      })
      seen.add(requestKey)
      if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value)
      env.runtime.set({ dshImSeen: [...seen] })
      return ACCEPTED
    })().finally(() => { running.delete(requestKey) })
    running.set(requestKey, accept)
    return accept
  } })

  // dsh-im keeps the platform connection; report whether it is up now and then.
  let watcher
  const report = async () => {
    try {
      const now = await service.describeBot(link.botId)
      if (signal.aborted) return
      if (now?.account?.fingerprint !== fingerprint) onStatus({ state: 'error', error: 'The dsh-im account behind this connection changed' })
      else onStatus({ state: now.connected === false ? 'connecting' : 'ready', account: { id: link.botId, name: now.account.name ?? link.botId } })
    } catch (error) {
      if (!signal.aborted) onStatus({ state: 'error', error: String(error?.message ?? error).slice(0, 300) })
    }
  }
  await report()
  watcher = setInterval(() => { void report() }, STATUS_MS)
  watcher.unref?.()

  const failure = (error, delivered) => {
    if (delivered || ['reply-result-unknown', 'send-result-unknown'].includes(error?.code) || signal.aborted) {
      return Object.assign(new Error(`${channel} could not confirm the complete message`), { unknown: true, cause: error })
    }
    if (['bot-not-connected', 'consumer-unavailable', 'provider-unavailable', 'cancelled'].includes(error?.code)) {
      return Object.assign(new Error(`${channel} is not connected right now`), { cause: error })
    }
    return Object.assign(new Error(`${channel} refused the message`), { permanent: true, cause: error })
  }

  return {
    channel,
    account: { id: link.botId, name: described.account.name ?? link.botId },
    fingerprint,
    formats,
    canPush,
    stop() {
      clearInterval(watcher)
      return dispose()
    },
    async send(chat, job) {
      signal.throwIfAborted()
      const format = formats.includes('markdown') ? 'markdown' : 'plain'
      const body = format === 'markdown' ? String(job.text ?? '').trim() : toPlain(job.text).trim()
      const reply = chat.reply !== undefined && chat.reply.conversationId === chat.key ? chat.reply : undefined
      const route = reply === undefined ? (chat.route ?? routeOf?.(chat.key)) : undefined
      if (reply === undefined && (route === undefined || !canPush)) {
        throw Object.assign(new Error(`This ${channel} chat can only be answered after it writes`), { permanent: true })
      }
      let delivered = false
      let messageId
      try {
        for (const part of parts(body)) {
          signal.throwIfAborted()
          const receipt = reply !== undefined
            ? await service.replyChecked(link.botId, reply, part, { ...options, format })
            : await service.pushChecked(link.botId, route, part, { ...options, format })
          if (receipt?.sent !== true) throw Object.assign(new Error('send-result-unknown'), { code: 'send-result-unknown' })
          delivered = true
          messageId ??= receipt.messageId
        }
        return { messageId }
      } catch (error) {
        throw failure(error, delivered)
      }
    },
  }
}
