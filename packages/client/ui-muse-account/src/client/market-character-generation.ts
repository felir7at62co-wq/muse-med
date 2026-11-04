/** Display-only generation adapter; it neither publishes packages nor changes installed Bots. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque generation task identity assigned by the provider. */
export type CharacterJobId = Branded<'MuseCharacterJobId'>
/** Immutable candidate identity assigned by the provider. */
export type CharacterCandidateId = Branded<'MuseCharacterCandidateId'>
/** Immutable media revision, independent of a Bot package version. */
export type CharacterVersionId = Branded<'MuseCharacterVersionId'>

/** Equal-sized cells in a row-major sprite sheet; durations are positive milliseconds. */
export interface CharacterAnimation {
  readonly sheetUrl: string
  readonly columns: number
  readonly rows: number
  readonly cellWidth: number
  readonly cellHeight: number
  readonly idle: readonly { readonly cell: number; readonly durationMs: number }[]
  readonly introduce: readonly { readonly cell: number; readonly durationMs: number }[]
}

/** Frozen author information used for one portrait generation. */
export interface CharacterBrief {
  readonly title: string
  readonly description: string
  readonly role: string
  readonly introduction: string
}

/** A generated portrait that must be selected before animation generation. */
export interface CharacterCandidate extends CharacterBrief {
  readonly id: CharacterCandidateId
  readonly posterUrl: string
}

/** Completed media revision; applying it changes only the current local preview. */
export interface CharacterVersion {
  readonly id: CharacterVersionId
  readonly candidate: CharacterCandidate
  readonly animation: CharacterAnimation
}

/** Generation states are separate from publication and review states. */
export type CharacterJob = { readonly id: CharacterJobId } & (
  | { readonly status: 'queued' | 'running'; readonly kind: 'portraits' | 'animation' }
  | { readonly status: 'failed'; readonly kind: 'portraits' | 'animation' }
  | { readonly status: 'succeeded'; readonly kind: 'portraits'; readonly candidates: readonly CharacterCandidate[] }
  | { readonly status: 'succeeded'; readonly kind: 'animation'; readonly version: CharacterVersion }
)

/** Provider operations consumed through page injection, without browser credentials or provider keys. */
export interface CharacterGenerationActions {
  readonly mode: 'preview' | 'connected'
  readonly pollIntervalMs: number
  readonly timeoutMs: number
  /** Start portrait generation using the provider's official Muse reference and style template.
   * @param brief Frozen author fields, never interpreted as Bot execution instructions.
   * @param signal Cancels this request; it does not promise remote job cancellation.
   * @returns Created or already completed portrait task.
   */
  startPortraits(brief: CharacterBrief, signal: AbortSignal): Promise<CharacterJob>
  /** Animate the selected immutable portrait, preserving its identity.
   * @param candidate Selected portrait returned by this provider.
   * @param signal Cancels this request, without cancelling a persisted remote task.
   * @returns Created or completed animation task.
   */
  startAnimation(candidate: CharacterCandidate, signal: AbortSignal): Promise<CharacterJob>
  /** Read a task until a terminal state is returned.
   * @param id Provider-issued task identity.
   * @param signal Cancels the current request.
   * @returns Authoritative task state; wire validation belongs in the adapter.
   */
  readJob(id: CharacterJobId, signal: AbortSignal): Promise<CharacterJob>
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Generation wait aborted', 'AbortError'))
    }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** Poll one operation, stopping immediately when the owner aborts or the provider settles.
 * @param actions Provider callbacks and polling interval.
 * @param initial Created task.
 * @param signal Operation lifetime, including the caller's deadline.
 * @param progress Queued/running UI updates for this operation only.
 * @returns Terminal task; failure details remain provider-private.
 */
export async function settleCharacterJob(actions: CharacterGenerationActions, initial: CharacterJob,
  signal: AbortSignal, progress: (job: CharacterJob) => void): Promise<CharacterJob> {
  let job = initial
  signal.throwIfAborted()
  progress(job)
  while (job.status === 'queued' || job.status === 'running') {
    await pause(actions.pollIntervalMs, signal)
    job = await actions.readJob(job.id, signal)
    signal.throwIfAborted()
    progress(job)
  }
  return job
}
