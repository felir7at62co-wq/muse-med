/** Private chapter cache and immutable, fully verified original-novel TXT publications. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import type { NovelArtifact, NovelShelfItem } from '../../shared/novels.ts';
import type { Work } from '../../shared/types.ts';
import { NovelSourceError, type NovelChapter, type NovelDirectory } from './source.ts';
import { sliceText } from '../../shared/text.ts';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const chapterSchema = z.object({ id: z.string().regex(/^\d{1,30}$/), index: z.number().int().positive(),
  title: z.string().trim().min(1).max(1000), sourceUrl: z.string().url().max(2000),
  wordCount: z.number().int().nonnegative().safe().nullable(), sourceUpdatedAt: z.string().max(300).nullable() }).strict();
const directorySchema = z.object({ workId: z.string().max(100), sourceId: z.string().max(40), platform: z.enum(['fanqie', 'qimao']),
  title: z.string().trim().min(1).max(500), author: z.string().max(500).nullable(), sourceUrl: z.string().url().max(2000),
  observedAt: z.string().datetime({ offset: true }), declaredChapterCount: z.number().int().positive(), finished: z.boolean(),
  chapters: z.array(chapterSchema).min(1) }).strict();
const artifactSchema = z.object({ id: uuid, workId: z.string().max(100), platform: z.enum(['fanqie', 'qimao']),
  fileName: z.string().max(200).regex(/^[^/\\\x00-\x1f\x7f]+\.txt$/), contentType: z.literal('text/plain'), byteLength: z.number().int().positive(), sha256: sha,
  createdAt: z.string().datetime(), sourceUrl: z.string().url(), directoryObservedAt: z.string().datetime({ offset: true }),
  chapterCount: z.number().int().positive(), scope: z.enum(['complete-book', 'current-published-directory']) }).strict();
const cacheSchema = z.object({ fileId: uuid, fingerprint: sha, sha256: sha, byteLength: z.number().int().positive() }).strict();
const receiptSchema = cacheSchema.omit({ fileId: true }).extend({ id: z.string(), index: z.number().int().positive() }).strict();
const manifestSchema = z.object({ version: z.literal(1), artifact: artifactSchema, directory: directorySchema, chapters: z.array(receiptSchema).min(1) }).strict();

/** A bounded, public file failure without plaintext, paths or provider details. */
export class NovelFileError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 429 = 409) { super(message); this.name = 'NovelFileError'; }
}

/** Limits cover one published TXT and all private cache, manifest and TXT files combined. */
export interface NovelLibraryOptions { maxChapters?: number; maxFileBytes?: number; maxStorageBytes?: number; now?: () => Date; }

function integer(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid novel ${name}`);
  return value;
}

/** Canonical official reference URLs are retained even when an adapter uses an authorized API to retrieve text. */
function sourceUrl(value: string, platform: NovelDirectory['platform'], id: string, chapter?: string): void {
  const expected = platform === 'fanqie' ? `https://fanqienovel.com/${chapter ? `reader/${chapter}` : `page/${id}`}`
    : `https://www.qimao.com/shuku/${id}${chapter ? `-${chapter}` : ''}/`;
  if (value !== expected) throw new NovelSourceError('invalid_source', '原文来源地址与作品或章节身份不一致');
}

/** Private storage; callers receive metadata and verified bytes, never a local file location. */
export class NovelLibrary {
  readonly maxChapters: number;
  readonly maxFileBytes: number;
  private readonly maxStorageBytes: number;
  private readonly now: () => Date;
  private readonly directory: string;
  private initializing: Promise<void> | undefined;
  private writing: Promise<unknown> = Promise.resolve();
  private usedBytes = 0;
  private readonly storedSizes = new Map<string, number>();

