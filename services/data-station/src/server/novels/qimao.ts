/** Anonymous official Qimao directory and exact target-chapter reads, independent from metadata collection. */
import { createHash } from 'node:crypto';
import { parse, parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { z } from 'zod';
import type { Work } from '../../shared/types.ts';
import { parseQimaoState } from '../collectors/qimao/state.ts';
import { createQimaoOriginalReader } from './qimao-http.ts';
import { NovelSourceError, type NovelChapter, type NovelDirectory, type NovelSourceAdapter } from './source.ts';

const ORIGIN = 'https://www.qimao.com';
const identifier = z.string().regex(/^\d{1,24}(?:_0)?$/);
const chapterId = z.string().regex(/^\d{1,30}$/);
const number = z.union([z.number().int().nonnegative().safe(), z.string().regex(/^\d+$/)]).transform(Number).refine(Number.isSafeInteger);
const flag = z.union([z.literal('0'), z.literal('1'), z.literal(0), z.literal(1)]).transform(Number);
const title = z.string().trim().min(1).max(1000);
const bookSchema = z.object({ book_id: identifier, title, author: z.string().max(500), is_over: flag,
  catalogue_num: number, latest_chapter_id: chapterId, latest_chapter_title: title, latest_chapter_url: z.string().url() }).passthrough();
const directoryRow = z.object({ id: chapterId, index: number, title, is_vip: flag, words: number,
  update_time: z.string().regex(/^\d+$/), chapter_sort: number }).passthrough();
const directorySchema = z.object({ data: z.object({ chapters: z.array(directoryRow).min(1).max(20_000) }) });
const chapterInfo = z.object({ book_id: identifier, chapter_id: chapterId, book_title: title, author: z.string().max(500),
  title, index: number, words: number, is_vip: flag, is_over: flag, is_final: flag, update_time: z.string().max(300) }).passthrough();
const readerSchema = z.object({ state: z.object({
  reader: z.object({ currentBookId: identifier, currentChapterId: chapterId, showReaderLimit: z.boolean(), limitScroll: z.boolean(),
    bookInfo: z.object({ title, author: z.string().max(500), chapterTitle: title }) }),
  readerChapterInfo: z.object({ chapterInfo, bookSummary: z.object({ book_id: identifier, book_title: title,
    author: z.string().max(500), is_over: flag }).passthrough(), chapterData: z.string().min(1), showDom: z.boolean() }).passthrough(),
}), routePath: z.string(), error: z.null() });

/** Official request bounds; chapter text has its own UTF-8 byte cap before it reaches the publication library. */
export interface QimaoNovelOptions {
  requestIntervalMs?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxChapterBytes?: number;
  allowLegacyHeaders?: boolean;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

type Node = DefaultTreeAdapterMap['node'];
function nodes(root: Node): Node[] {
  const result: Node[] = [], pending = [root];
  while (pending.length) {
    const node = pending.pop()!; result.push(node);
    if ('childNodes' in node && !['script', 'style', 'template', 'noscript'].includes(node.nodeName)) pending.push(...node.childNodes.toReversed());
  }
  return result;
}
const attr = (node: Node, key: string) => 'attrs' in node ? node.attrs.find(item => item.name === key)?.value ?? '' : '';
const has = (node: Node, ...classes: string[]) => classes.every(value => attr(node, 'class').split(/\s+/).includes(value));
const content = (node: Node) => nodes(node).flatMap(item => 'value' in item ? [item.value] : []).join('').trim();
const compact = (text: string) => text.replace(/\s/gu, '');
const invalid = () => new NovelSourceError('invalid_source', '七猫原文目录、章节身份或完整性未通过核验');
const authorization = () => new NovelSourceError('authorization_required', '七猫来源章节要求授权或仅提供预览');

function page(html: string, collections: boolean): { state: unknown; nodes: Node[] } {
  const all = nodes(parse(html));
  const heading = all.find(node => node.nodeName === 'title');
  if (heading && /验证码|安全验证|访问过于频繁|Access Denied|WAF|Forbidden/iu.test(content(heading))) throw new NovelSourceError('unavailable', '七猫公开原文页面当前要求访问验证');
  const scripts = all.filter(node => node.nodeName === 'script').map(node => 'childNodes' in node
    ? node.childNodes.flatMap(child => 'value' in child ? [child.value] : []).join('') : '').filter(script => script.includes('window.__NUXT__'));
  if (scripts.length !== 1) throw invalid();
  return { state: parseQimaoState(scripts[0]!, { allowCollectionAliases: collections }), nodes: all };
}

function free(value: Record<string, unknown>): void {
  for (const key of ['is_vip', 'is_lock', 'is_locked', 'locked', 'is_preview', 'preview', 'need_pay', 'is_paid', 'is_trial']) {
    if (!Object.hasOwn(value, key)) continue;
    const flag = value[key];
    if (flag === 1 || flag === '1' || flag === true) throw authorization();
    if (flag !== 0 && flag !== '0' && flag !== false) throw invalid();
  }
}

function paragraphs(root: Node): string {
  const list = nodes(root).filter(node => node.nodeName === 'p');
  if (!list.length || nodes(root).some(node => node.nodeName === 'script' || node.nodeName === 'style' || node.nodeName === 'iframe')) throw invalid();
  return list.map(content).filter(Boolean).join('\n\n');
}

function directoryKey(directory: NovelDirectory): string {
  return createHash('sha256').update(JSON.stringify([directory.workId, directory.sourceId, directory.platform, directory.title, directory.author,
    directory.sourceUrl, directory.observedAt, directory.declaredChapterCount, directory.finished,
    directory.chapters.map(chapter => [chapter.id, chapter.index, chapter.title, chapter.sourceUrl, chapter.wordCount, chapter.sourceUpdatedAt])])).digest('hex');
}

/**
 * Creates a fixed-origin source. Every target chapter is checked against both its verified directory and rendered body.
 * @param options Anonymous HTTP pacing, byte limits and optional test transport.
 * @returns A source retaining only verified directory metadata until release; each request closes its own response resources.
 */
export function createQimaoNovelSource(options: QimaoNovelOptions = {}): NovelSourceAdapter {
  const config = z.object({ requestIntervalMs: z.number().int().min(0).max(60_000), requestTimeoutMs: z.number().int().min(100).max(120_000),
    maxResponseBytes: z.number().int().min(1024).max(33_554_432), maxChapterBytes: z.number().int().min(1).max(8_388_608),
    allowLegacyHeaders: z.boolean() }).parse({ requestIntervalMs: options.requestIntervalMs ?? 1000, requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
    maxResponseBytes: options.maxResponseBytes ?? 5_242_880, maxChapterBytes: options.maxChapterBytes ?? 2_097_152, allowLegacyHeaders: options.allowLegacyHeaders ?? true });
  const read = createQimaoOriginalReader({ ...config, fetch: options.fetch }), now = options.now ?? (() => new Date());
  const sessions = new Map<string, NovelDirectory>();
  return {
    platform: 'qimao',
    async directory(work: Work, signal: AbortSignal): Promise<NovelDirectory> {
      signal.throwIfAborted();
      if (work.platform !== 'qimao' || work.kind !== 'novel' || work.origin !== 'live' || !identifier.safeParse(work.sourceId).success
        || work.id !== `qimao:${work.sourceId}` || work.sourceUrl !== `${ORIGIN}/shuku/${work.sourceId}/`) throw invalid();
      try {
        const bookPath = `/shuku/${work.sourceId}/`, bookPage = page(await read(bookPath, signal), true);
        const source = z.object({ state: z.object({ common: z.object({ bookRelatedInfo: z.object({ bookDetail: bookSchema,
          bookIntroData: z.object({ first_chapter_title: title }) }) }) }), routePath: z.literal(bookPath), error: z.null() }).parse(bookPage.state);
        const book = source.state.common.bookRelatedInfo.bookDetail;
        if (book.book_id !== work.sourceId || !book.catalogue_num || book.catalogue_num > 20_000) throw invalid();
        free(book);
        const information = bookPage.nodes.find(node => has(node, 'book-information'));
        const titleRow = information ? nodes(information).find(node => has(node, 'title')) : undefined;
        const bookTitle = titleRow ? nodes(titleRow).find(node => has(node, 'txt')) : undefined;
        const author = bookPage.nodes.find(node => has(node, 'author-name'));
        const states = information ? nodes(information).filter(node => has(node, 'qm-tag')).map(content) : [];
        if (!bookTitle || content(bookTitle) !== book.title || !author || content(author) !== book.author
          || !states.some(state => book.is_over ? ['完结', '已完结'].includes(state) : state === '连载中')) throw invalid();
        const rows = directorySchema.parse(JSON.parse(await read(`/qimaoapi/api/book/chapter-list?book_id=${work.sourceId}`, signal))).data.chapters;
        if (rows.length !== book.catalogue_num || new Set(rows.map(chapter => chapter.id)).size !== rows.length
          || rows.some((chapter, index) => chapter.index !== index + 1) || rows.at(-1)!.id !== book.latest_chapter_id
          || rows.at(-1)!.title !== book.latest_chapter_title || book.latest_chapter_url !== `${ORIGIN}/shuku/${work.sourceId}-${book.latest_chapter_id}/`
          || rows[0]!.title !== source.state.common.bookRelatedInfo.bookIntroData.first_chapter_title) throw invalid();
        for (const row of rows) free(row);
        const directory: NovelDirectory = { workId: work.id, sourceId: work.sourceId, platform: 'qimao', title: book.title,
          author: book.author || null, sourceUrl: work.sourceUrl, observedAt: now().toISOString(), declaredChapterCount: rows.length,
          finished: book.is_over === 1, chapters: rows.map(chapter => ({ id: chapter.id, index: chapter.index, title: chapter.title,
            sourceUrl: `${ORIGIN}/shuku/${work.sourceId}-${chapter.id}/`, wordCount: chapter.words, sourceUpdatedAt: chapter.update_time })) };
        signal.throwIfAborted(); sessions.set(directoryKey(directory), directory); return directory;
      } catch (error) { if (signal.aborted) throw signal.reason; throw error instanceof NovelSourceError ? error : invalid(); }
    },
    async chapter(directory: NovelDirectory, chapter: NovelChapter, signal: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      const session = sessions.get(directoryKey(directory));
      const expected = session?.chapters.find(item => item.id === chapter.id);
      if (!session || !expected || JSON.stringify([chapter.index, chapter.title, chapter.sourceUrl, chapter.wordCount, chapter.sourceUpdatedAt])
        !== JSON.stringify([expected.index, expected.title, expected.sourceUrl, expected.wordCount, expected.sourceUpdatedAt])) throw invalid();
      try {
        const path = `/shuku/${session.sourceId}-${chapter.id}/`, parsed = page(await read(path, signal), false), state = readerSchema.parse(parsed.state);
        const target = state.state.readerChapterInfo, info = target.chapterInfo, reader = state.state.reader;
        free(info); free(target); free(target.bookSummary);
        if (reader.showReaderLimit) throw authorization();
        if (!target.showDom) throw invalid();
        if (state.routePath !== path || reader.currentBookId !== session.sourceId || reader.currentChapterId !== chapter.id
          || info.book_id !== session.sourceId || info.chapter_id !== chapter.id || info.book_title !== session.title
          || info.author !== (session.author ?? '') || info.title !== chapter.title || info.index !== chapter.index || info.words !== chapter.wordCount
          || info.is_over !== Number(session.finished)
          || target.bookSummary.book_id !== session.sourceId || target.bookSummary.book_title !== session.title
          || target.bookSummary.author !== (session.author ?? '') || target.bookSummary.is_over !== Number(session.finished)
          || reader.bookInfo.title !== session.title || reader.bookInfo.author !== (session.author ?? '') || reader.bookInfo.chapterTitle !== chapter.title) throw invalid();
        const sourceText = paragraphs(parseFragment(target.chapterData));
        const articles = parsed.nodes.filter(node => has(node, 'chapter-detail-article')).filter(article => {
          let ancestor: Node | undefined = article, wrapper: Node | undefined;
          while (ancestor) {
            if (has(ancestor, 'book-recommend')) return false;
            if (!wrapper && has(ancestor, 'chapter-detail-wrap')) wrapper = ancestor;
            ancestor = 'parentNode' in ancestor ? ancestor.parentNode ?? undefined : undefined;
          }
          if (!wrapper) return false;
          const headings = nodes(wrapper).filter(node => has(node, 'chapter-title'));
          return headings.length === 1 && content(headings[0]!) === chapter.title && compact(paragraphs(article)) === compact(sourceText);
        });
        if (articles.length !== 1) throw invalid();
        const text = paragraphs(articles[0]!);
        if (!text.trim() || /[\p{Co}\uFFFD\uD800-\uDFFF\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text)
          || [...compact(text)].length < (chapter.wordCount ?? 1) || Buffer.byteLength(text) > config.maxChapterBytes) throw invalid();
        signal.throwIfAborted(); return text;
      } catch (error) { if (signal.aborted) throw signal.reason; throw error instanceof NovelSourceError ? error : invalid(); }
    },
    async release(directory: NovelDirectory): Promise<void> { sessions.delete(directoryKey(directory)); },
  };
}
