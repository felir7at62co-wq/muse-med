import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_HIT_RULES, loadHitRules, resolveHitRules } from '../src/server/hits/rules.ts';
import { directionsHit, evaluateSink } from '../src/server/hits/sink.ts';
import { FanqieIpIndex, extractNames, mainTitle, normalizeTitle } from '../src/server/hits/ip-match.ts';
import { completionOf } from '../src/server/hits/selector.ts';
import { parseHongguoDetail } from '../src/server/collectors/hongguo-detail.ts';
import { createServiceIdentity, loadServiceIdentity, SERVICE_TOKEN_HEADER } from '../src/server/hits/service-auth.ts';
import { checkDouyinTopic } from '../src/server/hits/douyin-topic.ts';
import { DouyinSearchError } from '../src/server/douyin-search.ts';
import type { Work } from '../src/shared/types.ts';

const sink = DEFAULT_HIT_RULES.sink;
const input = (title: string, tags: string[] = [], description = '') => ({ title, tags, category: '', description });

describe('下沉 rules ported from collect_picks.py', () => {
  it('scores like sink_score: tables, strong bonus, block penalty and direction bonus', () => {
    // 种田 (S_SINK 3 + strong 2), 重生 (S_MODES 3), 年代文 via 七零 (+3).
    const result = evaluateSink(input('重生七零种田记', ['种田']), sink);
    expect(result).toMatchObject({ qualifies: true, blocked: false, score: 11, strongHits: ['种田'], directions: ['年代文'] });
  });

  it('blocks a hard-flaw topic unless a strong 下沉 tag is present (is_blocked)', () => {
    expect(evaluateSink(input('诡案', ['悬疑', '惊悚']), sink)).toMatchObject({ qualifies: false, blocked: true, blockHits: ['惊悚', '悬疑'] });
    const rescued = evaluateSink(input('诡案', ['悬疑', '逆袭']), sink);
    expect(rescued.blocked).toBe(false);
    expect(rescued.score).toBe(1); // 逆袭 2+2, 悬疑 -3
    expect(rescued.qualifies).toBe(true);
    // A hard-flaw word inside the description also blocks, case-insensitively.
    expect(evaluateSink(input('都市', [], '一场规则怪谈'), sink).blocked).toBe(true);
  });

  it('needs a strong tag or one of the chosen directions', () => {
    expect(evaluateSink(input('星辰大海', ['都市']), sink).qualifies).toBe(false);
    expect(evaluateSink(input('婆婆来了', ['家庭']), sink)).toMatchObject({ qualifies: true, directions: ['争议文/婆媳'] });
  });

  it('lets well-known material in through the 典故/关注度 direction added on 2026-11-15', () => {
    const legend = evaluateSink(input('白蛇新传', ['古装', '爱情'], '民间传说里的白素贞重回人间。'), sink);
    expect(legend).toMatchObject({ qualifies: true, strongHits: [], directions: ['典故/关注度'] });
    expect(evaluateSink(input('三国新说', ['历史'], '家喻户晓的历史故事。'), sink).directions).toEqual(['典故/关注度']);
    expect(evaluateSink(input('星辰大海', ['都市']), sink).qualifies).toBe(false);
    expect(DEFAULT_HIT_RULES.review.standard).toContain('历史典故、民间传说、神话、名著故事');
  });

  it('ignores a direction keyword right after 不/非/无, like directions_hit', () => {
    expect(directionsHit(input('非系统流', []), sink)).toEqual([]);
    expect(directionsHit(input('非系统流，系统来了', []), sink)).toEqual(['系统脑洞']);
  });

  it('applies overrides key by key and replaces word tables as a whole', () => {
    const rules = resolveHitRules({ minCollection: 50_000, sink: { strong: ['都市'], minScore: 5 }, queue: { leaseMinutes: 10 } });
    expect(rules.minCollection).toBe(50_000);
    expect(rules.sink.strong).toEqual(['都市']);
    expect(rules.sink.block).toEqual(DEFAULT_HIT_RULES.sink.block);
    expect(rules.queue).toMatchObject({ leaseMinutes: 10, maxAttempts: 2 });
    expect(() => resolveHitRules({ minCollection: -1 })).toThrow();
    expect(() => resolveHitRules({ unknown: true })).toThrow();
  });

  it('loads a rule file only from a regular absolute file', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'hit-rules-')));
    try {
      const file = join(directory, 'rules.json');
      await writeFile(file, JSON.stringify({ minCollection: 200000 }));
      expect((await loadHitRules(file)).minCollection).toBe(200_000);
      expect((await loadHitRules()).minCollection).toBe(100_000);
      await symlink(file, join(directory, 'link.json'));
      await expect(loadHitRules(join(directory, 'link.json'))).rejects.toThrow();
      await expect(loadHitRules('relative.json')).rejects.toThrow(/absolute/);
      await writeFile(file, '{"minCollection":"x"}');
      await expect(loadHitRules(file)).rejects.toThrow(/minCollection/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('Hongguo detail completion and cast', () => {
  const page = (detail: Record<string, unknown>) => `<html><script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { detail_page: {
    isSuccess: true, seriesDetail: { series_id: '7001', series_name: '剧', ...detail }, seriesSocialInfo: { series_favorite_count: '3189000' } } } })}</script></html>`;

  it('reads status, episode count and roles from 「饰 角色」', () => {
    const detail = parseHongguoDetail(page({ episode_right_text: '全63集', series_episode_info: { episode_cnt: 63, episode_total_cnt: 63, series_status: 1 },
      celebrities: [{ nickname: '张艳', sub_title: '饰 柳如意' }, { nickname: '无角色' }] }), '7001', '2026-11-15T00:00:00.000Z');
    expect(detail).toMatchObject({ seriesStatus: 1, episodeCount: 63, collection: 3_189_000, cast: [{ actor: '张艳', role: '柳如意' }, { actor: '无角色', role: null }] });
    expect(completionOf(detail, DEFAULT_HIT_RULES)).toBe('completed');
  });

  it('treats status 0 as 连载 even with 「全N集」 and falls back to explicit text only', () => {
    const base = parseHongguoDetail(page({}), '7001', '2026-11-15T00:00:00.000Z');
    expect(completionOf({ ...base, seriesStatus: 0, episodeRightText: '全60集' }, DEFAULT_HIT_RULES)).toBe('serial');
    expect(completionOf({ ...base, episodeRightText: '全60集' }, DEFAULT_HIT_RULES)).toBeNull();
    expect(completionOf({ ...base, episodeRightText: '更新至30集' }, DEFAULT_HIT_RULES)).toBe('serial');
    expect(completionOf({ ...base, seriesStatus: 7 }, DEFAULT_HIT_RULES)).toBeNull();
    expect(completionOf({ ...base, seriesStatus: 7 }, resolveHitRules({ completion: { completedStatuses: [7], serialStatuses: [] } }))).toBe('completed');
    expect(() => parseHongguoDetail(page({}), '7002', '2026-11-15T00:00:00.000Z')).toThrow('identity');
  });
});

function fanqie(sourceId: string, title: string, description: string): Work {
  return { id: `fanqie:${sourceId}`, sourceId, platform: 'fanqie', kind: 'novel', title, author: '作者', description, coverUrl: null,
    sourceUrl: 'https://fanqienovel.com/', tags: [], category: '', episodeCount: null, wordCount: null, serialStatus: null, publishedAt: null,
    metrics: [], rank: null, rankChange: null, board: '', origin: 'live', observedAt: '2026-11-14T00:00:00.000Z', sourceUpdatedAt: null };
}

describe('Fanqie IP matching', () => {
  const catalog = [
    fanqie('1', '契约到期，傅总追妻火葬场', '傅承彦与温越的契约婚姻走到尽头。温越远走他乡，傅承彦追悔莫及。'),
    fanqie('2', '装穷提亲', '一个装穷的男人去提亲。'),
    fanqie('3', '挖掘机之王', '赵志华开挖掘机养家的故事。'),
    fanqie('4', '别的书', '与本剧无关。'),
    ...Array.from({ length: 30 }, (_, index) => fanqie(String(100 + index), `常见词小说${index}`, '时间过得很快，林家的人都来了。')),
  ];
  const index = new FanqieIpIndex(catalog, DEFAULT_HIT_RULES.ip);
  const drama = (title: string, description: string, roles: string[] = []) => index.match({ title, description, roles });

  it('normalizes titles and finds repeated character names', () => {
    expect(normalizeTitle('重生！丑小鸭第五季')).toBe('重生丑小鸭');
    expect(mainTitle('反向拿捏2：和闺蜜穿七零')).toBe('反向拿捏');
    expect(extractNames('傅承彦和温越定下婚约，温越远走。傅承彦后悔。林家的人来了，林家散了。')).toEqual(['傅承彦', '温越']);
  });

  it('confirms an adaptation by two shared distinctive names', () => {
    const result = drama('总裁的契约新娘', '傅承彦和温越被迫定下婚约，温越远赴山区。傅承彦强行带回温越。');
    expect(result).toMatchObject({ level: 'confirmed', fanqieWorkId: 'fanqie:1' });
    expect(result.reasons.join()).toContain('共同人物：傅承彦、温越');
  });

  it('confirms through a 《》 citation or a same title with a shared cast role', () => {
    expect(drama('新剧名', '改编自小说《装穷提亲》。')).toMatchObject({ level: 'confirmed', fanqieWorkId: 'fanqie:2' });
    expect(drama('挖掘机之王', '一个男人的奋斗。', ['赵志华'])).toMatchObject({ level: 'confirmed', fanqieWorkId: 'fanqie:3' });
  });

  it('labels a title-only match as suspected and ignores names common across the catalog', () => {
    expect(drama('装穷提亲，娶到全家嫌弃的她', '顾承川装穷提亲，娶了林小满。')).toMatchObject({ level: 'suspected', fanqieWorkId: 'fanqie:2' });
    expect(drama('完全原创', '时间来到林家，时间不多，林家人着急。', ['林家'])).toMatchObject({ level: 'none' });
  });
});

describe('service identity', () => {
  it('accepts the token as a bearer or the dedicated header and nothing else', () => {
    const service = createServiceIdentity('a'.repeat(40));
    const call = (headers: Record<string, string>) => service.verify(new Request('http://127.0.0.1/', { headers }));
    expect(call({ authorization: `Bearer ${'a'.repeat(40)}` })).toBe(true);
    expect(call({ [SERVICE_TOKEN_HEADER]: 'a'.repeat(40) })).toBe(true);
    expect(call({ authorization: `Bearer ${'b'.repeat(40)}` })).toBe(false);
    expect(call({ cookie: `token=${'a'.repeat(40)}` })).toBe(false);
    expect(() => createServiceIdentity('short')).toThrow();
  });

  it('reads the token only from a private regular file', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'hit-token-')));
    try {
      const file = join(directory, 'token');
      await writeFile(file, `${'c'.repeat(48)}\n`, { mode: 0o600 });
      await chmod(file, 0o600);
      expect((await loadServiceIdentity(file)).verify(new Request('http://x/', { headers: { authorization: `Bearer ${'c'.repeat(48)}` } }))).toBe(true);
      await chmod(file, 0o644);
      await expect(loadServiceIdentity(file)).rejects.toThrow(/private regular file/);
      await expect(loadServiceIdentity('token')).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('hit loop configuration', () => {
  it('reads the token and rule file paths and the selection schedule from the environment', async () => {
    const { resolveConfig } = await import('../src/server/config.ts');
    const config = resolveConfig({ MUSE_DATA_SERVICE_TOKEN_FILE: '/srv/muse-data-web/access/service-token', MUSE_DATA_HIT_INTERVAL_MINUTES: '30', MUSE_DATA_HIT_ENABLED: '0' });
    expect(config).toMatchObject({ serviceTokenFile: '/srv/muse-data-web/access/service-token', hitIntervalMs: 1_800_000, hitEnabled: false, hitRulesFile: undefined });
    expect(resolveConfig({}).hitEnabled).toBe(true);
    expect(() => resolveConfig({ MUSE_DATA_SERVICE_TOKEN_FILE: 'service-token' })).toThrow(/absolute/);
    expect(() => resolveConfig({ MUSE_DATA_HIT_RULES_FILE: '/a/../rules.json' })).toThrow(/absolute/);
  });
});

describe('Douyin topic check', () => {
  const now = () => '2026-11-15T10:00:00.000Z';
  const options = { minPlays: 50_000_000, searchCount: 20, now };
  const post = (tags: [string, string][]) => ({ content_id: '7570000000000000001', raw: { text_extra: tags.map(([hashtag_id, hashtag_name]) => ({ hashtag_id, hashtag_name })) } });

  it('takes only the exact-name topic, not its 后续/完整版/季 variants, and compares its views with the threshold', async () => {
    const calls: string[] = [];
    const reader = { read: async (path: string, query: Record<string, string>) => {
      calls.push(`${path}:${query.keyword ?? query.hashtag_id}`);
      if (path === 'search/posts') return { items: [post([['111', '谁让这个文盲修仙的第六季'], ['222', '谁让这个文盲修仙的后续']]), post([['333', '谁让这个 文盲修仙的！']])] };
      return { hashtag_name: '谁让这个文盲修仙的', view_count: 244_000_000, content_count: '5300' };
    } };
    expect(await checkDouyinTopic(reader, '谁让这个文盲修仙的', options)).toMatchObject({ state: 'pass', hashtagId: '333', viewCount: 244_000_000, postCount: 5300, manual: false });
    expect(calls).toEqual(['search/posts:谁让这个文盲修仙的', 'hashtag:333']);
    const below = { read: async (path: string) => path === 'search/posts' ? { items: [post([['444', '万物有声鉴宝天骄']])] } : { view_count: 875_000 } };
    expect(await checkDouyinTopic(below, '万物有声鉴宝天骄', options)).toMatchObject({ state: 'below', viewCount: 875_000 });
    const exact = { read: async (path: string) => path === 'search/posts' ? { items: [] } : { view_count: 50_000_000 } };
    expect(await checkDouyinTopic(exact, '剧', { ...options, hashtagId: '555', manual: true })).toMatchObject({ state: 'below', hashtagId: '555', manual: true });
  });

  it('reports not_found without an exact topic and error on DTK failures', async () => {
    const none = { read: async () => ({ items: [post([['111', '别的剧']])] }) };
    expect(await checkDouyinTopic(none, '无限白粥，朕可是忠臣啊', options)).toMatchObject({ state: 'not_found', hashtagId: null, viewCount: null });
    const limited = { read: async () => { throw new DouyinSearchError('抖音搜索太频繁，请稍等一会儿再试', 429); } };
    expect(await checkDouyinTopic(limited, '剧名', { ...options, hashtagId: '666' })).toMatchObject({ state: 'error', hashtagId: '666', error: '抖音搜索太频繁，请稍等一会儿再试' });
    const blank = { read: async (path: string) => path === 'search/posts' ? { items: [post([['777', '剧名']])] } : {} };
    expect(await checkDouyinTopic(blank, '剧名', options)).toMatchObject({ state: 'error', error: '话题没有返回播放量' });
  });
});
