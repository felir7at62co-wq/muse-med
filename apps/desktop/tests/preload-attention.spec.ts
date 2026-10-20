// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { installAttentionAudio } from '../src/preload-attention.ts'

const audio = vi.hoisted(() => ({ play: vi.fn(async (_kind: string) => {}), dispose: vi.fn(async () => {}) }))
const ipc = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: ipc }))
vi.mock('../src/attention-audio.ts', () => ({ createAttentionAudioPlayer: () => audio }))

beforeEach(() => { vi.clearAllMocks() })
afterEach(async () => {
  window.dispatchEvent(new Event('pagehide'))
  await Promise.resolve()
  vi.restoreAllMocks()
})

it('plays only valid live cues and disconnects the subscription on page replacement', async () => {
  installAttentionAudio()
  const [channel, receive] = ipc.on.mock.calls[0]! as [string, (event: unknown, kind: unknown) => void]
  expect(channel).toBe(DESKTOP_IPC.attentionSound)
  receive({}, 'complete')
  receive({}, 'question')
  for (const invalid of [undefined, null, {}, 'other']) receive({}, invalid)
  expect(audio.play.mock.calls).toEqual([['complete'], ['question']])
  window.dispatchEvent(new Event('pagehide'))
  expect(ipc.off).toHaveBeenCalledExactlyOnceWith(channel, receive)
  expect(audio.dispose).toHaveBeenCalledOnce()
  receive({}, 'complete')
  expect(audio.play).toHaveBeenCalledTimes(2)
  await Promise.resolve()
})

it('reports playback and disposal failures without an unhandled rejection', async () => {
  const playback = new Error('audio device unavailable')
  const disposal = new Error('audio close failed')
  audio.play.mockRejectedValueOnce(playback)
  audio.dispose.mockRejectedValueOnce(disposal)
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  installAttentionAudio()
  const receive = ipc.on.mock.calls[0]![1] as (event: unknown, kind: unknown) => void
  receive({}, 'question')
  await Promise.resolve()
  expect(warning).toHaveBeenCalledWith('desktop attention audio:', playback)
  window.dispatchEvent(new Event('pagehide'))
  await Promise.resolve()
  expect(warning).toHaveBeenCalledWith('desktop attention audio:', disposal)
})
