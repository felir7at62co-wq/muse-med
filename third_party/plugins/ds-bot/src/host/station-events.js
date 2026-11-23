// Muse: the data station's 储备 changes wake the Bot that supervises transcription. The station posts
// signed batches of job changes to one route; each verified batch becomes one message in that Bot's own
// chat: the Bot named by MUSE_STATION_EVENTS_BOT (config `stationEventsBot`), or the first main Bot when
// none is named. The route is off unless MUSE_STATION_EVENTS_SECRET_FILE names a private file holding
// the secret the station signs with.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync, lstatSync } from 'node:fs'

export const STATION_EVENTS_PATH = '/api/muse/station-events'
const MAX_BODY_BYTES = 256 * 1024
const MAX_SKEW_MS = 5 * 60_000
const REMEMBERED_DELIVERIES = 500

// A private secret file: a regular file only its owner can read, at least 32 characters.
export function readStationSecret(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('station events: the secret file must be a private regular file')
  const secret = readFileSync(path, 'utf8').trim()
  if (secret.length < 32) throw new Error('station events: the secret is too short')
  return secret
}

export function verifySignature(secret, timestamp, body, signature) {
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'))
  const given = Buffer.from(String(signature ?? ''))
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const named = event => `《${event.title || event.workId}》`
const why = event => (event.note ? `（${event.note}）` : '')

// One line per change, in the words the supervising Bot works with.
export function describeEvent(event) {
  if (event.note === '立即转写') return `立即转写：${named(event)}，${event.actor} 发起`
  switch (event.to) {
    case 'queued': return event.from === null ? `新入储备：${named(event)}${why(event)}` : `重新排队：${named(event)}${why(event)}`
    case 'downloading': return `开始处理：${named(event)}，${event.actor}${why(event)}`
    case 'published': return `已发布剧本：${named(event)}${why(event)}`
    case 'failed': return `失败待重试：${named(event)}${why(event)}`
    case 'needs-attention': return `需要处理：${named(event)}${why(event)}`
    case 'rejected': return `已淘汰：${named(event)}${why(event)}`
    case 'withdrawn': return `撤出储备：${named(event)}${why(event)}`
    default: return `${named(event)}：${event.from ?? '—'} → ${event.to}${why(event)}`
  }
}

export function describeDelivery(events) {
  return ['【储备变化】数据站自动通知，不是用户发的消息；按技能 transcription-assigning 处理。', ...events.map(event => `- ${describeEvent(event)}`)].join('\n')
}

function validEvents(value) {
  if (value === null || typeof value !== 'object' || typeof value.deliveryId !== 'string' || value.deliveryId.length > 80 || !Array.isArray(value.events)) return undefined
  if (value.events.length === 0 || value.events.length > 500) return undefined
  const text = (item, max) => typeof item === 'string' && item.length <= max
  for (const event of value.events) {
    if (event === null || typeof event !== 'object') return undefined
    if (!text(event.workId, 160) || !text(event.to, 40) || !text(event.actor, 200) || !(event.from === null || text(event.from, 40))) return undefined
    if (!(event.title === null || text(event.title, 400)) || !(event.note === null || text(event.note, 1000))) return undefined
  }
  return value
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('too large'), { status: 413 })); request.destroy(); return }
      parts.push(chunk)
    })
    request.on('end', () => { resolve(Buffer.concat(parts).toString('utf8')) })
    request.on('error', reject)
  })
}

export function install(rt) {
  const { ctx } = rt
  const secretFile = rt.config.stationEventsSecretFile ?? process.env.MUSE_STATION_EVENTS_SECRET_FILE
  if (!secretFile) return
  const botName = rt.config.stationEventsBot ?? process.env.MUSE_STATION_EVENTS_BOT
  // A named Bot that does not exist is refused (503) rather than redirected, so the station keeps the batch.
  const target = () => (botName ? rt.findBot(botName)?.id : rt.state.mainBotIds?.[0])
  const seen = []
  const reply = (response, status, body) => {
    response.statusCode = status
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(body))
  }
  const handler = async (request, response) => {
    try {
      if (request.method !== 'POST') { response.setHeader('allow', 'POST'); return reply(response, 405, { error: 'method' }) }
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return reply(response, 415, { error: 'content-type' })
      const body = await readBody(request)
      const timestamp = String(request.headers['x-muse-station-timestamp'] ?? '')
      if (!/^\d{10,16}$/.test(timestamp) || Math.abs((rt.now?.() ?? Date.now()) - Number(timestamp)) > MAX_SKEW_MS) return reply(response, 401, { error: 'timestamp' })
      let secret
      try { secret = readStationSecret(secretFile) } catch { return reply(response, 503, { error: 'unconfigured' }) }
      if (!verifySignature(secret, timestamp, body, request.headers['x-muse-station-signature'])) return reply(response, 401, { error: 'signature' })
      let parsed
      try { parsed = validEvents(JSON.parse(body)) } catch { parsed = undefined }
      if (parsed === undefined) return reply(response, 400, { error: 'events' })
      // The station sends a batch again until it is acknowledged; a repeat is acknowledged without a second message.
      if (seen.includes(parsed.deliveryId)) return reply(response, 200, { accepted: 0, repeated: true })
      const botId = target()
      if (botId === undefined) {
        if (botName) rt.warn?.('ds-bot: station events: no Bot is named %s', botName)
        return reply(response, 503, { error: botName ? 'no-named-bot' : 'no-main-bot' })
      }
      await rt.sendUser({ sessionId: botId, content: [{ type: 'text', text: describeDelivery(parsed.events) }], requestId: `station:${parsed.deliveryId}` })
      seen.push(parsed.deliveryId)
      if (seen.length > REMEMBERED_DELIVERIES) seen.shift()
      return reply(response, 202, { accepted: parsed.events.length })
    } catch (error) {
      rt.warn?.('ds-bot: station events failed: %s', error instanceof Error ? error.message : String(error))
      if (!response.headersSent) reply(response, error?.status === 413 ? 413 : 500, { error: 'failed' })
    }
  }
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: STATION_EVENTS_PATH, handler }), 'ds-bot: station events')
  })
}
