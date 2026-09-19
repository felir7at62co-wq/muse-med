/**
 * Session-scoped workspace resolution shared by every plugin in this deployment.
 *
 * The point of this package is that "which directory is this session working in" has **one** answer. The
 * generation plugin, the audio plugin and the production panel all need it, and three private copies would
 * be three behaviours the day one of them is fixed. Nothing here writes: a resolver that created a
 * directory would impose one product's layout on another, and a read that has side effects is a bug.
 */
export { DomainRecordError, unknownFailureMessage } from './errors.ts'
export { sessionLookup, sessionDirectory, trySessionDirectory } from './session.ts'
export type { SessionId, SessionLookup, SessionDirectory } from './session.ts'
export { verifiedDirectory, resolveProductionRoot, productionSubdirectory } from './root.ts'
export type { ProductionRoot, ResolveRootInput } from './root.ts'
