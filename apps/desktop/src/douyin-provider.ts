/** Main-owned media facts from a target detail response already received by its guest. */
import type { WebContents } from 'electron'
import { BlockList, isIP } from 'node:net'
import { douyinMedia } from './douyin-policy.ts'

/** Maximum decoded detail body and Chromium observer buffer. */
export const PROVIDER_MAX_BYTES = 2 * 1024 ** 2
/** Exact-work plain MP4 alternatives and the provider's video facts. */
export interface ProviderSource {
  readonly targetVideoId: string
  readonly urls: readonly string[]
  readonly sourceField: 'video.play_addr' | 'video.bit_rate.play_addr'
  readonly durationMs: number
  readonly width: number
  readonly height: number
}
/** Source facts belonging to the currently approved main document. */
export interface ProviderEvidence extends ProviderSource {
  readonly documentEpoch: number
}

/**
 * @param url - page-generated request URL.
 * @param target - approved work ID.
 * @returns true only for the official detail endpoint with one matching ID.
 */
export function providerRequest(url: string, target: string): boolean {
  if (url.length > 8192 || !URL.canParse(url)) return false
  const value = new URL(url)
  return (
    value.protocol === 'https:' &&
    !value.username &&
    !value.password &&
    (!value.port || value.port === '443') &&
    value.hostname === 'www.douyin.com' &&
    ['/aweme/v1/web/aweme/detail/', '/aweme/v1/web/aweme/detail'].includes(value.pathname) &&
    value.searchParams.getAll('aweme_id').length === 1 &&
    value.searchParams.get('aweme_id') === target
  )
}

/** @param url - provider address, retained verbatim. @returns true for a plain HTTPS MP4 on the allowed CDN names. */
export function providerMP4(url: string): boolean {
  if (!douyinMedia(url)) return false
  const value = new URL(url)
  return (
    !value.hash &&
    !/\.(?:m3u8|mpd)(?:$|\/)/i.test(value.pathname) &&
    (/\.mp4$/i.test(value.pathname) || value.searchParams.get('mime_type') === 'video_mp4')
  )
}

const privateAddresses = new BlockList()
const privateIPv6 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  privateAddresses.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const)
  privateIPv6.addSubnet(network, prefix, 'ipv6')
/** @param address - resolved IP. @returns whether it is outside reserved/private address space. */
export function publicMediaAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? !privateAddresses.check(address, 'ipv4') : family === 6 && !privateIPv6.check(address, 'ipv6')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * @param body - bounded official JSON response.
 * @param target - approved ID.
 * @returns exact-work video sources or protection indication; ignores recommendations and author/auth fields.
 */
export function providerSources(
  body: string,
  target: string,
): { sources: readonly ProviderSource[]; protected: boolean } {
  const empty = { sources: [], protected: false }
  if (Buffer.byteLength(body) > PROVIDER_MAX_BYTES) return empty
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return empty
  }
  const detail = record(record(parsed)?.aweme_detail)
  if (detail?.aweme_id !== target) return empty
  const video = record(detail.video)
  if (video === undefined) return empty
  const rates = Array.isArray(video.bit_rate)
    ? video.bit_rate
      .slice(0, 16)
      .map(record)
      .filter(v => v !== undefined)
    : []
  const nodes = [video, record(video.play_addr), ...rates.flatMap(r => [r, record(r.play_addr)])].filter(
    v => v !== undefined,
  )
  const protectedMedia = nodes.some(n =>
    Object.keys(n).some(
      key =>
        /drm|encrypt|decrypt|license/i.test(key) &&
        n[key] !== undefined &&
        n[key] !== null &&
        n[key] !== false &&
        n[key] !== 0 &&
        n[key] !== '',
    ),
  )
  if (protectedMedia) return { sources: [], protected: true }
  const { duration, width, height } = video
  if (
    typeof duration !== 'number' ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 86_400_000 ||
    typeof width !== 'number' ||
    !Number.isInteger(width) ||
    width <= 0 ||
    width > 16_384 ||
    typeof height !== 'number' ||
    !Number.isInteger(height) ||
    height <= 0 ||
    height > 16_384
  )
    return empty
  const sources: ProviderSource[] = []
  const add = (address: unknown, sourceField: ProviderSource['sourceField']): void => {
    const value = record(address)
    if (!Array.isArray(value?.url_list)) return
    const urls = value.url_list.slice(0, 32).filter((url): url is string => typeof url === 'string' && providerMP4(url))
    if (urls.length > 0) sources.push({ targetVideoId: target, urls, sourceField, durationMs: duration, width, height })
  }
  // F2's single-work filter selects video.bit_rate[0].play_addr.url_list; order remains provider-owned.
  for (const rate of rates)
    if (typeof rate.bit_rate === 'number' && Number.isFinite(rate.bit_rate) && rate.bit_rate > 0)
      add(rate.play_addr, 'video.bit_rate.play_addr')
  add(video.play_addr, 'video.play_addr')
  return { sources, protected: false }
}

/** A deliberately small player fact check; the provider branch does not assert exact currentSrc matching. */
export const PROVIDER_PLAYER_PROBE = `(() => {
 const all=document.querySelectorAll('video');if(all.length>16)return null;
 const v=[...all].filter(x=>x.getBoundingClientRect().width>0&&x.getBoundingClientRect().height>0);
 if(v.length!==1||v[0].readyState<2||v[0].paused)return null;
 return {duration:v[0].duration,https:v[0].currentSrc.startsWith('https:'),protected:v[0].mediaKeys!==null};
})()`

