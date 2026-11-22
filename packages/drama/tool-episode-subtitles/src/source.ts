/**
 * The `source` switch of `episode_subtitles`: each value names one episode provider behind {@link EpisodeSource}.
 *
 * `local` reads the project on this computer. `jingliu` needs Jingliu's edit-plan route; until that provider is
 * mounted every Jingliu episode is reported `jingliu_outdated`, which is also what an old server answers.
 */
import type { EpisodeSource } from './types.ts'

/**
 * Provider used when Jingliu's edit-plan route is unavailable.
 * @param root - Workspace folder of the Jingliu project.
 * @param project - Jingliu project ID as the model passed it.
 * @returns A source that blocks every episode with `jingliu_outdated`.
 */
export function unavailableJingliuSource(root: string, project: string): EpisodeSource {
  return { kind: 'jingliu', root, filesPattern: `jingliu/${project}/subtitles/epNN.srt`,
    resolve: async episodes => episodes.map(episode => ({ kind: 'blocked', episode, reason: 'jingliu_outdated', shots: [] })) }
}
