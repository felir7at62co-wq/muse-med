/**
 * Inspect trusted production-root metadata with the Node Host filesystem.
 * A stated session-origin directory takes precedence over the configured
 * fallback. Checks observe existing paths without creating them or granting
 * Session filesystem access; callers own writes and authorization.
 */
import { existsSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { DomainRecordError } from './errors.ts'

/** Observed Node Host directory selected for caller-authorized production output. */
export interface ProductionRoot {
  /** Absolute Host directory selected from trusted session-origin or deployment metadata. */
  root: string
  /** Whether the session-origin input selected the root instead of the configured fallback. */
  fromSession: boolean
}

/** Inputs for one resolution; the path always comes from trusted metadata, never from a model argument. */
export interface ResolveRootInput {
  /** Trusted session-origin directory, typically the initial Session.header.cwd. */
  sessionCwd?: string | undefined
  /** The deployment's configured root, used only when the session states none. */
  configuredRoot?: string | undefined
  /** Human-readable name of the configured root, for the failure message. */
  configuredLabel?: string
}

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase()

/**
 * Check an existing absolute Node Host directory with lstat and realpath.
 * @param path - Candidate absolute path.
 * @param label - What to call it when refusing, e.g. "session working directory".
 * @returns The same path after local checks; this observation does not authorize later access.
 */
export async function verifiedDirectory(path: string, label: string): Promise<string> {
  if (typeof path !== 'string' || !path.trim() || !isAbsolute(path)) {
    throw new DomainRecordError('INVALID_ARGUMENT', `${label} must be an absolute path, received '${path}'`)
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
 * Select and inspect a trusted Node Host production root without creating it.
 * @param input - Trusted session-origin directory and deployment fallback.
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
