/** Fixed URL and identity checks for the single-video native transport. */
import { createHash } from 'node:crypto'
import type { DouyinDesktopDataRequest, DouyinDesktopRequest, DouyinVideoId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
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

/** @param value - Requested normal account page. @returns True for the official Creator HTTPS origin. */
export function douyinCreatorPage(value: string): boolean {
  return httpsURL(value)?.hostname === 'creator.douyin.com'
}

/** @param value - official final page. @returns its sole video ID, never an arbitrary query field. */
export function targetVideoId(value: string): DouyinVideoId | undefined {
  const url = httpsURL(value)
  if (url === undefined || !['www.douyin.com', 'www.iesdouyin.com'].includes(url.hostname)) return undefined
  const pathId = /^\/(?:share\/)?video\/(\d{10,25})\/?$/.exec(url.pathname)?.[1]
  const modal = url.searchParams.getAll('modal_id')
  if (pathId !== undefined)
    return modal.length === 0 || (modal.length === 1 && modal[0] === pathId) ? pathId as DouyinVideoId : undefined
  return url.hostname === 'www.douyin.com' &&
    ['/discover', '/', '/jingxuan'].includes(url.pathname) &&
    modal.length === 1 &&
    /^\d{10,25}$/.test(modal[0] ?? '')
    ? modal[0] as DouyinVideoId
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
    typeof v.maxDownloadBytes !== 'number' ||
    !Number.isSafeInteger(v.maxDownloadBytes) ||
    v.maxDownloadBytes < 1 ||
    v.maxDownloadBytes > 8 * 1024 ** 3 ||
    (v.action === 'download' && (typeof v.targetVideoId !== 'string' || !/^\d{10,25}$/.test(v.targetVideoId)))
  )
    return undefined
  return value as DouyinDesktopRequest
}

/** @param value - Private child-process IPC. @returns A bounded data operation, or undefined. */
export function parseDouyinDataRequest(value: unknown): DouyinDesktopDataRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const request = value as Record<string, unknown>
  const selection = typeof request.selection === 'object' && request.selection !== null && !Array.isArray(request.selection)
    ? request.selection as Record<string, unknown> : undefined
  const comments = typeof selection?.comments === 'object' && selection.comments !== null && !Array.isArray(selection.comments)
    ? selection.comments as Record<string, unknown> : undefined
  if (request.type !== 'douyin-browser-data' || typeof request.action !== 'string' || !['read', 'release'].includes(request.action)
    || typeof request.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.requestId)
    || typeof request.taskId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.taskId)
    || typeof request.sessionId !== 'string' || request.sessionId.length < 1 || request.sessionId.length > 256
    || typeof request.cwd !== 'string' || request.cwd.length > 4096 || !isAbsolute(request.cwd) || request.cwd.includes('\0')
    || typeof selection?.url !== 'string' || !douyinPage(selection.url)
    || typeof selection.source !== 'string' || !['public', 'creator', 'auto'].includes(selection.source)
    || typeof selection.timeoutMs !== 'number' || !Number.isSafeInteger(selection.timeoutMs)
    || selection.timeoutMs < 1000 || selection.timeoutMs > 300_000
    || typeof comments?.enabled !== 'boolean' || typeof comments.count !== 'number' || !Number.isSafeInteger(comments.count)
    || comments.count < 1 || comments.count > 200
    || (comments.cursor !== undefined && (typeof comments.cursor !== 'string' || !/^\d{1,64}$/.test(comments.cursor)))
    || (!comments.enabled && comments.cursor !== undefined)) return undefined
  return value as DouyinDesktopDataRequest
}

