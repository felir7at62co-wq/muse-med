/** Real completed-Session selection and cue playback with only the audio device replaced. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const { attentionSoundForEvent } = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/attention-sound.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/types/attention-sound.js', import.meta.url),
)
const { createAttentionAudioPlayer } = await importSnapshotModule(
  new URL('../../../apps/desktop/src/attention-audio.ts', import.meta.url),
  new URL('../../../apps/desktop/lib/types/attention-audio.js', import.meta.url),
)

export const name = 'snapshot-attention-audio'

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless Loader context. */
export function apply(ctx) {
  const cues = []
  const devices = []
  const playbacks = []
  let playbackFailure
  const player = createAttentionAudioPlayer(() => {
    const device = { resumeCount: 0, closeCount: 0, oscillators: [], gains: [] }
    devices.push(device)
    const destination = {}
    const gainNodes = new Set()
    const context = {
      state: 'suspended',
      currentTime: 10,
      destination,
      async resume() {
        device.resumeCount++
        context.state = 'running'
      },
      async close() {
        device.closeCount++
        context.state = 'closed'
      },
      createOscillator() {
        const observed = { frequencyHz: null, gainConnectCount: 0, startCount: 0, stopCount: 0, disconnectCount: 0 }
        device.oscillators.push(observed)
        let ended = false
        const oscillator = {
          type: 'sine',
          frequency: { setValueAtTime(value) { observed.frequencyHz = value } },
          onended: null,
          connect(target) {
            assert.ok(gainNodes.has(target))
            observed.gainConnectCount++
            return target
          },
          disconnect() { observed.disconnectCount++ },
          start() { observed.startCount++ },
          stop() {
            observed.stopCount++
            // The fake device advances scheduled audio to its explicit completion event.
            queueMicrotask(() => {
              if (ended) return
              ended = true
              oscillator.onended?.()
            })
          },
        }
        return oscillator
      },
      createGain() {
        const observed = { destinationConnectCount: 0, disconnectCount: 0 }
        device.gains.push(observed)
        const gain = {
          gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
          connect(target) {
            assert.equal(target, destination)
            observed.destinationConnectCount++
            return target
          },
          disconnect() { observed.disconnectCount++ },
        }
        gainNodes.add(gain)
        return gain
      },
    }
    return context
  })

  const detach = ctx.on('session/event', (session, event) => {
    const kind = attentionSoundForEvent(session.header, event)
    if (kind === undefined) return
    cues.push({ kind, eventType: event.type, turn: event.data.turn })
    playbacks.push(player.play(kind).catch((error) => { playbackFailure = error }))
  })
  ctx.effect(() => async () => {
    detach()
    try {
      await Promise.all(playbacks)
    } finally {
      await player.dispose()
    }
    if (playbackFailure !== undefined) throw playbackFailure
    assert.equal(cues.length, 1, 'One genuine completed root turn emits one cue')
    await player.dispose()
    await writeFile(join(process.cwd(), 'audio-probe.json'), JSON.stringify({ cues, devices }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 })
  }, 'finish and close the synthetic attention audio device')
}
