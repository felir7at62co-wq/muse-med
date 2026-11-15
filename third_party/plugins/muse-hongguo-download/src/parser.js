/** Official public directories and ordinary compatibility playback JSON; page JavaScript is never executed. */
import { isDeepStrictEqual } from 'node:util';
import { DownloadError } from './errors.js';

export const ORIGIN = 'https://hongguoduanju.com';

/** Validate a decimal series id without converting it to a JavaScript number. */
export function seriesId(value) {
  if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) throw new Error('seriesId 必须是十进制字符串 ID');
  return value;
}

/** Validate a positive episode number at the model input boundary. */
export function episodeNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('episode 必须是正整数');
  return value;
}

/** Extract a balanced JSON assignment, refusing expressions and incomplete pages. */
export function routerData(html) {
  const match = /(?:window\.)?_ROUTER_DATA\s*=\s*/.exec(html);
  if (!match) throw new Error('官网播放器数据缺失；页面可能已改变或访问受限');
  const start = match.index + match[0].length;
  if (html[start] !== '{') throw new Error('官网播放器必须包含 JSON 数据');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (--depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error('官网播放器 JSON 未完整返回');
}

/** Validate the declared directory; metadata-only reads never require or resolve a media model. */
export function parsePlayer(html, requestedSeriesId, episode, { metadataOnly = false } = {}) {
  seriesId(requestedSeriesId);
  episodeNumber(episode);
  const loaders = routerData(html)?.loaderData;
  const firstRoute = 'player_(series_id)/page', itemRoute = 'player_(series_id)/(vid)/page';
  const first = loaders?.[firstRoute], item = loaders?.[itemRoute];
  if (first !== undefined && item !== undefined && !isDeepStrictEqual(first, item)) throw new Error('官网返回相互冲突的播放器路由数据');
  const route = item !== undefined && (episode > 1 || first === undefined) ? itemRoute : firstRoute;
  const data = loaders?.[route];
  const detail = data?.seriesDetail;
  if (data?.isSuccess !== true || data.series_id !== requestedSeriesId || detail?.series_id !== requestedSeriesId) {
    throw new Error('官网没有返回请求的剧集；页面可能已改变或访问受限');
  }
  const count = detail.episode_cnt, accessible = detail.accessible_episode_cnt;
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(accessible) || accessible < 0 || accessible > count
    || typeof detail.series_name !== 'string' || !detail.series_name.trim() || !Array.isArray(detail.vid_list)
    || detail.vid_list.length !== count || detail.vid_list.some(vid => typeof vid !== 'string' || !vid
      || vid.trim() !== vid || /[\u0000-\u001f\u007f]/.test(vid))
    || new Set(detail.vid_list).size !== detail.vid_list.length) {
    throw new Error('官网剧集数据字段无效');
  }
  if (episode > count) throw new Error(`此剧共有 ${count} 集，没有第 ${episode} 集`);
  const info = {
    seriesId: requestedSeriesId, title: detail.series_name, episode,
    episodeCount: count, accessibleEpisodeCount: accessible,
    publicPlaybackAvailable: episode <= accessible,
    sourceUrl: `${ORIGIN}/player/${requestedSeriesId}${episode === 1 ? '' : `/${encodeURIComponent(detail.vid_list[episode - 1])}`}`,
    durationSeconds: null,
  };
  if (metadataOnly || !info.publicPlaybackAvailable) return { info, mediaUrl: null, vids: detail.vid_list };
  if (typeof detail.vid_list[episode - 1] !== 'string' || data.vid !== detail.vid_list[episode - 1]) {
    throw new Error('官网返回的播放集与请求不一致；没有下载其他集');
  }
  if (data.protectedPlayback !== undefined && typeof data.protectedPlayback !== 'boolean') throw new Error('官网播放格式标记无效');
  const seo = data.publicVideoSeo;
  if (seo !== undefined) {
    if (!seo || typeof seo !== 'object' || Array.isArray(seo) || typeof seo.available !== 'boolean'
      || seo.seriesId !== requestedSeriesId || seo.itemId !== data.vid) throw new Error('官网公开播放元数据与请求集不一致');
    if (!seo.available) return { info: { ...info, publicPlaybackAvailable: false }, mediaUrl: null, vids: detail.vid_list };
    if (typeof seo.durationSeconds !== 'number' || !Number.isFinite(seo.durationSeconds) || seo.durationSeconds <= 0) {
      throw new Error('公开集视频时长无效');
    }
  }
  if (data.protectedPlayback === true) {
    if (seo === undefined) {
      if (route !== itemRoute || episode === 1) throw new Error('官网公开播放元数据缺失');
      return { info, mediaUrl: null, publicFallback: { itemId: data.vid }, vids: detail.vid_list };
    }
    info.durationSeconds = seo.durationSeconds;
    return { info, mediaUrl: null, publicFallback: { itemId: seo.itemId }, vids: detail.vid_list };
  }
  const video = data.video_player_info;
  if (typeof video?.main_url !== 'string' || !video.main_url) throw new Error('公开集没有可下载的视频地址');
  if (typeof video.duration !== 'number' || !Number.isFinite(video.duration) || video.duration <= 0) {
    throw new Error('公开集视频时长无效');
  }
  info.durationSeconds = video.duration;
  return { info, mediaUrl: video.main_url, vids: detail.vid_list };
}

