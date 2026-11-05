/**
 * Optional compatibility exports for recorded Session origins and trusted Node Host paths.
 * These helpers read immutable header metadata and local filesystem observations;
 * they do not track effective directory changes, grant permissions or create directories.
 */
export { DomainRecordError, unknownFailureMessage } from './errors.ts'
export { sessionLookup, sessionDirectory, trySessionDirectory } from './session.ts'
export type { SessionId, SessionLookup, SessionDirectory } from './session.ts'
export { verifiedDirectory, resolveProductionRoot, productionSubdirectory } from './root.ts'
export type { ProductionRoot, ResolveRootInput } from './root.ts'
