/** Fixed URL and identity checks for the single-video native transport. */
import { createHash } from 'node:crypto'
import type { DouyinDesktopRequest } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { isAbsolute } from 'node:path'

/** @param value - untrusted URL. @returns a credential-free public HTTPS URL. */
function httpsURL(value: string): URL | undefined {
  if (value.length > 8192 || !URL.canParse(value)) return undefined
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
    ? url
    : undefined
}

/** @param value - requested page. @returns true for official video/share navigation only. */
export function douyinPage(value: string): boolean {
  const url = httpsURL(value)
  return (
    url !== undefined &&
    ((url.hostname === 'v.douyin.com' && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) ||
      (['www.douyin.com', 'www.iesdouyin.com'].includes(url.hostname) && targetVideoId(value) !== undefined))
  )
}

/** @param value - official final page. @returns its sole video ID, never an arbitrary query field. */
export function targetVideoId(value: string): string | undefined {
  const url = httpsURL(value)
  if (url === undefined || !['www.douyin.com', 'www.iesdouyin.com'].includes(url.hostname)) return undefined
  const pathId = /^\/(?:share\/)?video\/(\d{10,25})\/?$/.exec(url.pathname)?.[1]
  const modal = url.searchParams.getAll('modal_id')
  if (pathId !== undefined)
    return modal.length === 0 || (modal.length === 1 && modal[0] === pathId) ? pathId : undefined
  return url.hostname === 'www.douyin.com' &&
    ['/discover', '/', '/jingxuan'].includes(url.pathname) &&
    modal.length === 1 &&
    /^\d{10,25}$/.test(modal[0] ?? '')
    ? modal[0]
    : undefined
}

/** @param value - observed media or redirect. @returns true for a fixed public CDN namespace. */
export function douyinMedia(value: string): boolean {
  const url = httpsURL(value)
  return (
    url !== undefined &&
    ['douyinvod.com', 'bytecdn.com', 'bytecdn.cn'].some(host => url.hostname.endsWith(`.${host}`))
  )
}

/** @param value - child IPC. @returns narrowed bounded request, or undefined. */
export function parseDouyinRequest(value: unknown): DouyinDesktopRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (
    v.type !== 'douyin-browser' ||
    !['prepare', 'download', 'release'].includes(String(v.action)) ||
    typeof v.requestId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(v.requestId) ||
    typeof v.taskId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(v.taskId) ||
    typeof v.sessionId !== 'string' ||
    v.sessionId.length === 0 ||
    v.sessionId.length > 256 ||
    typeof v.cwd !== 'string' ||
    v.cwd.length > 4096 ||
    !isAbsolute(v.cwd) ||
    v.cwd.includes('\0') ||
    typeof v.url !== 'string' ||
    !douyinPage(v.url) ||
    (v.action === 'download' && (typeof v.targetVideoId !== 'string' || !/^\d{10,25}$/.test(v.targetVideoId)))
  )
    return undefined
  return value as DouyinDesktopRequest
}

/** @param value - transient signed URL. @returns a receipt-safe identity digest. */
export function mediaURLHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Read only visible-player and target-specific public bootstrap metadata; never cookies or response bodies. */
export const DOUYIN_PLAYER_PROBE = `(() => {
  const videos = [...document.querySelectorAll('video')].filter(v => v.getBoundingClientRect().width > 0 && v.getBoundingClientRect().height > 0);
  if (videos.length !== 1 || videos[0].paused) return null;
  if (!videos[0].currentSrc.startsWith('https:')) return { unsupported: 'BLOB_OR_SEGMENTS' };
  const data = window._ROUTER_DATA;
  if (!data || typeof data !== 'object' || !data.loaderData) return document.readyState === 'complete' ? { unsupported: 'PAGE_METADATA' } : null;
  const items = Object.values(data.loaderData).slice(0, 16).flatMap(v => v?.videoInfoRes?.item_list || []);
  if (items.length !== 1) return null;
  const item = items[0], urls = item.video?.play_addr?.url_list;
  if (!Array.isArray(urls) || !urls.includes(videos[0].currentSrc)) return null;
  return { id: String(item.aweme_id), src: videos[0].currentSrc };
})()`
