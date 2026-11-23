/** Wire types of Douyin → TOS downloads served by `/api/douyin/downloads*`. */

export type DouyinDownloadState = 'queued' | 'downloading' | 'uploading' | 'done' | 'failed';
export const DOUYIN_DOWNLOAD_STATE_LABELS: Record<DouyinDownloadState, string> = {
  queued: '排队中', downloading: '准备中', uploading: '准备中', done: '可下载', failed: '失败',
};

/** One Douyin post saved (or being saved) to TOS. The requester's account id is never returned. */
export interface DouyinDownload {
  id: string;
  awemeId: string;
  mixId: string | null;
  mixName: string | null;
  episode: number | null;
  title: string;
  state: DouyinDownloadState;
  /** TOS object key, fixed when the download is requested. */
  key: string;
  bytes: number | null;
  sha256: string | null;
  error: string | null;
  /** Stable failure code, without source addresses or credentials. */
  errorCode: string | null;
  /** The earliest automatic retry; null for a new, running or ended request. */
  nextRetryAt: string | null;
  /** Completed groups of failed attempts; the wait grows after each group. */
  cooldownRounds: number;
  attempts: number;
  requestedBy: string;
  /** Public object address of a saved file in public mode; null otherwise (private mode signs a link on request). */
  url: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Whether downloads are set up, how files are shared, and this member's quota for the Beijing day. */
export interface DouyinDownloadStatus {
  enabled: boolean;
  /** Why downloads are off, e.g. 「TOS 未配置」; absent when enabled. */
  reason?: string;
  /** `private`: the station hands out time-limited signed links; `public`: links are the public object address. */
  access: 'private' | 'public';
  linkSeconds: number;
  dailyLimit: number;
  usedToday: number;
  /** Administrators are not limited per day. */
  unlimited: boolean;
  maxMixEpisodes: number;
}

/** Result of one download request. */
export interface DouyinDownloadRequestResult {
  /** Newly queued or re-queued downloads. */
  queued: DouyinDownload[];
  /** Posts already queued, in progress or saved; not downloaded again. */
  existing: DouyinDownload[];
  /** Mix episodes left out because the member's daily limit was reached. */
  skipped: number;
}
