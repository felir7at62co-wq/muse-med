/** Public page bootstrap settings are resolved before the Client registers its UI. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSessionVideoConfig, SESSION_VIDEO_CONFIG_GLOBAL } from '../src/config.ts'

afterEach(() => vi.unstubAllGlobals())

describe('Session video page configuration', () => {
  it('resolves the default when the Host supplied no configuration', () => {
    vi.stubGlobal(SESSION_VIDEO_CONFIG_GLOBAL, undefined)
    expect(readSessionVideoConfig()).toEqual({ enabled: true, pixelsPerSecond: 48 })
  })

  it('reads the Host timeline scale from the public bootstrap', () => {
    vi.stubGlobal(SESSION_VIDEO_CONFIG_GLOBAL, { pixelsPerSecond: 80 })
    expect(readSessionVideoConfig()).toEqual({ enabled: true, pixelsPerSecond: 80 })
  })

  it('starts without presentation contributions when the saved switch is off', () => {
    vi.stubGlobal(SESSION_VIDEO_CONFIG_GLOBAL, { enabled: false, pixelsPerSecond: 80 })
    expect(readSessionVideoConfig()).toEqual({ enabled: false, pixelsPerSecond: 80 })
  })

  it('retains the schema timeline scale when the Host supplies only the saved presentation switch', () => {
    vi.stubGlobal(SESSION_VIDEO_CONFIG_GLOBAL, { enabled: false })
    expect(readSessionVideoConfig()).toEqual({ enabled: false, pixelsPerSecond: 48 })
  })

  it.each([null, [], '80', { pixelsPerSecond: '80' }, { pixelsPerSecond: 0 }, { enabled: 'false' }])(
    'rejects malformed bootstrap configuration %j before UI registration', (value) => {
      vi.stubGlobal(SESSION_VIDEO_CONFIG_GLOBAL, value)
      expect(() => readSessionVideoConfig()).toThrow()
    },
  )
})
