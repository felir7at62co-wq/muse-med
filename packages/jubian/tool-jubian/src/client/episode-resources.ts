/** Episode query providers use the shared resource lifetime and poll only pending status. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import type { EpisodeDeliveryStatus, EpisodeHistory, EpisodeReadiness, VideoArtifactSha256 } from '../types.ts'
import type { EpisodeClient, EpisodeDirectory } from './episode-directory.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Explicit measured export-readiness result. */
    'jubian-episode-readiness': EpisodeReadiness
    /** Bounded recorded original-task discovery; entries supply no resume permission. */
    'jubian-episode-history': EpisodeHistory
    /** Exact original digest observation and Host resume permission. */
    'jubian-episode-status': EpisodeDeliveryStatus
  }
}

const querySchema = z.strictObject({ kind: z.enum(['readiness', 'history', 'status']), projectDir: z.string().min(1),
  episode: z.number().int().min(1).max(99), epoch: z.number().int().nonnegative(), revision: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u).transform(value => brandString<VideoArtifactSha256>(value)).optional() })
const pending = new Set<EpisodeDeliveryStatus['state']>(['queued', 'preparing', 'running', 'stopping'])

function pause(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, delay)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

/** Register the actual generated namespace for one connection generation.
 * @param ctx - Resource-owning client scope.
 * @param client - Actual generated episode Remote namespace.
 * @param directory - Registration interaction owner.
 * @param pollIntervalMs - Validated deployment interval for pending status only.
 * @returns Removes all three providers and retires their observations.
 */
export function registerEpisodeResources(ctx: Context, client: EpisodeClient, directory: EpisodeDirectory,
  pollIntervalMs: number): () => void {
  const failed = (error: unknown): RemoteResult<never> => ({ ok: false,
    error: new RemoteError('jubian-video-recovery/rejected', error instanceof Error ? error.message : String(error), {}) })
  const parse = (address: string, kind: 'readiness' | 'history' | 'status') => {
    const url = new URL(address), query = querySchema.parse(JSON.parse(decodeURIComponent(url.pathname.slice(1))))
    if (url.protocol !== 'dsh-resource:' || url.hostname !== 'jubian-episode-' + kind || query.kind !== kind) {
      throw new Error('Invalid episode resource address')
    }
    return query
  }
  const releases: (() => void)[] = []
  try {
    releases.push(ctx.resources.register({ protocol: 'jubian-episode-readiness', async *open(address, { signal }) {
      try {
        const query = parse(address, 'readiness')
        const result = await client.episodeReadiness({ projectDir: query.projectDir, episode: query.episode })
        if (signal.aborted || !directory.current('readiness', address)) return
        if (result.ok) directory.acceptReadiness(address, result.value)
        yield result
      } catch (error) { if (!signal.aborted && directory.current('readiness', address)) yield failed(error) }
    } }))
    releases.push(ctx.resources.register({ protocol: 'jubian-episode-history', async *open(address, { signal }) {
      try {
        const query = parse(address, 'history')
        const result = await client.episodeHistory({ projectDir: query.projectDir, episode: query.episode })
        if (signal.aborted || !directory.current('history', address)) return
        if (result.ok) directory.acceptHistory(address, result.value)
        yield result
      } catch (error) { if (!signal.aborted && directory.current('history', address)) yield failed(error) }
    } }))
    releases.push(ctx.resources.register({ protocol: 'jubian-episode-status', async *open(address, { signal }) {
      try {
        const query = parse(address, 'status')
        if (query.digest === undefined) throw new Error('Original episode digest is required')
        while (!signal.aborted && directory.current('status', address)) {
          const result = await client.episodeStatus({ projectDir: query.projectDir, episode: query.episode, digest: query.digest })
          // A request can settle after resource release, independently of the preceding loop test.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AbortSignal is externally mutable across await.
          if (signal.aborted || !directory.current('status', address)) return
          if (result.ok) directory.acceptStatus(address, result.value)
          yield result
          if (!result.ok || !pending.has(result.value.state)) return
          await pause(pollIntervalMs, signal)
        }
      } catch (error) { if (!signal.aborted && directory.current('status', address)) yield failed(error) }
    } }))
  } catch (error) {
    for (const release of releases.reverse()) release()
    throw error
  }
  return () => { for (const release of releases.reverse()) release() }
}
