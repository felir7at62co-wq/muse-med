/** Application-issued screenplay artifact identities. @module screenplay-project/ids */
import type { Branded } from '@deepseek-ai/dsh-brand'
/** Identity of one screenplay project. */
export type ProjectId = Branded<'ScreenplayProjectId'>
/** Digest-derived identity of an immutable source. */
export type SourceId = Branded<'ScreenplaySourceId'>
/** Identity of an original source line or speech segment. */
export type UnitId = Branded<'ScreenplayUnitId'>
/** Identity of one immutable source classification. */
export type FactId = Branded<'ScreenplayFactId'>
/** Identity of one immutable episode candidate. */
export type CandidateId = Branded<'ScreenplayCandidateId'>
/** Session identity owning a source proposal, draft, or review. */
export type ActorId = Branded<'ScreenplayActorId'>
