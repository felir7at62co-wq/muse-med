import type { Metric, Platform, Work } from '../shared/types.ts';

/** Platforms with fictional preview records; 绿泡泡 starts without demo data. */
type DemoPlatform = Exclude<Platform, 'lvpaopao'>;
const titles: Record<DemoPlatform, string[]> = {
  hongguo: ['重返八零，风从小城来', '长街灯火等你归', '她从星河归来', '小厨娘的逆风人生', '山海之间有故人', '春风不负少年时', '我在大唐开书店', '雨过天青见故人', '满城烟火为你亮', '归途有光'],
  douyin: ['纸上山海', '白夜来信', '大荒第一修理铺', '时光杂货店', '长安有个小神仙', '重启人生的第七天', '故城风云录', '月光里的第九封信', '末日种田手册', '星际便利店'],
  fanqie: ['穿过夏天的风', '从小镇书屋开始', '青山之外是人间', '我在古代研究美食', '她的第二次春天', '荒野求生从种田开始', '长安烟雨录', '末世里的小小农场', '在星海深处相遇', '重生后我选择慢生活'],
  qimao: ['青瓦巷口的时光', '山河旧梦', '风起时正少年', '一间小店通古今', '她与山海共长青', '穿越后我修复古籍', '向着光的方向', '重回故乡开农场', '星河之外的答案', '人间烟火正当时'],
};
const sources: Record<DemoPlatform, string> = {
  hongguo: 'https://www.hongguo.com/', douyin: 'https://www.douyin.com/',
  fanqie: 'https://fanqienovel.com/', qimao: 'https://www.qimao.com/',
};
const categories = ['年代', '都市情感', '奇幻脑洞', '逆袭成长', '古风', '青春', '种田经营', '悬疑'];

/** Builds explicitly fictional preview records without claiming platform coverage. */
export function createDemoWorks(observedAt: string, dayIndex = 6): Work[] {
  return (Object.keys(titles) as DemoPlatform[]).flatMap((platform, platformIndex) =>
    titles[platform].map((title, i): Work => {
      const novel = platform === 'fanqie' || platform === 'qimao';
      const base = 5_750_000 - i * 365_000 + platformIndex * 117_000;
      const factor = 1 + dayIndex * (i % 3 === 0 ? 0.045 : 0.012);
      const metrics: Metric[] = platform === 'hongguo'
        ? [{ key: 'heat', label: '热度值', value: Math.round(base * factor) }, { key: 'collection', label: '收藏', value: Math.round(base * factor * 0.063) }]
        : platform === 'douyin'
          ? [{ key: 'play', label: '播放', value: Math.round(base * factor * 5) }, { key: 'likes', label: '点赞', value: Math.round(base * factor * 0.13) }, { key: 'share', label: '分享', value: i === 3 ? null : Math.round(base * factor * 0.004) }]
          : [{ key: 'readers', label: '在读人数', value: platform === 'qimao' ? null : Math.round(base * factor * 0.041) }, { key: 'score', label: '评分', value: Math.round((8.4 + i % 6 * 0.1) * 10) / 10 }];
      return {
        id: `demo-${platform}-${i + 1}`, sourceId: `demo-${i + 1}`,
        platform, kind: novel ? 'novel' : 'drama', title,
        author: `${['云间', '拾光', '青禾', '山月', '南风'][i % 5]}${novel ? '（示例作者）' : '影业（示例）'}`,
        description: `【虚构示例】${title}：一段关于成长、选择和重新出发的故事。主人公在生活的转折处发现新的可能，在困境中寻找自己的答案。本作品及所有展示指标仅用于体验界面，不代表真实平台数据。`,
        coverUrl: null, sourceUrl: sources[platform],
        tags: [categories[i % categories.length]!, ['女性成长', '温暖治愈', '强情节', '东方幻想'][i % 4]!],
        category: categories[i % categories.length]!,
        episodeCount: novel ? null : 60 + i * 4,
        wordCount: novel ? 250_000 + i * 81_000 : null,
        serialStatus: novel ? i % 3 === 0 ? '连载中' : '已完结' : '已完结',
        publishedAt: new Date(Date.parse(observedAt) - (i + 5) * 86_400_000).toISOString(),
        metrics, rank: Math.max(1, i + 1 + (6 - dayIndex) * (i % 3 === 0 ? 1 : 0)),
        rankChange: null, board: novel ? '新书榜（示例）' : '热播榜（示例）',
        origin: 'demo', observedAt, sourceUpdatedAt: null,
      };
    }),
  );
}
