/** Official Hongguo SSR player JSON; page JavaScript is never executed. */
export const ORIGIN = 'https://hongguoduanju.com';

/** Validate a decimal series id without converting it to a JavaScript number. */
export function seriesId(value) {
  if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) throw new Error('seriesId 必须是十进制字符串 ID');
  return value;
}

/** Validate a positive episode number at the model input boundary. */
export function episodeNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000) throw new Error('episode 必须是 1–10000 的整数');
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

/** Resolve only the requested publicly accessible episode; never substitute episode 1. */
export function parsePlayer(html, requestedSeriesId, episode) {
  seriesId(requestedSeriesId);
  episodeNumber(episode);
  const data = routerData(html)?.loaderData?.['player_(series_id)/page'];
  const detail = data?.seriesDetail;
  if (data?.isSuccess !== true || data.series_id !== requestedSeriesId || detail?.series_id !== requestedSeriesId) {
    throw new Error('官网没有返回请求的剧集；页面可能已改变或访问受限');
  }
  const count = detail.episode_cnt, accessible = detail.accessible_episode_cnt;
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(accessible) || accessible < 0 || accessible > count
    || typeof detail.series_name !== 'string' || !detail.series_name.trim() || !Array.isArray(detail.vid_list)) {
    throw new Error('官网剧集数据字段无效');
  }
  if (episode > count) throw new Error(`此剧共有 ${count} 集，没有第 ${episode} 集`);
  const info = {
    seriesId: requestedSeriesId, title: detail.series_name, episode,
    episodeCount: count, accessibleEpisodeCount: accessible,
    publicPlaybackAvailable: episode <= accessible,
    sourceUrl: `${ORIGIN}/player/${requestedSeriesId}${episode === 1 ? '' : `/${episode}`}`,
    durationSeconds: null,
  };
  if (!info.publicPlaybackAvailable) return { info, mediaUrl: null };
  if (typeof detail.vid_list[episode - 1] !== 'string' || data.vid !== detail.vid_list[episode - 1]) {
    throw new Error('官网返回的播放集与请求不一致；没有下载其他集');
  }
  const video = data.video_player_info;
  if (typeof video?.main_url !== 'string' || !video.main_url) throw new Error('公开集没有可下载的视频地址');
  if (typeof video.duration !== 'number' || !Number.isFinite(video.duration) || video.duration <= 0) {
    throw new Error('公开集视频时长无效');
  }
  info.durationSeconds = video.duration;
  return { info, mediaUrl: video.main_url };
}
