import { constants } from 'node:fs'
import { expect, it } from 'vitest'
import { marketReadOpenFlags } from '../src/local.ts'

it('selects read-only Windows flags without requesting unsupported POSIX flags', () => {
  expect(marketReadOpenFlags('win32')).toBe(constants.O_RDONLY)
})

it.each(['linux', 'darwin'] as const)('retains no-follow and nonblocking flags on %s', (platform) => {
  expect(marketReadOpenFlags(platform)).toBe(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
})
