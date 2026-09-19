/**
 * Shared fixture: a real temp notes tree served by the real local filesystem
 * backend.
 *
 * The real backend, not a mocked `ctx.fs`, because the gates under test are only
 * meaningful against a real filesystem: a `..` segment, a symlink whose
 * category leaves the root, a file whose extension is not markdown, and a
 * version token that moves when somebody else writes. A fake provider would
 * make a string-prefix containment check pass this file, which is exactly the
 * defect the gate exists to prevent.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { AgentNotes, type Config } from '../src/index.ts'

/** One temp tree: the notes root inside it, and siblings outside the root. */
export interface Harness {
  /** Absolute directory holding the whole temp tree. */
  readonly base: string
  /** Absolute notes root the service is configured with. */
  readonly root: string
  /** A directory beside the root, used as the escape target for symlinks. */
  readonly outside: string
  /** The host context carrying the filesystem capability. */
  readonly ctx: Context
  /** The service under test. */
  readonly notes: AgentNotes
  dispose(): Promise<void>
}

/**
 * Create the temp tree and a context with the local backend, then mount the
 * service under test.
 *
 * The harness's own `root` directory always exists, so a test that needs the
 * absent or not-a-directory case removes or replaces it deliberately.
 * @param prefix - temp directory prefix naming the suite.
 * @param configure - overrides for the service config.
 * @returns the harness; dispose it in `afterEach`.
 */
export async function openNotes(prefix: string, configure: Partial<Config> = {}): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), prefix))
  const root = join(base, 'notes')
  const outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalFileSystem, { cwd: base })
  const notes = new AgentNotes(ctx, {
    root: configure.root ?? root,
    maxNotes: configure.maxNotes ?? 2000,
  })
  return {
    base,
    root,
    outside,
    ctx,
    notes,
    dispose: async () => {
      await fiber.dispose()
      await rm(base, { recursive: true, force: true })
    },
  }
}

/**
 * Write one note into the harness's root, creating its category directory.
 * @param harness - the tree to write into.
 * @param id - root-relative note id ending in `.md`.
 * @param text - the note's complete text.
 * @returns the note's absolute path on disk.
 */
export async function writeNote(harness: Harness, id: string, text: string): Promise<string> {
  const path = join(harness.root, ...id.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
  return path
}

/**
 * Point a root-relative id at a target outside the root through a symlink,
 * creating whatever parent directory the id needs.
 * @param harness - the tree to link inside.
 * @param id - root-relative id ending in `.md` whose file becomes a link.
 * @param target - the absolute path the link points at.
 * @returns whether the link was created; a host that refuses (Windows without
 *   developer mode) reports `false` so the spec can skip rather than fail.
 */
export async function linkNote(harness: Harness, id: string, target: string): Promise<boolean> {
  const path = join(harness.root, ...id.split('/'))
  await mkdir(dirname(path), { recursive: true })
  try {
    await symlink(target, path, 'file')
    return true
  } catch {
    return false
  }
}

/**
 * Await an operation expected to fail with a Remote error.
 * @param operation - the call under test.
 * @returns the Remote failure's code and details.
 */
export async function failureOf(operation: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  try {
    await operation
  } catch (error: unknown) {
    const failure = remoteErrorOf(error)
    // A non-Remote throw is a defect in the service, not an expected outcome.
    if (failure === undefined) throw error
    return { code: failure.code, details: failure.details }
  }
  throw new Error('expected the operation to fail')
}
