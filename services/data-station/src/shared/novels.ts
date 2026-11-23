import type { Work } from './types.ts';
/** Public metadata for immutable original-novel versions; no private file paths or account data. */
export interface NovelArtifact {
  id: string;
  workId: string;
  platform: 'fanqie' | 'qimao';
  fileName: string;
  contentType: 'text/plain';
  byteLength: number;
  sha256: string;
  createdAt: string;
  sourceUrl: string;
  directoryObservedAt: string;
  chapterCount: number;
  scope: 'complete-book' | 'current-published-directory';
}

/** One durable download attempt; an older artifact remains independently available after failure. */
export interface NovelJob {
  id: string;
  workId: string;
  state: 'queued' | 'running' | 'ready' | 'failed';
  completedChapters: number;
  totalChapters: number;
  createdAt: string;
  updatedAt: string;
  errorCode: 'authorization_required' | 'unavailable' | 'invalid_source' | 'storage_limit' | null;
  message: string;
  artifactId: string | null;
}

/** One original-novel version in a member's bookshelf, with the work's current metadata. */
export interface NovelShelfItem {
  work: Work;
  artifact: NovelArtifact;
  /** Time of this member's latest verified download of `artifact`. */
  downloadedAt: string;
  /** ID of the work's newest published version; differs from `artifact.id` once a newer version exists. */
  latestArtifactId: string;
}

export interface NovelState {
  available: boolean;
  job: NovelJob | null;
  artifact: NovelArtifact | null;
}