  constructor(readonly database: PGlite, storageDir: string, options: NovelLibraryOptions = {}) {
    const allowed = resolve(process.cwd(), '.data');
    this.directory = resolve(storageDir);
    const scope = relative(allowed, this.directory);
    if (!isAbsolute(storageDir) || !scope || scope === '..' || scope.startsWith(`..${sep}`) || isAbsolute(scope)
      || basename(this.directory) !== 'novel-files') throw new NovelFileError('原文目录必须位于本项目独立数据目录内', 400);
    this.maxChapters = integer(options.maxChapters ?? 20_000, 'maxChapters', 20_000);
    this.maxFileBytes = integer(options.maxFileBytes ?? 20 * 1024 * 1024, 'maxFileBytes', 20 * 1024 * 1024);
    this.maxStorageBytes = integer(options.maxStorageBytes ?? 1024 ** 3, 'maxStorageBytes', 1024 ** 3);
    this.now = options.now ?? (() => new Date());
  }

  private async ensureDirectory(): Promise<void> {
    let ancestor = this.directory;
    for (;;) {
      try { if (await realpath(ancestor) !== ancestor) throw new NovelFileError('不允许使用符号链接原文目录'); break; }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        const parent = dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent;
      }
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await realpath(this.directory) !== this.directory) throw new NovelFileError('不允许使用符号链接原文目录');
    await chmod(this.directory, 0o700);
  }

  async initialize(): Promise<void> {
    this.initializing ??= (async () => {
      await this.ensureDirectory();
      for (const entry of await readdir(this.directory, { withFileTypes: true })) {
        const stat = await lstat(resolve(this.directory, entry.name));
        const name = /^([0-9a-f-]{36})\.(?:chapter|txt|manifest\.json)$/.exec(entry.name);
        if (!name || !uuid.safeParse(name[1]).success || !stat.isFile() || stat.isSymbolicLink()) throw new NovelFileError('原文目录含不受支持的文件');
        this.storedSizes.set(entry.name, stat.size); this.usedBytes += stat.size;
      }
      await this.database.exec(`CREATE TABLE IF NOT EXISTS novel_chapters (
        work_id text NOT NULL REFERENCES works(id), fingerprint text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(work_id,fingerprint));
        CREATE TABLE IF NOT EXISTS novel_artifacts (id text PRIMARY KEY,work_id text NOT NULL REFERENCES works(id),
          version bigint GENERATED ALWAYS AS IDENTITY,payload jsonb NOT NULL,manifest_sha256 text NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS novels_same_content ON novel_artifacts(work_id,(payload->>'sha256'));
        CREATE INDEX IF NOT EXISTS novels_current_work ON novel_artifacts(work_id,version DESC);
        CREATE TABLE IF NOT EXISTS novel_bookshelf (user_id text NOT NULL, artifact_id text NOT NULL REFERENCES novel_artifacts(id),
          downloaded_at timestamptz NOT NULL, PRIMARY KEY(user_id,artifact_id));`);
    })();
    return this.initializing;
  }

  /** Validates the complete directory before fetching or reusing any chapter text. */
  validateDirectory(input: NovelDirectory, work: Pick<Work, 'id' | 'sourceId' | 'platform'>): NovelDirectory {
    const parsed = directorySchema.parse(input);
    const id = parsed.platform === 'fanqie' ? /^\d{1,30}$/ : /^\d{1,24}(?:_0)?$/;
    if (!id.test(parsed.sourceId) || parsed.workId !== `${parsed.platform}:${parsed.sourceId}` || parsed.workId !== work.id
      || parsed.sourceId !== work.sourceId || parsed.platform !== work.platform || parsed.chapters.length > this.maxChapters
      || parsed.declaredChapterCount !== parsed.chapters.length || new Set(parsed.chapters.map(chapter => chapter.id)).size !== parsed.chapters.length) {
      throw new NovelSourceError('invalid_source', '原文目录的作品身份、章节总数或唯一章节不一致');
    }
    sourceUrl(parsed.sourceUrl, parsed.platform, parsed.sourceId);
    for (const [index, chapter] of parsed.chapters.entries()) {
      if (chapter.index !== index + 1) throw new NovelSourceError('invalid_source', '原文目录章节顺序不连续');
      sourceUrl(chapter.sourceUrl, parsed.platform, parsed.sourceId, chapter.id);
    }
    return parsed;
  }

  private fingerprint(directory: NovelDirectory, chapter: NovelChapter): string {
    return digest(JSON.stringify({ workId: directory.workId, platform: directory.platform, sourceId: directory.sourceId,
      chapter: { id: chapter.id, index: chapter.index, title: chapter.title, sourceUrl: chapter.sourceUrl,
        wordCount: chapter.wordCount, sourceUpdatedAt: chapter.sourceUpdatedAt } }));
  }

  private text(bytes: Uint8Array, chapter?: NovelChapter): string {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new NovelSourceError('invalid_source', '原文不是合法 UTF-8 文本'); }
    if (!text.trim() || /[\p{Co}\uFFFD\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text)) throw new NovelSourceError('invalid_source', '原文为空、含未解码字符或二进制内容');
    if (chapter?.wordCount !== null && chapter?.wordCount !== undefined && [...text.replace(/\s/gu, '')].length < chapter.wordCount) {
      throw new NovelSourceError('invalid_source', '章节正文短于来源声明字数，不能发布截文');
    }
    return text;
  }

  private async readBytes(name: string, expectedSize: number, expectedSha: string, maximum = this.maxFileBytes): Promise<Uint8Array> {
    await this.ensureDirectory();
    let handle;
    try { handle = await open(resolve(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch { throw new NovelFileError('原文文件缺失或不可读取'); }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== expectedSize || stat.size > maximum) throw new NovelFileError('原文文件长度校验失败');
      const bytes = new Uint8Array(await handle.readFile());
      if (digest(bytes) !== expectedSha) throw new NovelFileError('原文文件摘要校验失败');
      return bytes;
    } finally { await handle.close(); }
  }

  private async writeBytes(name: string, bytes: Uint8Array): Promise<void> {
    const handle = await open(resolve(this.directory, name), 'wx', 0o600);
    // Reserve the complete write after exclusive creation; an undeletable partial file remains conservatively charged.
    this.storedSizes.set(name, bytes.byteLength); this.usedBytes += bytes.byteLength;
    try {
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
    } catch (error) { await this.removeFile(name); throw error; }
  }

  private async capacity(additional: number): Promise<void> {
    await this.ensureDirectory();
    if (this.usedBytes + additional > this.maxStorageBytes) throw new NovelFileError('原文存储空间达到配置上限', 413);
  }

  private async removeFile(name: string): Promise<void> {
    try { await unlink(resolve(this.directory, name)); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    this.usedBytes -= this.storedSizes.get(name) ?? 0; this.storedSizes.delete(name);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writing.then(operation); this.writing = result.catch(() => {}); return result;
  }

  /** Verifies cached bytes and source chapter metadata before resuming; directory growth does not invalidate old chapters. */
  async cachedChapter(directory: NovelDirectory, chapter: NovelChapter): Promise<string | null> {
    await this.initialize();
    const fingerprint = this.fingerprint(directory, chapter);
    const row = (await this.database.query<{ payload: unknown }>('SELECT payload FROM novel_chapters WHERE work_id=$1 AND fingerprint=$2', [directory.workId, fingerprint])).rows[0];
    if (!row) return null;
    const cached = cacheSchema.parse(row.payload);
    if (cached.fingerprint !== fingerprint) throw new NovelFileError('章节缓存身份校验失败');
    return this.text(await this.readBytes(`${cached.fileId}.chapter`, cached.byteLength, cached.sha256), chapter);
  }

  /** Saves one verified chapter privately; no download artifact exists until every declared chapter passes. */
  async saveChapter(directory: NovelDirectory, chapter: NovelChapter, text: string): Promise<void> {
    await this.initialize();
    const bytes = new TextEncoder().encode(text); this.text(bytes, chapter);
    if (bytes.byteLength > this.maxFileBytes) throw new NovelFileError('章节正文超过配置字节上限', 413);
    await this.exclusive(async () => {
      if (await this.cachedChapter(directory, chapter) !== null) return;
      await this.capacity(bytes.byteLength);
      const cached = { fileId: randomUUID(), fingerprint: this.fingerprint(directory, chapter), sha256: digest(bytes), byteLength: bytes.byteLength };
      const name = `${cached.fileId}.chapter`;
      await this.writeBytes(name, bytes);
      try { await this.database.query('INSERT INTO novel_chapters(work_id,fingerprint,payload) VALUES($1,$2,$3::jsonb)', [directory.workId, cached.fingerprint, JSON.stringify(cached)]); }
      catch (error) { await this.removeFile(name); throw error; }
    });
  }

  /** Assembles only a fully verified directory and atomically exposes immutable TXT plus its private manifest. */
  async publish(directory: NovelDirectory): Promise<NovelArtifact> {
    await this.initialize();
    const checked = this.validateDirectory(directory, { id: directory.workId, sourceId: directory.sourceId, platform: directory.platform });
    return this.exclusive(async () => {
      const scope = checked.finished ? 'complete-book' : 'current-published-directory';
      const parts = [`${checked.title}\n${checked.author ? `作者：${checked.author}\n` : ''}来源：${checked.sourceUrl}\n范围：${checked.finished ? '来源标记已完结的完整目录' : '截至当前目录快照的已发布章节，非全本'}\n目录观察时间：${checked.observedAt}\n`];
      const receipts: z.infer<typeof receiptSchema>[] = [];
      let size = Buffer.byteLength(parts[0]!);
      for (const chapter of checked.chapters) {
        const text = await this.cachedChapter(checked, chapter);
        if (text === null) throw new NovelSourceError('invalid_source', '目录中仍有未完成章节，不能发布原文');
        const chunk = `\n${chapter.title}\n\n${text}\n`;
        size += Buffer.byteLength(chunk);
        if (size > this.maxFileBytes) throw new NovelFileError('原文 TXT 超过配置字节上限', 413);
        parts.push(chunk);
        receipts.push({ id: chapter.id, index: chapter.index, fingerprint: this.fingerprint(checked, chapter),
          sha256: digest(new TextEncoder().encode(text)), byteLength: Buffer.byteLength(text) });
      }
      const bytes = new TextEncoder().encode(parts.join('')); this.text(bytes);
      const contentSha = digest(bytes);
      const existing = (await this.database.query<{ payload: unknown }>("SELECT payload FROM novel_artifacts WHERE work_id=$1 AND payload->>'sha256'=$2", [checked.workId, contentSha])).rows[0];
      if (existing) {
        const artifact = artifactSchema.parse(existing.payload); await this.read(artifact.id); return artifact;
      }
      const title = sliceText(checked.title.replace(/[\\/\x00-\x1f\x7f]/g, '_'), 0, 100);
      const artifact: NovelArtifact = { id: randomUUID(), workId: checked.workId, platform: checked.platform, fileName: `${title}.txt`,
        contentType: 'text/plain', byteLength: bytes.byteLength, sha256: contentSha, createdAt: this.now().toISOString(),
        sourceUrl: checked.sourceUrl, directoryObservedAt: checked.observedAt, chapterCount: checked.chapters.length, scope };
      const manifest = new TextEncoder().encode(JSON.stringify({ version: 1, artifact, directory: checked, chapters: receipts }));
      if (manifest.byteLength > 32 * 1024 * 1024) throw new NovelFileError('原文目录清单超过安全字节上限', 413);
      await this.capacity(bytes.byteLength + manifest.byteLength);
      const created: string[] = [];
      try {
        for (const [name, content] of [[`${artifact.id}.txt`, bytes], [`${artifact.id}.manifest.json`, manifest]] as const) {
          await this.writeBytes(name, content); created.push(name);
        }
        await this.database.query('INSERT INTO novel_artifacts(id,work_id,payload,manifest_sha256) VALUES($1,$2,$3::jsonb,$4)',
          [artifact.id, checked.workId, JSON.stringify(artifact), digest(manifest)]);
      } catch (error) {
        let failure = error;
        for (const name of created) { try { await this.removeFile(name); } catch (cleanup) { failure = cleanup; } }
        throw failure;
      }
      return artifact;
    });
  }

  async current(workId: string): Promise<NovelArtifact | null> {
    await this.initialize();
    const row = (await this.database.query<{ payload: unknown }>('SELECT payload FROM novel_artifacts WHERE work_id=$1 ORDER BY version DESC LIMIT 1', [workId])).rows[0];
    if (!row) return null;
    const artifact = artifactSchema.parse(row.payload);
    if (artifact.workId !== workId) throw new NovelFileError('原文版本的作品身份不一致');
    return artifact;
  }

  /**
   * Records a member's verified download of an original version; the client calls it only after checking the file's length and digest.
   * A repeated download updates the download time.
   * @param userId Confirmed member ID.
   * @param artifactId Downloaded original version.
   */
  async addToShelf(userId: string, artifactId: string): Promise<void> {
    await this.initialize();
    if (!uuid.safeParse(artifactId).success || !(await this.database.query('SELECT 1 FROM novel_artifacts WHERE id=$1', [artifactId])).rows.length) throw new NovelFileError('原小说文件不存在', 404);
    await this.database.query(`INSERT INTO novel_bookshelf(user_id,artifact_id,downloaded_at) VALUES($1,$2,$3)
      ON CONFLICT(user_id,artifact_id) DO UPDATE SET downloaded_at=EXCLUDED.downloaded_at`, [userId, artifactId, this.now().toISOString()]);
  }

  /**
   * Lists a member's originals, newest download first, with each work's current metadata and newest version ID.
   * @param userId Confirmed member ID.
   * @returns Shelf entries; other members' entries are never included.
   */
  async shelf(userId: string): Promise<NovelShelfItem[]> {
    await this.initialize();
    const result = await this.database.query<{ work: Work; artifact: unknown; downloaded_at: Date | string; latest: string }>(`SELECT w.payload AS work,a.payload AS artifact,b.downloaded_at,
        (SELECT n.id FROM novel_artifacts n WHERE n.work_id=a.work_id ORDER BY n.version DESC LIMIT 1) AS latest
      FROM novel_bookshelf b JOIN novel_artifacts a ON a.id=b.artifact_id JOIN works w ON w.id=a.work_id
      WHERE b.user_id=$1 ORDER BY b.downloaded_at DESC,a.version DESC`, [userId]);
    return result.rows.map(row => ({ work: row.work, artifact: artifactSchema.parse(row.artifact), downloadedAt: new Date(row.downloaded_at).toISOString(), latestArtifactId: row.latest }));
  }

  /** Removes only this member's shelf entry; the shared file and other members' entries remain. */
  async removeShelf(userId: string, artifactId: string): Promise<void> {
    await this.initialize();
    await this.database.query('DELETE FROM novel_bookshelf WHERE user_id=$1 AND artifact_id=$2', [userId, artifactId]);
  }

  /** Verifies both immutable manifest and TXT digest before returning any downloadable bytes. */
  async read(id: string): Promise<{ artifact: NovelArtifact; bytes: Uint8Array } | null> {
    await this.initialize();
    if (!uuid.safeParse(id).success) return null;
    const row = (await this.database.query<{ payload: unknown; manifest_sha256: string }>('SELECT payload,manifest_sha256 FROM novel_artifacts WHERE id=$1', [id])).rows[0];
    if (!row) return null;
    const artifact = artifactSchema.parse(row.payload);
    if (artifact.id !== id) throw new NovelFileError('原文版本身份不一致');
    await this.ensureDirectory();
    const manifestStat = await lstat(resolve(this.directory, `${id}.manifest.json`));
    const manifestBytes = await this.readBytes(`${id}.manifest.json`, manifestStat.size, sha.parse(row.manifest_sha256), 32 * 1024 * 1024);
    const manifest = manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)));
    this.validateDirectory(manifest.directory, { id: artifact.workId, sourceId: manifest.directory.sourceId, platform: artifact.platform });
    if (JSON.stringify(manifest.artifact) !== JSON.stringify(artifact) || artifact.chapterCount !== manifest.directory.chapters.length
      || artifact.sourceUrl !== manifest.directory.sourceUrl || artifact.directoryObservedAt !== manifest.directory.observedAt
      || artifact.scope !== (manifest.directory.finished ? 'complete-book' : 'current-published-directory')
      || manifest.chapters.length !== manifest.directory.chapters.length
      || manifest.chapters.some((chapter, index) => chapter.id !== manifest.directory.chapters[index]!.id
        || chapter.index !== index + 1 || chapter.fingerprint !== this.fingerprint(manifest.directory, manifest.directory.chapters[index]!))) throw new NovelFileError('原文清单与作品版本不一致');
    const bytes = await this.readBytes(`${id}.txt`, artifact.byteLength, artifact.sha256); this.text(bytes);
    return { artifact, bytes };
  }
}
