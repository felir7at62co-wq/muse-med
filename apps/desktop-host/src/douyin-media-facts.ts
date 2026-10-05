/** Validate sanitized native IPC evidence against the local MP4 probe. */
import type { DouyinDesktopResult } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

type Evidence = NonNullable<DouyinDesktopResult['evidence']>
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function dimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 16_384
}

/**
 * @param value - native IPC evidence.
 * @param target - approved work ID.
 * @returns validated evidence; throws for inconsistent identification.
 */
export function mediaEvidence(value: unknown, target: string): Evidence {
  const evidence = record(value)
  if (
    evidence === undefined ||
    ![200, 206].includes(Number(evidence.responseStatus)) ||
    typeof evidence.responseStatus !== 'number' ||
    typeof evidence.mediaUrlHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(evidence.mediaUrlHash) ||
    typeof evidence.mediaHost !== 'string' ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:douyinvod\.com|bytecdn\.(?:com|cn))$/.test(evidence.mediaHost)
  )
    throw new Error('Invalid media evidence')
  if (evidence.association === 'player-exact') {
    if (evidence.currentSrcMatched !== true || evidence.provider !== undefined)
      throw new Error('Invalid player evidence')
    return {
      responseStatus: evidence.responseStatus,
      mediaHost: evidence.mediaHost,
      mediaUrlHash: evidence.mediaUrlHash,
      association: 'player-exact',
      currentSrcMatched: true,
    }
  } else if (evidence.association === 'provider-detail-verified') {
    const provider = record(evidence.provider)
    if (
      evidence.currentSrcMatched !== false ||
      provider?.detailResponseStatus !== 200 ||
      provider.detailHost !== 'www.douyin.com' ||
      provider.detailPath !== '/aweme/v1/web/aweme/detail/' ||
      provider.targetVideoId !== target ||
      provider.documentEpoch !== 1 ||
      (provider.sourceField !== 'video.play_addr' && provider.sourceField !== 'video.bit_rate.play_addr') ||
      typeof provider.durationMs !== 'number' ||
      !Number.isFinite(provider.durationMs) ||
      provider.durationMs <= 0 ||
      provider.durationMs > 86_400_000 ||
      !dimension(provider.width) ||
      !dimension(provider.height)
    )
      throw new Error('Invalid provider evidence')
    return {
      responseStatus: evidence.responseStatus,
      mediaHost: evidence.mediaHost,
      mediaUrlHash: evidence.mediaUrlHash,
      association: 'provider-detail-verified',
      currentSrcMatched: false,
      provider: {
        detailResponseStatus: 200,
        detailHost: 'www.douyin.com',
        detailPath: '/aweme/v1/web/aweme/detail/',
        targetVideoId: target,
        documentEpoch: 1,
        sourceField: provider.sourceField,
        durationMs: provider.durationMs,
        width: provider.width,
        height: provider.height,
      },
    }
  } else throw new Error('Missing media identification')
}

/**
 * @param metadata - local ffprobe JSON.
 * @param evidence - validated native facts.
 * @returns local duration and dimensions; throws on a provider mismatch.
 */
export function nativeMediaFacts(
  metadata: unknown,
  evidence: Evidence,
): { duration: number; width: number; height: number } {
  const value = record(metadata)
  const videos = Array.isArray(value?.streams)
    ? value.streams.map(record).filter(stream => stream?.codec_type === 'video')
    : []
  const video = videos[0]
  const duration = Number(record(value?.format)?.duration)
  if (
    video === undefined ||
    !dimension(video.width) ||
    !dimension(video.height) ||
    !Number.isFinite(duration) ||
    duration <= 0
  )
    throw new Error('Invalid video metadata')
  const provider = evidence.provider
  if (
    provider !== undefined &&
    (Math.abs(duration - provider.durationMs / 1000) > 0.25 ||
      Math.abs(video.width / video.height / (provider.width / provider.height) - 1) > 0.01)
  )
    throw new Error('Provider media mismatch')
  return { duration, width: video.width, height: video.height }
}
