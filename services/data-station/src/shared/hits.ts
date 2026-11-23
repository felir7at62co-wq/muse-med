/**
 * Daily hit-transcription loop: automatic Hongguo candidate selection, the transcription job table
 * written by non-human workers, and the member-facing 储备看板 (stockpile board).
 */
import type { ScriptArtifact } from './types.ts';

/**
 * Pipeline state of one drama's transcription job.
 * `queued` waits for a worker; `downloading`, `transcribing` and `checking` are active stages reported by the
 * worker holding the lease; `published` has a script in the library; `failed` exhausted its automatic retries;
 * `needs-attention` (待处理) failed the program checks or stopped reporting too often.
 */
export type TranscriptionJobState = 'queued' | 'downloading' | 'transcribing' | 'checking' | 'published' | 'failed' | 'needs-attention' | 'rejected';
export const ACTIVE_JOB_STATES = ['downloading', 'transcribing', 'checking'] as const;
export type ActiveJobState = typeof ACTIVE_JOB_STATES[number];
export const JOB_STATE_LABELS: Record<TranscriptionJobState, string> = {
  queued: '排队中', downloading: '下载中', transcribing: '转写中', checking: '检查中',
  published: '可下载', failed: '失败', 'needs-attention': '待处理', rejected: '复核淘汰',
};

/**
 * Queue lane of a job: `manual` was requested with 立即转写, `new` qualified within the new-work window of its first
 * observation, `backlog` is an older qualifying work. Claims take manual, then new, then backlog.
 */
export type JobLane = 'manual' | 'new' | 'backlog';

/** Completion of a drama as published by the source; null when the source has not said. */
export type DramaCompletion = 'completed' | 'serial';

/** How sure the station is that a drama adapts a Fanqie novel in its own catalog. */
export type IpMatchLevel = 'none' | 'suspected' | 'confirmed';

/** Result of the user's 2026-10-19 下沉 (lower-tier-market) topic rules for one work. */
export interface SinkEvaluation {
  qualifies: boolean;
  /** A hard-flaw tag matched without any strong 下沉 tag. */
  blocked: boolean;
  score: number;
  strongHits: string[];
  blockHits: string[];
  directions: string[];
}

/** The closest Fanqie work in the station's catalog and why it matched. */
export interface IpMatch {
  level: IpMatchLevel;
  fanqieWorkId: string | null;
  fanqieTitle: string | null;
  /** Human-readable evidence, e.g. 「同名作品」「共同人物：顾承川、林小满」. */
  reasons: string[];
}

/**
 * Douyin reach of a drama: the view count of the Douyin topic named exactly like the title.
 * `pass` is above the threshold; `below` is not; `not_found` means no exact-name topic; `error` is a DTK failure and is retried.
 */
export interface DouyinTopicCheck {
  state: 'pass' | 'below' | 'not_found' | 'error';
  /** Words searched for. */
  keyword: string;
  topicName: string | null;
  hashtagId: string | null;
  viewCount: number | null;
  /** Posts under the topic. */
  postCount: number | null;
  checkedAt: string;
  /** Set by a person on the board rather than found by search. */
  manual: boolean;
  error: string | null;
}

/** One measured 收藏 value and where it came from. */
export interface CollectionReading { value: number; measuredAt: string; source: 'board' | 'catalog' | 'detail'; }

/** Why a candidate did or did not qualify, recomputed by every selection run. */
export interface HitEvaluation {
  qualified: boolean;
  /** Unmet conditions in display order; empty when qualified. */
  unmet: string[];
  collection: CollectionReading | null;
  completion: DramaCompletion | null;
  /** Detail-page time of the completion reading; null when no detail page has been read. */
  completionMeasuredAt: string | null;
  sink: SinkEvaluation;
  ip: IpMatch;
  /** Douyin topic check; null until a drama meets the other conditions and has been checked. */
  douyin: DouyinTopicCheck | null;
  evaluatedAt: string;
}

/** Progress the worker last reported. */
export interface JobProgress {
  /** Episodes finished in the current stage, out of `totalEpisodes`. */
  episode: number | null;
  totalEpisodes: number | null;
  message: string | null;
  updatedAt: string;
}

/** One uploaded TOS object; `url` is derived by the station from the key, never taken from the caller. */
export interface VideoArchiveObject { kind: string; key: string; url: string; bytes: number | null; sha256: string | null; status: string | null; }

