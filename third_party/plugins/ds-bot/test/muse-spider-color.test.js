import assert from 'node:assert/strict'
import { test } from 'node:test'
import { characterMarkup, lookOf, MASK_ID } from '../src/client/characters.js'

test('spider color follows the saved selection without changing its animated eyes', () => {
  const purple = characterMarkup('muse-spider', 'violet')
  assert.match(purple, /<image href="data:image\/png;base64,/)
  assert.match(purple, /<g class="bt-b" pointer-events="none">/)
  assert.doesNotMatch(purple, /spider-image/)
  for (const color of ['black', 'red', 'orange', 'green', 'blue', 'gray', 'aurora', '#ffcc33']) {
    const saved = lookOf({ id: 'test', color, avatar: { shape: 'muse-spider' } })
    assert.equal(saved.color, color)
    const svg = characterMarkup(saved.shape, saved.color)
    assert.match(svg, /spider-image/)
    assert.match(svg, /mask-type:alpha/)
    assert.match(svg, /mix-blend-mode:multiply/)
    assert.match(svg, /mix-blend-mode:screen/)
    assert.match(svg, /pointer-events:none/)
    assert.match(svg, /<g class="bt-b" pointer-events="none">/)
    assert.match(svg, /<rect x="0" y="0" width="100" height="100"/)
    assert.match(svg, /bt-gaze/)
    assert.match(svg, /bt-eye-happy/)
    assert.match(svg, /fill="#21152f"/)
    assert.doesNotMatch(svg.replaceAll(MASK_ID, 'instance-42'), /%MASK%/)
  }
  assert.match(characterMarkup('muse-spider', 'red'), /fill="var\(--bt-ink-red\)"/)
  assert.match(characterMarkup('muse-spider', 'aurora'), /fill="url\(#%MASK%g\)"/)
  assert.match(characterMarkup('muse-spider', '#ffcc33'), /fill="#ffcc33"/)
})
