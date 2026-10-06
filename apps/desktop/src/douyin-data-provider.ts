/** Bounded public work counters from normal page responses and visible action strips. */
import type {
  DouyinDataComments, DouyinDataCount, DouyinDataSnapshot, DouyinVideoId,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { PROVIDER_MAX_BYTES } from './douyin-provider.ts'

/** @param target - Main-approved work. @returns Read-only counters from bounded initial data or the visible work action strip. */
export function publicDataProbe(target: DouyinVideoId): string {
  return `(() => {
    if(document.readyState!=='complete')return null;
    const data=window._ROUTER_DATA;
    const rows=Object.values(data?.loaderData??{}).slice(0,16).flatMap(x=>Array.isArray(x?.videoInfoRes?.item_list)?x.videoInfoRes.item_list.slice(0,16):[]);
    const matches=rows.filter(x=>x?.aweme_id===${JSON.stringify(target)});
    if(matches.length>1)return null;
    if(matches.length===1&&matches[0].statistics&&typeof matches[0].statistics==='object'){
      const statistics={};
      for(const key of ['play_count','digg_count','comment_count','share_count','collect_count']){
        const value=matches[0].statistics[key];if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)statistics[key]=value;
      }
      return JSON.stringify({status_code:0,aweme_detail:{aweme_id:${JSON.stringify(target)},statistics}});
    }
    const visible=x=>x.getBoundingClientRect().width>0&&x.getBoundingClientRect().height>0;
    const videos=[...document.querySelectorAll('video')];
    if(videos.length>16||videos.filter(visible).length!==1||!videos.filter(visible).some(x=>x.readyState>=2))return null;
    const anchors=[...document.querySelectorAll('[data-e2e="video-share-icon-container"]')];
    if(anchors.length>16)return null;
    const shares=anchors.filter(visible);if(shares.length!==1)return null;
    const strip=shares[0].parentElement;if(!strip)return null;
    const cells=[...strip.querySelectorAll(':scope > div > span')].filter(visible);
    if(cells.length!==4||cells[3].parentElement!==shares[0]||cells.some(x=>!x.parentElement.querySelector('svg')))return null;
    const displays=cells.map(x=>(x.textContent??'').trim());if(displays.some(x=>x.length>64))return null;
    return JSON.stringify({kind:'public-action-strip',targetVideoId:${JSON.stringify(target)},displays});
  })()`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function displayedCount(value: string): DouyinDataCount {
  const match = /^(\d+)(?:\.(\d{1,2}))?([万亿])?$/.exec(value)
  if (match === null || (match[2] !== undefined && match[3] === undefined)) {
    return { value: null, precision: 'unavailable', reason: 'not-exposed' }
  }
  const multiplier = match[3] === '万' ? 10_000 : match[3] === '亿' ? 100_000_000 : 1
  const count = Number(match[1]) * multiplier + Number((match[2] ?? '').padEnd(2, '0')) * (multiplier / 100)
  if (!Number.isSafeInteger(count)) return { value: null, precision: 'unavailable', reason: 'invalid' }
  return match[3] === undefined ? { value: count, precision: 'exact' } : { value: count, precision: 'rounded', display: value }
}

/** @param value - An untrusted provider counter. @returns An exact nonnegative integer or an unavailable counter. */
export function providerCount(value: unknown): DouyinDataCount {
  if (value === undefined || value === null) return { value: null, precision: 'unavailable', reason: 'missing' }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { value, precision: 'exact' }
    : { value: null, precision: 'unavailable', reason: 'invalid' }
}

/**
 * @param body - The bounded detail response or visible action-strip projection.
 * @param target - Main-approved exact public work identity.
 * @param observedAt - The Main process's retrieval timestamp.
 * @param comments - Separately observed comment items and pagination.
 * @returns Only target-associated public counters; public play count is never inferred.
 */
export function publicData(
  body: string, target: DouyinVideoId, observedAt: string, comments: DouyinDataComments,
): DouyinDataSnapshot | undefined {
  if (Buffer.byteLength(body) > PROVIDER_MAX_BYTES) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return undefined }
  const root = record(parsed)
  if (root?.kind === 'public-action-strip') {
    if (root.targetVideoId !== target || !Array.isArray(root.displays) || root.displays.length !== 4
      || root.displays.some(value => typeof value !== 'string' || value.length > 64)) return undefined
    const displays = root.displays as [string, string, string, string]
    return { status: 'ok', source: 'public-page', targetVideoId: target, observedAt, comments,
      counts: { play_count: { value: null, precision: 'unavailable', reason: 'not-exposed' },
        digg_count: displayedCount(displays[0]), comment_count: displayedCount(displays[1]),
        collect_count: displayedCount(displays[2]), share_count: displayedCount(displays[3]) } }
  }
  if (root?.status_code !== undefined && root.status_code !== 0) return undefined
  const detail = record(root?.aweme_detail)
  if (detail === undefined || detail.aweme_id !== target) return undefined
  const stats = record(detail.statistics)
  if (stats === undefined) return undefined
  return {
    status: 'ok', source: 'public-page', targetVideoId: target, observedAt,
    counts: {
      play_count: stats.play_count === 0
        ? { value: null, precision: 'unavailable', reason: 'not-exposed' }
        : providerCount(stats.play_count),
      digg_count: providerCount(stats.digg_count), comment_count: providerCount(stats.comment_count),
      share_count: providerCount(stats.share_count), collect_count: providerCount(stats.collect_count),
    },
    comments,
  }
}

/**
 * @param body - The normal Creator content-management list response.
 * @param target - Exact selected work; numeric item identifiers are never coerced.
 * @param observedAt - Main process retrieval timestamp.
 * @param comments - Independently observed comments.
 * @returns Target counters only when the aligned own-work permission and statistics identity match.
 */
export function creatorData(
  body: string, target: DouyinVideoId, observedAt: string, comments: DouyinDataComments,
): { readonly data?: DouyinDataSnapshot; readonly ownList: boolean; readonly hasMore: boolean } {
  const unavailable = { ownList: false, hasMore: false }
  if (Buffer.byteLength(body) > PROVIDER_MAX_BYTES) return unavailable
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return unavailable }
  const root = record(parsed)
  if (root?.status_code !== 0 || !Array.isArray(root.aweme_list) || !Array.isArray(root.can_modify)
    || root.aweme_list.length !== root.can_modify.length || root.can_modify.some(value => typeof value !== 'boolean')) return unavailable
  const result = { ownList: true, hasMore: root.has_more === true }
  const index = root.aweme_list.findIndex(value => record(value)?.aweme_id === target)
  if (index < 0 || root.can_modify[index] !== true) return result
  const detail = record(root.aweme_list[index]), stats = record(detail?.statistics)
  if (stats?.aweme_id !== target) return result
  const data = publicData(JSON.stringify({ status_code: 0, aweme_detail: detail }), target, observedAt, comments)
  if (data === undefined) return result
  return { ...result, data: { ...data, source: 'creator-page', counts: { ...data.counts, play_count: providerCount(stats.play_count) } } }
}
