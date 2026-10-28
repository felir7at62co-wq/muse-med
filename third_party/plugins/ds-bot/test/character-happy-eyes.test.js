import assert from 'node:assert/strict'
import { test } from 'node:test'
import { characterMarkup, DEFAULT_SHAPES, SHAPES } from '../src/client/characters.js'

test('ordinary Bot smile eyes retain visible arcs and valid line widths', () => {
  for (const shape of DEFAULT_SHAPES) {
    const svg = characterMarkup(shape, 'red')
    const eyes = [...svg.matchAll(/<path class="bt-eye-happy"[^>]*d="([^"]+)"[^>]*stroke-width="([^"]+)"/g)]
    assert.equal(eyes.length, 2, shape)
    for (const [index, eye] of eyes.entries()) {
      const start = /^M(-?[\d.]+) /.exec(eye[1])
      assert.ok(start && Number(start[1]) < 0, `${shape} eye ${index + 1} has a visible arc`)
      assert.equal(Number(eye[2]), SHAPES[shape].eyes[index][2] * 0.5, `${shape} eye ${index + 1} has the intended line weight`)
    }
  }
})

test('Muse spider keeps its finer separate visible smile arcs', () => {
  const svg = characterMarkup('muse-spider', 'violet')
  const eyes = [...svg.matchAll(/<path class="bt-eye-happy"[^>]*stroke-width="([^"]+)"/g)]
  assert.equal(eyes.length, 4)
  assert.equal(Number(eyes[2][1]), SHAPES['muse-spider'].eyes[0][2] * 0.22)
  assert.equal(Number(eyes[3][1]), SHAPES['muse-spider'].eyes[1][2] * 0.22)
})
