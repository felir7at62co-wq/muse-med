// Feishu / Lark: the long connection speaks protobuf pbbp2 frames — control
// pings sent at the server's interval, data frames ACKed by sending the frame back with a
// {"code":200} payload and a biz_rt header; split payloads reassemble by
// sum/seq. p2p messages are direct; a group message counts when the bot's
// open_id is in its mentions. Text, rich text (post), images, files, audio and
// video are read; any other message is handed on as `unsupported`, so the
// person is told. Sends go through the OpenAPI with a tenant access token: a
// reply that uses Markdown is a card with a markdown element, as is one with
// buttons (edited by PATCH); a plain reply is a text message, and so is a card
// the service refuses. `chats()` lists the groups the bot is in and `onChat`
// reports one it was added to, so each can be registered before anyone writes.
// The tiny protobuf codec below implements only this frame shape.
// Protocol ported from @larksuiteoapi/node-sdk (MIT, see NOTICE).
import { CARD_MAX_BYTES, cardChunks, hasMarkdown, toFeishuMarkdown } from '../feishu-markdown.js'
import { chunkMarkdown } from '../format.js'
import { retryDelay, retryWait } from './retry.js'

const TEXT_LIMIT = 4000
// An attachment is read fully into memory and handed on as one Buffer, so it is
// capped, at the size WeCom attachments are.
export const FILE_LIMIT = 100 * 1024 * 1024
// Inbound events are handled one after another, so a download that stalls is given
// up after this long instead of holding every later message back.
const DOWNLOAD_TIMEOUT = 5 * 60_000
// Message types that carry one downloadable file, with the name used when the
// message gives none: a voice message is Opus audio and has no name.
export const FILE_NAMES = { file: 'file', audio: 'audio.opus', media: 'video.mp4' }
// Pages of 100 groups read when the bot's chats are listed; a bot in more groups than
// that has the rest registered when they first write.
const CHAT_LIST_PAGES = 10
// Chat and member names are read again after this long, so renames show up.
const NAME_TTL_MS = 10 * 60_000
// Member pages of 100 read per chat for names; a larger group's later members keep their ids.
const NAME_MEMBER_PAGES = 10
const SOCKET_TIMEOUT = 30_000
const pingInterval = seconds => {
  const ms = Number(seconds) * 1000
  return Number.isFinite(ms) && ms >= 1000 && ms <= 2_147_483_647 ? ms : undefined
}

