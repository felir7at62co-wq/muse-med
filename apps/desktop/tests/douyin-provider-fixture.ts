/** Synthetic CDP responses: no platform request, credential, or real signed address. */
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

export const fixtureId = '7692443246022167851'
export const fixtureMedia = 'https://v3.douyinvod.com/video.mp4?synthetic=1'
export const fixtureDetail = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${fixtureId}`
export function fixtureBody() {
  return { aweme_detail: { aweme_id: fixtureId, video: { duration: 34434, width: 3840, height: 2160,
    play_addr: { url_list: [fixtureMedia] }, bit_rate: [{ bit_rate: 1000000, play_addr: { url_list: [fixtureMedia] } }] } } }
}
export function fixtureDebugger() {
  let attached = false
  return Object.assign(new EventEmitter(), {
    attach: vi.fn(() => { attached = true }), detach: vi.fn(() => { attached = false }), isAttached: () => attached,
    sendCommand: vi.fn(async (method: string, _params?: object): Promise<object> => method === 'Page.getFrameTree'
      ? { frameTree: { frame: { id: 'main', loaderId: 'loader' } } }
      : method === 'Network.getResponseBody' ? { body: JSON.stringify(fixtureBody()), base64Encoded: false } : {}),
  })
}
export async function fixtureResponse(
  debug: ReturnType<typeof fixtureDebugger>,
  overrides: { frame?: string; status?: number; bytes?: number; url?: string } = {},
) {
  const frame = overrides.frame ?? 'main', url = overrides.url ?? fixtureDetail
  debug.emit('message', {}, 'Network.requestWillBeSent', { requestId: 'r1', frameId: frame, loaderId: 'loader', type: 'XHR', request: { method: 'GET', url } })
  debug.emit('message', {}, 'Network.responseReceived', { requestId: 'r1', frameId: frame, loaderId: 'loader', response: { status: overrides.status ?? 200, mimeType: 'application/json', url } })
  debug.emit('message', {}, 'Network.loadingFinished', { requestId: 'r1', encodedDataLength: overrides.bytes ?? 200 })
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
