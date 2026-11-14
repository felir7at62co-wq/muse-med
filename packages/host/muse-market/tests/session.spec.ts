/** Empty durable checkpoints remain valid before an explicit release selection. */
import { expect, it } from 'vitest'
import { marketBindingProjectionDefinition } from '../src/session.ts'

it('restores an unbound empty market checkpoint without inventing a release choice', () => {
  const state = marketBindingProjectionDefinition.init()
  expect(marketBindingProjectionDefinition.stateSchema.parse(state)).toEqual({ bound: false, requested: false, releases: [] })
})
