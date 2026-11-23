/**
 * Selection thresholds and queue settings of the daily hit-transcription loop.
 * Every value has a default here and can be overridden by a private JSON file named in `MUSE_DATA_HIT_RULES_FILE`.
 */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { HitRuleSummary } from '../../shared/hits.ts';

/**
 * The user's 2026-10-19 下沉 rules, ported from `数据与选材/.work/collect_picks.py`; the 「典故/关注度」 direction was added on 2026-11-15
 * (`S_MODES`, `S_SINK`, `S_HARD`, `DIRECTIONS`, `SINK_STRONG`, `SINK_BLOCK`, `sink_score`, `directions_hit`, `is_blocked`).
 */
export const DEFAULT_SINK_RULES = {
  modes: { 穿越: 3, 重生: 3, 穿书: 3, 魂穿: 3, 系统: 3, 异世穿越: 3, 快穿: 2 } as Record<string, number>,
  sink: {
    种田: 3, 发家致富: 3, 空间: 2, 乡村: 2, 年代: 2, 基建: 2, 美食: 2,
    打脸: 2, 逆袭: 2, 扮猪吃虎: 2, 赘婿: 3, 战神: 2, 神医: 2, 医术: 2,
    萌宝: 2, 真假千金: 2, 宫斗宅斗: 1, 求生: 1, 末世: 1, 囤物资: 2,
    复仇: 1, 甜宠: 1, 豪门: 1, 高手下山: 2, 校花: 1, 致富: 3, 爽文: 1,
  } as Record<string, number>,
  hard: { 克苏鲁: -3, 无限流: -2, 规则怪谈: -2, 推理: -2, 群像: -1, 无CP: -1, 无后宫: -1, 网游: -2, 卡牌扮演: -2, 星际: -2 } as Record<string, number>,
  directions: {
    年代文: ['年代', '七零', '八零', '六零', '五零', '四合院', '下乡', '厂区', '知青', '供销社'],
    家长里短: ['家长里短', '婆家', '娘家', '分家', '妯娌', '亲戚', '邻里', '邻居', '姑嫂'],
    '争议文/婆媳': ['婆媳', '婆婆', '儿媳', '儿媳妇', '彩礼', '月子', 'AA', '复婚', '弃养', '偏心'],
    世情: ['世情', '豪门', '家族', '遗产', '拆迁', '原型', '算计', '人走茶凉'],
    新闻热点: ['新闻', '热点', '真实事件', '社会', '改编', '网暴', '反转'],
    甜宠马甲: ['甜宠', '马甲', '大佬', '宠妻', '闪婚', '隐婚', '身份', '总裁'],
    系统脑洞: ['系统', '脑洞', '签到', '抽奖', '模拟器', '扮演', '养成', '兑换', '面板'],
    // Added 2026-11-15, not in the 10-19 rules: well-known material brings its own attention. Recall is broad on purpose; the worker's 选材复核 rejects misfits.
    '典故/关注度': ['典故', '传说', '神话', '民间故事', '名著', '成语', '历史故事', '家喻户晓'],
  } as Record<string, string[]>,
  strong: ['种田', '年代', '发家致富', '致富', '赘婿', '逆袭', '打脸', '真假千金', '萌宝',
    '乡村', '空间', '囤物资', '高手下山', '扮猪吃虎', '神医', '都市脑洞', '甜宠',
    '虐渣', '家长里短', '厂区生活', '离婚', '婆媳', '亲子'],
  block: ['无限流', '克苏鲁', '规则怪谈', '群像', '群像剧', '无CP', '网游', '卡牌扮演',
    '星际', '智战', '微恐', '惊悚', '恐怖', '悬疑', '遗迹', '卡牌', '无女主',
    '玄幻', '修仙', '灵异', '游戏入侵', '求生', '盗墓'],
  /** `DIR_BONUS`: added per matched direction. */
  directionBonus: 3,
  /** Added per strong tag in `sink_score`. */
  strongBonus: 2,
  /** Subtracted per hard-flaw tag in `sink_score`. */
  blockPenalty: 3,
  /** A direction keyword right after one of these characters (「不系统」「非系统」) does not count. */
  negationPrefixes: ['不', '非', '无'],
  /** 「强下沉标签：命中才算够下沉」, with the user's chosen directions also counting as enough. */
  requireStrongOrDirection: true,
  /** Lowest `sink_score` that still qualifies. */
  minScore: 0,
};

