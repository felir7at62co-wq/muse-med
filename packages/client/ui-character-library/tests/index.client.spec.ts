/** The Host face is intentionally inert: browsing must not add writers or remote routes. */
import { expect, it } from 'vitest'
import * as host from '../src/index.ts'
it('exposes an inert Host apply only', () => {
  expect(Object.keys(host)).toEqual(['apply'])
  host.apply()
})