/** Public TOS archive of a drama's source videos and process material. */
export interface VideoArchive {
  bucket: string;
  /** `YYYYMMDD` folder under `download-video-date/hongguo/`. */
  date: string;
  directory: string;
  directoryUrl: string;
  manifest: { key: string; url: string };
  objects: VideoArchiveObject[];
  recordedAt: string;
}

/** Program-check summary the worker sends with a script; the station stores it for the board. */
export interface JobChecks { passed: boolean; summary: string | null; }

/** The last failure the worker reported, or a lease expiry noticed by the station. */
export interface JobFailure { at: string; reason: string; stage: string | null; }

/** A transcription job as members and workers see it; lease identifiers are only returned to the claiming worker. */
export interface TranscriptionJob {
  workId: string;
  sourceId: string;
  state: TranscriptionJobState;
  lane: JobLane;
  /** 收藏 value used to order the backlog lane. */
  priority: number | null;
  /** When the work first qualified, or when a member requested it manually. */
  qualifiedAt: string;
  queuedAt: string;
  rushAt: string | null;
  requestedBy: string | null;
  workerId: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  /** Claims so far; automatic re-dispatch stops at the configured maximum. */
  attempts: number;
  progress: JobProgress | null;
  videos: VideoArchive | null;
  scriptId: string | null;
  checks: JobChecks | null;
  lastError: JobFailure | null;
  /** Set when the worker's 选材复核 rejected the drama. */
  review: JobReview | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A claimed job with the lease the worker must send with every later call. */
/** A worker's 选材复核 rejection: the drama's overall audience does not fit the selection standard. */
export interface JobReview { rejectedAt: string; reason: string; workerId: string | null; }

/** What a worker needs to judge the whole drama against the selection standard. */
export interface ClaimedWork {
  title: string | null;
  category: string;
  /** Every source tag, not only the ones the rules matched. */
  tags: string[];
  /** The full source description. */
  description: string;
  episodes: number | null;
  collection: number | null;
  douyinTopic: { name: string | null; views: number | null } | null;
  ipMatch: IpMatchLevel;
  /** The program's 下沉 evaluation. */
  evaluation: Pick<SinkEvaluation, 'score' | 'strongHits' | 'blockHits' | 'directions'> | null;
}

/** Whether the worker must run the 选材复核 before transcribing, and the standard to judge by. */
export interface ClaimReview { required: boolean; standard: string; }

export interface ClaimedJob { job: TranscriptionJob; lease: string; }

/** Display fields of the drama on the board. */
export interface HitWorkSummary {
  id: string;
  sourceId: string;
  title: string | null;
  coverUrl: string | null;
  sourceUrl: string;
  tags: string[];
  episodeCount: number | null;
  board: string;
  observedAt: string;
}

/** One row of the 储备看板. */
export interface HitBoardItem {
  work: HitWorkSummary;
  evaluation: HitEvaluation | null;
  job: TranscriptionJob | null;
  script: ScriptArtifact | null;
}

/** Totals at the top of the board. */
export interface HitBoardSummary {
  /** Hongguo dramas with at least one script in the library. */
  stock: number;
  /** Jobs published since Beijing midnight. */
  addedToday: number;
  /** Mean hours from qualifying to downloadable over jobs published in the summary window; null without any. */
  averageHoursToDownload: number | null;
  averageWindowDays: number;
  /** Jobs currently failed or needing attention. */
  failures: number;
  /** Jobs the worker's 选材复核 rejected. */
  rejected: number;
  queued: number;
  active: number;
  candidates: number;
}

/** Thresholds shown with the board so members can see the selection rules in effect. */
export interface HitRuleSummary {
  minCollection: number;
  /** Douyin topic views must exceed this when `requireDouyinPlays`. */
  minDouyinPlays: number;
  requireDouyinPlays: boolean;
  requireCompleted: boolean;
  excludeConfirmedIp: boolean;
  autoEnqueue: boolean;
}

export type HitBoardFilter = 'all' | 'script' | 'active' | 'queued' | 'failed' | 'rejected';

export interface HitBoard {
  summary: HitBoardSummary;
  rules: HitRuleSummary;
  items: HitBoardItem[];
  total: number;
  page: number;
  limit: number;
  filter: HitBoardFilter;
  selection: HitSelectionStatus;
  generatedAt: string;
}

/** Persistent progress of the scheduled selection run. */
export interface HitSelectionStatus {
  state: 'idle' | 'running' | 'success' | 'failed' | 'disabled';
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  /** Dramas evaluated, detail pages read and jobs added by the last run. */
  evaluated: number;
  detailsRead: number;
  detailsFailed: number;
  enqueued: number;
  message: string;
}
