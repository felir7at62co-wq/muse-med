/**
 * The current approved selection of one local episode, as `episode_subtitles` resolves it.
 *
 * Draft builders read the selection through this module so that a re-approved, trimmed or regenerated shot is
 * compared with the subtitle receipt even before `episode_subtitles` runs again.
 */
import type { MediaToolkit, ResolvedShot } from '@deepseek-ai/dsh-tool-episode-render/subtitles'
import { HashCache } from './hash-cache.ts'
import { localShotManifestPath, resolveLocalEpisode } from './shots.ts'
import type { BlockReason } from './types.ts'

/** Current selection of one episode. */
export type LocalEpisodeSelection =
  | { readonly kind: 'ok'; readonly manifest: string; readonly clock: readonly ResolvedShot[] }
  | { readonly kind: 'blocked'; readonly reason: BlockReason; readonly shots: readonly number[] }

/**
 * Resolve the approved selection of one local episode and rewrite its derived shot manifest.
 * @param project - Absolute project root.
 * @param episode - Episode number.
 * @param toolkit - Media toolkit used to measure the picture clock.
 * @returns The manifest path and measured clock, or the reason and packages that block the episode.
 */
export async function localEpisodeSelection(project: string, episode: number, toolkit: MediaToolkit): Promise<LocalEpisodeSelection> {
  const hash = await HashCache.load(project)
  try {
    const resolved = await resolveLocalEpisode(project, episode, hash, hash.memoizeProbes(toolkit))
    return resolved.kind === 'ok' ? { kind: 'ok', manifest: localShotManifestPath(project, resolved.code), clock: resolved.clock } : resolved
  } finally { await hash.save() }
}
