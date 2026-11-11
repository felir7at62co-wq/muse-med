/** Bounded public work counters from normal page responses and visible action strips. */
import type {
  DouyinDataComments, DouyinDataCount, DouyinDataSnapshot, DouyinVideoId,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { PROVIDER_MAX_BYTES } from './douyin-provider.ts'

/** @param target - Main-approved work. @returns Read-only counters from bounded initial data or the visible work action strip. */
export function publicDataProbe(target: DouyinVideoId): string {
  return `(() => {
    if(document.readyState!=='complete')return null;
    const visible=x=>x.getBoundingClientRect().width>0&&x.getBoundingClientRect().height>0;
    const strictVisible=x=>{
      if(!visible(x))return false;
      let node=x,depth=0;
      while(node&&depth++<64){
        const style=window.getComputedStyle(node);
        if(node.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'
          ||style.opacity!==''&&Number(style.opacity)===0
          ||style.clipPath&&style.clipPath!=='none'||style.clip&&style.clip!=='auto'
          ||node===x&&(style.color==='transparent'||/^rgba\\([^)]*,\\s*0(?:\\.0+)?\\s*\\)$/u.test(style.color)))return false;
        node=node.parentElement;
      }
      return node===null;
    };
    const series=(()=>{
      let location;
      try{location=new URL(window.location.href)}catch{return null}
      const target=${JSON.stringify(target)};
      const ids=location.searchParams.getAll('modal_id');
      const path=/^\\/(?:share\\/)?video\\/(\\d{10,25})\\/?$/u.exec(location.pathname)?.[1];
      if(!['www.douyin.com','www.iesdouyin.com'].includes(location.hostname)||location.protocol!=='https:'
        ||location.username||location.password||location.port&&location.port!=='443'||ids.length>1
        ||path!==undefined&&path!==target||ids.length===1&&ids[0]!==target
        ||!(path===target||!path&&location.hostname==='www.douyin.com'&&['/','/discover','/jingxuan'].includes(location.pathname)&&ids.length===1))return null;
      const links=[...document.querySelectorAll('a[href]')];if(links.length>256)return null;
      const clean=x=>typeof x==='string'&&x.length<=512&&!/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/u.test(x)?x.trim():'';
      const normalize=x=>x.replace(/^短剧\\s*·\\s*/u,'短剧·');
      const visibleFragments=x=>{
        const walker=document.createTreeWalker(x,window.NodeFilter.SHOW_ELEMENT|window.NodeFilter.SHOW_TEXT);
        let node,count=0,length=0;const parts=[];
        while((node=walker.nextNode())){
          if(++count>128)return null;
          if(node.nodeType===window.Node.TEXT_NODE&&node.parentElement&&strictVisible(node.parentElement)){
            const text=node.nodeValue??'';length+=text.length;if(length>512)return null;parts.push(text);
          }
        }
        return parts;
      };
      const visibleText=x=>{const parts=visibleFragments(x);return parts===null?null:parts.join('')};
      const labelsFor=link=>{
        const text=visibleText(link);if(text===null)return null;
        const raw=[link.getAttribute('aria-label'),link.getAttribute('title'),text];
        if(raw.some(value=>typeof value==='string'&&value.trim()&&!clean(value)))return null;
        return raw.map(clean).filter(Boolean).map(normalize);
      };
      const workId=link=>{
        let url;try{url=new URL(link.getAttribute('href'),location.href)}catch{return null}
        const modal=url.searchParams.getAll('modal_id');
        const id=/^\\/video\\/(\\d{10,25})\\/?$/u.exec(url.pathname)?.[1];
        if(url.protocol!=='https:'||!['www.douyin.com','www.iesdouyin.com'].includes(url.hostname)
          ||url.username||url.password||url.port&&url.port!=='443'||!id
          ||modal.length>1||modal.length===1&&modal[0]!==id)return null;
        return id;
      };
      const active=[];
      for(const link of links){
        if(!strictVisible(link))continue;
        if(workId(link)!==target)continue;
        const labels=labelsFor(link);if(labels===null)return null;
        if(labels.some(label=>label.includes('播放中')))active.push({link,labels});
      }
      if(active.length!==1)return null;
      const {link,labels}=active[0],list=link.closest('ul,ol,[role="list"]');
      if(!list||!strictVisible(list)||list.querySelectorAll('a[href]').length>64)return null;
      const item=link.closest('li,[role="listitem"]');
      if(!item||item.closest('ul,ol,[role="list"]')!==list||!strictVisible(item))return null;
      const itemLabels=[...labels];
      const fragments=visibleFragments(item);if(fragments===null)return null;
      for(const text of fragments){
        const cleaned=clean(text);if(text.trim()&&!cleaned)return null;
        const value=normalize(cleaned);
        if(value.startsWith('短剧·')||/^第[0-9一二三四五六七八九十百零〇]+\\s*集/u.test(value))itemLabels.push(value);
      }
      for(const other of list.querySelectorAll('a[href]')){
        if(other===link||!strictVisible(other))continue;
        const otherLabels=labelsFor(other);if(otherLabels===null)return null;
        const id=workId(other),playing=otherLabels.some(value=>value.includes('播放中'));
        if(playing&&id!==target)return null;
        if(item.contains(other)){
          if(id===target)itemLabels.push(...otherLabels);
          else if(id!==null)return null;
        }
      }
      const region=list.parentElement,role=region?.getAttribute('role');
      if(!region||!strictVisible(region)||!(role===null||role==='region')
        ||!(region.tagName==='DIV'||region.tagName==='SECTION'||role==='region'))return null;
      const boundary='section,article,aside,nav,main,[role~="region"],[role~="article"],[role~="navigation"],[role~="complementary"],[role~="group"],[role~="main"],[role~="feed"],[role~="tabpanel"],[role~="dialog"]';
      const semantic=list.closest(boundary);
      const listNodes=[...region.querySelectorAll('ul,ol,[role="list"]')];if(listNodes.length>64)return null;
      const lists=listNodes.filter(strictVisible);
      if(lists.length!==1||lists[0]!==list)return null;
      const headings=[...region.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')];if(headings.length>64)return null;
      const found=headings.filter(heading=>{
        const text=normalize(clean(visibleText(heading)));
        return !list.contains(heading)&&heading.closest(boundary)===semantic
          &&strictVisible(heading)&&/^短剧·.{1,200}$/u.test(text);
      });
      if(found.length!==1)return null;
      const heading=found[0],original=clean(visibleText(heading)),label=normalize(original);
      const title=original.replace(/^短剧\\s*·\\s*/u,'').trim();
      if(!title||title.length>200)return null;
      const episodes=[];
      const combined=fragments.join('');
      for(const match of combined.matchAll(/短剧\\s*·\\s*/gu)){
        const text=normalize(combined.slice(match.index));if(!text.startsWith(label))return null;
        const tail=text.slice(label.length).trim();
        if(tail&&!/^(?:第[0-9一二三四五六七八九十百零〇]+\\s*集|播放中)/u.test(tail))return null;
      }
      for(const match of combined.matchAll(/第([0-9一二三四五六七八九十百零〇]+)\\s*集/gu))episodes.push(match[1]);
      const playing=labels.filter(value=>value.includes('播放中'));if(!playing.length)return null;
      for(const value of itemLabels){
        let tail=value;const full=/短剧\\s*·/u.test(value);
        if(full){
          if(!value.startsWith(label))return null;
          tail=value.slice(label.length).trim();
          if(!tail)continue;
        }
        const episode=/^第([0-9一二三四五六七八九十百零〇]+)\\s*集/u.exec(tail);
        if(full&&!episode)return null;
        if(episode)episodes.push(episode[1]);
        if(value.includes('播放中')&&!/^(?:第[0-9一二三四五六七八九十百零〇]+\\s*集\\s*)?播放中$/u.test(tail))return null;
      }
      if(new Set(episodes).size>1)return null;
      return {title,source:'visible-series-list'};
    })();
    const seriesOnly=()=>series?JSON.stringify({kind:'public-action-strip',targetVideoId:${JSON.stringify(target)},displays:null,visibleSeries:series}):null;
    const data=window._ROUTER_DATA;
    const loaders=Object.values(data?.loaderData??{});
    if(loaders.length>16||loaders.some(x=>Array.isArray(x?.videoInfoRes?.item_list)&&x.videoInfoRes.item_list.length>16))return seriesOnly();
    const rows=loaders.flatMap(x=>Array.isArray(x?.videoInfoRes?.item_list)?x.videoInfoRes.item_list:[]);
    const matches=rows.filter(x=>x?.aweme_id===${JSON.stringify(target)});
    if(matches.length>1)return seriesOnly();
    if(matches.length===1){
      const item=matches[0],raw=item.statistics;
      if(raw?.aweme_id!==undefined&&raw.aweme_id!==${JSON.stringify(target)})return seriesOnly();
      const statistics={};
      for(const key of ['play_count','digg_count','comment_count','share_count','collect_count']){
        const value=raw?.[key];if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)statistics[key]=value;
      }
      const detail={aweme_id:${JSON.stringify(target)},statistics};
      if(typeof item.desc==='string'&&item.desc.length<=5000)detail.desc=item.desc;
      if(typeof item.author?.nickname==='string'&&item.author.nickname.length<=256)detail.author={nickname:item.author.nickname};
      if(Number.isSafeInteger(item.create_time)&&item.create_time>0&&item.create_time<=253402300799)detail.create_time=item.create_time;
      if(Object.keys(statistics).length||detail.desc||detail.author||detail.create_time)return JSON.stringify({status_code:0,aweme_detail:detail,visibleSeries:series});
    }
    const videos=[...document.querySelectorAll('video')];
    if(videos.length>16||videos.filter(visible).length!==1||!videos.filter(visible).some(x=>x.readyState>=2))
      return seriesOnly();
    const anchors=[...document.querySelectorAll('[data-e2e="video-share-icon-container"]')];
    if(anchors.length>16)return seriesOnly();
    const shares=anchors.filter(visible);if(shares.length!==1)
      return seriesOnly();
    const strip=shares[0].parentElement;
    if(!strip)return seriesOnly();
    const cells=[...strip.querySelectorAll(':scope > div > span')].filter(visible);
    if(cells.length!==4||cells[3].parentElement!==shares[0]||cells.some(x=>!x.parentElement.querySelector('svg')))
      return seriesOnly();
    const displays=cells.map(x=>(x.textContent??'').trim());
    if(displays.some(x=>x.length>64))return seriesOnly();
    return JSON.stringify({kind:'public-action-strip',targetVideoId:${JSON.stringify(target)},displays,visibleSeries:series});
  })()`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function publicText(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ? value : null
}

function publicationTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 253402300799 ? value : null
}

function visibleSeries(value: unknown, pageProbe: boolean): { seriesTitle: string; seriesSource: 'visible-series-list' } | undefined {
  if (!pageProbe) return undefined
  const item = record(value), title = publicText(item?.title, 200)
  return item?.source === 'visible-series-list' && title !== null ? { seriesTitle: title, seriesSource: 'visible-series-list' } : undefined
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
 * @param pageProbe - Whether the projection came from the target-bound local page probe.
 * @returns Only target-associated public counters; public play count is never inferred.
 */
export function publicData(
  body: string, target: DouyinVideoId, observedAt: string, comments: DouyinDataComments, pageProbe = false,
): DouyinDataSnapshot | undefined {
  if (Buffer.byteLength(body) > PROVIDER_MAX_BYTES) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return undefined }
  const root = record(parsed)
  const series = visibleSeries(root?.visibleSeries, pageProbe)
  if (root?.kind === 'public-action-strip') {
    if (root.targetVideoId !== target || (root.displays === null ? series === undefined :
      !Array.isArray(root.displays) || root.displays.length !== 4
      || root.displays.some(value => typeof value !== 'string' || value.length > 64))) return undefined
    const displays = root.displays as [string, string, string, string] | null
    const count = (index: number): DouyinDataCount => displays === null
      ? { value: null, precision: 'unavailable', reason: 'missing' } : displayedCount(displays[index] ?? '')
    return { status: 'ok', source: 'public-page', targetVideoId: target, observedAt, comments,
      metadata: { description: null, authorName: null, publishedAt: null, ...series },
      counts: { play_count: { value: null, precision: 'unavailable', reason: 'not-exposed' },
        digg_count: count(0), comment_count: count(1), collect_count: count(2), share_count: count(3) } }
  }
  if (root?.status_code !== undefined && root.status_code !== 0) return undefined
  const detail = record(root?.aweme_detail)
  if (detail === undefined || detail.aweme_id !== target) return undefined
  const stats = record(detail.statistics)
  if (stats?.aweme_id !== undefined && stats.aweme_id !== target) return undefined
  const metadata = { description: publicText(detail.desc, 5000), authorName: publicText(record(detail.author)?.nickname, 256),
    publishedAt: publicationTime(detail.create_time), ...series }
  if (stats === undefined && Object.values(metadata).every(value => value === null)) return undefined
  const counts = stats ?? {}
  return {
    status: 'ok', source: 'public-page', targetVideoId: target, observedAt, metadata,
    counts: {
      play_count: counts.play_count === 0
        ? { value: null, precision: 'unavailable', reason: 'not-exposed' }
        : providerCount(counts.play_count),
      digg_count: providerCount(counts.digg_count), comment_count: providerCount(counts.comment_count),
      share_count: providerCount(counts.share_count), collect_count: providerCount(counts.collect_count),
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
  const matches = root.aweme_list.flatMap((value, index) => record(value)?.aweme_id === target ? [index] : [])
  const index = matches[0]
  if (matches.length !== 1 || index === undefined) return result
  if (index < 0 || root.can_modify[index] !== true) return result
  const detail = record(root.aweme_list[index]), stats = record(detail?.statistics)
  if (stats?.aweme_id !== target) return result
  const data = publicData(JSON.stringify({ status_code: 0, aweme_detail: detail }), target, observedAt, comments)
  if (data === undefined) return result
  return { ...result, data: { ...data, source: 'creator-page', counts: { ...data.counts, play_count: providerCount(stats.play_count) } } }
}
