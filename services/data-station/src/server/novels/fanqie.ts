import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Work } from '../../shared/types.ts';
import { createFanqieMetadataReader } from '../collectors/fanqie/http.ts';
import { readInitialState } from '../collectors/fanqie/parser.ts';
import { NovelSourceError, type NovelChapter, type NovelDirectory, type NovelSourceAdapter } from './source.ts';

/** Limits for an isolated one-book anonymous free-reading worker; no Muse runtime is loaded. */
export interface FanqieNovelOptions {
  pythonExecutable: string;
  sourceDirectory: string;
  workerDirectory: string;
  caFile?: string;
  requestTimeoutMs: number;
  requestIntervalMs: number;
  maxResponseBytes: number;
  maxChapterBytes: number;
  callTimeoutMs: number;
  graceMs: number;
  networkMode: 'direct' | 'system';
  /** Accept a website directory that flags app-locked chapters and a soft-renamed book title; every other identity check remains. */
  fullMode?: boolean;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

const identifier = z.string().regex(/^\d{1,30}$/);
const webChapter = z.object({ itemId: identifier, title: z.string().min(1).max(500), realChapterOrder: z.string().regex(/^\d+$/),
  needPay: z.union([z.literal(0), z.literal(1)]), isChapterLock: z.boolean(), isPaidPublication: z.boolean(), isPaidStory: z.boolean() });
const webDirectory = z.object({ page: z.object({ bookId: identifier, bookName: z.string().min(1).max(500), author: z.string().max(500),
  status: z.union([z.literal(1), z.literal(2), z.literal('1'), z.literal('2')]),
  chapterTotal: z.number().int().positive().safe(), chapterListWithVolume: z.array(z.array(webChapter)).min(1) }) });
const apiDirectory = z.object({ bookId: identifier, title: z.string().min(1).max(500), author: z.string().max(500).nullable(),
  chapters: z.array(z.object({ id: identifier, index: z.number().int().positive().safe(), title: z.string().min(1).max(500),
    wordCount: z.number().int().nonnegative().safe().nullable(), updatedAt: z.string().regex(/^\d+$/).nullable() })).min(1) });
const workerError = z.object({ ok: z.literal(false), code: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/), sourceStage: z.string().max(100).optional(),
  error: z.object({ httpStatus: z.number().int().min(100).max(599).optional(), reasonType: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/).optional(),
    message: z.string().max(1000).optional() }).passthrough().optional() }).passthrough();

function unavailable(message: string): NovelSourceError { return new NovelSourceError('unavailable', message); }
function invalid(message: string): NovelSourceError { return new NovelSourceError('invalid_source', message); }

