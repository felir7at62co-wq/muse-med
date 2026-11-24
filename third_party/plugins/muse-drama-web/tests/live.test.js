/**
 * Opt-in live check against the real deployment. It performs reads only and never
 * writes, shares or submits a paid task.
 *
 * Set DRAMA_WEB_BASE_URL and DRAMA_WEB_TOKEN in the test environment,
 * then run `node --test tests/live.test.js`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { DramaWebClient } from '../src/client.js'

const baseUrl = process.env.DRAMA_WEB_BASE_URL ?? ''
const skip = baseUrl && process.env.DRAMA_WEB_TOKEN ? false : 'DRAMA_WEB_BASE_URL and DRAMA_WEB_TOKEN are required'

test('the token identifies a real account', { skip }, async () => {
  const client = new DramaWebClient({ baseUrl })
  const me = await client.me()
  assert.ok(me?.id, 'expected an account id')
  assert.ok(typeof me.username === 'string' && me.username.length > 0)
  assert.ok(['member', 'leader', 'admin', 'team_admin'].includes(me.role) || typeof me.role === 'string')
})

test('the library answers a keyword search and keeps total honest', { skip }, async () => {
  const client = new DramaWebClient({ baseUrl })
  const page = await client.listDramas({ keyword: '听宝', page: 1, page_size: 5 })
  assert.ok(Array.isArray(page.items), 'expected an items array')
  assert.equal(typeof page.total, 'number')
  assert.ok(page.items.length <= 5, 'page_size must bound the returned rows')
})

test('a drama profile and its final files are readable', { skip }, async () => {
  const client = new DramaWebClient({ baseUrl })
  const page = await client.listDramas({ keyword: '听宝', page: 1, page_size: 1 })
  const drama = page.items?.[0]
  assert.ok(drama?.id, 'expected a drama id from the search')
  const profile = await client.getDrama(drama.id)
  assert.equal(profile.id, drama.id)
  const files = await client.listFiles(drama.id, { resourceType: 'final' })
  const list = Array.isArray(files) ? files : (files.items ?? files.data ?? null)
  assert.ok(Array.isArray(list), 'expected an array of files')
  if (list.length) {
    assert.equal(typeof list[0].id, 'number')
    const signed = await client.fileUrl(list[0].id)
    const url = signed?.url ?? signed?.download_url
    assert.ok(typeof url === 'string' && url.startsWith('https://'), 'expected a signed HTTPS URL')
  }
})

test('subtitle erasure reports its switch', { skip }, async () => {
  const client = new DramaWebClient({ baseUrl })
  const state = await client.subtitleEraseEnabled()
  assert.equal(typeof state?.enabled, 'boolean')
})
