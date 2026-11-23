/** Wire types of the Douyin keyword search and mix listing served by `/api/douyin/*`. */

/** A Hongguo work in this station's catalog whose title matches a Douyin result. */
export interface HongguoMatch {
  workId: string;
  title: string;
  episodeCount: number | null;
  serialStatus: string | null;
}

/** The Douyin series (合集) a post belongs to, as the post states it. */
export interface DouyinMix {
  id: string;
  name: string;
  /** This post's place in the series, when Douyin states it. */
  episode: number | null;
  /** Episodes published so far, when Douyin states it. */
  episodes: number | null;
}

/** One public Douyin post from a search or a series. Missing counts are null, never zero. */
export interface DouyinPost {
  id: string;
  title: string;
  description: string;
  url: string;
  coverUrl: string | null;
  durationMs: number | null;
  createdAt: string | null;
  author: { name: string; secUid: string | null; handle: string | null };
  stats: { likes: number | null; comments: number | null; shares: number | null; saves: number | null };
  mix: DouyinMix | null;
  hongguo: HongguoMatch | null;
}

/** One public Douyin account from an account search. */
export interface DouyinAccount {
  secUid: string;
  name: string;
  handle: string | null;
  signature: string | null;
  avatarUrl: string | null;
  followers: number | null;
  posts: number | null;
  url: string;
}

/** One page; pass `cursor` back unchanged for the next page, which exists only when `hasMore`. */
export interface DouyinPage<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}

/** Whether this deployment can search Douyin. */
export interface DouyinSearchStatus {
  enabled: boolean;
}

/** The administrator's saved search settings and the current verification pause; kept across restarts. */
export interface DouyinSearchSettings {
  perHour: number;
  perDay: number;
  /** An administrator turned every search off until they turn it on again. */
  stopped: boolean;
  /** End of the pause after Douyin asked for verification, ISO time, or null. */
  pausedUntil: string | null;
  /** When Douyin last asked for verification, ISO time, or null. */
  lastRiskAt: string | null;
}

/** What the administrator page shows. */
export interface DouyinSearchState extends DouyinSearchSettings {
  /** Searches started in the last rolling hour and day. */
  lastHour: number;
  lastDay: number;
  pauseMinutes: number;
}