function processEnvironment(mode: 'direct' | 'system', caFile?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (caFile) environment.SSL_CERT_FILE = caFile;
  if (mode === 'system') for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

/** Owns exactly one sequential JSON-line protocol and waits for the process and both output streams. */
class FanqieWorker {
  private process: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
  private buffered = Buffer.alloc(0);
  private stderrBytes = 0;
  private failed: Error | null = null;
  private closing: Promise<void> | null = null;
  private closed: Promise<void>;
  private didClose = false;
  private stdoutEnded = false;
  private stderrEnded = false;
  private code: number | null = null;
  private maxFrameBytes: number;

  constructor(private options: FanqieNovelOptions, cwd: string) {
    this.maxFrameBytes = options.maxResponseBytes + options.maxChapterBytes * 2 + 65_536;
    this.process = spawn(options.pythonExecutable, ['-I', '-B', '-X', 'utf8', resolve(options.sourceDirectory, 'worker.py')],
      { cwd, env: processEnvironment(options.networkMode, options.caFile), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.closed = new Promise(done => {
      this.process.once('close', code => {
        this.code = code; this.didClose = true;
        if (this.buffered.length || !this.stdoutEnded || !this.stderrEnded) this.fail(unavailable('番茄正文引擎输出未完整结束'));
        else if (this.pending) this.fail(unavailable('番茄正文引擎在响应完成前退出'));
        done();
      });
    });
    this.process.on('error', () => this.fail(unavailable('番茄正文运行时不可用，请检查独立 Python 环境')));
    this.process.stdin.on('error', () => this.fail(unavailable('番茄正文引擎输入已关闭')));
    this.process.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.process.stdout.once('end', () => { this.stdoutEnded = true; });
    this.process.stderr.once('end', () => { this.stderrEnded = true; });
    this.process.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > 65_536) this.fail(unavailable('番茄正文引擎诊断超过限制'));
    });
  }

  private fail(error: Error): void {
    this.failed ??= error;
    this.pending?.reject(error); this.pending = null;
    if (!this.didClose) this.process.kill('SIGTERM');
  }

  private receive(chunk: Buffer): void {
    if (this.failed) return;
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.buffered.length > this.maxFrameBytes) { this.fail(unavailable('番茄正文引擎响应超过限制')); return; }
    for (;;) {
      const end = this.buffered.indexOf(10);
      if (end < 0) return;
      const frame = this.buffered.subarray(0, end); this.buffered = this.buffered.subarray(end + 1);
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
        const envelope = z.object({ id: z.number().int().positive(), ok: z.boolean() }).passthrough().parse(value);
        if (!this.pending || envelope.id !== this.pending.id) throw invalid('番茄正文引擎响应顺序异常');
        const pending = this.pending;
        if (!envelope.ok) {
          const failure = workerError.parse(envelope);
          const stage = ({ registration: '匿名注册', catalog: '目录', 'key-negotiation': '正常阅读授权', 'chapter-download': '章节' } as Record<string, string>)[failure.sourceStage ?? ''] ?? '公开阅读';
          const category = failure.code === 'authorization_required' ? 'authorization_required'
            : ['chapter_mismatch', 'incomplete_catalog', 'invalid_catalog', 'invalid_ciphertext', 'invalid_content_key', 'incomplete_chapter', 'missing_chapter', 'input_size', 'chapter_size', 'response_size'].includes(failure.code) ? 'invalid_source' : 'unavailable';
          this.failed = new NovelSourceError(category, `番茄${stage}接口未完成核对（${failure.code}${failure.error?.reasonType ? `，${failure.error.reasonType}` : ''}${failure.error?.httpStatus ? `，HTTP ${failure.error.httpStatus}` : ''}）`);
          this.pending = null; pending.reject(this.failed); this.process.kill('SIGTERM');
        } else { this.pending = null; pending.resolve(envelope); }
      } catch (error) { this.fail(error instanceof NovelSourceError ? error : invalid('番茄正文引擎响应格式无效')); }
    }
  }

  async request(operation: string, values: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (this.failed) throw this.failed;
    if (this.didClose || this.pending || this.closing) throw unavailable('番茄正文引擎当前不可用');
    const id = ++this.sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => this.fail(unavailable('番茄正文核对已取消'));
    const result = new Promise<unknown>((resolveResult, reject) => {
      this.pending = { id, resolve: resolveResult, reject };
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => this.fail(unavailable('番茄正文核对超时')), this.options.callTimeoutMs);
      this.process.stdin.write(JSON.stringify({ id, operation, ...values }) + '\n');
    });
    try { const value = await result; if (this.failed) throw this.failed; return value; }
    catch (error) { await this.close(); if (signal.aborted) signal.throwIfAborted(); throw error; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      if (!this.didClose) this.process.stdin.end();
      const terminate = setTimeout(() => this.process.kill('SIGTERM'), this.options.graceMs);
      const kill = setTimeout(() => this.process.kill('SIGKILL'), this.options.graceMs * 2);
      try { await this.closed; }
      finally { clearTimeout(terminate); clearTimeout(kill); }
      if (this.failed) throw this.failed;
      if (!this.failed && (this.code !== 0 || !this.stdoutEnded || !this.stderrEnded || this.buffered.length)) throw unavailable('番茄正文引擎未正常完成退出');
    })();
  }
}

