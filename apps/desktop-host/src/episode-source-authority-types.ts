/** Same-process authority for a specific Session's verified source review. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { GenerationSessionBinding } from '@deepseek-ai/dsh-tool-jubian/generation-binding'
import type { SourceQaEvidenceBinding } from '@deepseek-ai/dsh-tool-episode-render'

/** Revocable source-review authority owned by the native Host. */
export interface EpisodeSourceQaAuthority {
  readonly binding: GenerationSessionBinding
  readonly sessionId: SessionId
  readonly workspaceRoot: string
  readonly signal: AbortSignal
  assertCurrent(): void
  verify(binding: SourceQaEvidenceBinding, signal: AbortSignal): Promise<void>
  /** Hold the actual Agent maintenance slot while committing. */
  withPublication<T>(publish: (signal: AbortSignal) => Promise<T>): Promise<T>
  release(): void
}

/** Resolve a recorded review Session through real Host ownership and evidence. */
export type EpisodeSourceAuthorityFactory = (sessionId: SessionId, projectDir: string, signal: AbortSignal,
  expected?: GenerationSessionBinding) => Promise<EpisodeSourceQaAuthority>
