/** Deterministic timecode selection for sampled video observations. */

/** A resolved interval and its requested observations. */
export interface SampleRequest {
  /** Probed source duration in seconds. */
  duration: number
  /** Inclusive interval start in seconds. */
  start: number
  /** Exclusive interval end in seconds. */
  end: number
  /** Number of uniformly spaced samples when explicit timestamps are absent. */
  count: number
  /** Optional source timecodes, each inside the selected interval. */
  timestamps?: readonly number[]
}

/**
 * Select ordered source timecodes without claiming continuous video coverage.
 * @param request - Resolved range and requested sample count or timecodes.
 * @param limits - Deployment limits on observations and interval duration.
 * @returns Unique chronological sample timestamps.
 */
export function planSamples(request: SampleRequest, limits: { maxRangeSeconds: number; maxFrames: number }): number[] {
  const { duration, start, end, count, timestamps } = request
  if (![duration, start, end].every(Number.isFinite) || duration <= 0 || start < 0 || end > duration || end <= start) {
    throw new Error('Sampling range must be inside the source video')
  }
  if (end - start > limits.maxRangeSeconds) {
    throw new Error(`Sample at most ${limits.maxRangeSeconds} seconds per call; inspect the next interval separately`)
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > limits.maxFrames) {
    throw new Error(`frame_count must be an integer from 1 to ${limits.maxFrames}`)
  }
  if (timestamps !== undefined) {
    if (!timestamps.length || timestamps.length > limits.maxFrames
      || timestamps.some(time => !Number.isFinite(time) || time < start || time >= end)) {
      throw new Error('timestamps_seconds must contain bounded timecodes inside the selected interval')
    }
    return [...new Set(timestamps)].sort((left, right) => left - right)
  }
  return Array.from({ length: count }, (_, index) => start + (end - start) * (index + 0.5) / count)
}