interface PendingResponse {
  epoch: number
  loader: string
  received: boolean
}
/** Reads bounded bodies only for page-generated target GET requests in the main document. */
export class ProviderResponses {
  private readonly pending = new Map<string, PendingResponse>()
  private frame = ''
  private loader = ''
  private closed = false
  private attached = false
  private epoch = 0
  private isClosed(): boolean {
    return this.closed
  }
  constructor(
    private readonly guest: WebContents,
    private readonly target: string,
    private readonly currentEpoch: () => number,
    private readonly deliver: (source: ProviderEvidence) => void,
    private readonly protection: () => void,
  ) {}

  /** @returns whether this observer attached; never takes over an existing debugger. */
  async start(): Promise<boolean> {
    if (this.guest.debugger.isAttached()) return false
    try {
      this.guest.debugger.attach('1.3')
      this.attached = true
      this.guest.debugger.on('message', this.message)
      await this.guest.debugger.sendCommand('Page.enable')
      if (this.isClosed()) return false
      const tree = record(await this.guest.debugger.sendCommand('Page.getFrameTree'))
      const frame = record(record(tree?.frameTree)?.frame)
      this.frame = typeof frame?.id === 'string' ? frame.id : ''
      this.loader = typeof frame?.loaderId === 'string' ? frame.loaderId : ''
      if (this.isClosed()) return false
      await this.guest.debugger.sendCommand('Network.enable', {
        maxTotalBufferSize: PROVIDER_MAX_BYTES,
        maxResourceBufferSize: PROVIDER_MAX_BYTES,
        maxPostDataSize: 0,
      })
      if (this.isClosed() || this.frame.length === 0) {
        this.close()
        return false
      }
      return true
    } catch {
      this.close()
      return false
    }
  }

  /** Invalidates the prior document even when the canonical target URL remains the same. */
  newDocument(): void {
    this.epoch = this.currentEpoch()
    this.pending.clear()
    this.loader = ''
  }

  private readonly message = (_event: Electron.Event, method: string, params: unknown): void => {
    void this.readMessage(method, params).catch(() => {
      /* Malformed/evicted CDP data provides no media selection. */
    })
  }

  private async readMessage(method: string, value: unknown): Promise<void> {
    if (this.isClosed() || this.guest.isDestroyed()) return
    const params = record(value)
    if (params === undefined) return
    const frame = record(params.frame)
    if (method === 'Page.frameNavigated' && frame?.id === this.frame && !frame.parentId) {
      this.loader = typeof frame.loaderId === 'string' ? frame.loaderId : ''
      return
    }
    if (typeof params.requestId !== 'string') return
    if (method === 'Network.requestWillBeSent') {
      // Read only method/URL/identity. Never access request headers, postData or response cookie fields.
      this.pending.delete(params.requestId)
      const request = record(params.request)
      if (params.type === 'XHR' || params.type === 'Fetch') {
        if (
          this.pending.size < 4 &&
          params.frameId === this.frame &&
          request?.method === 'GET' &&
          typeof request.url === 'string' &&
          typeof params.loaderId === 'string' &&
          providerRequest(request.url, this.target)
        )
          this.pending.set(params.requestId, { epoch: this.epoch, loader: params.loaderId, received: false })
      }
      return
    }
    const request = this.pending.get(params.requestId)
    if (request === undefined) return
    if (request.epoch !== this.currentEpoch() || request.loader !== this.loader) {
      this.pending.delete(params.requestId)
      return
    }
    if (method === 'Network.responseReceived') {
      const response = record(params.response)
      request.received =
        params.frameId === this.frame &&
        params.loaderId === request.loader &&
        response?.status === 200 &&
        typeof response.mimeType === 'string' &&
        /^application\/json(?:;|$)/i.test(response.mimeType) &&
        typeof response.url === 'string' &&
        providerRequest(response.url, this.target)
      if (!request.received) this.pending.delete(params.requestId)
    } else if (method === 'Network.loadingFailed') this.pending.delete(params.requestId)
    else if (method === 'Network.loadingFinished') {
      this.pending.delete(params.requestId)
      if (
        !request.received ||
        typeof params.encodedDataLength !== 'number' ||
        !Number.isFinite(params.encodedDataLength) ||
        params.encodedDataLength < 0 ||
        params.encodedDataLength > PROVIDER_MAX_BYTES
      )
        return
      try {
        const result = record(
          await this.guest.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }),
        )
        if (this.isClosed() || request.epoch !== this.currentEpoch() || request.loader !== this.loader) return
        if (
          typeof result?.body !== 'string' ||
          typeof result.base64Encoded !== 'boolean' ||
          result.body.length > (PROVIDER_MAX_BYTES * 4) / 3 + 4
        )
          return
        const body = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8')
        if (body.length > PROVIDER_MAX_BYTES) return
        const parsed = providerSources(body.toString('utf8'), this.target)
        if (parsed.protected) {
          this.protection()
          return
        }
        const source = parsed.sources[0]
        if (source !== undefined) this.deliver({ ...source, documentEpoch: request.epoch })
      } catch {
        /* Unsupported/evicted/invalid target bodies provide no grant. */
      }
    }
  }

  /** Does not take over or detach another consumer's debugger. */
  close(): void {
    this.closed = true
    this.pending.clear()
    if (!this.attached) return
    this.guest.debugger.removeListener('message', this.message)
    try {
      if (this.guest.debugger.isAttached()) this.guest.debugger.detach()
    } catch {
      /* Guest may already have closed. */
    }
    this.attached = false
  }
}
