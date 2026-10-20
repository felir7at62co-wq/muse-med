/** Short WebAudio attention cues owned by one desktop renderer. */

/** The two attention events supplied by the existing Host notification policy. */
export type AttentionSoundKind = 'complete' | 'question'

/** Renderer-owned cue playback and asynchronous audio-device teardown. */
export interface AttentionAudioPlayer {
  /**
   * Play two short tones, replacing any pending or sounding cue.
   * @param kind - Completion or question cue to synthesize.
   * @returns Resolves after playback or cancellation; rejects on audio failure.
   * Cancellation and disposal do not confirm that a cue sounded.
   */
  play(kind: AttentionSoundKind): Promise<void>
  /**
   * Cancel playback, ignore future cues, and await the owned AudioContext closing.
   * @returns The same teardown promise on every call; rejects if cleanup or closing fails.
   */
  dispose(): Promise<void>
}

interface Cue {
  nodes: AudioNode[]
  oscillators: { node: OscillatorNode; started: boolean }[]
  ended: number
  done: boolean
  settle(errors: unknown[]): void
}

/**
 * Create a lazy WebAudio player without queuing missed or superseded cues.
 * @param factory - Creates the context owned and closed by this player.
 * @returns A player whose promises expose playback and teardown failures.
 */
export function createAttentionAudioPlayer(factory: () => AudioContext = () => new AudioContext()): AttentionAudioPlayer {
  let context: AudioContext | undefined
  let current: Cue | undefined
  let disposed = false
  let disposal: Promise<void> | undefined

  function cleanup(cue: Cue, stop = true): unknown[] {
    const errors: unknown[] = []
    for (const oscillator of cue.oscillators) {
      oscillator.node.onended = null
      if (stop && oscillator.started) {
        try { oscillator.node.stop() }
        catch (error) { errors.push(error) }
      }
    }
    for (const node of cue.nodes) {
      try { node.disconnect() }
      catch (error) { errors.push(error) }
    }
    return errors
  }

  function finish(cue: Cue, errors: unknown[] = []): void {
    if (cue.done) return
    cue.done = true
    if (current === cue) current = undefined
    cue.settle(errors)
  }

  async function start(cue: Cue, audio: AudioContext, kind: AttentionSoundKind): Promise<void> {
    if (audio.state !== 'running') await audio.resume()
    if (current !== cue || disposed) return
    if (audio.state !== 'running') throw new Error(`Attention audio context is ${audio.state} after resume`)

    const frequencies = kind === 'complete' ? [660, 880] : [880, 660]
    const at = audio.currentTime + 0.01
    for (const [index, frequency] of frequencies.entries()) {
      const oscillator = audio.createOscillator()
      const owned = { node: oscillator, started: false }
      cue.nodes.push(oscillator)
      cue.oscillators.push(owned)
      const gain = audio.createGain()
      cue.nodes.push(gain)
      const begin = at + index * 0.24
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequency, begin)
      gain.gain.setValueAtTime(0, begin)
      gain.gain.linearRampToValueAtTime(0.2, begin + 0.015)
      gain.gain.setValueAtTime(0.2, begin + 0.10)
      gain.gain.linearRampToValueAtTime(0, begin + 0.16)
      oscillator.connect(gain)
      gain.connect(audio.destination)
      oscillator.onended = () => {
        if (cue.done) return
        cue.ended++
        if (cue.ended === frequencies.length) finish(cue, cleanup(cue, false))
      }
      oscillator.start(begin)
      owned.started = true
      oscillator.stop(begin + 0.16)
    }
  }

  return {
    play(kind) {
      if (disposed) return Promise.resolve()
      if (current) finish(current, cleanup(current))
      return new Promise<void>((resolve, reject) => {
        const cue: Cue = {
          nodes: [], oscillators: [], ended: 0, done: false,
          settle(errors) {
            if (errors.length === 0) resolve()
            else reject(errors.length === 1 && errors[0] instanceof Error
              ? errors[0] : new AggregateError(errors, 'Attention audio playback failed'))
          },
        }
        current = cue
        try { context ??= factory() }
        catch (error) { finish(cue, [error]); return }
        void start(cue, context, kind).catch((error: unknown) => {
          if (!cue.done) finish(cue, [error, ...cleanup(cue)])
        })
      })
    },
    dispose() {
      if (disposal) return disposal
      disposed = true
      const errors = current ? cleanup(current) : []
      if (current) finish(current, errors)
      disposal = (async () => {
        if (context) {
          try { await context.close() }
          catch (error) { errors.push(error) }
        }
        if (errors.length > 0) throw new AggregateError(errors, 'Attention audio disposal failed')
      })()
      return disposal
    },
  }
}
