/**
 * Measures a Hongguo drama's Douyin reach by the view count of the Douyin topic (话题) whose name is exactly the drama title.
 * Douyin search returns zero plays for every post, so topics are the only usable play measure (verified 2026-11-15).
 * Variants such as 「…后续」「…完整版」「…第N季」 are not counted: seasons are separate Hongguo works with their own topics.
 */
import type { DouyinTopicCheck } from '../../shared/hits.ts';
import { DouyinSearchError, titleKey, type DtkReader } from '../douyin-search.ts';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function count(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) return Number(value);
  return null;
}
const hashtagId = (value: unknown): string | null => typeof value === 'string' && /^\d{1,32}$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;

/** A topic's counts from `GET /api/v1/douyin/hashtag?hashtag_id=`. */
export async function readHashtag(reader: Pick<DtkReader, 'read'>, id: string): Promise<{ name: string | null; viewCount: number | null; postCount: number | null }> {
  if (!/^\d{1,32}$/.test(id)) throw new DouyinSearchError('话题编号无效', 400);
  const data = record(await reader.read('hashtag', { hashtag_id: id }));
  const stats = record(data.stats);
  const name = typeof data.hashtag_name === 'string' ? data.hashtag_name : typeof data.name === 'string' ? data.name : typeof data.title === 'string' ? data.title : null;
  return { name, viewCount: count(data.view_count) ?? count(stats.view_count), postCount: count(data.content_count) ?? count(stats.content_count) };
}

/**
 * Searches posts for the title, takes the hashtag whose normalized name equals the normalized title, then reads its view count.
 * A known hashtag id (from an earlier check or a person) skips the search.
 * @param minPlays Views must be strictly greater than this to pass.
 * @returns `pass`, `below`, `not_found` or `error`; an error is never read as pass or below.
 */
export async function checkDouyinTopic(reader: Pick<DtkReader, 'read'>, title: string, options: { minPlays: number; searchCount: number; hashtagId?: string | null; manual?: boolean; now: () => string }): Promise<DouyinTopicCheck> {
  const base = { keyword: title, checkedAt: options.now(), manual: options.manual ?? false, error: null };
  try {
    let id = options.hashtagId ?? null;
    let name: string | null = null;
    if (!id) {
      const wanted = titleKey(title);
      const data = record(await reader.read('search/posts', { keyword: title, count: String(options.searchCount), include_raw: 'true' }));
      const items = Array.isArray(data.items) ? data.items : [];
      for (const item of items) {
        const extra = record(record(item).raw).text_extra;
        for (const tag of Array.isArray(extra) ? extra : []) {
          const tagName = record(tag).hashtag_name;
          const tagId = hashtagId(record(tag).hashtag_id);
          if (tagId && typeof tagName === 'string' && titleKey(tagName) === wanted) { id = tagId; name = tagName; break; }
        }
        if (id) break;
      }
      if (!id) return { ...base, state: 'not_found', topicName: null, hashtagId: null, viewCount: null, postCount: null };
    }
    const topic = await readHashtag(reader, id);
    if (topic.viewCount === null) return { ...base, state: 'error', topicName: topic.name ?? name, hashtagId: id, viewCount: null, postCount: topic.postCount, error: '话题没有返回播放量' };
    return { ...base, state: topic.viewCount > options.minPlays ? 'pass' : 'below', topicName: topic.name ?? name, hashtagId: id, viewCount: topic.viewCount, postCount: topic.postCount };
  } catch (error) {
    return { ...base, state: 'error', topicName: null, hashtagId: options.hashtagId ?? null, viewCount: null, postCount: null,
      error: error instanceof DouyinSearchError ? error.message : '抖音话题查询失败' };
  }
}
