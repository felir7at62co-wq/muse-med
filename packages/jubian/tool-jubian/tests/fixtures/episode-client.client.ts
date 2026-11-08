/** Typed generated episode namespace with the real resource registry for client lifecycle owners. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ResourceRegistry } from '@deepseek-ai/dsh-client-resources/src/client/resources.ts'
import { onTestFinished, vi } from 'vitest'
import type { EpisodeAttemptId, EpisodeDeliveryStatus, EpisodeReadiness, VideoArtifactSha256 } from '../../src/types.ts'
import { EpisodeDirectory, type EpisodeClient } from '../../src/client/episode-directory.ts'
import { registerEpisodeResources } from '../../src/client/episode-resources.ts'

export const input = { projectDir: '/project', episode: 1, digest: brandString<VideoArtifactSha256>('a'.repeat(64)) }
export const attempt = brandString<EpisodeAttemptId>('00000000-0000-4000-8000-000000000001')
export const ready: EpisodeReadiness = { ...input, ready: true, shots: 1, issues: [], renderer: null }
export const unadmitted: EpisodeDeliveryStatus = { ...input, state: 'not-admitted', attempt: null, canResume: false }
export const original: EpisodeDeliveryStatus = { ...input, state: 'unknown', attempt, canResume: false }

/** Create a generated namespace fixture with real registration/resource lifetimes.
 * @param overrides - Controlled actual namespace methods, including held replies.
 * @param pollIntervalMs - Fixture interval for pending status observations.
 * @returns Controller, actual registry and typed namespace spies.
 */
export function episodeClientFixture(overrides: Partial<EpisodeClient> = {}, pollIntervalMs = 1000) {
  const ctx = new Context(), resources = new ResourceRegistry(ctx)
  ctx.effect(() => ctx.provide('resources', resources))
  const api: EpisodeClient = { episodeReadiness: vi.fn<EpisodeClient['episodeReadiness']>(async () => ({ ok: true, value: ready })),
    episodeHistory: vi.fn<EpisodeClient['episodeHistory']>(async () => ({ ok: true, value: { projectDir: input.projectDir, episode: input.episode,
      entries: [{ attempt, digest: input.digest, recordedState: 'unknown' }], truncated: false, unreadableRecords: 0, scannedEntries: 1 } })),
    episodeStatus: vi.fn<EpisodeClient['episodeStatus']>(async () => ({ ok: true, value: unadmitted })),
    admitEpisode: vi.fn<EpisodeClient['admitEpisode']>(async () => ({ ok: true, value: original })), ...overrides }
  const notices = vi.fn(), directory = new EpisodeDirectory(notices)
  const providers = registerEpisodeResources(ctx, api, directory, pollIntervalMs)
  const connect = (client = api) => directory.connect(client, (address, signal) => { resources.pin(address, signal) })
  const disconnect = connect()
  onTestFinished(async () => { directory.dispose(); providers(); await ctx.fiber.dispose() })
  const waitReady = async () => {
    directory.check(input)
    await vi.waitFor(() => { if (!directory.state.getSnapshot().statusAddress) throw new Error('Status not opened') })
    await vi.waitFor(() => { if (resources.source(directory.state.getSnapshot().statusAddress).getSnapshot().status !== 'live') throw new Error('Status not live') })
  }
  return { ctx, resources, api, notices, directory, connect, disconnect, waitReady }
}
