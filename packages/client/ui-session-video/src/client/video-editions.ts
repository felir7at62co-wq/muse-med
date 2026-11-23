/** Comparison candidates and browser-local adoption for a bound production shot. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionVideoShotId, SessionVideoSource } from '@deepseek-ai/dsh-session-video/types'
import { authoredShots } from './timeline.ts'

/** A playable source with an observed interval for the selected authored shot. */
export interface VideoEdition {
  readonly source: SessionVideoSource
  readonly shotId: SessionVideoShotId
  readonly number: number
  readonly startSeconds: number
  readonly endSeconds: number
}

/** Playable recordings of the same production shot, ordered by Session event. */
export interface VideoEditionSet {
  readonly key: string
  readonly items: readonly VideoEdition[]
  readonly current: VideoEdition
}

/**
 * Find comparison candidates with the same recorded script, episode, package and authored shot.
 * @param sources - current inventory of one Session.
 * @param source - selected recording, which must still be playable at its current version.
 * @param shotNumber - selected authored shot number, independent of detected cuts.
 * @returns the comparison group when at least two recordings have observed ranges.
 */
export function videoEditions(
  sources: readonly SessionVideoSource[], source: SessionVideoSource, shotNumber: number | undefined,
): VideoEditionSet | null {
  const production = source.production
  if (production?.episodeNumber === undefined || production.packageIndex === undefined || shotNumber === undefined) return null

  const candidates = sources.flatMap((candidate) => {
    const binding = candidate.production
    if (candidate.version === null || candidate.playbackUrl === null || binding === undefined
      || binding.scriptId !== production.scriptId || binding.episodeNumber !== production.episodeNumber
      || binding.packageIndex !== production.packageIndex
      || (binding.episodeId !== undefined && production.episodeId !== undefined && binding.episodeId !== production.episodeId)
      || (binding.storyboardId !== undefined && production.storyboardId !== undefined
        && binding.storyboardId !== production.storyboardId)) return []
    const cut = authoredShots(candidate).find(value => value.authoredNumber === shotNumber)
    if (cut === undefined) return []
    return [{ source: candidate, shotId: cut.id, startSeconds: cut.localStart, endSeconds: cut.localEnd }]
  }).sort((left, right) => left.source.eventSeq - right.source.eventSeq
    || (left.source.presentedIndex ?? 0) - (right.source.presentedIndex ?? 0)
    || left.source.id.localeCompare(right.source.id))

  // Missing IDs cannot disambiguate conflicting episode or storyboard records.
  const episodeIds = new Set(candidates.flatMap(({ source: item }) => item.production?.episodeId ?? []))
  const storyboardIds = new Set(candidates.flatMap(({ source: item }) => item.production?.storyboardId ?? []))
  if (episodeIds.size > 1 || storyboardIds.size > 1 || candidates.length < 2) return null
  const items = candidates.map((candidate, index) => ({ ...candidate, number: index + 1 }))
  const current = items.find(item => sameEdition(item.source, source))
  if (current === undefined) return null
  const key = JSON.stringify([production.scriptId, production.episodeNumber, production.packageIndex, shotNumber])
  return { key, items, current }
}

function sameEdition(left: SessionVideoSource, right: SessionVideoSource): boolean {
  return left.id === right.id && left.version === right.version
}

/** Map a source-local playhead by its progress through a verified shot interval.
 * @param time - Original source-local playback position.
 * @param from - Edition supplying the position.
 * @param to - Edition to preview at the corresponding position.
 * @returns A source-local position inside the destination interval.
 */
export function alignedEditionTime(time: number, from: VideoEdition, to: VideoEdition): number {
  const progress = Math.max(0, Math.min(1, (time - from.startSeconds) / (from.endSeconds - from.startSeconds)))
  return to.startSeconds + progress * (to.endSeconds - to.startSeconds)
}

function adoptionKey(sessionId: SessionId, set: VideoEditionSet): string {
  return `dsh.session-video.adopted:${JSON.stringify([sessionId, set.key])}`
}

function editionIdentity({ source }: VideoEdition): string {
  return JSON.stringify([source.id, source.version])
}

/**
 * Resolve the browser's preferred recording against current playable versions.
 * @param sessionId - Session owning the shot.
 * @param set - current candidates for the shot.
 * @returns the saved edition when its exact source version is still available.
 */
export function getAdoptedVideoEdition(sessionId: SessionId, set: VideoEditionSet): VideoEdition | null {
  try {
    const saved = localStorage.getItem(adoptionKey(sessionId, set))
    return set.items.find(item => editionIdentity(item) === saved) ?? null
  } catch (_error) {
    // Restricted browser storage can deny reads. The selected preview remains available.
    return null
  }
}

/**
 * Remember a preferred recording on this browser without modifying any video.
 * @param sessionId - Session owning the shot.
 * @param set - current candidates for the shot.
 * @param edition - recording selected by the user.
 * @returns whether the exact candidate was saved.
 */
export function adoptVideoEdition(sessionId: SessionId, set: VideoEditionSet, edition: VideoEdition): boolean {
  const candidate = set.items.find(item => sameEdition(item.source, edition.source))
  if (candidate === undefined) return false
  try {
    localStorage.setItem(adoptionKey(sessionId, set), editionIdentity(candidate))
    return true
  } catch (_error) {
    // Restricted browser storage can deny writes. Report that the preference was not saved.
    return false
  }
}
