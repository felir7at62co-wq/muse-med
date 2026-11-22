/**
 * Stat-keyed SHA-256 cache and probe memo for one project root.
 *
 * `<root>/.muse-hash-cache.json` maps each absolute path to `{size, mtimeMs, ino, sha256}`; a file is read again
 * only when its stat changes. Probe outputs are memoized by content digest, so a re-run does not start ffprobe
 * for unchanged media. The file is rewritten under its writer lock with an atomic rename.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { fileSha256, type MediaCommandOutcome, type MediaToolkit } from '@deepseek-ai/dsh-tool-episode-render/subtitles'

interface FileEntry { readonly size: number; readonly mtimeMs: number; readonly ino: number; readonly sha256: string }

/** Name of the cache file inside a project root. */
export const HASH_CACHE_FILE = '.muse-hash-cache.json'

/** One project's digest cache, owned by one build call. */
export class HashCache {
  private readonly files = new Map<string, FileEntry>()
  private readonly probes = new Map<string, string>()
  private readonly pending = new Map<string, Promise<string>>()
  private dirty = false

  private constructor(private readonly path: string) {}

  /**
   * Load the cache of one root; a missing or unreadable cache starts empty.
   * @param root - Project or workspace root that owns the cache file.
   * @returns The loaded cache.
   */
  static async load(root: string): Promise<HashCache> {
    const cache = new HashCache(join(root, HASH_CACHE_FILE))
    let value: unknown
    try { value = JSON.parse(await readFile(cache.path, 'utf8')) }
    catch (error) {
      // A missing or damaged cache only costs re-hashing; no digest is trusted from it.
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return cache
    }
    if (typeof value !== 'object' || value === null) return cache
    const { files, probes } = value as { files?: unknown; probes?: unknown }
    if (typeof files === 'object' && files !== null) {
      for (const [path, entry] of Object.entries(files as Record<string, unknown>)) {
        const row = entry as Partial<FileEntry> | null
        if (row !== null && typeof row === 'object' && typeof row.size === 'number' && typeof row.mtimeMs === 'number'
          && typeof row.ino === 'number' && typeof row.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(row.sha256)) {
          cache.files.set(path, { size: row.size, mtimeMs: row.mtimeMs, ino: row.ino, sha256: row.sha256 })
        }
      }
    }
    if (typeof probes === 'object' && probes !== null) {
      for (const [sha, stdout] of Object.entries(probes as Record<string, unknown>)) {
        if (typeof stdout === 'string') cache.probes.set(sha, stdout)
      }
    }
    return cache
  }

  /**
   * Digest one file, reading it only when its size, modification time or inode changed.
   * @param file - Absolute path.
   * @param signal - Owning call cancellation.
   * @returns Lowercase SHA-256.
   */
  async sha256(file: string, signal?: AbortSignal): Promise<string> {
    const running = this.pending.get(file)
    if (running !== undefined) return await running
    const work = (async () => {
      const before = await stat(file)
      const cached = this.files.get(file)
      if (cached !== undefined && cached.size === before.size && cached.mtimeMs === before.mtimeMs && cached.ino === before.ino) {
        return cached.sha256
      }
      const sha256 = await fileSha256(file, signal)
      const after = await stat(file)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
        throw new Error(`${file} changed while it was being read; retry after it is written.`)
      }
      this.files.set(file, { size: after.size, mtimeMs: after.mtimeMs, ino: after.ino, sha256 })
      this.dirty = true
      return sha256
    })()
    this.pending.set(file, work)
    try { return await work }
    finally { this.pending.delete(file) }
  }

  /**
   * Wrap a media toolkit so ffprobe output is memoized by the probed file's digest.
   * @param toolkit - Real binaries and channel.
   * @returns A toolkit whose probes of unchanged files start no process.
   */
  memoizeProbes(toolkit: MediaToolkit): MediaToolkit {
    return { ...toolkit, channel: { run: async (command, args): Promise<MediaCommandOutcome> => {
      const file = args.at(-1)
      if (command !== toolkit.ffprobe || file === undefined) return await toolkit.channel.run(command, args)
      const key = `${await this.sha256(file)}:${args.slice(0, -1).join('\u0000')}`
      const known = this.probes.get(key)
      if (known !== undefined) return { code: 0, stdout: known, stderr: '' }
      const outcome = await toolkit.channel.run(command, args)
      if (outcome.code === 0) { this.probes.set(key, outcome.stdout); this.dirty = true }
      return outcome
    } } }
  }

  /**
   * Persist new digests and probes, merging with entries another writer saved meanwhile.
   * @returns When the cache file is written, or at once when nothing changed.
   */
  async save(): Promise<void> {
    if (!this.dirty) return
    await withFileLock(this.path, async () => {
      const current = await HashCache.load(this.path.slice(0, -HASH_CACHE_FILE.length - 1))
      for (const [path, entry] of this.files) current.files.set(path, entry)
      for (const [key, stdout] of this.probes) current.probes.set(key, stdout)
      await writeFileAtomic(this.path, `${JSON.stringify({ version: 1, files: Object.fromEntries(current.files),
        probes: Object.fromEntries(current.probes) })}\n`, { mode: 0o600, dirMode: 0o700 })
    })
    this.dirty = false
  }
}
