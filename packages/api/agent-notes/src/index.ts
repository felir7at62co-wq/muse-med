/**
 * Agent Notes service: read and edit the markdown engineering notes that live
 * under one configured notes root, exposed as `agentNotes` over Typert Remote
 * so the Web Settings section can list, read, and save them.
 *
 * **Root.** The notes root is a deployment fact, not a session fact. A Web
 * Settings panel is not scoped to a session, and the tree a person keeps their
 * notes in is frequently not the workspace their sessions run in, so the row
 * configures `root` explicitly; the constructor's fallback is
 * `<process cwd>/.agents/notes`, which is the repository-local convention.
 *
 * **Boundary.** Every operation resolves a caller-supplied note id inside that
 * root and refuses anything else. The id grammar (`note-text.ts`) admits only
 * relative, `/`-separated segments, so an absolute path or a traversal segment
 * never reaches the filesystem; the resolved target is then checked with
 * `fs.contains` against the root's canonical target, which is what closes the
 * symlink case a grammar alone cannot see. A path that exists but is not a
 * regular file is refused, and a save never creates a file: this service edits
 * notes, it does not author them.
 *
 * **Concurrency.** A read returns the filesystem's opaque version token for the
 * bytes it read, and a save must present that token. A save whose token no
 * longer matches is refused instead of overwriting an edit the caller never
 * saw, so an editor that has been open across somebody else's write fails
 * loudly rather than silently.
 *
 * @module @deepseek-ai/dsh-api-agent-notes
 */

import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { noteIdSegments, noteStem, readHeadline } from './note-text.ts'
import type {
  AgentNoteSummary,
  AgentNoteText,
  AgentNotesCatalog,
  AgentNoteWriteResult,
} from './types.ts'

export type * from './types.ts'
// The id grammar is this package's published boundary rule: the Client and any
// other consumer of `agentNotes` reads the same predicate rather than
// restating it, so "what counts as a note id" has one home.
export { noteIdSegments } from './note-text.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `agentNotes` Remote namespace. */
    agentNotes: AgentNotes
  }
}

/** Deployment configuration of the notes root and its listing cap. */
export interface Config {
  /**
   * Directory holding the notes tree.
   *
   * No schema default: the constructor resolves it so the stored root is
   * absolute whatever form it arrived in, and a deployment that omits the key
   * fails at mount instead of silently reading a tree nobody named. That is the
   * loud half of the rule; the quiet half is that this is the deployment's own
   * choice, not the service's guess.
   *
   * Point it at the tree that actually holds the notes. A tree kept beside a
   * repository's source is not the workspace a session runs in, so a deployment
   * whose notes live there — the common case for Agent Notes written into the
   * checkout — must set this to that absolute path.
   */
  readonly root: string
  /**
   * Cap on notes reported by one listing. A larger tree is cut and reported as
   * `truncated` rather than silently shortened.
   */
  readonly maxNotes: number
}

/**
 * Cap on directory depth walked below the notes root.
 *
 * A notes tree is category directories holding files; this bound exists so a
 * pathological or cyclic tree cannot turn one listing into unbounded work.
 */
const MAX_DEPTH = 8

/**
 * Host Remote file reads and writes for one notes root over the composed
 * filesystem.
 */
export class AgentNotes extends TypertRemoteService {
  static inject = ['fs']

  static Config: z<Config> = z.object({
    root: z.string(),
    maxNotes: z.number().step(1).min(1).default(2000),
  })

  /** Absolute notes root this service confines every operation to. */
  private readonly root: string

  /**
   * @param ctx - host context carrying the filesystem capability.
   * @param config - deployment notes root and listing cap.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'agentNotes')
    this.root = join(config.root)
  }

  /**
   * List every note under the notes root, grouped facts only and never content.
   * @returns the catalog, its root, and whether the cap cut it. A root that
   *   does not exist reports `absent` with no notes; that is an empty state,
   *   not a failure.
   */
  @Remote
  async list(): Promise<AgentNotesCatalog> {
    const root = await this.ctx.fs.resolve(this.root)
    const rootInfo = await this.ctx.fs.stat(root)
    if (rootInfo === undefined) return { state: 'absent', root: this.root, notes: [], truncated: false }
    if (rootInfo.type !== 'directory') {
      throw new RemoteError(
        'agent-note/not-regular-file',
        `the agent notes root is a ${rootInfo.type}, not a directory`,
        { id: this.root, kind: rootInfo.type },
      )
    }

    const found: AgentNoteSummary[] = []
    let truncated = false
    const walk = async (directory: FsTarget, depth: number): Promise<void> => {
      for (const child of await this.ctx.fs.listDir(directory)) {
        if (found.length >= this.config.maxNotes) {
          truncated = true
          return
        }
        if (child.type === 'directory') {
          if (depth >= MAX_DEPTH) continue
          // A nested directory is inspected before it is entered: notes are
          // grouped by the tree's own shape, and a link out of the root is not
          // part of that shape.
          const entry = await this.ctx.fs.lstat(this.ctx.fs.processPath(child.target))
          if (entry?.type !== 'directory') continue
          await walk(child.target, depth + 1)
          continue
        }
        if (child.type !== 'file' || !child.name.toLowerCase().endsWith('.md')) continue
        found.push(await this.summarize(directory, child))
      }
    }
    await walk(root, 0)

    const notes = found.sort((left, right) =>
      left.category.localeCompare(right.category) || left.title.localeCompare(right.title))
    return { state: 'ready', root: this.root, notes, truncated }
  }

