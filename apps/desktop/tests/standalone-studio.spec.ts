import { expect, it } from 'vitest'
import { standaloneStudioOrigin } from '../src/standalone-studio.ts'

it('leaves normal desktop runs unchanged and accepts an explicit local tunnel', () => {
  expect(standaloneStudioOrigin(undefined)).toBeUndefined()
  expect(standaloneStudioOrigin('')).toBeUndefined()
  expect(standaloneStudioOrigin('http://127.0.0.1:5684/')).toBe('http://127.0.0.1:5684')
})

it.each([
  'http://0.0.0.0:5684', 'http://127.0.0.1:5684.example.invalid/', 'https://127.0.0.1:5684',
  'http://user:pass@127.0.0.1:5684', 'http://127.0.0.1:5684/media', 'http://127.0.0.1:5684?token=fixture',
  'http://127.0.0.1:0', 'http://127.0.0.1:65536',
])('rejects studio configuration that is not an explicit loopback origin: %s', (input) => {
  expect(() => standaloneStudioOrigin(input)).toThrow(/MUSE_LOCALMINIDRAMA_URL/u)
})
