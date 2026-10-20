import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAttentionAudioPlayer, type AttentionAudioPlayer } from '../src/attention-audio.ts'

interface DeviceNode {
  connect: (destination: AudioNode) => AudioNode
  disconnect: () => void
}
type DeviceOscillator = Pick<OscillatorNode, 'type' | 'start' | 'stop' | 'onended'> & DeviceNode & {
  frequency: Pick<AudioParam, 'setValueAtTime'>
}
type DeviceGain = DeviceNode & {
  gain: Pick<AudioParam, 'setValueAtTime' | 'linearRampToValueAtTime'>
}
type DeviceContext = Pick<AudioContext, 'resume' | 'close' | 'createOscillator' | 'createGain'> & {
  state: AudioContextState
  currentTime: number
  destination: Pick<AudioDestinationNode, 'maxChannelCount'>
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function device(state: AudioContextState = 'running') {
  const oscillators: ReturnType<typeof oscillator>[] = []
  const gains: ReturnType<typeof gain>[] = []
  function oscillator(): DeviceOscillator {
    return {
      type: 'sine',
      frequency: { setValueAtTime: vi.fn<AudioParam['setValueAtTime']>() },
      connect: vi.fn<DeviceNode['connect']>(), disconnect: vi.fn<DeviceNode['disconnect']>(),
      start: vi.fn<OscillatorNode['start']>(), stop: vi.fn<OscillatorNode['stop']>(),
      onended: null,
    }
  }
  function gain(): DeviceGain {
    return {
      gain: {
        setValueAtTime: vi.fn<AudioParam['setValueAtTime']>(),
        linearRampToValueAtTime: vi.fn<AudioParam['linearRampToValueAtTime']>(),
      },
      connect: vi.fn<DeviceNode['connect']>(), disconnect: vi.fn<DeviceNode['disconnect']>(),
    }
  }
  const context: DeviceContext = {
    state, currentTime: 7, destination: { maxChannelCount: 2 },
    resume: vi.fn<AudioContext['resume']>(async () => { context.state = 'running' }),
    close: vi.fn<AudioContext['close']>(async () => { context.state = 'closed' }),
    createOscillator: vi.fn<AudioContext['createOscillator']>(() => {
      const node = oscillator()
      oscillators.push(node)
      return node as OscillatorNode
    }),
    createGain: vi.fn<AudioContext['createGain']>(() => {
      const node = gain()
      gains.push(node)
      return node as GainNode
    }),
  }
  function endAll() {
    for (const node of oscillators) node.onended?.call(node as OscillatorNode, new Event('ended'))
  }
  return { context, oscillators, gains, endAll, factory: vi.fn(() => context as AudioContext) }
}

const players: AttentionAudioPlayer[] = []
function player(factory: () => AudioContext) {
  const owned = createAttentionAudioPlayer(factory)
  players.push(owned)
  return owned
}
afterEach(async () => {
  await Promise.allSettled(players.splice(0).map(owned => owned.dispose()))
})

describe('renderer attention audio', () => {
  it.each([
    ['complete', [660, 880]],
    ['question', [880, 660]],
  ] as const)('synthesizes and disconnects the two %s tones', async (kind, frequencies) => {
    const audio = device()
    const owned = player(audio.factory)
    expect(audio.factory).not.toHaveBeenCalled()
    const played = owned.play(kind)
    let settled = false
    void played.then(() => { settled = true })
    expect(audio.factory).toHaveBeenCalledOnce()
    expect(audio.context.resume).not.toHaveBeenCalled()
    expect(audio.oscillators).toHaveLength(2)
    for (const [index, node] of audio.oscillators.entries()) {
      const at = 7.01 + index * 0.24
      expect(node.frequency.setValueAtTime).toHaveBeenCalledWith(frequencies[index], at)
      expect(node.start).toHaveBeenCalledWith(at)
      expect(node.stop).toHaveBeenCalledWith(at + 0.16)
      expect(node.connect).toHaveBeenCalledWith(audio.gains[index])
      expect(audio.gains[index]!.connect).toHaveBeenCalledWith(audio.context.destination)
      expect(audio.gains[index]!.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.2, at + 0.015)
      expect(audio.gains[index]!.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, at + 0.16)
    }
    const first = audio.oscillators[0]!
    first.onended!.call(first as OscillatorNode, new Event('ended'))
    await Promise.resolve()
    expect(settled).toBe(false)
    const second = audio.oscillators[1]!
    second.onended!.call(second as OscillatorNode, new Event('ended'))
    await played
    for (const node of [...audio.oscillators, ...audio.gains]) expect(node.disconnect).toHaveBeenCalledOnce()
    expect(audio.oscillators.map(node => node.onended)).toEqual([null, null])
    await owned.dispose()
    expect(audio.context.close).toHaveBeenCalledOnce()
  })

  it('replaces sounding tones immediately and reuses the owned context', async () => {
    const audio = device()
    const owned = player(audio.factory)
    const previous = owned.play('complete')
    const staleEnded = audio.oscillators[0]!.onended!
    const played = owned.play('question')
    await previous
    expect(audio.factory).toHaveBeenCalledOnce()
    for (const node of audio.oscillators.slice(0, 2)) {
      expect(node.stop).toHaveBeenLastCalledWith()
      expect(node.disconnect).toHaveBeenCalledOnce()
    }
    for (const node of audio.gains.slice(0, 2)) expect(node.disconnect).toHaveBeenCalledOnce()
    staleEnded.call(audio.oscillators[0] as OscillatorNode, new Event('ended'))
    audio.endAll()
    await played
    expect(audio.oscillators).toHaveLength(4)
  })

  it('never replays an older cue when its resume resolves after a newer cue', async () => {
    const audio = device('suspended')
    const olderResume = deferred()
    const newerResume = deferred()
    vi.mocked(audio.context.resume).mockImplementationOnce(() => olderResume.promise).mockImplementationOnce(() => newerResume.promise)
    const owned = player(audio.factory)
    const older = owned.play('complete')
    const newer = owned.play('question')
    await older
    expect(audio.context.resume).toHaveBeenCalledTimes(2)
    expect(audio.oscillators).toHaveLength(0)
    audio.context.state = 'running'
    newerResume.resolve()
    await newerResume.promise
    expect(audio.oscillators).toHaveLength(2)
    olderResume.resolve()
    await olderResume.promise
    expect(audio.oscillators).toHaveLength(2)
    expect(audio.oscillators[0]!.frequency.setValueAtTime).toHaveBeenCalledWith(880, 7.01)
    audio.endAll()
    await newer
  })

  it.each(['resolve', 'reject'] as const)('ignores late resume %s after disposal and awaits close', async (outcome) => {
    const audio = device('suspended')
    const resumed = deferred()
    const closed = deferred()
    vi.mocked(audio.context.resume).mockImplementationOnce(() => resumed.promise)
    vi.mocked(audio.context.close).mockImplementationOnce(() => closed.promise)
    const owned = player(audio.factory)
    const played = owned.play('complete')
    const disposing = owned.dispose()
    expect(owned.dispose()).toBe(disposing)
    await played
    let disposed = false
    void disposing.then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    if (outcome === 'resolve') resumed.resolve()
    else resumed.reject(new Error('resume failed after close'))
    await Promise.allSettled([resumed.promise])
    expect(audio.oscillators).toHaveLength(0)
    closed.resolve()
    await disposing
    await owned.play('question')
    expect(audio.factory).toHaveBeenCalledOnce()
    expect(audio.context.close).toHaveBeenCalledOnce()
    expect(audio.oscillators).toHaveLength(0)
  })

  it('stops and disconnects active nodes before closing', async () => {
    const audio = device()
    const owned = player(audio.factory)
    const played = owned.play('complete')
    vi.mocked(audio.context.close).mockImplementationOnce(async () => {
      for (const node of audio.oscillators) expect(node.stop).toHaveBeenLastCalledWith()
      for (const node of [...audio.oscillators, ...audio.gains]) expect(node.disconnect).toHaveBeenCalledOnce()
    })
    await owned.dispose()
    await played
    audio.endAll()
    expect(audio.oscillators).toHaveLength(2)
  })

  it('does not create a device when disposed before playback', async () => {
    const audio = device()
    const owned = player(audio.factory)
    const disposing = owned.dispose()
    expect(owned.dispose()).toBe(disposing)
    await disposing
    await owned.play('complete')
    expect(audio.factory).not.toHaveBeenCalled()
  })

  it('exposes factory failures and allows a later cue to retry', async () => {
    const audio = device()
    const error = new Error('no audio device')
    audio.factory.mockImplementationOnce(() => { throw error })
    const owned = player(audio.factory)
    await expect(owned.play('complete')).rejects.toBe(error)
    const played = owned.play('question')
    audio.endAll()
    await played
    expect(audio.factory).toHaveBeenCalledTimes(2)
  })

  it('exposes resume rejection without creating tones', async () => {
    const audio = device('suspended')
    const error = new Error('audio permission denied')
    vi.mocked(audio.context.resume).mockRejectedValueOnce(error)
    const owned = player(audio.factory)
    await expect(owned.play('question')).rejects.toBe(error)
    expect(audio.oscillators).toHaveLength(0)
  })

  it('rejects a resume that leaves the context suspended', async () => {
    const audio = device('suspended')
    vi.mocked(audio.context.resume).mockResolvedValueOnce(undefined)
    const owned = player(audio.factory)
    await expect(owned.play('complete')).rejects.toThrow('suspended after resume')
    expect(audio.oscillators).toHaveLength(0)
  })

  it('reports non-Error audio failures as diagnosable errors', async () => {
    const audio = device('suspended')
    vi.mocked(audio.context.resume).mockRejectedValueOnce('audio unavailable')
    const owned = player(audio.factory)
    await expect(owned.play('complete')).rejects.toMatchObject({ name: 'AggregateError', errors: ['audio unavailable'] })
    expect(audio.oscillators).toHaveLength(0)
  })

  it.each([0, 1])('cleans every acquired node when gain allocation fails at tone %s', async (index) => {
    const audio = device()
    const error = new Error('gain allocation failed')
    const allocateGain = vi.mocked(audio.context.createGain).getMockImplementation()!
    if (index === 1) vi.mocked(audio.context.createGain).mockImplementationOnce(allocateGain)
    vi.mocked(audio.context.createGain).mockImplementationOnce(() => { throw error })
    const owned = player(audio.factory)
    await expect(owned.play('complete')).rejects.toBe(error)
    expect(audio.oscillators).toHaveLength(index + 1)
    expect(audio.oscillators[index]!.stop).not.toHaveBeenCalled()
    if (index === 1) expect(audio.oscillators[0]!.stop).toHaveBeenLastCalledWith()
    for (const node of [...audio.oscillators, ...audio.gains]) expect(node.disconnect).toHaveBeenCalledOnce()
  })

  it('continues releasing nodes and closing when individual cleanup operations fail', async () => {
    const audio = device()
    const stopError = new Error('stop failed')
    const disconnectError = new Error('disconnect failed')
    const closeError = new Error('close failed')
    const owned = player(audio.factory)
    const played = owned.play('complete')
    vi.mocked(audio.oscillators[0]!.stop).mockImplementationOnce(() => { throw stopError })
    vi.mocked(audio.gains[0]!.disconnect).mockImplementationOnce(() => { throw disconnectError })
    vi.mocked(audio.context.close).mockRejectedValueOnce(closeError)
    const playbackFailure = expect(played).rejects.toMatchObject({ errors: [stopError, disconnectError] })
    const disposing = owned.dispose()
    await playbackFailure
    await expect(disposing).rejects.toMatchObject({ errors: [stopError, disconnectError, closeError] })
    for (const node of audio.oscillators) expect(node.stop).toHaveBeenLastCalledWith()
    for (const node of [...audio.oscillators, ...audio.gains]) expect(node.disconnect).toHaveBeenCalledOnce()
    expect(audio.context.close).toHaveBeenCalledOnce()
  })

  it('reports closing failures once through the idempotent disposal promise', async () => {
    const audio = device()
    const error = new Error('device close failed')
    vi.mocked(audio.context.close).mockRejectedValueOnce(error)
    const owned = player(audio.factory)
    const played = owned.play('complete')
    const disposing = owned.dispose()
    const failure = await disposing.catch((reason: unknown) => reason)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([error])
    expect(owned.dispose()).toBe(disposing)
    await played
    expect(audio.context.close).toHaveBeenCalledOnce()
  })
})
