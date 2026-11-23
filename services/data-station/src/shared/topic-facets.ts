import type { Topic, TopicFacets, Work } from './types.ts';

/** Display order and labels of topic groups. */
export const TOPIC_GROUPS: Record<string, string> = {
  era: '时代与背景', setting: '核心设定', plot: '剧情与爽点', relationship: '情感与关系', identity: '角色与身份', style: '类型与风格', other: '待分类',
};

/**
 * Counts topics once per work within the supplied scope; a work without topics counts as 待分类.
 * @param works Works in scope.
 * @param topicsOf Returns a work's topics; defaults to its stored topics.
 * @returns Groups in display order, each with its topics by count.
 */
export function buildTopicFacets(works: Work[], topicsOf: (work: Work) => Topic[] = work => work.topics ?? []): TopicFacets {
  const counts = new Map<string, { id: string; label: string; group: string; count: number }>();
  for (const work of works) {
    const topics = topicsOf(work);
    if (!topics.length) {
      const unknown = counts.get('unclassified') ?? { id: 'unclassified', label: '待分类', group: 'other', count: 0 };
      unknown.count++; counts.set(unknown.id, unknown);
    }
    for (const topic of topics) {
      const entry = counts.get(topic.id) ?? { id: topic.id, label: topic.label, group: topic.group, count: 0 };
      entry.count++; counts.set(topic.id, entry);
    }
  }
  return { groups: Object.entries(TOPIC_GROUPS).flatMap(([id, label]) => {
    const items = [...counts.values()].filter(item => item.group === id).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN')).map(({ id: key, label: name, count }) => ({ id: key, label: name, count }));
    return items.length ? [{ id, label, items }] : [];
  }) };
}
