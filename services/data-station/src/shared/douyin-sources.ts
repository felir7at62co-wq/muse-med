import type { ManagedDouyinSource } from './types.ts';

/** Bounds administrator-maintained sources and the collector's per-attempt work. */
export const MAX_DOUYIN_SOURCES = 32;

const excluded = ['教程', '教学', '直播', '带货', '福利', '拍摄花絮', '制作流程', '全流程', '测评'];
const presetDate = '2026-11-13T00:00:00.000Z';

type SourcePreset = Pick<ManagedDouyinSource, 'videoId' | 'expectedAuthor' | 'expectedAuthorId' | 'includeKeywords' | 'excludeKeywords'>
  & Partial<Pick<ManagedDouyinSource, 'label' | 'mode' | 'maxVideos'>>;

const presets: readonly SourcePreset[] = [
  { videoId: '7548688130618953001', expectedAuthor: '龙王动漫剧场', expectedAuthorId: '1517806160971176', includeKeywords: [], excludeKeywords: excluded },
  { videoId: '7614503414332899685', expectedAuthor: '司康Sikang', expectedAuthorId: '95569863196', includeKeywords: ['短片', '原创', '剧集', '野怪', '双探', '士兵传奇', '金丹跑了'], excludeKeywords: [...excluded, '分享', 'skill', '技巧', '工作流', '保姆级'] },
  { videoId: '7634848601440619803', expectedAuthor: 'KOD行空幻象', expectedAuthorId: '752490098985358', includeKeywords: ['傩狩司', '封妖录', '特摄'], excludeKeywords: [...excluded, '企划', '玩具', '周边'] },
  { videoId: '7605637828249550842', expectedAuthor: '泽叔', expectedAuthorId: '105090863518', includeKeywords: ['山海裂天志', '山海猎天志', '山海镇兽录', '短剧'], excludeKeywords: [...excluded, '澄清', '侵权', '下架'] },
  { videoId: '7608492911897908618', expectedAuthor: '光波', expectedAuthorId: '66736517186', includeKeywords: ['【归尘】第', '归尘 第', '【熔神】'], excludeKeywords: [...excluded, '同名歌曲', '主题曲', '深拆'] },
  { videoId: '7608009641208876326', expectedAuthor: '屿竹影像', expectedAuthorId: '2461181859866515', includeKeywords: ['寒尸录', '神豹奇缘', '赫尔墨斯号', '北境裂痕'], excludeKeywords: excluded },
  { videoId: '7616690487881223433', expectedAuthor: '小导牛敢', expectedAuthorId: '68237278874', includeKeywords: ['硅基纪元', '第一集', '第二集', '第三集', '第四集'], excludeKeywords: excluded },
  { videoId: '7623785542903720805', expectedAuthor: '似翁', expectedAuthorId: '91615391212', includeKeywords: ['黄河滩人鱼传说', '少年古来希', '桃花渡', '志异'], excludeKeywords: [...excluded, '测试片段'] },
  { videoId: '7640034737620290835', expectedAuthor: 'Fel', expectedAuthorId: '72716348933', label: 'Fel｜安宁大厦生存守则', maxVideos: 10, includeKeywords: ['安宁大厦生存守则'], excludeKeywords: excluded.filter(keyword => keyword !== '直播') },
  { videoId: '7127587821187091725', expectedAuthor: '姜十七', expectedAuthorId: '1754419881327491', label: '姜十七｜真人短剧', maxVideos: 10, includeKeywords: ['霸总', '老板', '实习生', '魂穿', '联姻', '夜枭', '任务', '王妃', '恶女'], excludeKeywords: [...excluded, '预告', '花絮'] },
  { videoId: '7650776473860157861', expectedAuthor: '悉尼年糕剧场', expectedAuthorId: '1401234657121292', label: '悉尼年糕剧场｜吸血鬼教授', maxVideos: 10, includeKeywords: ['吸血鬼教授把我挂科了', 'The Boy Who Raised Me Is Mine'], excludeKeywords: [...excluded, '番外', '高能集锦', '预告'] },
  { videoId: '7582252181152173338', expectedAuthor: '大吉AIGC', expectedAuthorId: '2911985306708039', label: '大吉AIGC｜孤月寻星及西游', maxVideos: 10, includeKeywords: ['孤月寻星', '西游记'], excludeKeywords: [...excluded, '预告', '主题曲', 'MV', '纪录片', '鉴赏', '人物传记'] },
  { videoId: '7683938190692076815', expectedAuthor: '云笺AI剧场', expectedAuthorId: '54969400977', label: '云笺AI剧场｜赤月挽歌', maxVideos: 10, includeKeywords: ['赤月挽歌'], excludeKeywords: [...excluded, '预告'] },
  { videoId: '7702679855258815794', expectedAuthor: 'AIGC KK', expectedAuthorId: null, label: 'AIGC KK｜蚀爱·美人鱼之死1-4合集', mode: 'video', maxVideos: 1, includeKeywords: [], excludeKeywords: excluded },
  { videoId: '7700904672520850751', expectedAuthor: '胡久AIGC', expectedAuthorId: null, label: '胡久AIGC｜晚星拾旧光1-5合集', mode: 'video', maxVideos: 1, includeKeywords: [], excludeKeywords: excluded },
  { videoId: '7640034737620290835', expectedAuthor: 'Fel', expectedAuthorId: '72716348933', label: 'Fel｜安宁大厦生存守则1-6合集', mode: 'video', maxVideos: 1, includeKeywords: [], excludeKeywords: [] },
  { videoId: '7682856139819112699', expectedAuthor: '悉尼年糕剧场', expectedAuthorId: '1401234657121292', label: '悉尼年糕｜吸血鬼教授第1集', mode: 'video', maxVideos: 1, includeKeywords: [], excludeKeywords: [] },
];

/** Verified creators and specific compilations; installed once without replacing saved administrator choices. */
export const DEFAULT_MANAGED_DOUYIN_SOURCES: readonly ManagedDouyinSource[] = presets.map(source => ({
  ...source, label: source.label ?? source.expectedAuthor, id: `seed-${source.mode === 'video' ? 'video-' : ''}${source.videoId}`, mode: source.mode ?? 'creator', enabled: true,
  maxVideos: source.maxVideos ?? 8, updatedAt: presetDate, validatedAt: null,
}));