const weights = z.record(z.string().min(1).max(40), z.number().finite().min(-100).max(100));
const words = z.array(z.string().min(1).max(40)).max(500);
const sinkSchema = z.object({
  modes: weights, sink: weights, hard: weights,
  directions: z.record(z.string().min(1).max(40), words),
  strong: words, block: words,
  directionBonus: z.number().finite().min(0).max(100), strongBonus: z.number().finite().min(0).max(100), blockPenalty: z.number().finite().min(0).max(100),
  negationPrefixes: z.array(z.string().length(1)).max(20),
  requireStrongOrDirection: z.boolean(),
  minScore: z.number().finite().min(-1000).max(1000),
}).strict();

const ruleSchema = z.object({
  /** 收藏 must be strictly greater than this (10万 = 100000). */
  minCollection: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** Excludes 连载 and works whose completion is still unknown. */
  requireCompleted: z.boolean(),
  /** Excludes confirmed adaptations of the station's own Fanqie novels; suspected ones are kept and labelled. */
  excludeConfirmedIp: z.boolean(),
  /** Creates a queued job as soon as a work qualifies. */
  autoEnqueue: z.boolean(),
  sink: sinkSchema,
  completion: z.object({
    /** `series_episode_info.series_status` values meaning finished. Observed 2026-11-15: 1 on finished dramas. */
    completedStatuses: z.array(z.number().int()).max(20),
    /** Values meaning still updating. Observed 2026-11-15: 0 on dramas still adding episodes (e.g. 「nova：新星」 全60集). */
    serialStatuses: z.array(z.number().int()).max(20),
  }).strict(),
  ip: z.object({
    /** Shorter normalized titles never count as a title match. */
    minTitleLength: z.number().int().min(1).max(50),
    /** A name found in more Fanqie works than this is too common to be evidence. */
    maxNameDocuments: z.number().int().min(1).max(10_000),
    /** Distinct shared character names that confirm an adaptation. */
    confirmNames: z.number().int().min(1).max(10),
    /** Description character-bigram Dice similarity that confirms an exact-title match. */
    confirmSimilarity: z.number().min(0).max(1),
    /** Similarity that makes one shared name or a partial title a suspected match. */
    suspectSimilarity: z.number().min(0).max(1),
    /** Re-evaluate an unchanged candidate's IP match after this many hours. */
    recheckHours: z.number().int().min(1).max(720),
  }).strict(),
  detail: z.object({
    /** Detail pages read per selection run. */
    batchSize: z.number().int().min(0).max(1_000),
    requestIntervalMs: z.number().int().min(0).max(60_000),
    requestTimeoutMs: z.number().int().min(1_000).max(120_000),
    /** Re-read a 连载 or unknown-completion drama after this many hours. */
    serialRecheckHours: z.number().int().min(1).max(720),
    /** Re-read a drama whose 收藏 is still unknown or below the threshold after this many hours. */
    collectionRecheckHours: z.number().int().min(1).max(720),
    /** Wait after a failed reading. */
    failureRetryHours: z.number().int().min(1).max(720),
  }).strict(),
  queue: z.object({
    /** A work that qualifies within this many hours of its first observation joins the `new` lane. */
    newWindowHours: z.number().int().min(1).max(8_760),
    /** A claim or report holds the job for this long; a silent worker loses it afterwards. */
    leaseMinutes: z.number().int().min(1).max(1_440),
    /** Claims per job before it stops being re-dispatched automatically. */
    maxAttempts: z.number().int().min(1).max(20),
    /** Days of published jobs averaged for 平均出稿时间. */
    summaryWindowDays: z.number().int().min(1).max(365),
  }).strict(),
  douyin: z.object({
    /** Only a drama whose exact-name Douyin topic has more views than this qualifies (5000万 = 50000000). */
    minPlays: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    /** Turns the Douyin gate on; without a DTK service it can never pass. */
    required: z.boolean(),
    /** Posts read from one search when looking for the topic. */
    searchCount: z.number().int().min(1).max(50),
    /** Topic checks per selection run; one Douyin account serves them all. */
    perRun: z.number().int().min(0).max(500),
    requestIntervalMs: z.number().int().min(0).max(120_000),
    /** Re-check a `below` or `not_found` drama after this many hours; topic views keep growing. */
    recheckHours: z.number().int().min(1).max(720),
    /** Retry an `error` check after this many hours. */
    errorRetryHours: z.number().int().min(1).max(720),
  }).strict(),
  review: z.object({
    /** Workers judge each automatically queued drama against `standard` before transcribing; false skips it. */
    enabled: z.boolean(),
    /** The selection standard given to the worker with each claim. */
    standard: z.string().min(1).max(5_000),
  }).strict(),
  videos: z.object({
    /** Only this bucket and top folder are accepted from `drama_tos_upload`. */
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    /** Top folder; objects sit under `<root>/<platform>/<YYYYMMDD>/<work id>/`. */
    root: z.string().regex(/^[A-Za-z0-9._-]{1,60}$/),
    /** Public HTTPS origin the download links are built from. */
    publicOrigin: z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; }),
  }).strict(),
}).strict();

