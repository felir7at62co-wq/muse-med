/**
 * Read the initial directory recorded in Session.header.cwd.
 * Effective directory changes belong to the working-directory service. These
 * compatibility helpers only inspect header metadata and never create paths.
 */
import { DomainRecordError, unknownFailureMessage } from './errors.ts'

/** Opaque session identity as the session store spells it. */
export type SessionId = string
/** The one lookup this module needs from the Host's session service. */
export interface SessionLookup {
  get: (id: SessionId) => { readonly header: { readonly cwd?: string } } | undefined
}
/** A Session's recorded origin, independent of its effective working directory. */
export interface SessionDirectory {
  sessionId: SessionId
  /** Initial header.cwd, or undefined when the Session was opened without one. */
  cwd: string | undefined
}

/**
 * Narrow the Host context to the session lookup, without requiring a service that may be absent.
 * @param ctx - Host context, or anything that may or may not expose `sessions`.
 * @returns The lookup, or undefined for a null, absent, or non-callable session service.
 */
export function sessionLookup(ctx: { get?: (name: string, strict?: false) => unknown }): SessionLookup | undefined {
  if (typeof ctx.get !== 'function') return undefined
  const sessions = ctx.get('sessions', false) as SessionLookup | null | undefined
  return sessions !== null && sessions !== undefined && typeof sessions.get === 'function' ? sessions : undefined
}

/**
 * Resolve the directory a session was opened in.
 * @param sessions - The Host's session lookup, when it has one.
 * @param sessionId - Session whose recorded initial directory is wanted.
 * @returns The Session and its recorded header.cwd; an unknown Session fails instead of selecting a fallback.
 */
export function sessionDirectory(sessions: SessionLookup | undefined, sessionId: string): SessionDirectory {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new DomainRecordError('INVALID_ARGUMENT', 'A session identity is required to resolve a working directory')
  }
  if (sessions === undefined) {
    throw new DomainRecordError('DEPENDENCY_MISSING',
      'This deployment has no session service, so a session working directory cannot be resolved')
  }
  const session = sessions.get(sessionId)
  if (session === undefined) {
    throw new DomainRecordError('NOT_FOUND', `Session '${sessionId}' is not live, so its working directory is unknown`)
  }
  return { sessionId, cwd: session.header.cwd }
}

/**
 * Read one Session's initial recorded directory without throwing when it is unavailable.
 * @param sessions - The Host's session lookup, when it has one.
 * @param sessionId - Session identity, possibly absent or already unknown.
 * @returns Recorded header.cwd, or undefined; effective directory changes are not read.
 */
export function trySessionDirectory(sessions: SessionLookup | undefined, sessionId: unknown): string | undefined {
  if (sessions === undefined || typeof sessionId !== 'string' || !sessionId.trim()) return undefined
  try { return sessions.get(sessionId)?.header.cwd } catch { return undefined }
}

export { DomainRecordError, unknownFailureMessage }
