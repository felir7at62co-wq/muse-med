import type { Work } from '../../shared/types.ts';

/** One source-declared chapter, indexed from one in reading order. */
export interface NovelChapter {
  id: string;
  index: number;
  title: string;
  sourceUrl: string;
  wordCount: number | null;
  sourceUpdatedAt: string | null;
}

/** The complete currently published directory; finished does not imply access to restricted chapters. */
export interface NovelDirectory {
  workId: string;
  sourceId: string;
  platform: 'fanqie' | 'qimao';
  title: string;
  author: string | null;
  sourceUrl: string;
  observedAt: string;
  declaredChapterCount: number;
  finished: boolean;
  chapters: NovelChapter[];
}

/** Source access and identity validation belong to the adapter; the library independently validates durable values. */
export interface NovelSourceAdapter {
  platform: 'fanqie' | 'qimao';
  directory(work: Work, signal: AbortSignal): Promise<NovelDirectory>;
  chapter(directory: NovelDirectory, chapter: NovelChapter, signal: AbortSignal): Promise<string>;
  release?(directory: NovelDirectory): Promise<void>;
}

/** A public, bounded failure category; messages must never contain credentials or chapter text. */
export class NovelSourceError extends Error {
  constructor(readonly code: 'authorization_required' | 'unavailable' | 'invalid_source', message: string) {
    super(message); this.name = 'NovelSourceError';
  }
}
