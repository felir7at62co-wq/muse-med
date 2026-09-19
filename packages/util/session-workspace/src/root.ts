/**
 * Turn a session's working directory into a production root this plugin may use.
 *
 * Two decisions are baked in, and both are about refusing to guess:
 *
 * - **The stated directory wins, the configured one is only a fallback.** A deployment that configures a
 *   root usually does it because some sessions carry no cwd; treating that root as stronger than the
 *   session's own directory would silently show one conversation another conversation's work.
 * - **A root is verified, never assumed.** Missing, non-directory, symlinked and otherwise redirected paths
 *   are all refused, because a plugin that follows a link out of the operator's directory is a plugin that
 *   writes where nobody asked it to. Nothing here is created: a read that founds a directory is a bug.
 */
import { existsSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { DomainRecordError } from './errors.ts'

/** A verified place one plugin may read from and produce into. */
export interface ProductionRoot {
  /** Absolute, real (not redirected) directory the session stated or the deployment configured. */
  root: string
  /** Whether the directory the caller asked for was the session's own, rather than the fallback. */
  fromSession: boolean
}

/** Inputs for one resolution; the path always comes from trusted metadata, never from a model argument. */
export interface ResolveRootInput {
  /** The session's absolute working directory, when it stated one. */
  sessionCwd?: string | undefined
  /** The deployment's configured root, used only when the session states none. */
  configuredRoot?: string | undefined
  /** Human-readable name of the configured root, for the failure message. */
  configuredLabel?: string
}

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase()

/**
 * Verify one absolute directory: it exists, it is a real directory, and it is not a link.
 * @param path - Candidate absolute path.
 * @param label - What to call it when refusing, e.g. "session working directory".
 * @returns The same path once verified.
 */
export async function verifiedDirectory(path: string, label: string): Promise<string> {
  if (typeof path !== 'string' || !path.trim() || !isAbsolute(path)) {
    throw new DomainRecordError('INVALID_ARGUMENT', `${label} must be an absolute path, received '${String(path)}'`)
  }
  if (!existsSync(path)) throw new DomainRecordError('NOT_FOUND', `${label} '${path}' does not exist`)
  const info = await lstat(path)
  // Redirect first: a junction can report itself as neither a plain directory nor a plain symlink, and
  // calling a redirect "not a directory" sends the operator looking for the wrong problem.
  if (info.isSymbolicLink() || !same(await realpath(path), path)) {
    throw new DomainRecordError('OUTSIDE_WORKSPACE', `${label} '${path}' is redirected`)
  }
  if (!info.isDirectory()) throw new DomainRecordError('INVALID_ARGUMENT', `${label} '${path}' is not a directory`)
  return path
}

/**
 * Resolve the directory a plugin should produce into.
 * @param input - The session's cwd and the deployment's fallback.
 * @returns The verified root and where it came from.
 */
export async function resolveProductionRoot(input: ResolveRootInput): Promise<ProductionRoot> {
  if (input.sessionCwd !== undefined && input.sessionCwd.trim()) {
    return { root: resolve(await verifiedDirectory(input.sessionCwd, 'session working directory')), fromSession: true }
  }
  if (input.configuredRoot !== undefined && input.configuredRoot.trim()) {
    const label = input.configuredLabel ?? 'configured workspace root'
    return { root: resolve(await verifiedDirectory(input.configuredRoot, label)), fromSession: false }
  }
  throw new DomainRecordError('DEPENDENCY_MISSING',
    'No working directory is known for this session; open the conversation in the project directory, '
    + 'or configure a workspace root for this plugin')
}

/**
 * Resolve an optional subdirectory of a production root, refusing traversal and redirects.
 * @param root - A root already returned by {@link resolveProductionRoot}.
 * @param parts - Path segments below it, e.g. `short-drama`, drawn from trusted configuration.
 * @returns The absolute subdirectory path; creating it remains the caller's decision.
 */
export async function productionSubdirectory(root: string, ...parts: string[]): Promise<string> {
  const path = resolve(root, ...parts)
  const suffix = path.slice(root.length).replaceAll('\\', '/')
  if (!path.toLowerCase().startsWith(root.toLowerCase()) || (!suffix.startsWith('/') && suffix !== '')) {
    throw new DomainRecordError('OUTSIDE_WORKSPACE', 'Production path escapes its workspace root')
  }
  // Verify each existing segment rather than only the leaf: a redirected parent is just as effective.
  let current = root
  for (const part of parts) {
    current = resolve(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || (info.isDirectory() && !same(await realpath(current), current))) {
        throw new DomainRecordError('OUTSIDE_WORKSPACE', `Production path '${part}' is redirected`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  return path
}
