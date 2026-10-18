/** Durable inbound claims across connection restarts and failed local writes. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createInboundClaims } from './muse-feishu-reliability.mjs'

const limits = { retentionMs: 21600000, maxEntries: 20, now: () => 1000 }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'muse-feishu-claims-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return join(root, 'claims.json')
}

test('commits before dispatch and rejects the same delivery after a connection restart', t => {
  const file = fixture(t)
  const first = createInboundClaims(file, limits)
  assert.equal(first.claim('om_first'), true)
  assert.equal(first.claim('om_first'), false)
  const restarted = createInboundClaims(file, limits)
  assert.equal(restarted.claim('om_first'), false)
  assert.equal(restarted.claim('om_second'), true)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, entries: [['om_first', 1000], ['om_second', 1000]] })
})

test('does not evict an unexpired claim to admit a new paid request', t => {
  const file = fixture(t)
  let clock = 1000
  const ledger = createInboundClaims(file, { ...limits, maxEntries: 1, retentionMs: 100, now: () => clock })
  assert.equal(ledger.claim('om_first'), true)
  clock = 1099
  assert.throws(() => ledger.claim('om_new'), /capacity reached/u)
  assert.equal(createInboundClaims(file, { ...limits, maxEntries: 1 }).claim('om_first'), false)
  clock = 1100
  assert.equal(ledger.claim('om_new'), true)
})

test('retains the original claim if the wall clock moves backwards', t => {
  const file = fixture(t)
  assert.equal(createInboundClaims(file, limits).claim('om_first'), true)
  assert.equal(createInboundClaims(file, { ...limits, now: () => 10 }).claim('om_first'), false)
})

test('refuses malformed persisted claims instead of replaying them as an empty inbox', t => {
  const file = fixture(t)
  for (const text of ['{broken', '{"version":2,"entries":[]}', '{"version":1,"entries":[["same",1],["same",2]]}']) {
    writeFileSync(file, text)
    assert.throws(() => createInboundClaims(file, limits))
    assert.equal(readFileSync(file, 'utf8'), text)
  }
})

test('does not remember an ID until its local write succeeds', t => {
  const path = fixture(t)
  const file = join(path, 'claims.json')
  const ledger = createInboundClaims(file, limits)
  writeFileSync(path, 'not a directory')
  assert.throws(() => ledger.claim('om_first'))
  rmSync(path)
  mkdirSync(path)
  assert.equal(ledger.claim('om_first'), true)
})

test('does not follow a claim-file symlink', { skip: process.platform === 'win32' ? 'Creating symlinks requires Windows privileges' : false }, t => {
  const file = fixture(t)
  const original = file + '.original'
  writeFileSync(original, '{"version":1,"entries":[]}')
  symlinkSync(original, file)
  assert.throws(() => createInboundClaims(file, limits), /regular file/u)
  assert.equal(readFileSync(original, 'utf8'), '{"version":1,"entries":[]}')
})
