import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { unzipSync } from 'fflate';
import type { BookshelfItem, ScriptArtifact, Work } from '../shared/types.ts';

export const MAX_SCRIPT_BYTES = 20 * 1024 * 1024;

/** A safe file-operation failure suitable for the upload/download response. */
export class ScriptFileError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 = 400) {
    super(message);
    this.name = 'ScriptFileError';
  }
}

const types: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

async function removeUnpublishedFile(path: string): Promise<void> {
  try { await unlink(path); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

function decodeText(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ScriptFileError('文本剧本必须使用 UTF-8 编码'); }
}

function validateFile(fileName: string, bytes: Uint8Array, mime: string): string {
  if (!fileName || fileName.length > 200 || /[\/\\\x00-\x1f\x7f]/.test(fileName) || ['.', '..'].includes(fileName)) throw new ScriptFileError('文件名无效');
  const extension = extname(fileName).toLowerCase();
  const contentType = types[extension];
  if (!contentType) throw new ScriptFileError('仅支持 TXT、Markdown、DOCX 和 PDF 剧本文件');
  if (!bytes.byteLength) throw new ScriptFileError('不能上传空剧本文件');
  if (bytes.byteLength > MAX_SCRIPT_BYTES) throw new ScriptFileError('剧本文件不能超过 20 MiB', 413);
  const supplied = mime.split(';')[0]!.trim().toLowerCase();
  if (supplied && supplied !== 'application/octet-stream' && supplied !== contentType && !(contentType === 'text/markdown' && supplied === 'text/plain')) throw new ScriptFileError('文件类型与扩展名不一致');
  if (extension === '.pdf') {
    const header = new TextDecoder().decode(bytes.subarray(0, 16));
    const tail = new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
    if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\s|$)/.test(header) || !tail.includes('%%EOF')) throw new ScriptFileError('文件不是有效的 PDF');
  } else if (extension === '.docx') {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) throw new ScriptFileError('文件不是有效的 DOCX');
    let entries = 0;
    let totalDeclared = 0;
    let unpacked: Record<string, Uint8Array>;
    try {
      unpacked = unzipSync(bytes, { filter: file => {
        entries++;
        totalDeclared += file.originalSize;
        if (entries > 2048 || totalDeclared > 128 * 1024 * 1024 || /(?:^|\/)\.\.(?:\/|$)|\\|^\//.test(file.name) || /vbaProject\.bin$/i.test(file.name)) throw new Error('Unsafe archive');
        const needed = file.name === '[Content_Types].xml' || file.name === 'word/document.xml';
        if (needed && file.originalSize > 2 * 1024 * 1024) throw new Error('Oversized document XML');
        return needed;
      } });
    } catch { throw new ScriptFileError('DOCX 压缩包结构无效或超过安全大小限制'); }
    if (!unpacked['[Content_Types].xml'] || !unpacked['word/document.xml']) throw new ScriptFileError('DOCX 缺少文档内容');
    const content = decodeText(unpacked['[Content_Types].xml']);
    const document = decodeText(unpacked['word/document.xml']);
    if (/<!DOCTYPE|<!ENTITY/i.test(content + document) || !content.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
      || !/<(?:[A-Za-z_][\w.-]*:)?document\b/.test(document) || !document.includes('http://schemas.openxmlformats.org/wordprocessingml/2006/main')) throw new ScriptFileError('DOCX 文档类型或内容无效');
  } else {
    const decoded = decodeText(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded) || decoded.startsWith('%PDF-') || decoded.startsWith('PK\u0003\u0004')) throw new ScriptFileError('文本文件包含二进制内容');
  }
  return contentType;
}

/** Immutable uploaded script versions and per-user downloaded-file shelves. */
export class ScriptLibrary {
  private directory: string;
  constructor(readonly database: PGlite, storageDir: string) {
    const allowed = resolve(process.cwd(), '.data');
    this.directory = resolve(storageDir);
    const scope = relative(allowed, this.directory);
    if (!isAbsolute(storageDir) || !scope || scope === '..' || scope.startsWith(`..${sep}`) || isAbsolute(scope) || !this.directory.endsWith(`${sep}script-files`)) throw new ScriptFileError('剧本目录必须位于本项目独立数据目录内');
  }