  /**
   * Read one complete note.
   * @param id - note id: a root-relative `/`-separated path ending in `.md`.
   * @returns the note's text, its resolved headline facts, and the version a
   *   following save must present.
   */
  @Remote
  async read(id: string): Promise<AgentNoteText> {
    const { target, info } = await this.locate(id)
    const text = await this.ctx.fs.readText(target)
    const headline = readHeadline(noteStem(id), text)
    return {
      id,
      title: headline.title,
      ...headline.status === undefined ? {} : { status: headline.status },
      text,
      version: info.version,
      bytes: info.size ?? Buffer.byteLength(text, 'utf8'),
    }
  }

  /**
   * Replace one note's complete text.
   *
   * The write is guarded by {@link expectedVersion}, so it replaces only the
   * bytes the caller read. It never creates a file: a note id with no note
   * behind it is refused, because authoring notes is the agent's and the
   * person's job, not this service's.
   *
   * @param id - note id: a root-relative `/`-separated path ending in `.md`.
   * @param text - the complete new note text.
   * @param expectedVersion - the version returned by the read this edit is based on.
   * @returns the note's version and size after the write.
   */
  @Remote
  async save(id: string, text: string, expectedVersion: string): Promise<AgentNoteWriteResult> {
    if (typeof text !== 'string') {
      throw new RemoteError('gateway/bad-request', 'note text must be a string', {})
    }
    const { target } = await this.locate(id)
    let outcome
    try {
      outcome = await this.ctx.fs.writeText(target, text, {
        kind: 'replaceIfVersion',
        // The version token is opaque: it round-trips as the string the read
        // returned and is never parsed here.
        version: expectedVersion as FsInfo['version'],
      })
    } catch (error: unknown) {
      // The version fence is the caller's own, so its refusal is a domain
      // outcome the editor reports, not an infrastructure failure. It is
      // recognized by the filesystem's stable code rather than by class
      // identity, which differs between installed copies of the backend.
      if (isStaleVersionRefusal(error)) {
        throw new RemoteError(
          'agent-note/stale',
          `"${id}" changed since it was read; reload it before saving`,
          { id },
          { cause: error },
        )
      }
      throw error
    }
    const info = await this.ctx.fs.stat(target)
    return {
      id,
      version: outcome.version,
      bytes: info?.size ?? Buffer.byteLength(text, 'utf8'),
    }
  }

  /**
   * Resolve one note id to its confined, existing regular-file target.
   *
   * Every gate for a note id lives here so `read` and `save` cannot drift
   * apart: the id grammar, canonical containment inside the root, and the
   * regular-file check.
   * @param id - the caller-supplied note id.
   * @returns the target and its current metadata.
   */
  private async locate(id: string): Promise<{ target: FsTarget; info: FsInfo }> {
    const segments = noteIdSegments(id)
    if (segments === undefined) {
      throw new RemoteError(
        'agent-note/bad-id',
        `"${id}" is not a root-relative path to one markdown note inside the notes root`,
        { id },
      )
    }
    // The final component is inspected before it is followed, so a note that
    // is itself a link is refused by kind rather than by where it points.
    const entry = await this.ctx.fs.lstat(join(...segments), { cwd: this.root })
    if (entry === undefined) throw new RemoteError('agent-note/not-found', `no note at "${id}"`, { id })
    if (entry.type !== 'file') {
      throw new RemoteError('agent-note/not-regular-file', `"${id}" is a ${entry.type}`, { id, kind: entry.type })
    }

    const root = await this.ctx.fs.resolve(this.root)
    const target = await this.ctx.fs.resolve(join(...segments), { cwd: this.root })
    if (!this.ctx.fs.contains(root, target)) {
      throw new RemoteError('agent-note/outside-root', `"${id}" resolves outside the notes root`, { id })
    }

    const info = await this.ctx.fs.stat(target)
    // The entry was inspected before resolution followed it; the stat re-checks
    // what that probe saw, because the file may have moved or changed kind.
    if (info === undefined) throw new RemoteError('agent-note/not-found', `no note at "${id}"`, { id })
    if (info.type !== 'file') {
      throw new RemoteError('agent-note/not-regular-file', `"${id}" is a ${info.type}`, { id, kind: info.type })
    }
    return { target, info }
  }

