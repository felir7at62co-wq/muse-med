// dsh-im owns the Feishu connection. DS Bot owns chat bindings and prompts. With
// dsh-im's rich consumer, DS Bot reads what each message carries (rich text,
// pictures, files, video, voice) through its own Feishu REST access, answers a
// reply that uses Markdown with cards on the source message, and lists the
// groups the bot is in.
import { createHash } from 'node:crypto'
import { FILE_NAMES, createFeishuHttp, flattenPost } from './feishu.js'
import { hasMarkdown } from '../feishu-markdown.js'
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
      let text = event.text.replace(/@_user_\d+/g, key => mentions.has(key) ? '' : key).trim()
      // What to download once the message is admitted: nothing is fetched for one that is not.
      const images = []
      const files = []
      if (rich && event.post !== undefined) {
        // An `at` names its mention by key; the bot's own mention goes, as in plain text.
        const atName = (item) => {
          const mention = event.mentions.find(entry => entry.key === item.user_id)
          if ((mention?.id ?? item.user_id) === conn.account?.id) return ''
          return String(item.user_name || mention?.name || '').trim()
        }
        const post = flattenPost(event.post, atName)
        text = post.text
        images.push(...post.images)
        files.push(...post.media.map(fileKey => ({ key: fileKey, name: FILE_NAMES.media })))
      }
      if (rich && event.imageKey) images.push(event.imageKey)
      if (rich && event.fileKey) files.push({ key: event.fileKey, name: event.fileName ?? FILE_NAMES[event.messageType] ?? 'file' })
      // dsh-im turns voice into text where its speech service is set up; elsewhere the
      // recording itself goes to the Bot.
      const voice = rich && event.audioKey ? context.voice : undefined
      if (rich && event.audioKey && voice === undefined) files.push({ key: event.audioKey, name: FILE_NAMES.audio })
      const addressed = kind === 'direct' || event.mentionedAccount === true
      // Nothing readable — a sticker, a forwarded bundle, a share card, an empty post: the
      // type goes on so the person is told, only where the bot was spoken to.
      const unsupported = rich && addressed && text === '' && images.length === 0 && files.length === 0 && voice === undefined
        ? (event.messageType ?? 'unknown') : undefined
      const attachments = images.length + files.length === 0 ? undefined : async () => {
        const loaded = { images: [], files: [], skipped: [] }
        for (const imageKey of images) {
          try {
            loaded.images.push(await http.image(event.messageId, imageKey))
          } catch (error) {
            inboxSignal.throwIfAborted()
            loaded.skipped.push('image')
            env.log?.warn('ds-bot im: feishu picture not read in a %s chat: %s', kind, error?.message ?? error)
          }
        }
        for (const file of files) {
          try {
            loaded.files.push({ name: file.name, data: await http.file(event.messageId, file.key) })
          } catch (error) {
            inboxSignal.throwIfAborted()
            loaded.skipped.push(file.name)
            env.log?.warn('ds-bot im: feishu %s %s in a %s chat', event.messageType ?? 'file', error?.overLimit === true ? 'over the size cap, skipped' : 'download failed', kind)
          }
        }
        return loaded
      }
      inboxSignal.throwIfAborted()
      await onMessage({
        chat: { key, kind, title: kind === 'direct' ? (name !== event.actor.id ? name : '') : names.title, reply: event.reply },
        sender: { id: event.actor.id, name },
        text,
        ...(attachments === undefined ? {} : { attachments }),
        ...(unsupported === undefined ? {} : { unsupported }),
        voice,
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
  // Plain text answering the source message through dsh-im, which checks it is still there.
  const replyText = async (reply, text) => {
    let messageId
    let remaining = toPlain(text).trim()
    while (remaining.length > 0) {
      // dsh-im counts UTF-16 units. Avoid splitting a surrogate pair at its limit.
      const cut = remaining.length > 4000 && /[\uD800-\uDBFF]/u.test(remaining[3999]) ? 3999 : 4000
      const part = remaining.slice(0, cut).trim()
      remaining = remaining.slice(cut).trimStart()
      if (part === '') continue
      const receipt = await service.replyChecked(botId, reply, part, options)
      if (receipt?.sent !== true) throw Object.assign(new Error('Feishu reply status is unknown'), { code: 'reply-result-unknown' })
      messageId ??= receipt.messageId
    }
    return { messageId }
  }
  return {
    rich,
    ...(rich ? {
      edit: http.edit, progress: http.progress, fileLimit: http.fileLimit,
      sendFile: (chat, file) => http.sendFile(chat, file, signal),
    } : {}),
    chats: http.chats,
    stop: dispose,
    async send(chat, job) {
      signal.throwIfAborted()
      if (rich && (job.buttons !== undefined || chat.reply === undefined)) return http.send(chat, job)
      if (chat.reply === undefined || chat.reply.conversationId !== chat.key) {
        throw Object.assign(new Error('Feishu reply has no active source message'), { permanent: true })
      }
      let delivered = false
      const textPart = async (text) => {
        const sent = await replyText(chat.reply, text)
        delivered ||= sent.messageId !== undefined
        return sent
      }
      try {
        // A reply that uses Markdown goes out as cards on the source message, in its topic;
        // a chunk the service will not take as a card goes as text.
        if (rich && hasMarkdown(String(job.text ?? ''))) return await http.reply(chat.reply, job.text, textPart)
        return await textPart(job.text)
      } catch (error) {
        // A refusal is definite: dsh-im's coded rejections and Feishu's own 4xx answers.
        // Anything else may already have reached the chat and is never sent again.
        const refused = typeof error?.status === 'number' ? error.permanent === true
          : typeof error?.code === 'string' && error.code !== 'reply-result-unknown'
        if (delivered || signal.aborted || !refused) {
          throw Object.assign(new Error('Feishu could not confirm the complete reply'), { unknown: true, cause: error })
        }
        throw Object.assign(new Error('Feishu rejected the reply'), { permanent: true, cause: error })
      }
    },
  }
}
