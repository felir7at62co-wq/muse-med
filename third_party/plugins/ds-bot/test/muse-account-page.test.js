// Muse: the user's avatar on the Account page and in the sidebar capsule.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { youLook } from '../src/client/characters.js'
import { lookOf } from '../src/client/characters.js'

test('the avatar is the saved picture, else the saved character, else one picked from the name', () => {
  const picked = lookOf({ id: 'user:ylk' })
  assert.deepEqual(youLook({}, 'ylk'), picked)
  assert.deepEqual(youLook(undefined, 'ylk'), picked)
  assert.deepEqual(youLook({ you: { shape: 'moon', color: 'green' } }, 'ylk'), { shape: 'moon', color: 'green' })
  assert.equal(youLook({ you: { image: 'data:image/png;base64,AAAA' } }, 'ylk').image, 'data:image/png;base64,AAAA')
})

test('a saved character that is no longer known falls back to the picked one', () => {
  assert.deepEqual(youLook({ you: { shape: 'no-such-shape', color: 'green' } }, 'ylk'), lookOf({ id: 'user:ylk' }))
  assert.equal(youLook({ you: { shape: 'moon', color: 'nope' } }, 'ylk').color, lookOf({ id: 'user:ylk' }).color)
})
