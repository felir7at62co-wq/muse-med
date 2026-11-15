import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPendingStore } from '../src/host/pending.js'

const record = id => ({ id, callId: id, title: '', view: { type: 'confirm', id: 'yes' }, askedAt: 1 })
async function store(t) {
  const home = await mkdtemp(join(tmpdir(), 'deep-view-pending-')), pending = createPendingStore(home)
  t.after(async () => { await pending.close(); await rm(home, { recursive: true, force: true }) })
  return { home, pending, path: join(home, 'pending.json') }
}
test('concurrent first writes retain every detached record and reload from disk', async t => {
  const fixture = await store(t)
  await Promise.all(Array.from({ length: 25 }, (_, index) => fixture.pending.set(`session-${index}`, record(`call-${index}`))))
  assert.equal(Object.keys(fixture.pending.snapshot()).length, 25)
  const reopened = createPendingStore(fixture.home); t.after(() => reopened.close()); await reopened.load()
  assert.deepEqual(reopened.snapshot(), fixture.pending.snapshot())
  const read = reopened.get('session-1'); read.title = 'Changed externally'
  assert.equal(reopened.get('session-1').title, '')
  if (process.platform !== 'win32') assert.equal((await stat(fixture.path)).mode & 0o777, 0o600)
})
test('a failed replacement retains committed memory and the next mutation can succeed', async t => {
  const fixture = await store(t); await fixture.pending.set('session', record('original'))
  await rename(fixture.path, fixture.path + '.backup'); await mkdir(fixture.path)
  await assert.rejects(fixture.pending.set('session', record('replacement')))
  assert.equal(fixture.pending.get('session').id, 'original')
  await rm(fixture.path, { recursive: true }); await rename(fixture.path + '.backup', fixture.path)
  await fixture.pending.set('session', record('replacement'))
  assert.equal(fixture.pending.get('session').id, 'replacement')
})
test('malformed stored data fails visibly and is never replaced with an empty file', async t => {
  const fixture = await store(t), malformed = '{"session":'; await writeFile(fixture.path, malformed)
  await assert.rejects(fixture.pending.load()); await assert.rejects(fixture.pending.set('session', record('call')))
  assert.equal(await readFile(fixture.path, 'utf8'), malformed)
})
test('conditional drops preserve replacements and close drains prior mutations', async t => {
  const fixture = await store(t); await fixture.pending.set('__proto__', record('safe-id'))
  assert.equal(fixture.pending.get('__proto__').id, 'safe-id')
  assert.equal(await fixture.pending.drop('__proto__', 'stale-id'), false)
  const saving = fixture.pending.set('session', record('call')); await fixture.pending.close(); await saving
  await assert.rejects(fixture.pending.set('late', record('late')))
  assert.equal(JSON.parse(await readFile(fixture.path, 'utf8')).session.id, 'call')
})