/** Accept only the ordinary compatibility URL and an explicit successful official response, never protected track/key models. */
export function parsePublicPlayback(result, itemId) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const details = { sourceStage: 'video_model', retryable: false };
  const invalid = message => { throw new DownloadError('platform_json', message, details); };
  if (!record(result) || !record(result.base_resp) || !Object.hasOwn(result.base_resp, 'StatusCode')) {
    invalid('官网兼容播放响应缺少明确业务状态，未确认媒体可用');
  }
  const values = [result.base_resp.StatusCode];
  for (const name of ['code', 'Code', 'status_code']) if (Object.hasOwn(result, name)) values.push(result[name]);
  if (Object.hasOwn(result, 'BaseResp')) {
    if (!record(result.BaseResp) || !Object.hasOwn(result.BaseResp, 'StatusCode')) invalid('官网兼容播放业务状态格式无效');
    values.push(result.BaseResp.StatusCode);
  }
  const codes = values.map(value => typeof value === 'string' && /^-?\d+$/u.test(value) ? Number(value) : value);
  if (codes.some(code => !Number.isSafeInteger(code))) invalid('官网兼容播放业务错误码格式无效');
  const failures = [...new Set(codes.filter(code => code !== 0))];
  if (failures.length > 1) invalid('官网兼容播放返回相互冲突的错误码');
  if (failures.length > 0) throw new DownloadError('platform_error', '官网兼容播放返回业务错误；没有下载媒体，请勿立即重复请求',
    { ...details, upstreamCode: failures[0] });
  if (Object.hasOwn(result, 'item_id') && result.item_id !== itemId) invalid('官网兼容播放返回了其他集的数据');
  if (['key', 'player_access_key', 'kid', 'play_info', 'drm', 'license', 'key_server',
    'spade', 'spade_a', 'encrypt_info', 'encryption', 'audio', 'audio_url', 'dash', 'video_list', 'video_model']
    .some(field => result[field] !== undefined && result[field] !== null && result[field] !== false)) {
    throw new DownloadError('unsupported_public_playback', '官网兼容播放没有返回普通单文件媒体；不会使用保护、密钥或分离音视频信息', details);
  }
  if (Object.hasOwn(result, 'url_expire') && (typeof result.url_expire !== 'number' || !Number.isFinite(result.url_expire) || result.url_expire < 0)) {
    invalid('官网兼容播放的有效期字段格式无效');
  }
  if (typeof result.main_url !== 'string' || !result.main_url || result.main_url.trim() !== result.main_url) {
    throw new DownloadError('missing_episode_url', '官网兼容播放没有返回可下载的普通媒体地址', details);
  }
  let url;
  try { url = new URL(result.main_url); }
  catch (error) { void error; invalid('官网兼容播放媒体地址格式无效'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new DownloadError('unsafe_url', '官网兼容播放没有返回无身份信息的 HTTPS 媒体地址', details);
  }
  return result.main_url;
}