  /**
   * Read one child's headline facts.
   *
   * The id is the child's path relative to the notes root, `/`-joined, so it
   * round-trips through {@link locate} unchanged — including for a note nested
   * deeper than one category directory. The category is the id's own first
   * segment, derived from the same value rather than tracked during the walk,
   * so a row can never claim a category its id does not have.
   * @param directory - the directory the child was listed in.
   * @param child - the listed markdown child.
   * @returns the summary row.
   */
  private async summarize(directory: FsTarget, child: FsDirEntry): Promise<AgentNoteSummary> {
    const id = await this.idOf(directory, child.name)
    const text = await this.ctx.fs.readText(child.target)
    const headline = readHeadline(noteStem(id), text)
    const modifiedMs = await lastModifiedMs(this.ctx.fs.processPath(child.target))
    return {
      id,
      category: id.includes('/') ? id.slice(0, id.indexOf('/')) : '',
      title: headline.title,
      ...headline.status === undefined ? {} : { status: headline.status },
      ...headline.summary === undefined ? {} : { summary: headline.summary },
      ...modifiedMs === undefined ? {} : { modifiedMs },
    }
  }

  /**
   * Derive one listed child's note id from the canonical root-relative path.
   *
   * The id is computed from the two resolved targets rather than concatenated
   * while walking, so it always names the file that was actually listed: the
   * same value {@link locate} will resolve back, with no walk-order state that
   * could drift from the tree.
   * @param directory - the directory the child was listed in.
   * @param name - the child's basename.
   * @returns the `/`-joined root-relative note id.
   */
  private async idOf(directory: FsTarget, name: string): Promise<string> {
    const root = await this.ctx.fs.resolve(this.root)
    const prefix = rootRelative(this.ctx.fs.fileUrl(root), this.ctx.fs.fileUrl(directory))
    return prefix.length === 0 ? name : `${prefix}/${name}`
  }
}

/**
 * Observe one file's last-modification time.
 *
 * The composed filesystem exposes an opaque version token and a size, but no
 * wall-clock timestamp, and the catalog orders and labels rows by "when did I
 * last touch this note". This is therefore a deliberate, narrow `node:fs` read
 * of one stat field over a path the filesystem itself resolved — never a
 * second route into note content, which always goes through `ctx.fs`.
 *
 * A filesystem whose targets do not exist in the harness host's own namespace
 * (a remote or sandboxed backend) reports no time, and the row simply omits it.
 *
 * @param path - absolute process path of the note, as the filesystem resolved it.
 * @returns the epoch milliseconds of the last modification, or `undefined` when unobservable.
 */
async function lastModifiedMs(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * The backend's stale-version refusal, recognized by its stable code alone:
 * the error class belongs to whichever `dsh-fs` instance the provider loaded,
 * so no class identity is shared across the package boundary.
 * @param error - a caught value.
 * @returns whether the filesystem refused the write as stale.
 */
function isStaleVersionRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'FS_STALE_VERSION'
}

/**
 * The `/`-joined path of `target` relative to `root`, derived from the two
 * canonical `file:` URIs so the answer is `/`-separated on every platform.
 * @param rootUrl - canonical `file:` URI of the notes root.
 * @param targetUrl - canonical `file:` URI of the listed directory.
 * @returns the relative path, empty for the root itself.
 */
function rootRelative(rootUrl: string, targetUrl: string): string {
  const root = new URL(rootUrl).pathname.replace(/\/+$/, '')
  const target = new URL(targetUrl).pathname.replace(/\/+$/, '')
  if (target === root) return ''
  /* v8 ignore next -- a listed directory is always inside the resolved root. */
  if (!target.startsWith(`${root}/`)) return ''
  return target.slice(root.length + 1).split('/').map(decodeURIComponent).join('/')
}

export default AgentNotes
