/** Every platform a stored record can belong to. */
export const PLATFORMS = ['hongguo', 'lvpaopao', 'douyin', 'fanqie', 'qimao'] as const;
export type Platform = typeof PLATFORMS[number];
/** Platforms exposed by this data station, in tab order; older Douyin records remain readable in storage. */
export const DATA_PLATFORMS = ['hongguo', 'lvpaopao', 'fanqie', 'qimao'] as const;
/** Navigation key for the selected platform's accumulated works, without a board filter. */
export const COLLECTED_LIBRARY = '__collected_library__';
export type WorkKind = 'drama' | 'novel';
export type DataOrigin = 'live' | 'demo';
export type SelectionStatus = 'pending' | 'reviewing' | 'selected' | 'passed';

export const PLATFORM_LABELS: Record<Platform, string> = {
  hongguo: '红果短剧', lvpaopao: '绿泡泡短剧', douyin: '抖音', fanqie: '番茄小说', qimao: '七猫小说',
};
/** Two-character platform names for compact badges. */
export const PLATFORM_SHORT_LABELS: Record<Platform, string> = { hongguo: '红果', lvpaopao: '绿泡泡', douyin: '抖音', fanqie: '番茄', qimao: '七猫' };
/** One-character platform marks for logos and compact badges. */
export const PLATFORM_GLYPHS: Record<Platform, string> = { hongguo: '果', lvpaopao: '泡', douyin: '抖', fanqie: '番', qimao: '猫' };

export interface Metric {
  key: string;
  label: string;
  value: number | null;
  unit?: string;
}

export interface Topic {
  id: string;
  label: string;
  group: string;
  source: 'platform' | 'text';
  evidence: string;
}

export interface TopicFacets {
  groups: { id: string; label: string; items: { id: string; label: string; count: number }[] }[];
}

export interface Work {
  id: string;
  sourceId: string;
  platform: Platform;
  kind: WorkKind;
  /** Verified source title; unavailable metadata keeps a null title. */
  title: string | null;
  author: string | null;
  description: string;
  coverUrl: string | null;
  sourceUrl: string;
  tags: string[];
  category: string;
  episodeCount: number | null;
  wordCount: number | null;
  serialStatus: string | null;
  publishedAt: string | null;
  metrics: Metric[];
  rank: number | null;
  rankChange: number | null;
  board: string;
  origin: DataOrigin;
  observedAt: string;
  sourceUpdatedAt: string | null;
  /** When the metric values were measured, if earlier than `observedAt`; absent means they were measured at `observedAt`. */
  metricsObservedAt?: string;
  metadataStatus?: 'verified' | 'unavailable';
  metadataNote?: string;
  topics?: Topic[];
  script?: ScriptArtifact | null;
}

export interface ScriptArtifact {
  id: string;
  workId: string;
  fileName: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  createdAt: string;
}

export interface BookshelfItem { work: Work; script: ScriptArtifact; downloadedAt: string; }
export interface UserIdentity {
  id: string; name: string; role: 'admin' | 'member';
  /** The Muse website account when signed in through Muse; its admin flag controls Muse links only, not data-station roles. */
  muse?: { username: string; admin: boolean };
  /** Feishu department, when the station knows it. */
  department?: string;
}

export interface Observation {
  observedAt: string;
  board: string;
  rank: number | null;
  metrics: Metric[];
  origin: DataOrigin;
  sourceUpdatedAt?: string | null;
}

export interface Selection {
  workId: string;
  status: SelectionStatus;
  note: string;
  owner: string;
  updatedAt: string;
}

export interface CollectorStatus {
  platform: Platform;
  state: 'idle' | 'running' | 'success' | 'failed' | 'not_configured';
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  message: string;
  coverage: string;
  count: number;
  nextRunAt?: string | null;
  intervalHours?: number;
  /** Failed attempts since the last success; each one doubles the retry delay, bounded by the interval. */
  consecutiveFailures?: number;
}

/** Persistent progress of the scheduled detail-page metric refresh of one platform's catalog-only works. */
export interface MetricRefreshStatus {
  platform: Platform;
  state: 'idle' | 'running' | 'success' | 'failed' | 'not_configured';
  /** Catalog-only works whose metrics are missing or older than the refresh age, as of the last run. */
  due: number;
  refreshed: number;
  lastRunRefreshed: number;
  lastRunFailed: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  message: string;
}

/** Persistent page-discovery progress, independent of complete ranking refreshes. */
export interface DiscoveryStatus {
  platform: Platform;
  state: 'idle' | 'running' | 'success' | 'failed' | 'not_configured';
  count: number;
  newWorks: number;
  lastRunNewWorks: number;
  pending: number;
  failed: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastPublishedAt: string | null;
  nextRunAt: string | null;
  coverage: string;
  message: string;
}

export interface CatalogQuery {
  platform?: Platform;
  kind?: WorkKind;
  q?: string;
  category?: string;
  board?: string;
  tag?: string;
  sort?: 'rank' | 'rising' | 'recent' | 'plays' | 'published';
  origin?: DataOrigin;
  page?: number;
  limit?: number;
  /** Collection time of the selected board batch; requires `board` and `origin`. Omitted means the latest batch. */
  at?: string;
}

/** One collection of a board, identified by its observation time at millisecond precision. */
export interface BoardBatch {
  observedAt: string;
  /** The batch immediately before `observedAt`; rank changes compare against it. Null for the first batch. */
  previousObservedAt: string | null;
}

export interface CatalogResponse {
  items: Work[];
  total: number;
  page: number;
  limit: number;
  categories: string[];
  boards: string[];
  /** Present for a board query with one origin; null when that board has no matching batch. */
  batch?: BoardBatch | null;
}

