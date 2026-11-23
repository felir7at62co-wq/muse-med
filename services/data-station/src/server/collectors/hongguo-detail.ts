/** Reads one public Hongguo detail page: counts, completion status and cast, without cookies or page scripts. */
import { z } from 'zod';
import { readHongguoHtml } from './hongguo.ts';
import { ORIGIN, routeData } from './hongguo-parser.js';

const count = z.union([z.string().regex(/^\d{1,16}$/), z.number().int().nonnegative().safe()]).transform(Number).refine(Number.isSafeInteger);
const detailSchema = z.object({
  isSuccess: z.literal(true),
  seriesDetail: z.object({
    series_id: z.string(),
    series_name: z.string().nullish(),
    series_intro: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
    episode_cnt: z.number().int().nonnegative().nullish(),
    episode_right_text: z.string().max(100).nullish(),
    series_episode_info: z.object({
      episode_cnt: z.number().int().nonnegative().nullish(),
      episode_total_cnt: z.number().int().nonnegative().nullish(),
      series_status: z.number().int().nullish(),
    }).nullish(),
    celebrities: z.array(z.object({ nickname: z.string().max(100).nullish(), sub_title: z.string().max(100).nullish() })).max(200).nullish(),
  }),
  seriesSocialInfo: z.object({ series_favorite_count: count.nullish(), series_like_count: count.nullish(),
    hot_score_data: z.object({ score: count }).nullish(),
    // A malformed rating or review count leaves that one value unknown instead of failing the whole reading.
    rating: z.number().min(0).max(10).nullish().catch(null), rating_count: count.nullish().catch(null),
    reviews: z.object({ total_count: count }).nullish().catch(null) }),
});

/** Facts of one detail page; missing source fields stay null. */
export interface HongguoDetail {
  seriesId: string;
  title: string | null;
  description: string | null;
  tags: string[];
  /** Raw `series_episode_info.series_status`; its meaning is configured by the selection rules. */
  seriesStatus: number | null;
  /** Source text beside the episode count, e.g. 「全63集」. */
  episodeRightText: string | null;
  episodeCount: number | null;
  /** Cast as listed: actor name and the character from 「饰 柳如意」. */
  cast: { actor: string | null; role: string | null }[];
  heat: number | null;
  collection: number | null;
  likes: number | null;
  /** 0–10 audience rating. */
  rating: number | null;
  ratingCount: number | null;
  /** Total reviews the page reports; the page itself carries only a few of them. */
  reviewCount: number | null;
  measuredAt: string;
}

/** HTTP limits and optional test transport. */
export interface HongguoDetailOptions {
  requestTimeoutMs: number;
  maxResponseBytes: number;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

/**
 * Parses a detail page's route data. Reviews and recommendations may still be streaming when the page ends;
 * the series and its counts must be present.
 * @throws When the page is not this series or its data no longer matches.
 */
export function parseHongguoDetail(html: string, seriesId: string, measuredAt: string): HongguoDetail {
  const data = detailSchema.parse(routeData(html, 'detail_page', { allowPending: true }));
  const detail = data.seriesDetail;
  if (detail.series_id !== seriesId) throw new Error('Hongguo detail identity differs from the request');
  const social = data.seriesSocialInfo;
  const info = detail.series_episode_info;
  return {
    seriesId, title: detail.series_name?.trim() || null, description: detail.series_intro ?? null, tags: detail.tags ?? [],
    seriesStatus: info?.series_status ?? null, episodeRightText: detail.episode_right_text ?? null,
    episodeCount: info?.episode_total_cnt ?? info?.episode_cnt ?? detail.episode_cnt ?? null,
    cast: (detail.celebrities ?? []).map(person => ({ actor: person.nickname?.trim() || null,
      role: person.sub_title?.replace(/^\s*饰\s*/u, '').trim() || null })),
    heat: social.hot_score_data?.score ?? null, collection: social.series_favorite_count ?? null, likes: social.series_like_count ?? null,
    rating: social.rating ?? null, ratingCount: social.rating_count ?? null, reviewCount: social.reviews?.total_count ?? null,
    measuredAt,
  };
}

/**
 * Fetches and parses one official detail page.
 * @returns The page facts, or null when the source answers 404 for this series.
 * @throws When the page is unavailable, redirected, too large or no longer matches.
 */
export async function readHongguoDetail(seriesId: string, options: HongguoDetailOptions, signal: AbortSignal): Promise<HongguoDetail | null> {
  if (!/^\d{1,30}$/.test(seriesId)) throw new TypeError('Not a Hongguo series ID');
  const fetchPage = options.fetch ?? globalThis.fetch;
  const url = new URL(`/detail?series_id=${seriesId}`, ORIGIN);
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs)]);
  const response = await fetchPage(url, { method: 'GET', redirect: 'error', credentials: 'omit', signal: requestSignal,
    headers: { accept: 'text/html', 'user-agent': 'MuseDataPreview/0.1 (+public drama metrics reader)' } });
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok || response.redirected || (response.url && response.url !== url.href)
    || !response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
    await response.body?.cancel();
    throw new Error(`Hongguo detail page unavailable (HTTP ${response.status})`);
  }
  const html = await readHongguoHtml(response, options.maxResponseBytes);
  return parseHongguoDetail(html, seriesId, (options.now ?? (() => new Date()))().toISOString());
}