async function workerDirectory(directory: string): Promise<string> {
  let ancestor = directory;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (await realpath(ancestor) !== ancestor) throw invalid('正文运行目录不能使用符号链接');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw invalid('正文运行目录不能使用符号链接');
  return directory;
}

function directoryKey(directory: NovelDirectory): string {
  return createHash('sha256').update(JSON.stringify([directory.workId, directory.sourceId, directory.platform, directory.title, directory.author,
    directory.sourceUrl, directory.observedAt, directory.declaredChapterCount, directory.finished,
    directory.chapters.map(c => [c.id, c.index, c.title, c.sourceUrl, c.wordCount, c.sourceUpdatedAt])])).digest('hex');
}

/**
 * Creates a source that cross-checks the public website and normal anonymous free-reading directory.
 * Full mode accepts a website directory that flags app-locked chapters and an officially renamed book title, but still binds every API chapter to the website directory.
 * @param options Explicit runtime, request, process and response limits.
 * @returns An adapter retaining one isolated worker per directory until release or failure.
 */
export function createFanqieNovelSource(options: FanqieNovelOptions): NovelSourceAdapter {
  z.object({ pythonExecutable: z.string().refine(isAbsolute), requestTimeoutMs: z.number().int().min(100).max(120_000),
    sourceDirectory: z.string().refine(value => isAbsolute(value) && value === resolve(process.cwd(), 'third_party/fanqie-original')),
    workerDirectory: z.string().refine(value => {
      const path = relative(resolve(process.cwd(), '.data'), value);
      return isAbsolute(value) && resolve(value) === value && Boolean(path) && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
    }),
    caFile: z.string().refine(isAbsolute).optional(),
    requestIntervalMs: z.number().int().min(0).max(60_000), maxResponseBytes: z.number().int().min(1024).max(33_554_432),
    maxChapterBytes: z.number().int().min(1024).max(8_388_608), callTimeoutMs: z.number().int().min(100).max(1_800_000),
    graceMs: z.number().int().min(10).max(10_000), networkMode: z.enum(['direct', 'system']),
    fullMode: z.boolean().optional() }).parse(options);
  const fullMode = options.fullMode === true;
  const workers = new Map<string, FanqieWorker>();
  return {
    platform: 'fanqie',
    async directory(work, signal) {
      signal.throwIfAborted();
      if (work.platform !== 'fanqie' || work.kind !== 'novel' || work.origin !== 'live' || !identifier.safeParse(work.sourceId).success
        || work.id !== `fanqie:${work.sourceId}` || work.sourceUrl !== `https://fanqienovel.com/page/${work.sourceId}`) throw invalid('番茄作品身份或来源无效');
      const path = `/page/${work.sourceId}`;
      const reader = createFanqieMetadataReader({ allowedPaths: [path], requestTimeoutMs: options.requestTimeoutMs,
        requestIntervalMs: options.requestIntervalMs, maxResponseBytes: options.maxResponseBytes, fetch: options.fetch });
      let source;
      try { source = webDirectory.parse(readInitialState(await reader(path, 'html', signal))).page; }
      catch (error) { if (signal.aborted) throw error; throw unavailable('番茄官方网页目录当前不可用或字段已变化'); }
      const chapters = source.chapterListWithVolume.flat();
      if (source.bookId !== work.sourceId || chapters.length !== source.chapterTotal || new Set(chapters.map(c => c.itemId)).size !== chapters.length
        || chapters.some((c, index) => Number(c.realChapterOrder) !== index + 1)) throw invalid('番茄官方网页目录身份、总数或顺序不一致');
      if (!fullMode && chapters.some(c => c.needPay !== 0 || c.isChapterLock || c.isPaidPublication || c.isPaidStory)) throw new NovelSourceError('authorization_required', '番茄目录包含锁定或需授权的章节，未下载正文');
      const worker = new FanqieWorker(options, await workerDirectory(options.workerDirectory));
      try {
        const api = apiDirectory.parse(await worker.request('directory', { bookId: work.sourceId, settings: {
          requestTimeoutMs: options.requestTimeoutMs, requestIntervalMs: options.requestIntervalMs, maxResponseBytes: options.maxResponseBytes,
          maxChapterBytes: options.maxChapterBytes, networkMode: options.networkMode,
        } }, signal));
        // Fanqie soft-renames books: the API book_name can lag behind (or lead) the website title while original_book_name and
        // book_short_name keep the former name, so in full mode the display title is not an identity field. BookId, author,
        // declared count and the exact chapter ids/titles/order below still bind the API directory to this website directory.
        if (api.bookId !== source.bookId || (!fullMode && api.title !== source.bookName) || api.author !== source.author || api.chapters.length !== source.chapterTotal
          || api.chapters.some((c, index) => c.id !== chapters[index]!.itemId || c.index !== index + 1 || c.title !== chapters[index]!.title)) throw invalid('番茄正常阅读目录与官网目录不一致，未下载正文');
        const directory: NovelDirectory = { workId: work.id, sourceId: work.sourceId, platform: 'fanqie', title: source.bookName,
          author: source.author || null, sourceUrl: work.sourceUrl, observedAt: (options.now?.() ?? new Date()).toISOString(),
          declaredChapterCount: source.chapterTotal, finished: String(source.status) === '2', chapters: api.chapters.map(c => ({
            id: c.id, index: c.index, title: c.title, sourceUrl: `https://fanqienovel.com/reader/${c.id}`, wordCount: c.wordCount,
            sourceUpdatedAt: c.updatedAt && Number.isSafeInteger(Number(c.updatedAt)) && Number(c.updatedAt) > 0 ? new Date(Number(c.updatedAt) * 1000).toISOString() : null,
          })) };
        const key = directoryKey(directory);
        if (workers.has(key)) throw unavailable('番茄该目录已有运行中的核对任务');
        workers.set(key, worker); return directory;
      } catch (error) {
        await worker.close();
        if (error instanceof NovelSourceError || signal.aborted) throw error;
        throw invalid('番茄正常阅读目录响应无效');
      }
    },
    async chapter(directory, chapter, signal) {
      const key = directoryKey(directory), worker = workers.get(key);
      const expected = directory.chapters[chapter.index - 1];
      if (!worker || !expected || expected.id !== chapter.id || expected.title !== chapter.title || expected.sourceUrl !== chapter.sourceUrl
        || expected.wordCount !== chapter.wordCount || expected.sourceUpdatedAt !== chapter.sourceUpdatedAt) throw invalid('番茄章节未绑定当前目录');
      try {
        const result = z.object({ bookId: identifier, chapterId: identifier, index: z.number().int().positive(), text: z.string() }).parse(await worker.request('chapter', { chapterId: chapter.id }, signal));
        if (result.bookId !== directory.sourceId || result.chapterId !== chapter.id || result.index !== chapter.index || !result.text.trim()
          || Buffer.byteLength(result.text) > options.maxChapterBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd\p{Co}]/u.test(result.text)
          || chapter.wordCount !== null && [...result.text.replace(/\s/gu, '')].length < chapter.wordCount) throw invalid('番茄正文身份、编码或来源字数校验失败');
        return result.text;
      } catch (error) {
        workers.delete(key); await worker.close();
        if (error instanceof NovelSourceError || signal.aborted) throw error;
        throw invalid('番茄章节响应无效');
      }
    },
    async release(directory) {
      const key = directoryKey(directory), worker = workers.get(key); workers.delete(key);
      if (worker) await worker.close();
    },
  };
}
