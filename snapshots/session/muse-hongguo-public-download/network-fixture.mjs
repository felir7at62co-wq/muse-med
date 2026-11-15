/** Exact public player, anonymous media lookup and invented CDN bytes; no real network is reachable. */
export * from '../../../third_party/plugins/muse-hongguo-download/src/network.js'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { checkedUrl } from '../../../third_party/plugins/muse-hongguo-download/src/network.js'

export const origin = 'https://hongguoduanju.com'
export const series = ['7700000000000000101', '7700000000000000102']
export const privateMarker = 'public_download_private_response_must_not_leak'
export const mediaUrl = `https://v1-hgweb.qznovelvod.com/public-fixture.mp4?token=${privateMarker}`
export const requests = []
const box = (type, bytes = Buffer.alloc(0)) => {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(bytes.length + 8)
  header.write(type, 4)
  return Buffer.concat([header, bytes])
}
export const media = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')),
  box('moov', box('trak', box('mdia'))), box('mdat', Buffer.from('invented public download fixture'))])
export const videoIds = id => Array.from({ length: 3 }, (_, index) => `${id}${index + 1}`)

function page(id, episode) {
  const vids = videoIds(id), itemId = vids[episode - 1]
  return `window._ROUTER_DATA = ${JSON.stringify({ loaderData: { 'player_(series_id)/page': {
    isSuccess: true, protectedPlayback: true, series_id: id, vid: itemId,
    seriesDetail: { series_id: id, series_name: '公开下载测试虚构剧', episode_cnt: 3,
      accessible_episode_cnt: 1, vid_list: vids }, videoList: {},
    publicVideoSeo: { available: episode === 1, seriesId: id, itemId,
      durationSeconds: 10, width: 128, height: 72, posterUrl: `${origin}/fixture-poster.jpg` },
  } } })};`
}

function reply(body, type) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  return Object.assign(Readable.from([bytes]), { statusCode: 200,
    headers: { 'content-type': type, 'content-length': String(bytes.length) } })
}

/**
 * @param {string} value - Exact official page, fallback endpoint or invented media URL.
 * @param {'page' | 'media'} kind - The real client's declared request type.
 * @param {AbortSignal} signal - Owning tool cancellation.
 * @param {object} options - Real client headers, method, body and allowlists.
 * @returns {Promise<import('node:stream').Readable>} Controlled HTTP response stream.
 */
export async function officialRequest(value, kind, signal, options = {}) {
  signal.throwIfAborted()
  const url = checkedUrl(value, kind, options.allowedHosts, options.allowedPorts)
  const method = options.method ?? 'GET'
  if (kind === 'media') {
    assert.equal(url.href, mediaUrl)
    assert.equal(method, 'GET')
    assert.equal(options.headers.referer, `${origin}/`)
    assert.equal(options.headers.cookie, undefined)
    requests.push({ kind: 'media' })
    return reply(media, 'video/mp4')
  }
  assert.equal(kind, 'page')
  assert.equal(url.origin, origin)
  assert.equal(options.headers?.cookie, undefined)
  if (url.pathname.startsWith('/player/')) {
    assert.equal(method, 'GET')
    assert.equal(url.search, '')
    const [, , id, rawEpisode] = url.pathname.split('/')
    assert.ok(series.includes(id))
    const episode = rawEpisode === undefined ? 1 : Number(rawEpisode)
    assert.equal(episode, 1, 'No unopened episode page may be queried')
    requests.push({ kind: 'catalog', seriesId: id })
    return reply(page(id, episode), 'text/html; charset=utf-8')
  }
  assert.equal(url.pathname, '/api/video/protected/fallback-play-info')
  assert.equal(url.search, '?aid=8662')
  assert.equal(method, 'POST')
  assert.deepEqual(Object.keys(options.headers).sort(), ['accept', 'content-length', 'content-type', 'x-xs-from-web'])
  assert.equal(options.headers['content-type'], 'application/json')
  assert.equal(options.headers.accept, 'application/json')
  assert.equal(options.headers['content-length'], Buffer.byteLength(options.body))
  assert.equal(options.headers['x-xs-from-web'], '1')
  const body = JSON.parse(options.body)
  assert.deepEqual(Object.keys(body), ['item_id'])
  const id = series.find(candidate => videoIds(candidate)[0] === body.item_id)
  assert.ok(id, 'Only an opened episode may reach the fallback API')
  requests.push({ kind: 'fallback', seriesId: id })
  const response = id === series[0]
    ? { main_url: mediaUrl, url_expire: 1794300000, base_resp: { StatusCode: 0, StatusMessage: '' } }
    : { main_url: mediaUrl, base_resp: { StatusCode: 1001, StatusMessage: privateMarker } }
  return reply(JSON.stringify(response), 'application/json; charset=utf-8')
}
