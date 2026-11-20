import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { bundleLink } from '../scripts/build-link.mjs'

// Muse vendors only the plugin directory, not upstream's ../link sources.
test('link.js is the build of ../link/src', { skip: 'upstream link sources are not vendored' }, async () => {
  assert.equal(await bundleLink(), readFileSync(new URL('../link.js', import.meta.url), 'utf8'), 'link.js is stale: run `npm run build` and commit it')
})
