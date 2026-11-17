/** Consecutive slices of an oversized cross-episode schedule, each reviewed by its own reviewer. */
import type { EpisodePair } from './manuscript-episode-checks.ts'
import type { ManuscriptMaterialEpisode, ManuscriptMaterialRange } from './manuscript-materials.ts'

/** Scheduled boundaries of one reviewer and the extracted lines holding exactly their complete episodes. */
export interface EpisodeWindow {
  checks: EpisodePair[]
  lines: ManuscriptMaterialRange
}

/** Split scheduled boundaries into chains of adjacent episodes, then into balanced windows of at most `maxChecks`.
 * @param checks - Complete Host schedule in manuscript order; every episode it names is complete in the reviewed read.
 * @param episodes - Episode index of the same file version that produced the schedule.
 * @param maxChecks - Maximum boundaries one reviewer assesses.
 * @returns Windows that together cover every check exactly once; a window never spans an unscheduled boundary,
 * so its line range contains only episodes that were complete in the original selection.
 */
export function episodeWindows(checks: readonly EpisodePair[], episodes: readonly ManuscriptMaterialEpisode[],
  maxChecks: number): EpisodeWindow[] {
  const sections = new Map(episodes.map(episode => [episode.episode, episode]))
  const section = (episode: number): ManuscriptMaterialEpisode => {
    const value = sections.get(episode)
    if (value === undefined) throw Error(`CROSS_EPISODE_WINDOW: 集界计划中的第${episode}集不在同一版本的分集索引中。`)
    return value
  }
  const chains: EpisodePair[][] = []
  for (const check of checks) {
    const chain = chains.at(-1)
    if (chain?.at(-1)?.to_episode === check.from_episode) chain.push(check)
    else chains.push([check])
  }
  return chains.flatMap((chain) => {
    // (count - 1) * size < chain.length because size <= maxChecks, so no window is empty.
    const count = Math.ceil(chain.length / maxChecks), size = Math.ceil(chain.length / count)
    return Array.from({ length: count }, (_value, index) => {
      const slice = chain.slice(index * size, (index + 1) * size)
      return { checks: slice, lines: slice.reduce((range, pair) => ({ start: Math.min(range.start, section(pair.from_episode).start),
        end: Math.max(range.end, section(pair.to_episode).end) }), { start: Number.POSITIVE_INFINITY, end: 0 }) }
    })
  })
}
