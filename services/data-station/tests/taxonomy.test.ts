import { describe, expect, it } from 'vitest';
import { classifyTopics, buildTopicFacets } from '../src/server/taxonomy.ts';
import { createDemoWorks } from '../src/server/seed.ts';

describe('evidence-backed story categories', () => {
  it('extracts fine topics from explicit platform tags and story text', () => {
    const result = classifyTopics({ title: '重生1988：携系统打脸逆袭', description: '女主穿越古代，靠种田经商致富。', tags: ['穿越', '甜宠'] });
    expect(result.map(topic => topic.id)).toEqual(expect.arrayContaining(['eighties', 'rebirth', 'system', 'revenge-rise', 'time-travel', 'farming', 'business', 'sweet']));
    expect(result.find(topic => topic.id === 'time-travel')).toMatchObject({ source: 'platform', evidence: '穿越' });
    expect(result.find(topic => topic.id === 'system')?.evidence).toContain('系统');
  });

  it('does not turn episode counts, money or everyday returns into eras and rebirth', () => {
    for (const title of ['80集短剧合集', '把一家七零八落的公司救回来', '1988万元收入', '重返1988万元投资现场', '重回故乡开书店']) {
      expect(classifyTopics({ title, description: '', tags: [] }).filter(topic => ['eighties', 'seventies', 'nineties', 'rebirth'].includes(topic.id)), title).toEqual([]);
    }
  });

  it('skips negative claims but finds later affirmative evidence', () => {
    expect(classifyTopics({ title: '无系统、无重生、无穿越的普通人生', description: '', tags: ['无系统', '非重生'] })).toEqual([]);
    const result = classifyTopics({ title: '不是重生', description: '没有系统，后来却穿越到了古代。', tags: [] });
    expect(result.map(topic => topic.id)).not.toContain('rebirth');
    expect(result.map(topic => topic.id)).not.toContain('system');
    expect(result.map(topic => topic.id)).toContain('time-travel');
  });

  it('counts each matching work and leaves uncertain works unclassified', () => {
    const base = createDemoWorks(new Date().toISOString())[0]!;
    const works = [{ ...base, title: '八零系统人生', description: '', tags: ['系统'] }, { ...base, id: 'unknown', title: '一封信', description: '一个人的生活。', tags: [] }];
    const groups = buildTopicFacets(works).groups;
    expect(groups.flatMap(group => group.items).find(item => item.id === 'system')?.count).toBe(1);
    expect(groups.flatMap(group => group.items).find(item => item.id === 'unclassified')?.count).toBe(1);
  });
});
