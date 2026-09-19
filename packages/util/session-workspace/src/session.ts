/**
 * Which directory is this session working in, and is it one a plugin may produce into?
 *
 * The harness records one absolute working directory per session at creation
 * (`Session.header.cwd`, validated when it enters the store). That value is the only honest answer to
 * "where does this conversation work" — the process's own `cwd` is the deployment's, not the operator's.
 *
 * This module is deliberately read-only. Founding a directory, writing an identity file or creating a
 * layout is the caller's decision, because two products disagree about it: one wants a checked-in identity
 * record, another only wants the path. A resolver that silently created things would impose one on the
 * other, and a *read* that creates a directory is a bug regardless.
 */
import { DomainRecordError, unknownFailureMessage } from './errors.ts'

/** Opaque session identity as the session store spells it. */
export type SessionId = string
/** The one lookup this module needs from the Host's session service. */
export interface SessionLookup {
  get: (id: SessionId) => { readonly header: { readonly cwd?: string } } | undefined
}
/** What a caller learns about one session's directory. */
export interface SessionDirectory {
  sessionId: SessionId
  /** Absolute working directory, or undefined when the session was opened without one. */
  cwd: string | undefined
}

/**
 * Narrow the Host context to the session lookup, without requiring a service that may be absent.
 * @param ctx - Host context, or anything that may or may not expose `sessions`.
 * @returns The lookup, or undefined when this deployment composes no session service.
 */
export function sessionLookup(ctx: { get?: (name: string, strict?: false) => unknown }): SessionLookup | undefined {
  if (typeof ctx.get !== 'function') return undefined
  const sessions = ctx.get('sessions', false) as SessionLookup | undefined
  return sessions !== undefined && typeof sessions.get === 'function' ? sessions : undefined
}

/**
 * Resolve the directory a session was opened in.
 * @param sessions - The Host's session lookup, when it has one.
 * @param sessionId - Session whose working directory is wanted.
 * @returns The session and its absolute cwd; an unknown session is an explicit failure, not a fallback.
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
 * Resolve one session's directory without throwing when it cannot be known.
 * @param sessions - The Host's session lookup, when it has one.
 * @param sessionId - Session identity, possibly absent or already unknown.
 * @returns The absolute cwd, or undefined; callers use this when a missing answer is a normal case.
 */
export function trySessionDirectory(sessions: SessionLookup | undefined, sessionId: unknown): string | undefined {
  if (sessions === undefined || typeof sessionId !== 'string' || !sessionId.trim()) return undefined
  try { return sessions.get(sessionId)?.header.cwd } catch { return undefined }
}

export { DomainRecordError, unknownFailureMessage }