/** Collection times of one platform's board within one data origin, newest first. */
export interface BoardBatchList {
  batches: string[];
  /** True when older batches exist beyond the listed ones. */
  truncated: boolean;
}

/** Display fields of a work in a batch comparison. */
export type ComparedWork = Pick<Work, 'id' | 'sourceId' | 'title' | 'author' | 'metadataStatus' | 'metadataNote'>;

/**
 * A work's membership in two batches of the same board.
 * `stayed` is in both, `entered` only in the later batch, `dropped` only in the earlier one.
 */
export interface BoardComparisonEntry {
  work: ComparedWork;
  status: 'stayed' | 'entered' | 'dropped';
  fromRank: number | null;
  toRank: number | null;
  /** Earlier rank minus later rank; positive moved up. Null unless the work stayed with both ranks known. */
  rankChange: number | null;
}

/** Membership and rank differences between two batches of one platform's board within one data origin. */
export interface BoardComparison {
  platform: Platform;
  board: string;
  origin: DataOrigin;
  from: string;
  to: string;
  entries: BoardComparisonEntry[];
}

/** A board view over one Beijing calendar day, the Monday-to-Sunday week, or the calendar month containing the chosen date. */
export type BoardPeriod = 'day' | 'week' | 'month';

/** One Beijing calendar day (`YYYY-MM-DD`) and the time of that day's last collection of a board. */
export interface BoardDay {
  date: string;
  observedAt: string;
}

/** Collected Beijing days of one platform's board within one data origin, newest first. */
export interface BoardDayList {
  days: BoardDay[];
  /** True when older collected days exist beyond the listed ones. */
  truncated: boolean;
}

/** One work in a board period. */
export interface BoardPeriodItem {
  /**
   * Day: the official rank of that day's last collection, or null when the source gave none.
   * Week and month: this site's position by days on board, average rank and best rank; equal works share a position.
   */
  position: number | null;
  /** Collected days in the period whose last collection lists this work. */
  daysOnBoard: number;
  /** Mean official rank over those days with a known rank; null when none is known. */
  averageRank: number | null;
  bestRank: number | null;
  /** Beijing date of the last listed day; `work` carries that day's rank, metrics and collection time. */
  lastDate: string;
  /** Day: rank change against the previous calendar day's last collection. Week and month: always null. */
  work: Work;
}

/**
 * A board computed from the last collection of each collected Beijing day of a period.
 * Uncollected days are left out rather than filled; `days` lists the ones used.
 */
export interface BoardPeriodView {
  platform: Platform;
  board: string;
  origin: DataOrigin;
  period: BoardPeriod;
  /** The chosen date, or the latest collected day when none was given. */
  date: string;
  /** First and last Beijing date of the period, inclusive. */
  start: string;
  end: string;
  daysInPeriod: number;
  /** Collected days within the period, oldest first. Empty when the period has no collection. */
  days: BoardDay[];
  /** Day period only: the previous calendar day when it was collected; rank changes compare against it. */
  previous: BoardDay | null;
  items: BoardPeriodItem[];
}

export interface Dashboard {
  totalWorks: number;
  liveWorks: number;
  demoWorks: number;
  selections: number;
  risingWorks: number;
  platformCounts: Record<Platform, number>;
  featured: Work[];
  rising: Work[];
  collectors: CollectorStatus[];
}

export interface WorkDetail { work: Work; observations: Observation[]; selection: Selection | null; }
export interface SelectionItem { work: Work; selection: Selection; }
export interface SessionInfo extends UserIdentity { mode: 'local-preview' | 'server'; }

/** Board names of one platform and the board opened first. */
export interface BoardDirectory { boards: string[]; defaultBoard: string | null; }

/**
 * Data embedded in the page for its confirmed account, so the first screen renders without waiting for requests.
 * Board fields describe the latest live day of `platform`'s default board; they are null when that platform has no collected board.
 */
export interface PageBootstrap {
  session: SessionInfo;
  platform: Platform;
  directory: BoardDirectory | null;
  period: BoardPeriodView | null;
  days: BoardDayList | null;
}

/** ID of the non-executable JSON element that carries a page's `PageBootstrap`. */
export const PAGE_BOOTSTRAP_ELEMENT = 'muse-data-bootstrap';
/** Path of the Muse sign-in page, sent with 401 responses when the data station reuses Muse sign-in. */
export const MUSE_LOGIN_PATH = '/login';
export interface CollectionBatch { platform: Platform; works: Work[]; coverage: string; observedAt: string; }

/** Administrator-selected public video or creator-window configuration. */
export interface DouyinSourceInput {
  label: string;
  videoId: string;
  mode: 'creator' | 'video';
  expectedAuthor: string;
  includeKeywords: string[];
  excludeKeywords: string[];
  enabled: boolean;
  maxVideos: number;
}

/** Persisted source with the official author identity bound during verification. */
export interface ManagedDouyinSource extends DouyinSourceInput {
  id: string;
  expectedAuthorId: string | null;
  updatedAt: string;
  validatedAt: string | null;
}

/** A read-only verification sample; it is never automatically added to the work library. */
export interface DouyinSourceValidation {
  author: string;
  authorId: string | null;
  works: Pick<Work, 'sourceId' | 'title' | 'sourceUrl' | 'publishedAt'>[];
  count: number;
  coverage: string;
  observedAt: string;
}

/** A person's name as shown in shared records: 「用户乙（用户甲组）」 when the department is known. */
export function displayName(user: Pick<UserIdentity, 'name' | 'department'>): string {
  return user.department ? `${user.name}（${user.department}）` : user.name;
}
