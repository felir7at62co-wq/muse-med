/**
 * The current approved selection of one local episode, as `episode_subtitles` resolves it.
 *
 * Draft builders read the selection through this module so that a re-approved, trimmed or regenerated shot is
 * compared with the subtitle receipt even before `episode_subtitles` runs again, and so that an edited script line,
 * name or review decision is compared with the digests the receipt recorded.
 */
import type { MediaToolkit, ResolvedShot, SubtitleClockInputs } from '@deepseek-ai/dsh-tool-episode-render/subtitles'
import { readDecisions, subtitleInputs } from './build.ts'
import { HashCache } from './hash-cache.ts'
import { bundledRulesDirectory, rulesDigest } from './rules.ts'
import { localShotManifestPath, resolveLocalEpisode } from './shots.ts'
import type { BlockReason } from './types.ts'

/** Current selection of one episode. */
export type LocalEpisodeSelection =
  | {
    readonly kind: 'ok'
    readonly manifest: string
    readonly clock: readonly ResolvedShot[]
    /** Current rules digest and input digests, compared with the clock receipt's. */
    readonly inputs: SubtitleClockInputs & { readonly rules_sha256: string }
  }
  | { readonly kind: 'blocked'; readonly reason: BlockReason; readonly shots: readonly number[] }

/**
 * Resolve the approved selection of one local episode and rewrite its derived shot manifest.
 * @param project - Absolute project root.
 * @param episode - Episode number.
 * @param toolkit - Media toolkit used to measure the picture clock.
 * @returns The manifest path, measured clock and subtitle inputs, or the reason and packages that block the episode.
 */
export async function localEpisodeSelection(project: string, episode: number, toolkit: MediaToolkit): Promise<LocalEpisodeSelection> {
  const hash = await HashCache.load(project)
  try {
    const resolved = await resolveLocalEpisode(project, episode, hash, hash.memoizeProbes(toolkit))
    if (resolved.kind !== 'ok') return resolved
    const inputs = { ...subtitleInputs(resolved, await readDecisions(resolved.files.decisions)),
      rules_sha256: await rulesDigest(bundledRulesDirectory()) }
    return { kind: 'ok', manifest: localShotManifestPath(project, resolved.code), clock: resolved.clock, inputs }
  } finally { await hash.save() }
}
