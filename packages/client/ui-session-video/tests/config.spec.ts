/** Public page bootstrap settings are resolved before the Client registers its UI. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSessionVideoConfig, SESSION_VIDEO_CONFIG_GLOBAL } from '../src/config.ts'

afterEach(() => vi.unstubAllGlobals())

describe('Session video page configuration', () => {
  it('resolves the default when the Host supplied no configuration', () => {
    vi.stubGlobal(SESSION_VIDEO_CONFIG_GLOBAL, undefined)
    expect(readSessionVideoConfig()).toEqual({ pixelsPerSecond: 48 })
  })

  it('reads the Host timeline scale from the public bootstrap', () => {
    vi.stubGlobal(SESSION_VIDEO_CONFIG_GLOBAL, { pixelsPerSecond: 80 })
    expect(readSessionVideoConfig()).toEqual({ pixelsPerSecond: 80 })
  })

  it.each([null, [], '80', { pixelsPerSecond: '80' }, { pixelsPerSecond: 0 }])(
    'rejects malformed bootstrap configuration %j before UI registration', (value) => {
      vi.stubGlobal(SESSION_VIDEO_CONFIG_GLOBAL, value)
      expect(() => readSessionVideoConfig()).toThrow()
    },
  )
})
