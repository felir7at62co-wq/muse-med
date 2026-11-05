/** Host and browser agree on the native header's public startup policy. */
import { afterEach, expect, it, vi } from 'vitest'
import { Config } from '../src/index.ts'
import { HEADER_PRESENTATION_GLOBAL, readHeaderPresentation } from '../src/header-presentation.ts'

afterEach(() => { vi.unstubAllGlobals() })
it('keeps standard navigation when no deployment selected another presentation', () => {
  vi.stubGlobal(HEADER_PRESENTATION_GLOBAL, undefined)
  expect(Config({}).headerPresentation).toBe('standard')
  expect(readHeaderPresentation()).toBe('standard')
})
it.each(['standard', 'floating'] as const)('projects the Host-selected %s presentation', (presentation) => {
  const config = Config({ headerPresentation: presentation })
  vi.stubGlobal(HEADER_PRESENTATION_GLOBAL, config.headerPresentation)
  expect(readHeaderPresentation()).toBe(presentation)
})
it.each(['hidden', null, {}, 1])('refuses malformed public header policy %j before registration', (value) => {
  vi.stubGlobal(HEADER_PRESENTATION_GLOBAL, value)
  expect(() => readHeaderPresentation()).toThrow('Invalid conversation header presentation')
})