const apiBase = (env, fields) => String(env.config?.api ?? (fields.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn')).replace(/\/+$/, '')

function namesByChat(rest, env) {
  const chats = new Map()
  return async (chatId, direct) => {
    const held = chats.get(chatId)
    if (held !== undefined && Date.now() - held.at < NAME_TTL_MS) return held.result
    const result = (async () => {
      const names = { title: '', members: new Map() }
      const path = `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`
      try {
        if (!direct) names.title = String((await rest(path))?.data?.name ?? '').trim()
        let pageToken
        for (let page = 0; page < NAME_MEMBER_PAGES; page += 1) {
          const query = `member_id_type=open_id&page_size=100${pageToken === undefined ? '' : `&page_token=${encodeURIComponent(pageToken)}`}`
          const data = (await rest(`${path}/members?${query}`))?.data ?? {}
          for (const item of data.items ?? []) {
            const name = String(item.name ?? '').trim()
            if (item.member_id && name !== '') names.members.set(String(item.member_id), name)
          }
          if (data.has_more !== true || !data.page_token) break
          pageToken = String(data.page_token)
        }
      } catch (error) {
        env.log?.warn?.('ds-bot im: feishu names for %s unavailable: %s', chatId, error?.message ?? error)
      }
      return names
    })()
    chats.set(chatId, { at: Date.now(), result })
    return result
  }
}

/** Authenticate Feishu REST operations without opening a message connection. */
export function createFeishuHttp(fields, env) {
  let token
  let pending
  const bearer = async () => {
    if (token === undefined || Date.now() > token.expiresAt - 30_000) {
      pending ??= tenantToken(fields, env).then(value => { token = value }).finally(() => { pending = undefined })
      await pending
    }
    return token.token
  }
  const rest = async (path, options) => api(env, apiBase(env, fields), await bearer(), path, options)
  const delivery = feishuDelivery(rest, env)
  return {
    ...delivery,
    async progress(route, caption, { messageId, mode } = {}) {
      if (messageId !== undefined) {
        await rest(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
          method: 'PATCH', body: { msg_type: 'interactive', content: progressCard(caption) },
        })
        return messageId
      }
      const card = mode !== 'post'
      const sent = await rest(`/open-apis/im/v1/messages/${encodeURIComponent(route.messageId)}/reply`, {
        method: 'POST',
        body: {
          msg_type: card ? 'interactive' : 'text',
          content: card ? progressCard(caption) : JSON.stringify({ text: caption }),
          reply_in_thread: Boolean(route.threadId),
        },
      })
      if (typeof sent?.data?.message_id !== 'string' || !sent.data.message_id) throw new Error('Feishu progress was not confirmed')
      return sent.data.message_id
    },
    names: namesByChat(path => rest(path, { method: 'GET' }), env),
    async image(messageId, key) {
      const bytes = await resource(env, apiBase(env, fields), await bearer(), messageId, key, 'image')
      if (bytes === undefined) throw new Error('Feishu did not send the picture')
      const buffer = Buffer.from(bytes)
      return { mediaType: imageMediaType(buffer), data: buffer.toString('base64') }
    },
    // One file, audio or video of a message, up to FILE_LIMIT bytes.
    async file(messageId, key) {
      const bytes = await resource(env, apiBase(env, fields), await bearer(), messageId, key, 'file', FILE_LIMIT)
      if (bytes === undefined) throw new Error('Feishu did not send the file')
      return bytes
    },
  }
}

// ---- pbbp2.Frame codec (protobuf wire format, only this message) ----------
// Frame: SeqID u64=1, LogID u64=2, service i32=3, method i32=4,
// headers repeated Header=5, payload_encoding string=6, payload_type
// string=7, payload bytes=8, LogIDNew string=9. Header: key string=1, value
// string=2. Wire types: 0 varint, 2 length-delimited.
const uvarint = (value) => {
  let v = BigInt(value)
  const bytes = []
  while (v > 127n) { bytes.push(Number(v & 127n) | 128); v >>= 7n }
  bytes.push(Number(v))
  return bytes
}
const field = (number, wire, bytes) => {
  const tag = uvarint((number << 3) | wire)
  if (wire === 0) return [...tag, ...uvarint(bytes)]
  const body = typeof bytes === 'string' ? [...Buffer.from(bytes, 'utf8')] : [...bytes]
  return [...tag, ...uvarint(body.length), ...body]
}
const encodeHeader = ({ key, value }) => [...field(1, 2, key), ...field(2, 2, value)]
export const encodeFrame = (frame) => {
  const out = []
  if (frame.SeqID !== undefined) out.push(...field(1, 0, frame.SeqID))
  if (frame.LogID !== undefined) out.push(...field(2, 0, frame.LogID))
  if (frame.service !== undefined) out.push(...field(3, 0, frame.service))
  if (frame.method !== undefined) out.push(...field(4, 0, frame.method))
  for (const header of frame.headers ?? []) out.push(...field(5, 2, encodeHeader(header)))
  if (frame.payloadEncoding !== undefined) out.push(...field(6, 2, frame.payloadEncoding))
  if (frame.payloadType !== undefined) out.push(...field(7, 2, frame.payloadType))
  if (frame.payload !== undefined) out.push(...field(8, 2, frame.payload))
  if (frame.LogIDNew !== undefined) out.push(...field(9, 2, frame.LogIDNew))
  return Buffer.from(out)
}
export const decodeFrame = (buffer) => {
  const frame = { headers: [] }
  let at = 0
  const varint = () => {
    let value = 0n
    let shift = 0n
    while (at < buffer.length) {
      const byte = buffer[at]
      at += 1
      value |= BigInt(byte & 127) << shift
      if ((byte & 128) === 0) break
      shift += 7n
    }
    return value
  }
  const bytes = () => {
    const length = Number(varint())
    const part = buffer.subarray(at, at + length)
    at += length
    return part
  }
  const header = (buf) => {
    let index = 0
    const out = {}
    const v = () => {
      let value = 0n
      let shift = 0n
      while (index < buf.length) {
        const byte = buf[index]
        index += 1
        value |= BigInt(byte & 127) << shift
        if ((byte & 128) === 0) break
        shift += 7n
      }
      return value
    }
    const b = () => {
      const length = Number(v())
      const part = buf.subarray(index, index + length)
      index += length
      return part
    }
    while (index < buf.length) {
      const tag = Number(v())
      if (tag >> 3 === 1) out.key = b().toString('utf8')
      else if (tag >> 3 === 2) out.value = b().toString('utf8')
      else if ((tag & 7) === 2) b()
      else if ((tag & 7) === 0) v()
    }
    return out
  }
  while (at < buffer.length) {
    const tag = Number(varint())
    const number = tag >> 3
    const wire = tag & 7
    if (wire === 0) {
      const value = varint()
      if (number === 1) frame.SeqID = Number(value)
      else if (number === 2) frame.LogID = Number(value)
      else if (number === 3) frame.service = Number(value)
      else if (number === 4) frame.method = Number(value)
    } else if (wire === 2) {
      const value = bytes()
      if (number === 5) frame.headers.push(header(value))
      else if (number === 6) frame.payloadEncoding = value.toString('utf8')
      else if (number === 7) frame.payloadType = value.toString('utf8')
      else if (number === 8) frame.payload = Buffer.from(value)
      else if (number === 9) frame.LogIDNew = value.toString('utf8')
    }
  }
  return frame
}
// ---------------------------------------------------------------------------

export default {
  id: 'feishu',

  async check(fields, env) {
    const { token } = await tenantToken(fields, env)
    const me = await api(env, apiBase(env, fields), token, '/open-apis/bot/v3/info', { method: 'GET' })
    const bot = me?.bot ?? me
    return { account: { id: String(bot?.open_id ?? bot?.app_id ?? fields.appId), name: bot?.app_name ?? String(fields.appId) } }
  },

  connect(fields, env, handlers) {
    const appId = String(fields.appId ?? '').trim()
    const appSecret = String(fields.appSecret ?? '').trim()
    let stopped = false
    let socket
    let generation = 0
    let reconnectTimer
    let connectTimer
    let pingTimer
    let heartbeatTimer
    let token
    let tokenExpiresAt = 0
    let refreshing
    let botOpenId = ''
    // Split data frames reassemble by (sum, seq) until all parts arrive.
    const parts = new Map()
    let inbound = Promise.resolve()

    // Inbound downloads share the expiry check: a socket that only receives
    // still needs a live token. Callers wait on the one in-flight refresh —
    // two images arriving together must not race two tokens.
    const freshToken = async () => {
      if (token === undefined || Date.now() > tokenExpiresAt - 30_000) {
        refreshing ??= tenantToken({ appId, appSecret }, env)
          .then(got => { token = got.token; tokenExpiresAt = got.expiresAt })
          .finally(() => { refreshing = undefined })
        await refreshing
      }
      return token
    }

    const rest = async (path, { method = 'POST', body } = {}) =>
      api(env, apiBase(env, fields), await freshToken(), path, { method, body })

    // Message events carry ids only. A group's name comes from its chat info and a
    // person's from the chat's member list, both readable with the app's
    // im:chat:readonly scope; without it, or for a member past the pages read, the id
    // stands in. Each chat is read once and again after NAME_TTL_MS.
    const namesOf = namesByChat(path => rest(path, { method: 'GET' }), env)

    const sendFrame = (buffer) => { if (socket?.readyState === 1) socket.send(buffer) }
    const pong = (frame) => sendFrame(encodeFrame({ ...frame, headers: frame.headers.map(h => h.key === 'type' ? { key: 'type', value: 'pong' } : h), payload: Buffer.from('pong') }))
    const ack = (frame, ms) => sendFrame(encodeFrame({
      ...frame,
      headers: [...frame.headers.filter(h => h.key !== 'biz_rt'), { key: 'biz_rt', value: String(ms) }],
      payload: Buffer.from(JSON.stringify({ code: 200, headers: {}, data: '' })),
      payloadType: 'json',
    }))

    const dispatch = async (type, body) => {
      const payload = JSON.parse(body.toString('utf8'))
      if (type === 'event' && payload.header?.event_type === 'im.message.receive_v1') {
        const event = payload.event ?? {}
        const message = event.message ?? {}
        const direct = message.chat_type === 'p2p'
        const chatKind = direct ? 'direct' : 'group'
        const mentioned = !direct && (message.mentions ?? []).some(m => m.id?.open_id === botOpenId || m.key === `@_user_${1}`)
        const content = safeJson(message.content)
        const messageType = String(message.message_type ?? '')
        let text = String(content.text ?? '').replace(/@_user_\d+/g, '').trim()
        const images = []
        const files = []
        const download = (key, kind, limit) => freshToken()
          .then(bearer => resource(env, apiBase(env, fields), bearer, message.message_id, key, kind, limit))
        const addImage = async (key) => {
          const bytes = await download(key, 'image').catch(() => undefined)
          if (bytes === undefined) {
            env.log?.warn?.('ds-bot im: feishu image download failed for %s', String(message.message_id ?? ''))
            return
          }
          const buffer = Buffer.from(bytes)
          try {
            images.push({ mediaType: imageMediaType(buffer), data: buffer.toString('base64') })
          } catch (error) {
            // A format the prompt cannot declare: the message goes on without the picture.
            env.log?.warn?.('ds-bot im: feishu image not read: %s', error.message)
          }
        }
        const addFile = async (key, name) => {
          const got = await download(key, 'file', FILE_LIMIT).catch(error => error)
          if (got instanceof Uint8Array) files.push({ name, data: got })
          else if (got?.overLimit === true) env.log?.warn?.('ds-bot im: feishu %s in a %s chat is over the %d byte cap, skipped', messageType, chatKind, FILE_LIMIT)
          else env.log?.warn?.('ds-bot im: feishu %s download failed in a %s chat', messageType, chatKind)
        }
        // A group message that does not mention the bot is ignored, so nothing is fetched for it.
        const read = direct || mentioned
        if (messageType === 'post') {
          // An `at` names its mention by key; the bot's own goes, like `@_user_N` in plain text.
          const atName = (item) => {
            const mention = (message.mentions ?? []).find(m => m.key === item.user_id)
            if ((mention?.id?.open_id ?? item.user_id) === botOpenId) return ''
            return String(item.user_name || mention?.name || '').trim()
          }
          const post = flattenPost(content, atName)
          text = post.text
          if (read) {
            for (const key of post.images) await addImage(key)
            for (const key of post.media) await addFile(key, FILE_NAMES.media)
          }
        }
        if (read && messageType === 'image' && content.image_key !== undefined) await addImage(content.image_key)
        if (read && Object.hasOwn(FILE_NAMES, messageType) && content.file_key !== undefined) {
          await addFile(content.file_key, String(content.file_name || FILE_NAMES[messageType]))
        }
        // Nothing readable — a sticker, a forwarded bundle, a share card, a failed
        // download, an empty message: the type goes on so the person can be told.
        const unsupported = read && text === '' && images.length === 0 && files.length === 0 ? (messageType || 'unknown') : undefined
        const sender = String(event.sender?.sender_id?.open_id ?? event.sender?.user_id ?? '')
        const chatId = String(message.chat_id ?? '')
        const names = await namesOf(chatId, direct)
        const senderName = names.members.get(sender) ?? sender
        await handlers.onMessage({
          chat: { key: chatId, kind: chatKind, title: direct ? senderName : (names.title || chatId) },
          sender: { id: sender, name: senderName },
          text, images, files,
          mentioned, unsupported, messageId: String(message.message_id ?? ''),
        })
      }
      // The bot was added to a group. Leaving or a disbanded group is not followed:
      // the chat keeps its Bot.
      if (type === 'event' && payload.header?.event_type === 'im.chat.member.bot.added_v1') {
        const event = payload.event ?? {}
        if (event.chat_id) await handlers.onChat?.({ key: String(event.chat_id), kind: 'group', title: String(event.name ?? '').trim() })
      }
      if (type === 'card' || payload.header?.event_type === 'card.action.trigger') {
        const event = payload.event ?? {}
        const action = event.action ?? event.actions?.[0] ?? {}
        const data = action.value ?? action.action_data?.value ?? action.action_data ?? {}
        await handlers.onAction({
          chat: { key: String(event.context?.open_chat_id ?? event.message?.chat_id ?? ''), kind: 'direct', title: '' },
          sender: { id: String(event.operator?.open_id ?? event.user_id ?? ''), name: '' },
          data: String(typeof data === 'object' ? (data.v ?? JSON.stringify(data)) : data),
          messageId: String(event.message_id ?? event.context?.open_message_id ?? ''),
        })
      }
    }

    const clearSocketTimers = () => {
      clearTimeout(connectTimer)
      clearTimeout(pingTimer)
      clearTimeout(heartbeatTimer)
      connectTimer = pingTimer = heartbeatTimer = undefined
    }
    let openFailures = 0
    const retry = (gen, error) => {
      if (stopped || generation !== gen) return
      generation += 1
      clearSocketTimers()
      const previous = socket
      socket = undefined
      try { previous?.close(4001, 'reconnect') } catch { /* already gone */ }
      handlers.onStatus({ state: 'retrying', error })
      clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => { if (!stopped) void open() }, retryDelay(openFailures))
      reconnectTimer.unref?.()
      openFailures += 1
    }
    const open = async () => {
      if (stopped) return
      const gen = ++generation
      let url
      let pingEvery = 90_000
      try {
        const answer = await env.fetch(`${apiBase(env, fields)}/callback/ws/endpoint`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${await freshToken()}` },
          body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
        })
        const body = await answer.json().catch(() => ({}))
        url = body.data?.URL
        if (url === undefined || (body.code !== undefined && body.code !== 0)) {
          const reason = body.msg ?? `Feishu answered ${answer.status}`
          const error = new Error(body.code === undefined ? reason : `${reason} (code ${body.code})`)
          error.status = answer.status
          // A 200 that carries no WebSocket URL is the platform refusing the app.
          error.permanent = answer.ok || (answer.status >= 400 && answer.status < 500 && answer.status !== 429)
          throw error
        }
        pingEvery = pingInterval(body.data?.ClientConfig?.PingInterval) ?? pingEvery
      } catch (error) {
        if (stopped || generation !== gen) return
        if (error?.permanent === true) {
          handlers.onStatus({ state: 'error', error: error.message })
          return
        }
        // The handshake is retried, also when this is the first one: a connection
        // started before the network is up is not over (#1119).
        retry(gen, error.message)
        return
      }
      if (stopped || generation !== gen) return
      let next
      let service
      try {
        const id = Number(new URL(url).searchParams.get('service_id') ?? 0)
        service = Number.isSafeInteger(id) && id >= 0 ? id : 0
        next = new env.WebSocket(url)
        next.binaryType = 'arraybuffer'
        socket = next
      } catch (error) {
        retry(gen, `Feishu could not open a socket: ${error?.message ?? error}`)
        return
      }
      const current = () => !stopped && generation === gen && socket === next
      const schedulePing = () => {
        clearTimeout(pingTimer)
        pingTimer = setTimeout(ping, pingEvery)
        pingTimer.unref?.()
      }
      const ping = () => {
        if (!current() || next.readyState !== 1) return
        if (heartbeatTimer === undefined) {
          heartbeatTimer = setTimeout(() => retry(gen, 'Feishu heartbeat timed out'), SOCKET_TIMEOUT)
          heartbeatTimer.unref?.()
        }
        try {
          next.send(encodeFrame({ SeqID: 0, LogID: 0, service, method: 0, headers: [{ key: 'type', value: 'ping' }] }))
        } catch {
          retry(gen, 'Feishu could not send a heartbeat')
          return
        }
        schedulePing()
      }
      next.addEventListener('message', (event) => {
        if (!current()) return
        // Any inbound frame answers the liveness probe. The next scheduled
        // ping arms it again; healthy idle time must not start a short timeout.
        clearTimeout(heartbeatTimer)
        heartbeatTimer = undefined
        let frame
        try { frame = decodeFrame(Buffer.from(event.data)) } catch { return }
        const type = frame.headers.find(h => h.key === 'type')?.value
        if (frame.method === 0 && type === 'ping') { pong(frame); return }
        if (frame.method === 0 && type === 'pong') {
          const interval = pingInterval(safeJson(frame.payload?.toString('utf8'))?.PingInterval)
          if (interval !== undefined) { pingEvery = interval; schedulePing() }
          return
        }
        if (frame.method === 1 && type === 'reconnect') { retry(gen, 'Feishu requested a reconnect'); return }
        if (frame.method !== 1 || (type !== 'event' && type !== 'card')) return
        const messageId = frame.headers.find(h => h.key === 'message_id')?.value ?? ''
        const sum = Number(frame.headers.find(h => h.key === 'sum')?.value ?? 1)
        const seq = Number(frame.headers.find(h => h.key === 'seq')?.value ?? 1)
        ack(frame, 0)
        if (sum > 1) {
          const held = parts.get(messageId) ?? { received: new Map(), sum }
          held.received.set(seq, frame.payload)
          parts.set(messageId, held)
          if (held.received.size !== sum) return
          frame.payload = Buffer.concat([...held.received.keys()].sort((a, b) => a - b).map(s => held.received.get(s)))
          parts.delete(messageId)
        }
        // Events are handled one after another in the order they arrived: reading a name or an
        // image must not let a later message overtake an earlier one.
        const payload = frame.payload
        inbound = inbound.then(() => dispatch(type, payload))
          .catch(error => env.log?.warn?.('ds-bot im: feishu event failed: %s', error?.message ?? error))
      })
      next.addEventListener('open', () => {
        if (!current()) return
        clearTimeout(connectTimer)
        openFailures = 0
        handlers.onStatus({ state: 'ready' })
        ping()
      })
      next.addEventListener('close', () => retry(gen, 'Feishu socket closed'))
      next.addEventListener('error', () => retry(gen, 'Feishu socket error'))
      connectTimer = setTimeout(() => retry(gen, 'Feishu socket opening timed out'), SOCKET_TIMEOUT)
      connectTimer.unref?.()
    }

    handlers.onStatus({ state: 'connecting' })
    // The tenant token is fetched until it arrives: a connection started before the
    // network is up must connect once it is (#1119). The bot identity is fetched
    // again per handshake below; here it only fills the mention check.
    void (async () => {
      let attempt = 0
      while (!stopped) {
        try {
          const got = await tenantToken({ appId, appSecret }, env)
          token = got.token
          tokenExpiresAt = got.expiresAt
          const me = await api(env, apiBase(env, fields), token, '/open-apis/bot/v3/info', { method: 'GET' }).catch(() => ({}))
          botOpenId = String(me?.bot?.open_id ?? me?.open_id ?? '')
          break
        } catch (error) {
          if (stopped) return
          if (error?.permanent === true) {
            handlers.onStatus({ state: 'error', error: error.message })
            return
          }
          handlers.onStatus({ state: 'retrying', error: error.message })
          await retryWait(retryDelay(attempt))
          attempt += 1
        }
      }
      if (!stopped) await open()
    })()

    return {
      ...feishuDelivery(rest, env),
      stop: () => {
        stopped = true
        generation += 1
        clearTimeout(reconnectTimer)
        clearSocketTimers()
        parts.clear()
        const previous = socket
        socket = undefined
        try { previous?.close(1000, 'stop') } catch { /* not open */ }
      },
    }
  },
}

const progressCard = text => JSON.stringify({
  schema: '2.0',
  config: { update_multi: true },
  body: { elements: [{ tag: 'markdown', content: text }] },
})

function feishuDelivery(rest, env) {
    const card = (text, buttons) => JSON.stringify({
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: text },
          ...(buttons?.length > 0 ? [{
            tag: 'action',
            actions: buttons.slice(0, 5).map(button => ({
              tag: 'button', type: 'primary',
              text: { tag: 'plain_text', content: button.label.slice(0, 20) },
              value: { v: button.data },
            })),
          }] : []),
        ],
      },
    })

    // A card refused for what it holds (too many tables, a tag the service does not
    // know) or past its size cap goes out as text, so the reply still arrives; auth,
    // rate limits and the network stay with the caller's send queue.
    const cardOrText = async (chunk, sendCard, sendText) => {
      const content = card(chunk)
      if (Buffer.byteLength(content, 'utf8') > CARD_MAX_BYTES) return sendText(chunk)
      return sendCard(content).catch((error) => {
        if (error?.permanent !== true || error.status === 401 || error.status === 403) throw error
        env?.log?.warn?.('ds-bot im: feishu refused a card (HTTP %s, code %s), sent as text', error.status, error.code ?? 'none')
        return sendText(chunk)
      })
    }

    return {
      send: async (chat, { text, buttons }) => {
        const body = String(text ?? '')
        const markdown = hasMarkdown(body)
        const chunks = markdown ? cardChunks(body, TEXT_LIMIT) : chunkMarkdown(body, TEXT_LIMIT)
        const post = (msgType, content) => rest('/open-apis/im/v1/messages?receive_id_type=chat_id', {
          method: 'POST', body: { receive_id: chat.key, msg_type: msgType, content },
        })
        let messageId
        for (const [index, chunk] of chunks.entries()) {
          const plain = () => post('text', JSON.stringify({ text: chunk }))
          let sent
          if (buttons !== undefined && index === chunks.length - 1) sent = await post('interactive', card(chunk, buttons))
          else if (!markdown) sent = await plain()
          else sent = await cardOrText(chunk, content => post('interactive', content), plain)
          messageId = String(sent?.data?.message_id ?? messageId ?? '')
        }
        return { messageId }
      },
      // A reply that uses Markdown, as cards answering one message (in its topic when it
      // has one). `sendText` takes a chunk the service will not take as a card.
      reply: async (route, text, sendText) => {
        let messageId
        for (const chunk of cardChunks(String(text ?? ''), TEXT_LIMIT)) {
          const sent = await cardOrText(chunk, content => rest(`/open-apis/im/v1/messages/${encodeURIComponent(route.messageId)}/reply`, {
            method: 'POST', body: { msg_type: 'interactive', content, reply_in_thread: Boolean(route.threadId) },
          }).then(result => ({ messageId: result?.data?.message_id })), sendText)
          messageId ??= sent?.messageId
        }
        return { messageId }
      },
      edit: async (chat, messageId, { text, buttons }) => {
        await rest(`/open-apis/im/v1/messages/${messageId}`, {
          method: 'PATCH',
          body: { msg_type: 'interactive', content: card(toFeishuMarkdown(text).slice(0, TEXT_LIMIT), buttons) },
        })
      },
      // The groups the bot is in, up to CHAT_LIST_PAGES pages of 100.
      chats: async () => {
        const out = []
        let pageToken
        for (let page = 0; page < CHAT_LIST_PAGES; page += 1) {
          const query = `page_size=100${pageToken === undefined ? '' : `&page_token=${encodeURIComponent(pageToken)}`}`
          const data = (await rest(`/open-apis/im/v1/chats?${query}`, { method: 'GET' }))?.data ?? {}
          for (const item of data.items ?? []) {
            if (item.chat_id) out.push({ key: String(item.chat_id), kind: 'group', title: String(item.name ?? '').trim() })
          }
          if (data.has_more !== true || !data.page_token) break
          pageToken = String(data.page_token)
        }
        return out
      },
    }
}

const safeJson = (text) => { try { return JSON.parse(text ?? '{}') } catch { return {} } }

/**
 * A rich-text post flattened to one line per paragraph, with its pictures and videos by key.
 * A link keeps its text and address, a mention the name `atName` gives it, code its fence.
 * @param {object} content - The post, as the receive event carries it or under a locale key.
 * @param {(item: object) => string} atName - The name an `at` item shows; '' drops it.
 * @returns {{ text: string, images: string[], media: string[] }}
 */
export function flattenPost(content, atName) {
  const post = Array.isArray(content?.content) ? content : Object.values(content ?? {}).find(part => Array.isArray(part?.content)) ?? {}
  const images = []
  const media = []
  const piece = (item) => {
    switch (item?.tag) {
      case 'a': {
        const label = String(item.text ?? '').trim()
        const href = String(item.href ?? '').trim()
        return label === '' || label === href || href === '' ? label || href : `[${label}](${href})`
      }
      case 'at': {
        const name = atName(item)
        return name === '' ? '' : `@${name}`
      }
      case 'img':
        if (item.image_key !== undefined) images.push(String(item.image_key))
        return ''
      case 'media':
        if (item.file_key !== undefined) media.push(String(item.file_key))
        return ''
      case 'emotion':
        return item.emoji_type === undefined ? '' : `[${item.emoji_type}]`
      case 'code_block':
        return `\`\`\`${String(item.language ?? '').toLowerCase()}\n${String(item.text ?? '').replace(/\n$/, '')}\n\`\`\``
      case 'hr':
        return '---'
      default:
        return String(item?.text ?? '')
    }
  }
  const lines = []
  for (const paragraph of post.content ?? []) {
    const items = Array.isArray(paragraph) ? paragraph : []
    const line = items.map(piece).join('').trim()
    // A paragraph that held only a picture, a video or the bot's mention leaves no empty line.
    if (line !== '' || items.every(item => item?.tag === 'text')) lines.push(line)
  }
  return { text: [String(post.title ?? '').trim(), ...lines].join('\n').trim(), images, media }
}

function imageMediaType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const header = bytes.toString('latin1', 0, 6)
  if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  throw new Error('Feishu returned an unsupported image format')
}

async function tenantToken(fields, env) {
  const response = await env.fetch(`${apiBase(env, fields)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: String(fields.appId ?? '').trim(), app_secret: String(fields.appSecret ?? '').trim() }),
  })
  const body = await response.json().catch(() => ({}))
  if (body.tenant_access_token === undefined) {
    const error = new Error(body.msg ?? 'Feishu refused these credentials')
    error.status = response.status
    // A 5xx or a 429 is the service, not the credentials: retry those.
    error.permanent = !(response.status >= 500 || response.status === 429)
    throw error
  }
  return { token: body.tenant_access_token, expiresAt: Date.now() + Math.max(60, Number(body.expire ?? 7200) - 300) * 1000 }
}

async function api(env, base, token, path, { method = 'GET', body } = {}) {
  const response = await env.fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok || (json.code !== undefined && json.code !== 0)) {
    const error = new Error(String(json.msg ?? `Feishu answered ${response.status}`))
    error.status = response.status
    error.code = json.code
    error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429
    throw error
  }
  return json
}

// One image (`type` image) or file, audio or video (`type` file) of a message.
// With a `limit` the body is abandoned as soon as it passes it, by its declared
// length or while it is read, and the error carries `overLimit`.
async function resource(env, base, token, messageId, key, type, limit) {
  const response = await env.fetch(`${base}/open-apis/im/v1/messages/${messageId}/resources/${key}?type=${type}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
  })
  if (!response.ok) return undefined
  if (limit === undefined) return new Uint8Array(await response.arrayBuffer())
  const overLimit = () => Object.assign(new Error('over the file cap'), { overLimit: true })
  const reader = response.body?.getReader?.()
  if (Number(response.headers?.get?.('content-length')) > limit) {
    await reader?.cancel().catch(() => {})
    throw overLimit()
  }
  // A response without a stream (a stubbed fetch) can only be taken whole.
  if (reader === undefined) {
    const whole = Buffer.from(await response.arrayBuffer())
    if (whole.length > limit) throw overLimit()
    return whole
  }
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw overLimit()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total)
}