/** @param value - transient signed URL. @returns a receipt-safe identity digest. */
export function mediaURLHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Read bounded public player metadata and return only its work ID and unchanged visible source. */
export const DOUYIN_PLAYER_PROBE = `(() => {
  const videos = [...document.querySelectorAll('video')].filter(v => v.getBoundingClientRect().width > 0 && v.getBoundingClientRect().height > 0);
  if (videos.length !== 1 || videos[0].readyState < 2) return null;
  if (videos[0].mediaKeys != null) return { unsupported: 'PROTECTED_MEDIA' };
  if (!videos[0].currentSrc.startsWith('https:')) return { unsupported: 'BLOB_OR_SEGMENTS' };
  const data = window._ROUTER_DATA;
  if (!data || typeof data !== 'object' || !data.loaderData) {
    if (document.readyState !== 'complete') return null;
    const player = videos[0], src = player.currentSrc;
    const addressEntries = value => Array.isArray(value) ? value.slice(0,32)
      : Array.isArray(value?.urlList) ? value.urlList.slice(0,32) : [];
    const addressURL = entry => typeof entry==='string' ? entry
      : typeof entry?.src==='string' ? entry.src : null;
    // The normal player adds __vid with awemeId; transfer still uses the unchanged currentSrc.
    const addressMatches = (entry,id) => {
      const value=addressURL(entry), current=new URL(src), markers=current.searchParams.getAll('__vid');
      if (markers.length && (markers.length!==1 || markers[0]!==id)) return false;
      if (value===src) return true;
      if (typeof value!=='string' || markers.length!==1 || !URL.canParse(value)) return false;
      const supplied=new URL(value);
      if (supplied.searchParams.has('__vid')) return false;
      const parameters=[...current.searchParams].filter(([key])=>key!=='__vid'), expected=[...supplied.searchParams];
      if (parameters.length!==expected.length || parameters.some(([key,value],index)=>key!==expected[index][0] || value!==expected[index][1])) return false;
      current.search=''; supplied.search='';
      return current.href===supplied.href;
    };
    let parent = player.parentElement;
    for (let ancestors=0; parent && ancestors<12; ancestors++, parent=parent.parentElement) {
      const roots = Object.getOwnPropertyNames(parent).filter(key=>key.startsWith('__reactProps$')).slice(0,4);
      const queue = roots.map(key=>({value:parent[key],depth:0})), matches = new Set();
      let examined=0;
      while(queue.length && examined++<1024) {
        const node=queue.shift(), item=node.value;
        if (!item || typeof item!=='object') continue;
        if (typeof item.awemeId==='string' && /^\\d{10,25}$/.test(item.awemeId) && item.video && typeof item.video==='object') {
          const video=item.video, rates=Array.isArray(video.bitRateList)?video.bitRateList.slice(0,16):[];
          const entries=[...addressEntries(video.playAddr),...addressEntries(video.playAddrH265),...rates.flatMap(rate=>addressEntries(rate?.playAddr))];
          if (entries.some(entry=>addressMatches(entry,item.awemeId))) {
            const nodes=[video,video.meta,...rates,...rates.map(rate=>rate?.playAddr),...entries].filter(x=>x && typeof x==='object');
            if (nodes.some(x=>Object.keys(x).some(key=>/drm|encrypt|decrypt|license/i.test(key) && x[key]!=null && x[key]!==false && x[key]!==0 && x[key]!==''))) return {unsupported:'PROTECTED_MEDIA'};
            matches.add(item.awemeId);
          }
        }
        if (node.depth>=6) continue;
        if (Array.isArray(item)) for (const value of item.slice(0,16)) queue.push({value,depth:node.depth+1});
        else for (const key of ['props','children','awemeInfo','aweme']) if (item[key] && typeof item[key]==='object') queue.push({value:item[key],depth:node.depth+1});
      }
      if (matches.size>1) return null;
      if (matches.size===1) return {id:[...matches][0],src};
    }
    return {unsupported:'PAGE_METADATA'};
  }
  const items = Object.values(data.loaderData).slice(0, 16).flatMap(v => v?.videoInfoRes?.item_list || []);
  if (items.length !== 1) return null;
  const item = items[0], urls = item.video?.play_addr?.url_list;
  if (!Array.isArray(urls) || !urls.includes(videos[0].currentSrc)) return null;
  return { id: String(item.aweme_id), src: videos[0].currentSrc };
})()`
