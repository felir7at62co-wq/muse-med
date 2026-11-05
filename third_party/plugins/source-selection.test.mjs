/** Offline selection checks; no package build, network, user home, or retained-source mutation. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { selectCommunitySources } from './source-selection.mjs'

const pins = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url), 'utf8'))
const owned = JSON.parse(readFileSync(new URL('./owned-downloads.json', import.meta.url), 'utf8'))

test('default builds select seven retained sources and seven owned plugins without archived Bot', () => {
  const selected = selectCommunitySources(pins)
  assert.deepEqual(selected, ['dshmarket', 'dsh-codex-subscription', 'dsh-bridge', 'dsh-ffmpeg', 'dsh-skill-mcp-panel', 'muse-hongguo-search', 'dsh-im'])
  assert.equal(Object.keys(owned).length, 7)
  assert.equal(selected.length + Object.keys(owned).length, 14)
  assert.ok(!selected.includes('ds-bot'))
  assert.ok(!selected.includes('dsh-feishu'))
})

test('only explicit selection enables an archived Bot or retired source compatibility build', () => {
  assert.deepEqual(selectCommunitySources(pins, 'ds-bot'), ['ds-bot'])
  assert.deepEqual(selectCommunitySources(pins, 'dsh-feishu'), ['dsh-feishu'])
  assert.deepEqual(selectCommunitySources(pins, 'dsh-codex-subscription'), ['dsh-codex-subscription'])
  assert.throws(() => selectCommunitySources(pins, '../unlisted'), /unknown source/)
})
