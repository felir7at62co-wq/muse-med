/** Workspace-local original manuscript bytes and immutable version identities. */
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { z } from 'zod'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { SessionId } from '@deepseek-ai/dsh-session'
import { isManuscript, readManuscriptFile, type DocumentLimits, type ManuscriptFile } from './manuscript-document.ts'

/** Storage limits are independent of the mutable returned-draft comparison ledger. */
export interface ManuscriptVersionLimits extends DocumentLimits {
  maxVersions: number
  maxVersionBytes: number
  maxDocuments: number
  maxLedgerBytes: number
  lockWaitMs: number
}

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const record = z.strictObject({ source_path: z.string().min(1), file_sha256: hash, text_sha256: hash,
  extension: z.enum(['.md', '.txt', '.docx']), session_id: z.string().transform(SessionId) })
const indexSchema = z.strictObject({ version: z.literal(1), records: z.array(record) })
type Index = z.infer<typeof indexSchema>
type VersionRecord = z.infer<typeof record>

/** A stored original can be supplied explicitly as a comparison baseline; it is not automatically selected. */
export interface ManuscriptVersion extends VersionRecord {
  snapshot_path: string
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Content-addressed originals are never overwritten, evicted or substituted for a caller's current draft. */
export class ManuscriptVersions {
  constructor(private readonly limits: ManuscriptVersionLimits) {}

  private async directory(cwd: string): Promise<string> {
    const parent = join(await realpath(cwd), '.muse', 'manuscript-revisions')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const directory = join(parent, 'versions')
    await mkdir(directory, { mode: 0o700, recursive: true })
    if (await realpath(directory) !== directory) throw Error('MANUSCRIPT_VERSION_DIRECTORY: 版本目录不能穿过符号链接。')
    return directory
  }