  private async ensureDirectory(): Promise<void> {
    // Resolve an existing parent before creating directories to avoid following an external symlink.
    let ancestor = this.directory;
    for (;;) {
      try {
        const actual = await realpath(ancestor);
        if (actual !== ancestor) throw new ScriptFileError('不允许使用符号链接剧本目录');
        break;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await realpath(this.directory) !== this.directory) throw new ScriptFileError('不允许使用符号链接剧本目录');
  }

  /** Creates append-only script records and member-scoped bookshelf records. */
  async initialize(): Promise<void> {
    await this.ensureDirectory();
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS script_artifacts (
        id text PRIMARY KEY, work_id text NOT NULL REFERENCES works(id),
        version bigint GENERATED ALWAYS AS IDENTITY, payload jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scripts_current_work ON script_artifacts(work_id,version DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS scripts_same_content ON script_artifacts(work_id,(payload->>'sha256'));
      CREATE TABLE IF NOT EXISTS script_bookshelf (
        user_id text NOT NULL, script_id text NOT NULL REFERENCES script_artifacts(id),
        downloaded_at timestamptz NOT NULL, PRIMARY KEY(user_id,script_id)
      );
    `);
  }

  /** Stores a new file version only for an existing work; older file versions are never replaced. */
  async put(workId: string, fileName: string, bytes: Uint8Array, mime: string): Promise<ScriptArtifact> {
    const contentType = validateFile(fileName, bytes, mime);
    if (!(await this.database.query('SELECT id FROM works WHERE id=$1', [workId])).rows.length) throw new ScriptFileError('作品不存在', 404);
    await this.ensureDirectory();
    const id = randomUUID();
    const artifact: ScriptArtifact = { id, workId, fileName, contentType, byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString() };
    const existing = await this.database.query<{ payload: ScriptArtifact }>('SELECT payload FROM script_artifacts WHERE work_id=$1 AND payload->>\'sha256\'=$2', [workId, artifact.sha256]);
    if (existing.rows[0]) {
      if (!await this.read(existing.rows[0].payload.id)) throw new ScriptFileError('相同内容的已有版本文件不可用，请联系管理员', 409);
      return existing.rows[0].payload;
    }
    const path = resolve(this.directory, `${id}.bin`);
    const handle = await open(path, 'wx', 0o600);
    try {
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
    } catch (error) { await removeUnpublishedFile(path); throw error; }
    try {
      const inserted = await this.database.query('INSERT INTO script_artifacts(id,work_id,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING id', [id, workId, JSON.stringify(artifact)]);
      if (!inserted.rows.length) {
        await removeUnpublishedFile(path);
        const winner = await this.database.query<{ payload: ScriptArtifact }>('SELECT payload FROM script_artifacts WHERE work_id=$1 AND payload->>\'sha256\'=$2', [workId, artifact.sha256]);
        if (!winner.rows[0]) throw new ScriptFileError('文件版本写入未完成，请重试', 409);
        return winner.rows[0].payload;
      }
    }
    catch (error) { await removeUnpublishedFile(path); throw error; }
    return artifact;
  }

  /** Returns the most recently stored version, without exposing any local storage path. */
  async current(workId: string): Promise<ScriptArtifact | null> {
    return (await this.database.query<{ payload: ScriptArtifact }>('SELECT payload FROM script_artifacts WHERE work_id=$1 ORDER BY version DESC LIMIT 1', [workId])).rows[0]?.payload ?? null;
  }

  /** Returns the latest real script version for each requested work, in one query. */
  async metadataForWorks(ids: string[]): Promise<Record<string, ScriptArtifact>> {
    if (!ids.length) return {};
    const rows = await this.database.query<{ work_id: string; payload: ScriptArtifact }>(`SELECT DISTINCT ON (work_id) work_id,payload FROM script_artifacts
      WHERE work_id IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY work_id,version DESC`, [JSON.stringify(ids)]);
    return Object.fromEntries(rows.rows.map(row => [row.work_id, row.payload]));
  }

  /** IDs of works with at least one script whose ID starts with `prefix` (e.g. `hongguo:`). */
  async workIdsWithScripts(prefix: string): Promise<string[]> {
    const rows = await this.database.query<{ work_id: string }>("SELECT DISTINCT work_id FROM script_artifacts WHERE starts_with(work_id,$1)", [prefix]);
    return rows.rows.map(row => row.work_id);
  }

  /** Reads the original immutable bytes, checking length and digest before a download succeeds. */
  async read(scriptId: string): Promise<{ artifact: ScriptArtifact; bytes: Uint8Array } | null> {
    if (!/^[0-9a-f-]{36}$/.test(scriptId)) return null;
    const artifact = (await this.database.query<{ payload: ScriptArtifact }>('SELECT payload FROM script_artifacts WHERE id=$1', [scriptId])).rows[0]?.payload;
    if (!artifact) return null;
    await this.ensureDirectory();
    let handle;
    try { handle = await open(resolve(this.directory, `${scriptId}.bin`), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw new ScriptFileError('剧本文件不可用，请联系管理员', 409);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== artifact.byteLength || stat.size > MAX_SCRIPT_BYTES) throw new ScriptFileError('剧本文件校验失败，请联系管理员', 409);
      const bytes = new Uint8Array(await handle.readFile());
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new ScriptFileError('剧本文件校验失败，请联系管理员', 409);
      return { artifact, bytes };
    } finally { await handle.close(); }
  }

  /** Records a verified file in this user's shelf; downloading alone never creates this record. */
  async addToShelf(userId: string, scriptId: string): Promise<void> {
    if (!await this.read(scriptId)) throw new ScriptFileError('剧本文件不存在', 404);
    await this.database.query('INSERT INTO script_bookshelf(user_id,script_id,downloaded_at) VALUES($1,$2,$3) ON CONFLICT(user_id,script_id) DO UPDATE SET downloaded_at=EXCLUDED.downloaded_at', [userId, scriptId, new Date().toISOString()]);
  }

  /** Joins current work metadata so a downloaded script's shelf follows later platform metrics. */
  async shelf(userId: string): Promise<BookshelfItem[]> {
    const result = await this.database.query<{ work: Work; script: ScriptArtifact; downloaded_at: Date | string }>(`SELECT w.payload AS work,s.payload AS script,b.downloaded_at
      FROM script_bookshelf b JOIN script_artifacts s ON s.id=b.script_id JOIN works w ON w.id=s.work_id
      WHERE b.user_id=$1 ORDER BY b.downloaded_at DESC,s.version DESC`, [userId]);
    return result.rows.map(row => ({ work: row.work, script: row.script, downloadedAt: new Date(row.downloaded_at).toISOString() }));
  }

  /** Removes only this user's shelf record; it never removes shared files or other users' records. */
  async removeShelf(userId: string, scriptId: string): Promise<void> {
    await this.database.query('DELETE FROM script_bookshelf WHERE user_id=$1 AND script_id=$2', [userId, scriptId]);
  }
}
