/** Compare neighboring music candidates without interpreting plot or dialogue as keywords. */

/** Deployment-selected bounds for ordinary contiguous music changes. */
export interface ContinuityPolicy {
  maxEmotionDistance: number
  minTagOverlap: number
}

/** Measurements and labels already attached to one selected audio identity. */
export interface ContinuityTrack { valence: number; arousal: number; tags: readonly string[] }

/** Auditable transition evidence, separate from dramatic suitability or actual listening. */
export interface ContinuityFit {
  status: 'compatible' | 'review_required' | 'insufficient_tags'
  emotion_distance: number
  tag_overlap: number | null
  shared_tags: string[]
}

/** Resolve configurable continuity bounds before matching begins.
 * @param config - Deployment configuration, independent of a model's candidate choices.
 * @returns Finite emotion-distance and tag-overlap limits.
 */
export function resolveContinuityPolicy(config: {
  maxTransitionEmotionDistance?: number
  minTransitionTagOverlap?: number
}): ContinuityPolicy {
  const policy = { maxEmotionDistance: config.maxTransitionEmotionDistance ?? 3,
    minTagOverlap: config.minTransitionTagOverlap ?? 0.2 }
  if (!Number.isFinite(policy.maxEmotionDistance) || policy.maxEmotionDistance < 0 || policy.maxEmotionDistance > 16
    || !Number.isFinite(policy.minTagOverlap) || policy.minTagOverlap < 0 || policy.minTagOverlap > 1) {
    throw new Error('Invalid BGM continuity policy')
  }
  return policy
}

/** Compare emotion movement and normalized tag-set overlap between neighboring cues.
 * @param previous - The actual preceding selected track, read from the same library.
 * @param next - A current candidate with measured values and existing labels.
 * @param policy - Resolved deployment thresholds.
 * @returns Review evidence; absent tags never constitute a successful semantic check.
 */
export function continuityFit(previous: ContinuityTrack, next: ContinuityTrack, policy: ContinuityPolicy): ContinuityFit {
  const normalize = (tags: readonly string[]) => new Set(tags.map(tag => tag.trim().toLowerCase()).filter(Boolean))
  const left = normalize(previous.tags), right = normalize(next.tags)
  const shared = [...left].filter(tag => right.has(tag))
  const overlap = left.size && right.size ? shared.length / new Set([...left, ...right]).size : null
  const distance = Math.abs(previous.valence - next.valence) + Math.abs(previous.arousal - next.arousal)
  return { status: distance > policy.maxEmotionDistance || (overlap !== null && overlap < policy.minTagOverlap)
    ? 'review_required' : overlap === null ? 'insufficient_tags' : 'compatible',
  emotion_distance: Number(distance.toFixed(4)), tag_overlap: overlap === null ? null : Number(overlap.toFixed(4)), shared_tags: shared }
}