export type HitRules = z.infer<typeof ruleSchema>;
export type SinkRules = HitRules['sink'];

export const DEFAULT_HIT_RULES: HitRules = {
  minCollection: 100_000,
  requireCompleted: true,
  excludeConfirmedIp: true,
  autoEnqueue: true,
  sink: DEFAULT_SINK_RULES,
  completion: { completedStatuses: [1], serialStatuses: [0] },
  ip: { minTitleLength: 4, maxNameDocuments: 20, confirmNames: 2, confirmSimilarity: 0.35, suspectSimilarity: 0.2, recheckHours: 24 },
  detail: { batchSize: 40, requestIntervalMs: 1_500, requestTimeoutMs: 15_000, serialRecheckHours: 24, collectionRecheckHours: 72, failureRetryHours: 6 },
  queue: { newWindowHours: 72, leaseMinutes: 30, maxAttempts: 2, summaryWindowDays: 30 },
  douyin: { minPlays: 50_000_000, required: true, searchCount: 20, perRun: 20, requestIntervalMs: 5_000, recheckHours: 24, errorRetryHours: 2 },
  review: { enabled: true, standard: '选材复核：本队列只转写面向下沉观众的剧。选材方向：年代文、家长里短、争议文/婆媳、世情、甜宠马甲、系统脑洞，以及自带关注度的题材——不只是新闻热点，历史典故、民间传说、神话、名著故事等大众熟悉的内容都算。按整部剧判断它的主要受众：看全部标签和简介，拿不准时看前一两集。命中某个下沉标签不等于整部剧下沉；如果其他题材让整体受众偏年轻（例如校园、青春恋爱、电竞、二次元），即使带有家长里短等标签也不转写。收藏、完结、番茄 IP、抖音播放量已由程序检查，不要重复判断；不要因集数、画质或制作难度淘汰。' },
  videos: { bucket: 'muse', root: 'download-video-date', publicOrigin: 'https://muse.tos-cn-beijing.volces.com' },
};

type Overrides = { [key: string]: unknown };
/** Word tables of the 下沉 rules; an override replaces the whole table so a rule file can remove words, not only add them. */
const replacedTables = new Set(['modes', 'sink', 'hard', 'directions']);
function merge(base: unknown, override: unknown, path: string[] = []): unknown {
  if (!override || typeof override !== 'object' || Array.isArray(override) || !base || typeof base !== 'object' || Array.isArray(base)) return override;
  const result: Overrides = { ...(base as Overrides) };
  for (const [key, value] of Object.entries(override as Overrides)) {
    const replaced = path.length === 1 && path[0] === 'sink' && replacedTables.has(key);
    result[key] = key in result && !replaced ? merge(result[key], value, [...path, key]) : value;
  }
  return result;
}

/**
 * Applies a partial override to the defaults and validates the result.
 * Nested objects merge key by key; word lists and weight tables replace the default table.
 * @throws When a value is outside its allowed range or a key is unknown.
 */
export function resolveHitRules(override: unknown = {}): HitRules {
  return ruleSchema.parse(merge(DEFAULT_HIT_RULES, override));
}

const MAX_RULE_FILE_BYTES = 262_144;

/**
 * Reads a rule override file: an absolute regular file, not a symbolic link, at most 256 KiB of UTF-8 JSON.
 * @param path Absolute path from `MUSE_DATA_HIT_RULES_FILE`, or undefined for the defaults.
 */
export async function loadHitRules(path?: string): Promise<HitRules> {
  if (path === undefined) return resolveHitRules();
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('MUSE_DATA_HIT_RULES_FILE must be an absolute path');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > MAX_RULE_FILE_BYTES || await realpath(path) !== path) throw new Error('MUSE_DATA_HIT_RULES_FILE must be a regular file of at most 256 KiB without symbolic links');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile());
    try { return resolveHitRules(JSON.parse(text)); }
    catch (error) { throw new Error(`Hit rule file is invalid: ${error instanceof z.ZodError ? error.issues.map(issue => issue.path.join('.')).join(', ') : 'JSON'}`); }
  } finally { await handle.close(); }
}

/** The thresholds members see on the board. */
export function ruleSummary(rules: HitRules): HitRuleSummary {
  return { minCollection: rules.minCollection, minDouyinPlays: rules.douyin.minPlays, requireDouyinPlays: rules.douyin.required, requireCompleted: rules.requireCompleted, excludeConfirmedIp: rules.excludeConfirmedIp, autoEnqueue: rules.autoEnqueue };
}
