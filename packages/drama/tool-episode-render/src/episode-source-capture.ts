/** Capture strict source-review facts without starting media work. */
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileSha256 } from './cache.ts'
import { resolveDeliveryPolicy } from './delivery-policy.ts'
import { episodePaths, shotFileName } from './paths.ts'
import { parseShotManifest, readJsonDocument } from './prepare.ts'
import { verifySelectedSourceReviews } from './approved-sources.ts'
import { summarizeSourceQa, type SourceQaEvidenceBinding, type SourceQaVerifier } from './source-qa.ts'
import { readTimeline } from './timeline.ts'
import type { RenderSettings } from './types.ts'

/** Exact reviewed files and Host-verified tool evidence from one preparation. */
export interface EpisodeSourceCapture {
  readonly sourceQaSha256: string
  readonly selectedPaths: readonly string[]
  readonly files: readonly { readonly path: string; readonly sha256: string }[]
  readonly bindings: readonly SourceQaEvidenceBinding[]
}

/** Read and verify strict source review without making a media or provider request.
 * @param project - Original project containing source and review records.
 * @param episode - Padded episode identifier.
 * @param timelinePath - Original timeline whose clips are being rendered.
 * @param settings - Captured renderer settings for the delivery policy.
 * @param verify - Host verifier for the actual Session source evidence.
 * @returns Verified files and tool evidence, or undefined for a nonstrict delivery.
 */
export async function captureEpisodeSourceReview(project: string, episode: string, timelinePath: string,
  settings: RenderSettings, verify: SourceQaVerifier): Promise<EpisodeSourceCapture | undefined> {
  const timeline = await readTimeline(timelinePath, settings.enforceSubtitleVisual)
  const policy = await resolveDeliveryPolicy(project, timeline.delivery, settings.defaultSubtitleVisual, settings.enforceSubtitleVisual)
  if (policy.delivery.require_source_review !== true) return undefined
  const paths = episodePaths(project, episode), document = await readJsonDocument(paths.sources, '已准备选源')
  const rows = parseShotManifest(document, paths.sources), bindings: SourceQaEvidenceBinding[] = []
  const reviews = await verifySelectedSourceReviews(paths, rows, true, true, async (binding) => {
    await verify(binding)
    bindings.push({ ...binding })
  })
  const approved = new Map(reviews.map(review => [review.shot, review]))
  const prepared = document as { shots: { shot: number; sha256?: string; review_sha256?: string; audio_sha256?: string }[] }
  if (rows.length !== timeline.clips.length || prepared.shots.some((row) => {
    const review = approved.get(row.shot)
    return review === undefined || row.sha256 !== review.videoSha256 || row.review_sha256 !== review.reviewSha256
      || row.audio_sha256 !== review.audioSha256 || !timeline.clips.some(clip => clip.shot === row.shot)
  })) throw new Error('正式渲染的选源或审核已变化，请重新 prepare 并复验。')
  for (const clip of timeline.clips) {
    if (await fileSha256(resolve(paths.videoDir, shotFileName(clip.shot))) !== approved.get(clip.shot)?.videoSha256) {
      throw new Error('正式渲染的镜头副本与已审看源片字节不符，请重新 prepare。')
    }
  }
  const summary = summarizeSourceQa(reviews)
  if (bindings.length === 0) throw new Error('Strict source review has no verified Session bindings')
  const selectedPaths = await Promise.all(rows.map(row => realpath(resolve(project, row.video))))
  return { sourceQaSha256: summary.sha256, selectedPaths, files: summary.files, bindings }
}