  private async index(directory: string, signal: AbortSignal): Promise<Index> {
    const path = join(directory, 'index.json')
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > this.limits.maxLedgerBytes) {
        throw Error('MANUSCRIPT_VERSION_INDEX: 版本索引不是大小限制内的普通文件。')
      }
      const text = await readFile(path, { encoding: 'utf8', signal })
      if (Buffer.byteLength(text) > this.limits.maxLedgerBytes) throw Error('MANUSCRIPT_VERSION_INDEX: 版本索引过大。')
      const index = indexSchema.parse(JSON.parse(text))
      if (index.records.length > this.limits.maxVersions) throw Error('MANUSCRIPT_VERSION_LIMIT: 已有版本超出当前配置，未删除历史。')
      return index
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      return { version: 1, records: [] }
    }
  }

  private path(directory: string, value: VersionRecord): string {
    return join(directory, value.file_sha256 + value.extension)
  }

  private async original(directory: string, value: VersionRecord, signal: AbortSignal): Promise<string> {
    const path = this.path(directory, value), info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > this.limits.maxFileBytes) throw Error('MANUSCRIPT_VERSION_FILE: 历史原件不可读取。')
    const bytes = await readFile(path, { signal })
    if (bytes.length > this.limits.maxFileBytes || sha256(bytes) !== value.file_sha256) throw Error('MANUSCRIPT_VERSION_CHANGED: 历史原件摘要不一致，未替换当前稿。')
    return path
  }

  /** Preserve exact Word/Markdown/text originals with no automatic current-draft selection.
   * @param files - Complete reads whose bytes and body were obtained together.
   * @param cwd - Workspace owning this history.
   * @param session - Actual initiating Session.
   * @param signal - Cancellation before index publication.
   * @returns Verified snapshot paths in the supplied file order; repeated captures reuse the same bytes.
   */
  async capture(files: readonly ManuscriptFile[], cwd: string, session: SessionId, signal: AbortSignal): Promise<ManuscriptVersion[]> {
    if (files.length > this.limits.maxDocuments) throw Error('MANUSCRIPT_DOCUMENT_LIMIT: 本次保留的文稿过多。')
    const directory = await this.directory(cwd), file = join(directory, 'index.json')
    return withFileLock(file, async () => {
      signal.throwIfAborted()
      const index = await this.index(directory, signal), result: ManuscriptVersion[] = []
      const existingFiles = await readdir(directory, { withFileTypes: true })
      let bytesUsed = 0
      for (const entry of existingFiles) {
        if (entry.name === 'index.json' || entry.name === 'index.json.lock') continue
        const info = await lstat(join(directory, entry.name))
        if (!info.isFile() || info.isSymbolicLink()) throw Error('MANUSCRIPT_VERSION_FILE: 版本目录存在非普通原件。')
        bytesUsed += info.size
      }
      for (const input of files) {
        const extension = extname(input.document.path).toLowerCase()
        const value = record.parse({ source_path: input.document.path, file_sha256: input.document.sha256,
          text_sha256: sha256(input.document.text), extension, session_id: session })
        if (input.bytes.length > this.limits.maxFileBytes || sha256(input.bytes) !== value.file_sha256) {
          throw Error('MANUSCRIPT_VERSION_BYTES: 原件字节与正文版本不一致。')
        }
        const previous = index.records.find(row => row.source_path === value.source_path && row.file_sha256 === value.file_sha256)
        if (previous !== undefined) {
          result.push({ ...previous, snapshot_path: await this.original(directory, previous, signal) })
          continue
        }
        if (index.records.length >= this.limits.maxVersions) throw Error('MANUSCRIPT_VERSION_LIMIT: 历史版本已满，未覆盖或删除旧稿。')
        const path = this.path(directory, value)
        let exists = false
        try { await lstat(path); exists = true }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
        if (exists) await this.original(directory, value, signal)
        else {
          if (bytesUsed + input.bytes.length > this.limits.maxVersionBytes) throw Error('MANUSCRIPT_VERSION_SIZE: 历史原件空间达到配置上限，未删除旧稿。')
          const temporary = join(directory, `.${randomUUID()}.tmp`)
          try {
            await writeFile(temporary, input.bytes, { flag: 'wx', mode: 0o600, signal })
            signal.throwIfAborted()
            await link(temporary, path)
          } finally { await rm(temporary, { force: true }) }
          bytesUsed += input.bytes.length
        }
        index.records.push(value)
        result.push({ ...value, snapshot_path: path })
      }
      const text = JSON.stringify(index)
      if (Buffer.byteLength(text) > this.limits.maxLedgerBytes) throw Error('MANUSCRIPT_VERSION_INDEX: 版本索引过大，未丢弃已有版本。')
      signal.throwIfAborted()
      await writeFileAtomic(file, text + '\n', { mode: 0o600, dirMode: 0o700 })
      return result
    }, { waitMs: this.limits.lockWaitMs })
  }

  /** List exact historical originals for explicitly named source files, including missing current paths.
   * @param paths - Source names, never automatically inferred from directory order.
   * @param cwd - Owning workspace.
   * @param signal - Cancellation.
   * @returns Historical records with verified original bytes; a missing history remains empty.
   */
  async history(paths: readonly string[], cwd: string, signal: AbortSignal): Promise<ManuscriptVersion[]> {
    if (paths.length > this.limits.maxDocuments || paths.some(path => !isManuscript(path))) throw Error('MANUSCRIPT_DOCUMENT_LIMIT: 历史查询需明确大小限制内的文稿列表。')
    const directory = await this.directory(cwd), canonicalCwd = await realpath(cwd)
    const canonical = await Promise.all(paths.map(async (path) => {
      const absolute = resolve(canonicalCwd, path)
      try { return await realpath(absolute) }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return absolute; throw error }
    }))
    return withFileLock(join(directory, 'index.json'), async () => {
      const index = await this.index(directory, signal)
      return Promise.all(index.records.filter(row => canonical.includes(row.source_path)).map(async value =>
        ({ ...value, snapshot_path: await this.original(directory, value, signal) })))
    }, { waitMs: this.limits.lockWaitMs })
  }
}

/** Read explicitly supplied manuscripts before capturing them; no file content becomes an instruction.
 * @param paths - Actual selected source files.
 * @param cwd - Owning workspace.
 * @param limits - File, text and history budgets.
 * @param session - Initiating Session.
 * @param signal - Cancellation.
 * @returns Original-file versions, retaining DOCX comments and formatting in archived bytes.
 */
export async function snapshotManuscripts(paths: readonly string[], cwd: string, limits: ManuscriptVersionLimits,
  session: SessionId, signal: AbortSignal): Promise<ManuscriptVersion[]> {
  if (paths.length > limits.maxDocuments) throw Error('MANUSCRIPT_DOCUMENT_LIMIT: 本次保留的文稿过多。')
  const files = await Promise.all(paths.map(path => readManuscriptFile(path, cwd, limits, signal)))
  if (new Set(files.map(file => file.document.path)).size !== files.length) throw Error('MANUSCRIPT_DUPLICATE_PATH: 同一文稿不能重复保留。')
  return new ManuscriptVersions(limits).capture(files, cwd, session, signal)
}
