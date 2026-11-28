/** Acoustic measurements use waveform correspondence only. They do not identify words or voices. */
export const acousticRate = 8_000
const channels = 2
const minimumRms = 0.002
const maxLag = acousticRate / 4
const minimumLag = acousticRate / 125
const searchStep = 8

export type AcousticStatus = 'matching' | 'missing_reference_signal' | 'shifted_reference_signal'
  | 'uncertain_reference' | 'uncertain_correspondence'

type Measurements = {
  readonly correlation: number
  readonly referenceRms: number
  readonly candidateRms: number
  readonly gain: number
}

type AcousticWindow = {
  readonly status: AcousticStatus
  readonly lagSamples?: number
  readonly nominal: Measurements
  readonly aligned?: Measurements
}

function measure(reference: Float32Array, signal: Float32Array,
  start: number, end: number, lag = 0, stride = 1): Measurements {
  let power = 0, candidatePower = 0, cross = 0
  const frames = Math.ceil((end - start) / stride)
  // Center each channel independently so a DC offset cannot suggest a match.
  for (let channel = 0; channel < channels; channel++) {
    let xSum = 0, ySum = 0, xx = 0, yy = 0, xy = 0
    for (let frame = start; frame < end; frame += stride) {
      const x = reference[frame * channels + channel] ?? 0
      const y = signal[(frame + lag) * channels + channel] ?? 0
      xSum += x
      ySum += y
      xx += x * x
      yy += y * y
      xy += x * y
    }
    power += Math.max(0, xx - xSum * xSum / frames)
    candidatePower += Math.max(0, yy - ySum * ySum / frames)
    cross += xy - xSum * ySum / frames
  }
  return { correlation: power > 0 && candidatePower > 0 ? cross / Math.sqrt(power * candidatePower) : 0,
    referenceRms: Math.sqrt(power / (frames * channels)), candidateRms: Math.sqrt(candidatePower / (frames * channels)),
    gain: power > 0 ? cross / power : 0 }
}

function matching(value: Measurements, minimumCorrelation = 0.8): boolean {
  return value.correlation >= minimumCorrelation && value.gain >= 0.12
}

function findShift(reference: Float32Array, signal: Float32Array, start: number, end: number, ceiling: number) {
  const low = Math.max(-maxLag, -start), high = Math.min(maxLag, ceiling - end)
  const coarse: { lag: number; correlation: number }[] = []
  for (let lag = Math.ceil(low / searchStep) * searchStep; lag <= high; lag += searchStep) {
    coarse.push({ lag, correlation: measure(reference, signal, start, end, lag, searchStep).correlation })
  }
  const strongest = coarse.sort((a, b) => b.correlation - a.correlation)[0]
  if (strongest === undefined || strongest.correlation < 0.65) return undefined
  let bestLag = strongest.lag, best = measure(reference, signal, start, end, bestLag)
  for (let lag = Math.max(low, strongest.lag - searchStep + 1); lag < Math.min(high + 1, strongest.lag + searchStep); lag++) {
    const candidate = measure(reference, signal, start, end, lag)
    if (candidate.correlation > best.correlation) {
      best = candidate
      bestLag = lag
    }
  }
  // A repeating waveform or two comparably strong locations are ambiguous.
  const rival = coarse.find(item => Math.abs(item.lag - bestLag) > minimumLag)
  return Math.abs(bestLag) >= minimumLag && matching(best, 0.86)
    && best.correlation - (rival?.correlation ?? 0) >= 0.06 ? { lag: bestLag, measurement: best } : undefined
}

/** Compare one expected interval on the same picture clock. A quiet reference stays unresolved. */
export function measureAcousticWindow(reference: Float32Array, signal: Float32Array,
  start: number, end: number, ceiling: number): AcousticWindow {
  const nominal = measure(reference, signal, start, end)
  if (end > reference.length / channels || nominal.referenceRms < minimumRms || end - start < acousticRate / 20) {
    return { status: 'uncertain_reference', nominal }
  }
  if (matching(nominal)) return { status: 'matching', nominal }
  const shifted = findShift(reference, signal, start, end, ceiling)
  if (shifted !== undefined) {
    return { status: 'shifted_reference_signal', nominal, lagSamples: shifted.lag, aligned: shifted.measurement }
  }
  return { status: Math.abs(nominal.gain) < 0.08 && nominal.candidateRms < nominal.referenceRms * 0.2
    ? 'missing_reference_signal' : 'uncertain_correspondence', nominal }
}
